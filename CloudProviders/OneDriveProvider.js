const axios = require('axios');
const qs = require('qs');
const CloudProvider = require('../CloudProvider');

class OneDriveProvider extends CloudProvider {
  constructor() {
    super();
    this.clientId = process.env.ONEDRIVE_CLIENT_ID;
    this.clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;
    this.scope = 'Files.ReadWrite offline_access';
    this.redirectBase = 'https://login.microsoftonline.com/common/oauth2/v2.0';
    this.graphBase = 'https://graph.microsoft.com/v1.0';
  }

  getAuthUrl(callbackUrl, state) {
    const params = {
      client_id: this.clientId, response_type: 'code', redirect_uri: callbackUrl,
      scope: this.scope, response_mode: 'query', state: state
    };
    return `${this.redirectBase}/authorize?${qs.stringify(params)}`;
  }

  async getTokenFromCode(code, redirectUri) {
    const params = {
      client_id: this.clientId, client_secret: this.clientSecret, code: code,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    };
    const response = await axios.post(`${this.redirectBase}/token`, qs.stringify(params),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return response.data;
  }

  async uploadStream(fileStream, metadata, token) {
    const accessToken = token.access_token || token;
    
    // folder structure
    const fullPath = `${metadata.folderPath}/${metadata.name}`.replace(/\/+/g, '/');
    const url = `${this.graphBase}/me/drive/root:/${fullPath}:/createUploadSession`;

    // upload session
    const sessionRes = await axios.post(url, {
        item: {
            "@microsoft.graph.conflictBehavior": "rename"
        }
    }, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    
    const uploadUrl = sessionRes.data.uploadUrl;
    
    // upload chunks
    const chunkSize = 327680 * 10; 
    let buffer = Buffer.alloc(0);
    let start = 0;
    let finalResponse = null;

    for await (const chunk of fileStream) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= chunkSize) {
        const slice = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        await this._sendChunk(uploadUrl, slice, start, metadata.size);
        start += slice.length;
      }
    }
    if (buffer.length > 0) {
      finalResponse = await this._sendChunk(uploadUrl, buffer, start, metadata.size);
    }

    return {
      id: finalResponse.data.id,
      webViewLink: finalResponse.data.webUrl
    };
  }

  async _sendChunk(url, buffer, start, totalSize) {
    const end = start + buffer.length - 1;
    return axios.put(url, buffer, {
      headers: {
        'Content-Length': buffer.length,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`
      }
    });
  }

  async deleteFile(fileId, token) {
      if (!fileId) return;
      const accessToken = token.access_token || token;
      try {
          await axios.delete(`${this.graphBase}/me/drive/items/${fileId}`, {
              headers: { 'Authorization': `Bearer ${accessToken}` }
          });
      } catch (e) {
          console.error("OneDrive delete error", e.message);
      }
  }
}

module.exports = OneDriveProvider;