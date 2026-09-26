import express from 'express';
import cors from 'cors';
import busboy from 'busboy';
import { google } from 'googleapis';

const app = express();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const UPLOAD_SECRET = process.env.UPLOAD_SERVICE_SECRET;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || null;

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB, matches the Next app's video cap

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Attendee'],
  })
);

function driveClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// In-memory cache so we don't re-look-up a guest's folder on every upload.
// Resets if the process restarts — fine for a short event.
const attendeeFolderCache = new Map();

function escapeForDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getOrCreateAttendeeFolder(drive, attendeeName) {
  if (attendeeFolderCache.has(attendeeName)) {
    return attendeeFolderCache.get(attendeeName);
  }

  const parentClause = FOLDER_ID
    ? `'${FOLDER_ID}' in parents`
    : `'root' in parents`;

  const safeName = escapeForDriveQuery(attendeeName);

  const query = `${parentClause} and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const existing = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  let folderId;

  if (existing.data.files && existing.data.files.length > 0) {
    folderId = existing.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: attendeeName,
        mimeType: 'application/vnd.google-apps.folder',
        ...(FOLDER_ID ? { parents: [FOLDER_ID] } : {}),
      },
      fields: 'id',
    });

    folderId = created.data.id;
  }

  attendeeFolderCache.set(attendeeName, folderId);
  return folderId;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/upload', (req, res) => {
  if (!UPLOAD_SECRET) {
    console.error('UPLOAD_SERVICE_SECRET is not configured.');
    return res.status(500).json({ error: 'Server misconfigured.' });
  }

  const authHeader = req.headers['authorization'] || '';

  if (authHeader !== `Bearer ${UPLOAD_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const attendeeHeader = req.headers['x-attendee'];

  const attendeeName = attendeeHeader
    ? decodeURIComponent(String(attendeeHeader)).trim()
    : null;

  let bb;

  try {
    bb = busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });
  } catch (err) {
    console.error('BUSBOY INIT ERROR:', err);
    return res.status(400).json({ error: 'Malformed upload request.' });
  }

  let receivedFile = false;
  let responded = false;

  function sendError(status, message) {
    if (responded || res.headersSent) return;
    responded = true;
    res.status(status).json({ error: message });
  }

  function sendSuccess(payload) {
    if (responded || res.headersSent) return;
    responded = true;
    res.json(payload);
  }

  bb.on('file', (_fieldName, fileStream, info) => {
    receivedFile = true;
    const { filename, mimeType } = info;

    let tooLarge = false;

    fileStream.on('limit', () => {
      tooLarge = true;
      fileStream.resume(); // drain so busboy can finish cleanly
      sendError(413, `"${filename}" is larger than 200MB.`);
    });

    (async () => {
      try {
        const drive = driveClient();

        let parentId = FOLDER_ID;

        if (attendeeName) {
          parentId = await getOrCreateAttendeeFolder(drive, attendeeName);
        }

        const driveRes = await drive.files.create(
          {
            requestBody: {
              name: filename,
              ...(parentId ? { parents: [parentId] } : {}),
            },
            media: {
              mimeType,
              body: fileStream,
            },
            fields: 'id, name, mimeType, size',
          },
          {
            // allow the underlying HTTP client to send large bodies
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          }
        );

        if (tooLarge) return; // already responded with 413

        sendSuccess({
          ok: true,
          fileId: driveRes.data.id,
          fileName: driveRes.data.name,
          mimeType: driveRes.data.mimeType,
          fileSize: Number(driveRes.data.size || 0),
        });
      } catch (err) {
        console.error('DRIVE UPLOAD ERROR:', err?.response?.data || err);
        sendError(502, 'Upload to Google Drive failed.');
      }
    })();
  });

  bb.on('error', (err) => {
    console.error('BUSBOY STREAM ERROR:', err);
    sendError(400, 'Upload stream failed.');
  });

  bb.on('close', () => {
    if (!receivedFile) {
      sendError(400, 'No file was received.');
    }
  });

  req.pipe(bb);
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Upload service listening on port ${port}`);
});
