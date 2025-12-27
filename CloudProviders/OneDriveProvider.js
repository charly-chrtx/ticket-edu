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

  // generate auth url for oauth flow
  getAuthUrl(callbackUrl, state) {
    const params = {
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: this.scope,
      response_mode: 'query',
      state: state
    };
    
    return `${this.redirectBase}/authorize?${qs.stringify(params)}`;
  }

  // exchange code for token
  async getTokenFromCode(code, redirectUri) {
    const params = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    };

    const response = await axios.post(
      `${this.redirectBase}/token`,
      qs.stringify(params),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return response.data;
  }

  // upload file stream
  async uploadStream(fileStream, metadata, token) {
    const accessToken = token.access_token || token;
    const fileSize = metadata.size;
    // 4mb threshold for upload session
    const threshold = 4 * 1024 * 1024;

    if (fileSize < threshold) {
      return this._uploadSimple(fileStream, metadata, accessToken);
    } else {
      return this._uploadLargeFile(fileStream, metadata, accessToken);
    }
  }

  // simple upload for small files
  async _uploadSimple(fileStream, metadata, token) {
    const url = `${this.graphBase}/me/drive/root:/${metadata.name}:/content`;
    
    const response = await axios.put(url, fileStream, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': metadata.mimeType
      }
    });

    return {
      id: response.data.id,
      webViewLink: response.data.webUrl
    };
  }

  // large file upload with session
  async _uploadLargeFile(fileStream, metadata, token) {
    // create upload session
    const createSessionUrl = `${this.graphBase}/me/drive/root:/${metadata.name}:/createUploadSession`;
    const sessionRes = await axios.post(createSessionUrl, {}, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const uploadUrl = sessionRes.data.uploadUrl;
    // multiple of 320kb required by onedrive
    const chunkSize = 327680 * 10; 
    let buffer = Buffer.alloc(0);
    let start = 0;
    let finalResponse = null;

    // read stream chunks
    for await (const chunk of fileStream) {
      buffer = Buffer.concat([buffer, chunk]);

      // send chunk if buffer is big enough
      while (buffer.length >= chunkSize) {
        const slice = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        
        await this._sendChunk(uploadUrl, slice, start, metadata.size);
        start += slice.length;
      }
    }

    // send remaining buffer
    if (buffer.length > 0) {
      finalResponse = await this._sendChunk(uploadUrl, buffer, start, metadata.size);
    }

    return {
      id: finalResponse.data.id,
      webViewLink: finalResponse.data.webUrl
    };
  }

  // send individual byte range
  async _sendChunk(url, buffer, start, totalSize) {
    const end = start + buffer.length - 1;
    
    return axios.put(url, buffer, {
      headers: {
        'Content-Length': buffer.length,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`
      }
    });
  }
}

module.exports = OneDriveProvider;