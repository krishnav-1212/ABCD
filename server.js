'use strict';
/* ════════════════════════════════════════════════════════════════════
   Krishnav 2211 — Drive file server (runs on Render)

   What it does
     GET  /health            wake-up / uptime check
     GET  /projects          list of files in your Drive folder (public)
     GET  /download/:fileId  streams one file from that folder (public)
     POST /upload            admin only: streams a file into the folder

   Render environment variables
     DRIVE_SERVICE_ACCOUNT_KEY  (required) the service-account JSON key
     DRIVE_FOLDER_ID            (required) the Drive folder id
     FIREBASE_PROJECT_ID        (required for uploads) your Firebase project id
     ADMIN_UIDS                 (required for uploads) your Firebase user id(s), comma separated
     ALLOWED_ORIGINS            optional, comma separated. Default: your Netlify site
     MAX_UPLOAD_MB              optional, default 200
   ════════════════════════════════════════════════════════════════════ */
const express = require('express');
const cors = require('cors');
const busboy = require('busboy');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { google } = require('googleapis');

// ───────────────────────── configuration ─────────────────────────
const TARGET_FOLDER_ID = process.env.DRIVE_FOLDER_ID || 'PASTE_YOUR_TARGET_FOLDER_ID_HERE';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://krishnav-2211.netlify.app')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 200)) * 1024 * 1024;
const PORT = process.env.PORT || 3000;

function fatal(msg) { console.error('\n✖ ' + msg + '\n'); process.exit(1); }
if (!process.env.DRIVE_SERVICE_ACCOUNT_KEY) fatal('DRIVE_SERVICE_ACCOUNT_KEY is not set.');
if (TARGET_FOLDER_ID.startsWith('PASTE_')) fatal('Set DRIVE_FOLDER_ID (or edit TARGET_FOLDER_ID) to your Drive folder id.');
let CREDENTIALS;
try { CREDENTIALS = JSON.parse(process.env.DRIVE_SERVICE_ACCOUNT_KEY); }
catch (e) { fatal('DRIVE_SERVICE_ACCOUNT_KEY is not valid JSON. Paste the whole key file contents, unchanged.'); }

const UPLOADS_ENABLED = !!(FIREBASE_PROJECT_ID && ADMIN_UIDS.length);
if (UPLOADS_ENABLED) admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });
else console.warn('⚠ Uploads are DISABLED until FIREBASE_PROJECT_ID and ADMIN_UIDS are set (downloads still work).');

// ───────────────────────── Google Drive ─────────────────────────
let driveClient;
function getDrive() {                       // created once, reused for every request
  if (!driveClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/drive'],   // full path required — a bare host is not a valid scope
    });
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

// ───────────────────────── helpers ─────────────────────────
function cleanName(n) {
  n = String(n || '').normalize('NFKC').split(/[\\/]/).pop();            // drop any path
  n = n.replace(/[\u0000-\u001f\u007f"<>:*?|]/g, '').replace(/^\.+/, '').trim().slice(0, 150);
  return n || 'project.zip';
}
function guessMime(name, given) {
  if (/\.zip$/i.test(name)) return 'application/zip';
  if (/\.(mcaddon|mcpack|mcworld|mctemplate)$/i.test(name)) return 'application/zip';
  return given && given !== 'application/x-www-form-urlencoded' ? given : 'application/octet-stream';
}
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
const FILE_ID = /^[A-Za-z0-9_-]{10,80}$/;

// ───────────────────────── app ─────────────────────────
const app = express();
app.set('trust proxy', 1);                  // Render sits behind a proxy; needed for per-visitor rate limits
app.disable('x-powered-by');

app.use(cors({
  origin(origin, cb) { cb(null, !origin || ALLOWED_ORIGINS.includes(origin)); },   // only your site may call this from a browser
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

const limiter = (windowMin, max, what) => rateLimit({
  windowMs: windowMin * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: `Too many ${what} — please wait a few minutes and try again.` },
});
const apiLimiter = limiter(10, Number(process.env.API_LIMIT || 300), 'requests');
const downloadLimiter = limiter(10, Number(process.env.DOWNLOAD_LIMIT || 60), 'downloads');
const uploadLimiter = limiter(60, Number(process.env.UPLOAD_LIMIT || 30), 'uploads');

// ── admin check: a valid Firebase login token that belongs to one of ADMIN_UIDS ──
async function requireAdmin(req, res, next) {
  if (!UPLOADS_ENABLED) return res.status(503).json({ success: false, error: 'Uploads are not configured on the server yet (FIREBASE_PROJECT_ID / ADMIN_UIDS).' });
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ success: false, error: 'Please log in first.' });
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    if (!ADMIN_UIDS.includes(decoded.uid)) return res.status(403).json({ success: false, error: 'This account is not allowed to upload.' });
    req.adminUid = decoded.uid; next();
  } catch (e) { res.status(401).json({ success: false, error: 'Your login expired — log in again.' }); }
}

// ───────────────────────── routes ─────────────────────────
app.get(['/', '/health'], (req, res) => {          // also used to wake Render up before a visitor clicks Download
  res.set('Cache-Control', 'no-store').json({ ok: true, service: 'drive-backend' });
});

// 1. ADMIN UPLOAD — multipart/form-data, streamed straight to Drive (never held in memory, no base64)
//    Send the "description" field BEFORE the "file" field.
app.post('/upload', uploadLimiter, requireAdmin, (req, res) => {
  let bb;
  try {
    bb = busboy({ headers: req.headers, defParamCharset: 'utf8',
      limits: { files: 1, fields: 6, fieldSize: 20 * 1024, fileSize: MAX_UPLOAD_BYTES } });
  } catch (e) { return res.status(400).json({ success: false, error: 'Send the file as multipart/form-data.' }); }

  const fields = {}; let gotFile = false, done = false, tooBig = false;
  const finish = (code, body) => { if (done) return; done = true; res.status(code).json(body); };

  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('file', (name, stream, info) => {
    if (name !== 'file' || gotFile) { stream.resume(); return; }
    gotFile = true;
    const fileName = cleanName(fields.name || info.filename);
    const mimeType = guessMime(fileName, info.mimeType);
    stream.on('limit', () => { tooBig = true; });
    stream.on('error', () => {});
    getDrive().files.create({
      requestBody: { name: fileName, parents: [TARGET_FOLDER_ID], description: String(fields.description || '').slice(0, 4000) || undefined },
      media: { mimeType, body: stream },
      fields: 'id,name,size',
      supportsAllDrives: true,
    }).then(async r => {
      if (tooBig) {                                                  // never keep a half-uploaded file
        try { await getDrive().files.delete({ fileId: r.data.id, supportsAllDrives: true }); } catch (e) {}
        return finish(413, { success: false, error: `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.` });
      }
      finish(200, { success: true, fileId: r.data.id, name: r.data.name, size: Number(r.data.size) || null });
    }).catch(e => {
      console.error('upload failed:', e.message);
      const quota = /storage quota/i.test(e.message || '');
      finish(500, { success: false, error: e.message || 'Upload failed.',
        hint: quota ? 'Google rejects service accounts uploading into a normal My Drive folder. Use an OAuth refresh token for your own account instead, or upload through the Drive app and register the file.' : undefined });
    });
  });
  bb.on('error', () => finish(400, { success: false, error: 'Upload was interrupted or malformed.' }));
  bb.on('close', () => { if (!gotFile) finish(400, { success: false, error: 'No file received (field name must be "file").' }); });
  req.on('aborted', () => { done = true; });
  req.pipe(bb);
});

// 2. PUBLIC LIST — files + descriptions in the folder
app.get('/projects', apiLimiter, async (req, res) => {
  try {
    const drive = getDrive(); const files = []; let pageToken;
    for (let i = 0; i < 10; i++) {
      const r = await drive.files.list({
        q: `'${TARGET_FOLDER_ID}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, description, size, mimeType, modifiedTime)',
        orderBy: 'modifiedTime desc', pageSize: 100, pageToken,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      files.push(...r.data.files); pageToken = r.data.nextPageToken; if (!pageToken) break;
    }
    res.set('Cache-Control', 'public, max-age=60').json({ success: true, projects: files });
  } catch (e) { console.error('list failed:', e.message); res.status(502).json({ success: false, error: 'Could not load the project list right now.' }); }
});

// 3. PUBLIC DOWNLOAD — only files that live in YOUR folder, always sent as a download
app.get('/download/:fileId', downloadLimiter, async (req, res) => {
  const fileId = req.params.fileId;
  if (!FILE_ID.test(fileId)) return res.status(400).send('Bad file id.');
  try {
    const drive = getDrive();
    let meta;
    try { meta = (await drive.files.get({ fileId, fields: 'id,name,size,parents,trashed', supportsAllDrives: true })).data; }
    catch (e) { return res.status(404).send('File not found.'); }
    if (meta.trashed || !(meta.parents || []).includes(TARGET_FOLDER_ID)) return res.status(404).send('File not found.');

    const up = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    res.set({
      'Content-Type': 'application/octet-stream',            // never html/js: a file here must not run on this server's origin
      'Content-Disposition': contentDisposition(meta.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    });
    if (meta.size) res.set('Content-Length', meta.size);
    res.on('close', () => up.data.destroy());                // visitor cancelled -> stop pulling from Drive
    up.data.on('error', err => { console.error('stream failed:', err.message); res.destroy(err); });
    up.data.pipe(res);
  } catch (e) {
    console.error('download failed:', e.message);
    if (!res.headersSent) res.status(502).send('Could not download this file right now.');
    else res.destroy();
  }
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found.' }));
app.use((err, req, res, next) => {                           // last-resort handler: never leak internals
  console.error('unhandled:', err && err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ success: false, error: 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT} · uploads ${UPLOADS_ENABLED ? 'enabled' : 'DISABLED'}`));
