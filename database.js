const sqlite3 = require('sqlite3').verbose();
const dbPath = process.env.DB_PATH || './tickets.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // tickets table
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

  // rooms table
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    adminId TEXT,
    lastActivity TEXT,
    createdAt TEXT,
    maxTickets INTEGER DEFAULT 1,
    aiEnabled INTEGER DEFAULT 0,
    csvFilePath TEXT
  )`, (err) => {
    if (!err) {
      db.run("ALTER TABLE rooms ADD COLUMN maxTickets INTEGER DEFAULT 1", () => { });
      db.run("ALTER TABLE rooms ADD COLUMN aiEnabled INTEGER DEFAULT 0", () => { });
      db.run("ALTER TABLE rooms ADD COLUMN csvFilePath TEXT", () => { });
      db.run("ALTER TABLE rooms ADD COLUMN forceName INTEGER DEFAULT 0", () => { });
    }
  });

  // announcements table
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    roomCode TEXT,
    userId TEXT,
    content TEXT,
    color TEXT,
    createdAt TEXT
  )`);

  // files table
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    encryptedName TEXT,
    mimeType TEXT,
    size INTEGER,
    roomCode TEXT,
    userId TEXT,
    announcementId TEXT,
    depositId TEXT,
    cloudId TEXT 
  )`); 

  // deposits table
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    roomCode TEXT,
    name TEXT,
    color TEXT,
    cloudProvider TEXT,
    createdAt TEXT
  )`);

  // update table
  db.serialize(() => {
    const cols = [
        {table: 'files', col: 'depositId'},
        {table: 'files', col: 'announcementId'},
        {table: 'deposits', col: 'color'},
        {table: 'deposits', col: 'cloudProvider'},
        {table: 'files', col: 'cloudId'}
    ];

    cols.forEach(item => {
        db.run(`alter table ${item.table} add column ${item.col} text`, err => {
            if (err && !err.message.includes("duplicate column")) console.error(err);
        });
    });
  });
});

module.exports = db;