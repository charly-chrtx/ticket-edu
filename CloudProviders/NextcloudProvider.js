const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudProvider = require('../CloudProvider');

class NextcloudProvider extends CloudProvider {
  getAuthUrl(callbackUrl, state) { return null; }

  // get basic auth header
  getAuthHeader(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  async verifyCredentials(params) {
    // use url, user, pass consistently
    const { url, user, pass } = params;
    const targetUrl = new URL(url);
    const options = {
      method: 'PROPFIND',
      headers: { 'Authorization': this.getAuthHeader(user, pass), 'Depth': '0' }
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

  async createFolder(pathOrUrl, credentials) {
    const { url, user, pass } = credentials;
    const authHeader = this.getAuthHeader(user, pass);
    
    // build full url if path is relative
    let targetUrlString = pathOrUrl;
    if (!pathOrUrl.startsWith('http')) {
      const encodedPath = pathOrUrl.split('/').map(encodeURIComponent).join('/');
      targetUrlString = `${url}/remote.php/dav/files/${user}/${encodedPath}`;
    }

    const targetUrl = new URL(targetUrlString);
    const options = { method: 'MKCOL', headers: { 'Authorization': authHeader } };
    return new Promise((resolve) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      const req = client.request(targetUrl, options, () => resolve(targetUrlString));
      req.end();
    });
  }

  async uploadStream(fileStream, metadata, credentials) {
    const { url, user, pass } = credentials;
    const authHeader = this.getAuthHeader(user, pass);
    
    const baseUrl = `${url}/remote.php/dav/files/${user}`;
    const pathParts = metadata.folderPath.split('/').filter(p => p);
    
    let currentPath = baseUrl;
    for (const part of pathParts) {
      currentPath += '/' + encodeURIComponent(part);
      const exists = await this.checkExists(currentPath, authHeader);
      if (!exists) {
        // create subfolder
        const subUrl = new URL(currentPath);
        await new Promise(r => {
          const client = subUrl.protocol === 'http:' ? http : https;
          const req = client.request(subUrl, { method: 'MKCOL', headers: { 'Authorization': authHeader } }, r);
          req.end();
        });
      }
    }

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
    const options = { method: 'PUT', headers: { 'Authorization': authHeader } };

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
      headers: { 'Authorization': this.getAuthHeader(user, pass) }
    };
    const client = targetUrl.protocol === 'http:' ? http : https;
    const req = client.request(targetUrl, options);
    req.end();
  }
}

module.exports = NextcloudProvider;