const fs = require('fs');
const path = require('path');
const CloudProvider = require('../CloudProvider');

class LocalProvider extends CloudProvider {
  constructor() {
    super();
    // base upload dir
    this.baseDir = process.env.UPLOAD_DIR || './uploads';
    // target deposits dir
    this.depositsDir = path.join(this.baseDir, 'deposits');
    
    // ensure deposits dir exists
    if (!fs.existsSync(this.depositsDir)) {
      fs.mkdirSync(this.depositsDir, { recursive: true });
    }
  }

  getAuthUrl(callbackUrl, state) { return null; }

  async getTokenFromCode(code, redirectUri) { return null; }

  // always valid
  async verifyCredentials(params) {
    return true; 
  }

  // no folder creation needed for flat structure
  async createFolder(folderPath, tokenOrCredentials) {
    return null;
  }

  // save with random name
  async uploadStream(fileStream, metadata, tokenOrCredentials) {
    // generate random encrypted name
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const encryptedName = 'local-dep-' + suffix;
    
    const filePath = path.join(this.depositsDir, encryptedName);
    const writeStream = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
      fileStream.pipe(writeStream);
      
      writeStream.on('finish', () => {
        // return encrypted name as id, no url
        resolve({ 
          id: encryptedName, 
          webViewLink: null 
        });
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    });
  }

  // read from deposits dir
  async getDownloadStream(fileId, tokenOrCredentials) {
    const filePath = path.join(this.depositsDir, fileId);
    if (!fs.existsSync(filePath)) {
      throw new Error("file not found");
    }
    return fs.createReadStream(filePath);
  }

  // delete from deposits dir
  async deleteFile(fileId, tokenOrCredentials) {
    const filePath = path.join(this.depositsDir, fileId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = LocalProvider;