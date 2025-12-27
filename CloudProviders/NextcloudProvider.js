const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudProvider = require('../CloudProvider');

class NextcloudProvider extends CloudProvider {

  getAuthUrl(callbackUrl, state) { return null; }

  async verifyCredentials(params) {
    const { instanceUrl, username, password } = params;
    const targetUrl = new URL(instanceUrl);
    const options = {
      method: 'PROPFIND',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Depth': '0' }
    };
    return new Promise((resolve, reject) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      const req = client.request(targetUrl, options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`auth failed ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // check if file/folder exists
  async checkExists(url, authHeader) {
    const targetUrl = new URL(url);
    const options = { method: 'PROPFIND', headers: { 'Authorization': authHeader, 'Depth': '0' } };
    return new Promise((resolve) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      const req = client.request(targetUrl, options, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.end();
    });
  }

  // create folder
  async createFolder(url, authHeader) {
      const targetUrl = new URL(url);
      const options = { method: 'MKCOL', headers: { 'Authorization': authHeader } };
      return new Promise((resolve) => {
          const client = targetUrl.protocol === 'http:' ? http : https;
          const req = client.request(targetUrl, options, (res) => resolve());
          req.end();
      });
  }

  async uploadStream(fileStream, metadata, credentials) {
    const { url, user, pass } = credentials;
    const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    
    // folder structure
    const baseUrl = `${url}/remote.php/dav/files/${user}`;
    const pathParts = metadata.folderPath.split('/').filter(p => p);
    
    let currentPath = baseUrl;
    for (const part of pathParts) {
        currentPath += '/' + encodeURIComponent(part);
        const exists = await this.checkExists(currentPath, authHeader);
        if (!exists) {
            await this.createFolder(currentPath, authHeader);
        }
    }

    // manage file name conflicts
    let finalName = metadata.name;
    let counter = 1;
    let targetUrlString = `${currentPath}/${encodeURIComponent(finalName)}`;
    
    while (await this.checkExists(targetUrlString, authHeader)) {
        const parts = metadata.name.split('.');
        const ext = parts.length > 1 ? '.' + parts.pop() : '';
        const base = parts.join('.');
        finalName = `${base} (${counter})${ext}`;
        counter++;
        targetUrlString = `${currentPath}/${encodeURIComponent(finalName)}`;
    }

    const targetUrl = new URL(targetUrlString);
    const options = {
      method: 'PUT',
      headers: { 'Authorization': authHeader }
    };

    return new Promise((resolve, reject) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      const req = client.request(targetUrl, options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ id: targetUrlString, webViewLink: targetUrlString });
        } else {
          reject(new Error(`upload failed ${res.statusCode}`));
        }
      });
      fileStream.pipe(req);
    });
  }

  async deleteFile(fileId, credentials) {
      if (!fileId) return;
      const { user, pass } = credentials;
      const targetUrl = new URL(fileId);
      const options = {
          method: 'DELETE',
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }
      };
      
      const client = targetUrl.protocol === 'http:' ? http : https;
      const req = client.request(targetUrl, options);
      req.end();
  }
}

module.exports = NextcloudProvider;