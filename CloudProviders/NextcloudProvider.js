const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudProvider = require('../CloudProvider');

class NextcloudProvider extends CloudProvider {

  getAuthUrl(callbackUrl, state) {
    return null;
  }

  // verify user credentials via webdav propfind
  async verifyCredentials(params) {
    const { instanceUrl, username, password } = params;
    const targetUrl = new URL(instanceUrl);
    
    const options = {
      method: 'PROPFIND',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
      }
    };

    return new Promise((resolve, reject) => {
      const client = targetUrl.protocol === 'http:' ? http : https;
      
      const req = client.request(targetUrl, options, (res) => {
        // check for success status code
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`auth failed with status ${res.statusCode}`));
        }
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  // upload file using stream pipe
  async uploadStream(fileStream, metadata, credentials) {
    const { url, user, pass } = credentials;
    // construct target url
    const targetUrlString = `${url}/remote.php/dav/files/${user}/${metadata.name}`;
    const targetUrl = new URL(targetUrlString);

    const options = {
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      }
    };

    return new Promise((resolve, reject) => {
      const client = targetUrl.protocol === 'http:' ? http : https;

      const req = client.request(targetUrl, options, (res) => {
        // handle response
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            id: targetUrlString,
            webViewLink: targetUrlString
          });
        } else {
          reject(new Error(`upload failed with status ${res.statusCode}`));
        }
      });

      req.on('error', (err) => {
        reject(err);
      });

      // pipe stream to request
      fileStream.pipe(req);
    });
  }
}

module.exports = NextcloudProvider;