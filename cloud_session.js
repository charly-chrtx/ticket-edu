const crypto = require('crypto');
const fs = require('fs');

// global maps (ram only)
// map: cookie_id -> { token, provider, email, ... }
const globalSessionMap = new Map();

// map: room_code -> { key: buffer }
const roomKeyMap = new Map();

// providers registry (to be filled by other devs)
const providers = {};

function registerProvider(name, instance) {
  providers[name] = instance;
}

function getProvider(name) {
  return providers[name];
}

// session helpers
function setSession(cookieId, data) {
  globalSessionMap.set(cookieId, data);
}

function getSession(cookieId) {
  return globalSessionMap.get(cookieId);
}

function deleteSession(cookieId) {
  globalSessionMap.delete(cookieId);
}

// key helpers
function setRoomKey(roomCode, rawKey) {
  // ensure key is buffer
  const keyBuffer = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey, 'hex');
  roomKeyMap.set(roomCode, { key: keyBuffer });
}

function getRoomKey(roomCode) {
  const data = roomKeyMap.get(roomCode);
  return data ? data.key : null;
}

function deleteRoomKey(roomCode) {
  roomKeyMap.delete(roomCode);
}

// decryption stream helper
// assumes iv is first 12 bytes of file
async function createDecryptedStream(filePath, key) {
  // read first 12 bytes for iv
  const fd = await fs.promises.open(filePath, 'r');
  const iv = Buffer.alloc(12);
  await fd.read(iv, 0, 12, 0);
  await fd.close();

  // create read stream skipping iv
  const input = fs.createReadStream(filePath, { start: 12 });
  
  // create decipher
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  
  // pipe
  return input.pipe(decipher);
}

module.exports = {
  globalSessionMap,
  roomKeyMap,
  registerProvider,
  getProvider,
  setSession,
  getSession,
  deleteSession,
  setRoomKey,
  getRoomKey,
  deleteRoomKey,
  createDecryptedStream
};