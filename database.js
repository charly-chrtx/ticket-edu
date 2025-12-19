const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./tickets.db');

db.serialize(() => {
  // create tickets table
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    nom TEXT,
    description TEXT,
    couleur TEXT,
    etat TEXT,
    dateCreation TEXT,
    userId TEXT,
    roomCode TEXT
  )`);

  // create rooms table
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    adminId TEXT,
    announcementMessage TEXT,
    announcementColor TEXT,
    lastActivity TEXT,
    createdAt TEXT,
    maxTickets INTEGER DEFAULT 1,
    aiEnabled INTEGER DEFAULT 0,
    csvFilePath TEXT
  )`, (err) => {
    if (!err) {
      db.run("ALTER TABLE rooms ADD COLUMN maxTickets INTEGER DEFAULT 1", () => {});
      db.run("ALTER TABLE rooms ADD COLUMN aiEnabled INTEGER DEFAULT 0", () => {}); 
      db.run("ALTER TABLE rooms ADD COLUMN csvFilePath TEXT", () => {}); // <--- new column
    }
  });

  // create announcements table
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    roomCode TEXT,
    userId TEXT,
    content TEXT,
    color TEXT,
    createdAt TEXT
  )`);

  // create files table
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    encryptedName TEXT,
    mimeType TEXT,
    size INTEGER,
    roomCode TEXT,
    userId TEXT,
    announcementId TEXT
  )`, (err) => {
    if (!err) {
      db.run("ALTER TABLE files ADD COLUMN announcementId TEXT", () => {});
    }
  });
});

module.exports = db;