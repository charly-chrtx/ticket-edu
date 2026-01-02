const { google } = require('googleapis');
const CloudProvider = require('../CloudProvider');

class GoogleProvider extends CloudProvider {
  constructor() {
    super();
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  }

  getAuthUrl(callbackUrl, state) {
    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, callbackUrl);
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      state: state
    });
  }

  async getTokenFromCode(code, redirectUri) {
    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    try {
      oauth2Client.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      const about = await drive.about.get({ fields: 'user(emailAddress)' });
      
      tokens.email = about.data.user.emailAddress; 
    } catch (e) {
      console.error("Impossible de récupérer l'email lors du handshake Google:", e.message);
      tokens.email = 'Inconnu';
    }

    return tokens;
  }

  // helper to ensure path exists
  async _ensureFolderPath(drive, folderPath) {
    const pathParts = folderPath.split('/').filter(p => p);
    let parentId = 'root';

    for (const folderName of pathParts) {
      parentId = await this.findOrCreateFolder(drive, folderName, parentId);
    }
    return parentId;
  }

  async findOrCreateFolder(drive, folderName, parentId = 'root') {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive' });

    if (res.data.files.length > 0) {
      return res.data.files[0].id;
    } else {
      const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      };
      const folder = await drive.files.create({
        requestBody: fileMetadata,
        fields: 'id'
      });
      return folder.data.id;
    }
  }

  // create folder and get link
  async createFolder(folderPath, token) {
    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret);
    oauth2Client.setCredentials(token);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const parentId = await this._ensureFolderPath(drive, folderPath);

    const res = await drive.files.get({
      fileId: parentId,
      fields: 'webViewLink'
    });

    return res.data.webViewLink;
  }

  async uploadStream(fileStream, metadata, token) {
    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret);
    oauth2Client.setCredentials(token);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // get user email
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    const userEmail = about.data.user.emailAddress;

    // folder structure
    const parentId = await this._ensureFolderPath(drive, metadata.folderPath);

    // get folder info
    const folderRes = await drive.files.get({
      fileId: parentId,
      fields: 'webViewLink, name'
    });

    // if file exists, rename it
    let finalName = metadata.name;
    let counter = 1;
    let exists = true;

    while (exists) {
      const q = `name='${finalName}' and '${parentId}' in parents and trashed=false`;
      const check = await drive.files.list({ q, fields: 'files(id)' });
      if (check.data.files.length > 0) {
        const parts = metadata.name.split('.');
        const ext = parts.length > 1 ? '.' + parts.pop() : '';
        const base = parts.join('.');
        finalName = `${base} (${counter})${ext}`;
        counter++;
      } else {
        exists = false;
      }
    }

    // upload
    const response = await drive.files.create({
      requestBody: {
        name: finalName,
        mimeType: metadata.mimeType,
        parents: [parentId]
      },
      media: {
        mimeType: metadata.mimeType,
        body: fileStream
      },
      fields: 'id, webViewLink'
    });

    return {
      id: response.data.id,
      webViewLink: response.data.webViewLink,
      folderLink: folderRes.data.webViewLink,
      folderName: folderRes.data.name,
      account: userEmail
    };
  }

  async deleteFile(fileId, token) {
    if (!fileId) return;
    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret);
    oauth2Client.setCredentials(token);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    try {
      await drive.files.delete({ fileId: fileId });
    } catch (e) {
      console.error("Google Drive delete error:", e.message);
    }
  }
}

module.exports = GoogleProvider;