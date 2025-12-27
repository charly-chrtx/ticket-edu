const crypto = require('crypto');
const fs = require('fs');
const roomTokenMap = new Map();

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

function setRoomToken(roomCode, tokenData) {
  roomTokenMap.set(roomCode, tokenData);
}

function getRoomToken(roomCode) {
  return roomTokenMap.get(roomCode);
}

// decryption stream helper
async function createDecryptedStream(filePath, key) {
  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;

  if (fileSize < 28) {
    throw new Error("File too small to be encrypted");
  }

  const fd = await fs.promises.open(filePath, 'r');

  const iv = Buffer.alloc(12);
  await fd.read(iv, 0, 12, 0);


  const authTag = Buffer.alloc(16);
  await fd.read(authTag, 0, 16, fileSize - 16);

  await fd.close();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);


  const input = fs.createReadStream(filePath, { start: 12, end: fileSize - 17 });

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
  createDecryptedStream,
  setRoomToken,
  getRoomToken
};