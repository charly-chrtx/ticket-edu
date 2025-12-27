const { google } = require('googleapis');
const CloudProvider = require('../CloudProvider');

class GoogleProvider extends CloudProvider {
  constructor() {
    super();
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  }

  // generate auth url for oauth flow
  getAuthUrl(callbackUrl, state) {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      callbackUrl
    );

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      state: state
    });
  }

  // exchange code for token
  async getTokenFromCode(code, redirectUri) {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
  }

  // upload file stream
  async uploadStream(fileStream, metadata, token) {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret
    );
    oauth2Client.setCredentials(token);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const response = await drive.files.create({
      requestBody: {
        name: metadata.name,
        mimeType: metadata.mimeType
      },
      media: {
        mimeType: metadata.mimeType,
        body: fileStream
      },
      fields: 'id, webViewLink'
    });

    return {
      id: response.data.id,
      webViewLink: response.data.webViewLink
    };
  }
}

module.exports = GoogleProvider;