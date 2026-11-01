const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '50mb' })); 
app.use(cors()); 

// Helper function to initialize Google Drive client
function getDriveService() {
  const credentials = JSON.parse(process.env.DRIVE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://googleapis.com'],
  });
  return google.drive({ version: 'v3', auth });
}

const TARGET_FOLDER_ID = 'PASTE_YOUR_TARGET_FOLDER_ID_HERE';

// 1. ADMIN UPLOAD ROUTE (Includes Description)
app.post('/upload', async (req, res) => {
  try {
    const drive = getDriveService();
    const { fileName, mimeType, fileData, description } = req.body;

    const fileMetadata = {
      name: fileName || 'project_upload.zip',
      parents: [TARGET_FOLDER_ID],
      description: description || 'No description provided.' // Storing custom text here!
    };

    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: fileData, 
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    res.status(200).json({ success: true, fileId: file.data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. PUBLIC LIST ROUTE (Fetches all files & metadata)
app.get('/projects', async (req, res) => {
  try {
    const drive = getDriveService();
    
    // Search for non-deleted files inside your specific project folder
    const response = await drive.files.list({
      q: `'${TARGET_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, description, size, mimeType)',
      pageSize: 100
    });

    res.status(200).json({ success: true, projects: response.data.files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. PUBLIC DIRECT DOWNLOAD ROUTE (Streams file directly through backend)
app.get('/download/:fileId', async (req, res) => {
  try {
    const drive = getDriveService();
    const fileId = req.params.fileId;

    // Get the original file name and content type first
    const metadata = await drive.files.get({ fileId: fileId, fields: 'name, mimeType' });

    // Set headers so the browser triggers an automatic download with the original file name
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.data.name}"`);
    res.setHeader('Content-Type', metadata.data.mimeType);

    // Request the raw binary content stream from Google Drive
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    // Pipe the file data directly into the user's browser response
    response.data.pipe(res);
  } catch (error) {
    res.status(500).send('Error downloading file: ' + error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
