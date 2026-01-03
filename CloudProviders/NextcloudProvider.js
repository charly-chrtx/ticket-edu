const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudProvider = require('../CloudProvider');

class NextcloudProvider extends CloudProvider {

  getAuthUrl(callbackUrl, state) { return null; }

  // clean url
  cleanBaseUrl(url) {
    return url.replace(/\/$/, '');
  }

  // get basic auth header
  getAuthHeader(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  async verifyCredentials(params) {
    const { url, user, pass } = params;
    const baseUrl = this.cleanBaseUrl(url);
    
    // check user root
    const targetUrlString = `${baseUrl}/remote.php/dav/files/${user}`;
    const targetUrl = new URL(targetUrlString);

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
  async createFolder(pathOrUrl, credentials) {
    const { url, user, pass } = credentials;
    const baseUrl = this.cleanBaseUrl(url);
    const authHeader = this.getAuthHeader(user, pass);
    
    // build webdav url
    const parts = pathOrUrl.split('/').map(encodeURIComponent);
    const encodedPath = parts.join('/');
    const davUrlString = `${baseUrl}/remote.php/dav/files/${user}/${encodedPath}`;
    
    // build ui url
    const uiPath = pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl;
    const uiUrl = `${baseUrl}/index.php/apps/files/?dir=${encodeURIComponent(uiPath)}`;

    const targetUrl = new URL(davUrlString);
    const options = { method: 'MKCOL', headers: { 'Authorization': authHeader } };
    
    return new Promise((resolve) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      // execute mkcol
      const req = client.request(targetUrl, options, () => {
        // return ui url
        resolve(uiUrl);
      });
      req.end();
    });
  }

  // upload stream
  async uploadStream(fileStream, metadata, credentials) {
    const { url, user, pass } = credentials;
    const baseUrl = this.cleanBaseUrl(url);
    const authHeader = this.getAuthHeader(user, pass);
    
    const davBaseUrl = `${baseUrl}/remote.php/dav/files/${user}`;
    const pathParts = metadata.folderPath.split('/').filter(p => p);
    
    // recursive create
    let currentPath = davBaseUrl;
    for (const part of pathParts) {
      currentPath += '/' + encodeURIComponent(part);
      const exists = await this.checkExists(currentPath, authHeader);
      if (!exists) {
        const subUrl = new URL(currentPath);
        await new Promise(r => {
          const client = subUrl.protocol === 'http:' ? http : https;
          const req = client.request(subUrl, { method: 'MKCOL', headers: { 'Authorization': authHeader } }, r);
          req.end();
        });
      }
    }

    // name conflict
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

  // delete file
  async deleteFile(fileId, credentials) {
    if (!fileId) return;
    const { user, pass } = credentials;
    // fileid is full url
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