class CloudProvider {
  constructor() {
    if (this.constructor === CloudProvider) {
      throw new Error("abstract class cannot be instantiated");
    }
  }

  // generate auth url for oauth flow
  getAuthUrl(callbackUrl, state) {
    throw new Error("method 'getAuthUrl' must be implemented");
  }

  // exchange code for token
  async getTokenFromCode(code, redirectUri) {
    throw new Error("method 'getTokenFromCode' must be implemented");
  }

  // verify direct credentials (e.g. nextcloud)
  async verifyCredentials(params) {
    throw new Error("method 'verifyCredentials' must be implemented");
  }

  // upload file stream
  // returns { id, webViewLink, ... }
  async uploadStream(fileStream, metadata, tokenOrCredentials) {
    throw new Error("method 'uploadStream' must be implemented");
  }

  // delete file
  async deleteFile(fileId, tokenOrCredentials) {
    throw new Error("method 'deleteFile' must be implemented");
  }
}

module.exports = CloudProvider;