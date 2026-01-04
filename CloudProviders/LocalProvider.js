const fs = require('fs');
const path = require('path');
const CloudProvider = require('../CloudProvider');

class LocalProvider extends CloudProvider {
  constructor() {
    super();
    // use env var or default
    this.baseDir = process.env.UPLOAD_DIR || './uploads';
  }

  getAuthUrl(callbackUrl, state) { return null; }

  async getTokenFromCode(code, redirectUri) { return null; }

  // always valid for local
  async verifyCredentials(params) {
    return true; 
  }

  // create local folder
  async createFolder(folderPath, tokenOrCredentials) {
    const fullPath = path.join(this.baseDir, folderPath);
    
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    
    // return relative path as url
    return folderPath;
  }

  // save stream to disk
  async uploadStream(fileStream, metadata, tokenOrCredentials) {
    const folderPath = metadata.folderPath ? path.join(this.baseDir, metadata.folderPath) : this.baseDir;
    
    // ensure dir exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const filePath = path.join(folderPath, metadata.name);
    const writeStream = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
      fileStream.pipe(writeStream);
      
      writeStream.on('finish', () => {
        resolve({ 
          id: filePath, 
          webViewLink: filePath 
        });
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    });
  }

  // read stream from disk
  async getDownloadStream(fileId, tokenOrCredentials) {
    if (!fs.existsSync(fileId)) {
      throw new Error("file not found");
    }
    return fs.createReadStream(fileId);
  }

  // delete local file
  async deleteFile(fileId, tokenOrCredentials) {
    if (fs.existsSync(fileId)) {
      fs.unlinkSync(fileId);
    }
  }
}

module.exports = LocalProvider;