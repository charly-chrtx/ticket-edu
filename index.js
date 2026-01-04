require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const db = require('./database');
const url = require('url');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const cloudManager = require('./cloud_session');
const crypto = require('crypto');
const CloudProvider = require('./CloudProvider');
const GoogleProvider = require('./CloudProviders/GoogleProvider');
const OneDriveProvider = require('./CloudProviders/OneDriveProvider');
const NextcloudProvider = require('./CloudProviders/NextcloudProvider');
const LocalProvider = require('./CloudProviders/LocalProvider');
cloudManager.registerProvider('google', new GoogleProvider());
cloudManager.registerProvider('onedrive', new OneDriveProvider());
cloudManager.registerProvider('nextcloud', new NextcloudProvider());
cloudManager.registerProvider('local', new LocalProvider());


// ai filter
const { checkTicketSafety, getAiStatus, setAiStatusCallback } = require('./ai_filter');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://charly-chrtx.github.io", //Github pages
  "https://ticket-edu.com", // Production
  process.env.FRONT_URL,
  process.env.BASE_URL
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("CORS blocked:", origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// public assets
app.use(express.static('public'));

// env config
const MAX_GLOBAL_STORAGE = (parseInt(process.env.MAX_STORAGE_MO) || 10000) * 1024 * 1024;
const DEPOT_EXPIRATION = (parseInt(process.env.DEPOT_FILE_EXPIRATION_HOURS) || 24) * 60 * 60 * 1000;
const CLOUD_BASE_PATH = process.env.CLOUD_BASE_PATH || 'Ticket-Edu';

// settings
let globalSettings = {
  maxRooms: 50,
  maxStoragePerRoom: 1.25 * 1024 * 1024 * 1024 // default 1.25gb per room
};

const ENABLE_REPORT = process.env.REPORT === 'true';
const REPORT_DIR = process.env.REPORT_DIR || './reports';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const PATH_ANN = path.join(UPLOAD_DIR, 'announcements');
const PATH_DEP = path.join(UPLOAD_DIR, 'deposits');

// ensure dir
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
if (!fs.existsSync(PATH_ANN)) {
  fs.mkdirSync(PATH_ANN);
}
if (!fs.existsSync(PATH_DEP)) {
  fs.mkdirSync(PATH_DEP);
}
if (ENABLE_REPORT && !fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR);
}

// helper to clean names
function normalize(str) {
  return str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_");
}

// cloud status
app.get('/api/cloud/status', (req, res) => {
  const sessionId = req.cookies.sessionID;
  const roomCode = req.query.roomCode;

  const userSession = cloudManager.getSession(sessionId);

  const roomSession = roomCode ? cloudManager.getRoomToken(roomCode) : null;

  const activeSession = roomSession || userSession;

  if (activeSession) {
    res.json({ connected: true, provider: activeSession.provider });
  } else {
    res.json({ connected: false });
  }
});

// cloud handshake 
app.post('/api/cloud/handshake', async (req, res) => {
  const { roomCode, cryptoKey, provider, authData, basePath } = req.body;

  if (!roomCode || !cryptoKey || !provider) {
    return res.status(400).json({ error: "missing fields" });
  }

// local bypass
  if (provider === 'local') { 
    cloudManager.setRoomKey(roomCode, cryptoKey);
    cloudManager.setRoomToken(roomCode, {
      provider: 'local',
      token: 'local_token',
      basePath: basePath || 'Ticket-Edu',
      email: roomCode
    });
    return res.json({ connected: true });
  }

  // store key in ram
  cloudManager.setRoomKey(roomCode, cryptoKey);

  const providerInstance = cloudManager.getProvider(provider);
  if (!providerInstance) {
    return res.status(400).json({ error: "provider not supported" });
  }

  try {
    if (provider === 'nextcloud') {

      if (authData.url) {
        const flowData = await providerInstance.startLoginFlow(authData.url);

        // return poll info to client
        return res.json({
          action: "poll_required",
          loginUrl: flowData.login,
          poll: flowData.poll
        });
      }

      else {
        return res.status(400).json({ error: "URL requise pour l'authentification Nextcloud" });
      }
    }

    // oauth flow (google)
    if (provider === 'google') {
      const state = JSON.stringify({ roomCode, basePath });
      const callbackUrl = `${process.env.BASE_URL}/api/cloud/callback/google`;
      const url = providerInstance.getAuthUrl(callbackUrl, state);
      return res.json({ redirectUrl: url });
    }

  } catch (e) {
    console.error("handshake error", e);
    return res.status(500).json({ error: e.message });
  }
});

//poll nextcloud
app.post('/api/cloud/nextcloud/poll', async (req, res) => {
  const { token, endpoint, roomCode, basePath, serverUrl } = req.body;
  const providerInstance = cloudManager.getProvider('nextcloud');

  if (!providerInstance) return res.status(500).json({ error: "provider missing" });

  try {
    // check status
    const result = await providerInstance.pollCredentials(token, endpoint);

    // success (got credentials)
    if (result && result.loginName && result.appPassword) {

      const authData = {
        url: serverUrl,
        user: result.loginName,
        pass: result.appPassword,
        email: result.loginName
      };

      // save session
      let sessionId = req.cookies.sessionID;
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        res.cookie('sessionID', sessionId, { httpOnly: true });
      }

      cloudManager.setSession(sessionId, {
        provider: 'nextcloud',
        token: authData,
        email: result.loginName
      });

      if (roomCode) {
        cloudManager.setRoomToken(roomCode, {
          provider: 'nextcloud',
          token: authData,
          basePath: basePath
        });
      }

      return res.json({ status: "success", user: result.loginName });
    }

    // pending or waiting
    else {
      return res.json({ status: "pending" });
    }

  } catch (e) {
    console.error("poll error", e);
    return res.status(500).json({ error: e.message });
  }
});

// cloud callback
app.get('/api/cloud/callback/:provider', async (req, res) => {
  const { code, state } = req.query;
  const providerName = req.params.provider;

  const providerInstance = cloudManager.getProvider(providerName);
  if (!providerInstance) return res.status(400).send("unknown provider");

  try {
    const callbackUrl = `${process.env.BASE_URL}/api/cloud/callback/${providerName}`;
    const tokenData = await providerInstance.getTokenFromCode(code, callbackUrl);

    // parse state to get roomCode and basePath
    let roomCode = null;
    let basePath = null;
    try {
      if (state) {
        const parsedState = JSON.parse(state);
        roomCode = parsedState.roomCode;
        basePath = parsedState.basePath;
      }
    } catch (e) { }

    // create session
    let sessionId = req.cookies.sessionID;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      res.cookie('sessionID', sessionId, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    }

    cloudManager.setSession(sessionId, {
      provider: providerName,
      token: tokenData,
      email: tokenData.email || 'oauth-user'
    });

    // save token for the room if code exists
    if (roomCode) {
      cloudManager.setRoomToken(roomCode, {
        provider: providerName,
        token: tokenData,
        basePath: basePath
      });
    }

    res.redirect(process.env.FRONT_URL + '?cloud=success');
  } catch (e) {
    console.error("callback error", e);
    res.redirect('/?error=cloud_auth_failed');
  }
});

// cloud disconnect
app.post('/api/cloud/disconnect', (req, res) => {
  const { roomCode } = req.body;

  if (roomCode) {
    // delete room data
    cloudManager.deleteRoomKey(roomCode);
    cloudManager.deleteRoomToken(roomCode);
  }

  const sessionId = req.cookies.sessionID;
  if (sessionId) {
    cloudManager.deleteSession(sessionId);
    res.clearCookie('sessionID');
  }

  res.json({ message: "Cloud disconnected" });
});

// helper to get providers
function getActiveProviders() {
  const providers = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) providers.push('google');
  if (process.env.ONEDRIVE_CLIENT_ID) providers.push('onedrive');
  if (process.env.NEXTCLOUD_ENABLE === 'true') providers.push('nextcloud');
  if (process.env.TICKET_CLOUD_ENABLE === 'true') providers.push('local');
  return providers;
}
app.get('/api/cloud/config', (req, res) => {
  res.json(getActiveProviders());
});

// csv helper
function parseAndSearchCsv(fileContent, query, usedNames = []) {
  const lines = fileContent.split(/\r?\n/);

  // clean and filter
  const validEntries = lines
    .map(line => line.split(';')[0])
    .map(text => text ? text.trim() : '')
    .filter(text => {
      if (!text) return false;
      if (text.includes('Élèves')) return false;
      if (text.includes('Encouragement')) return false;
      return true;
    });

  // parse names
  const parsedData = validEntries.map(fullName => {
    const parts = fullName.split(/\s+/);
    const firstname = parts.pop();
    const surname = parts.join(' ');
    const initial = surname.charAt(0);
    return `${firstname} ${initial}.`;
  });

  // filter used
  const availableData = parsedData.filter(name => !usedNames.includes(name));

  if (!query) return [];

  return availableData.filter(name =>
    name.toLowerCase().includes(query.toLowerCase())
  );
}

// multer storage dynamic
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // route-based destination
    if (req.originalUrl.includes('announcements')) cb(null, PATH_ANN);
    else if (req.originalUrl.includes('deposits')) cb(null, PATH_DEP);
    else cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'file-' + suffix);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_GLOBAL_STORAGE } });

// upload errors
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file too large for server storage' });
    }
  }
  next(err);
});


// generate code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// update activity
function updateRoomActivity(roomCode) {
  const now = new Date().toISOString();
  db.run("UPDATE rooms SET lastActivity = ? WHERE code = ?", [now, roomCode]);
}

// ai validation
async function validateContent(text) {
  if (!getAiStatus()) return true;

  console.log(`analysing: ${text.substring(0, 20)}...`);
  const analysis = await checkTicketSafety(text);

  if (analysis.skipped) return true;
  if (analysis.is_unsafe) return false;
  return true;
}

// map stores { code, studentName, userId }
const clientRooms = new Map();

wss.on('connection', async (ws, req) => {
  const parameters = url.parse(req.url, true);
  const roomCode = parameters.query.room;
  const type = parameters.query.type;
  const userId = parameters.query.userId;
  const requestedName = parameters.query.name;

  // admin check
  if (!roomCode && type === 'admin') {
    ws.isAdmin = true;
    return;
  }

  // client check
  if (!roomCode) {
    ws.close();
    return;
  }

  // validation for csv mode
  db.get("SELECT csvFilePath, forceName FROM rooms WHERE code = ?", [roomCode], (err, room) => { // AJOUT forceName
    if (err || !room) {
      ws.close();
      return;
    }

    // if csv active, validate name
    if (room.csvFilePath || room.forceName === 1) {
      if (!requestedName) {
        ws.close(1008, "name required");
        return;
      }

      // check if name taken
      const isTaken = [...clientRooms.values()].some(c =>
        c.code === roomCode && c.studentName === requestedName && c.userId !== userId
      );

      if (isTaken) {
        ws.close(1008, "name taken");
        return;
      }

      // check in csv if applicable
      if (room.csvFilePath) {
        try {
          const content = fs.readFileSync(path.join(UPLOAD_DIR, room.csvFilePath), 'utf8');
          const matches = parseAndSearchCsv(content, requestedName, []);
          const exists = matches.some(n => n === requestedName);

          if (!exists) {
            ws.close(1008, "invalid name");
            return;
          }
        } catch (e) {
          console.log("csv read error", e);
          ws.close(1011, "server error");
          return;
        }
      }
    }

    ws.isAlive = true;
    ws.roomCode = roomCode;
    ws.studentName = requestedName;
    ws.userId = userId;

    clientRooms.set(ws, {
      code: roomCode,
      studentName: requestedName,
      userId: userId
    });

    ws.on('pong', () => ws.isAlive = true);

    ws.on('close', () => {
      clientRooms.delete(ws);
    });

    ws.on('error', () => {
      clientRooms.delete(ws);
    });
  });
});

// ai status listener
setAiStatusCallback((isHealthy) => {
  console.log(`ai global status: ${isHealthy ? 'online' : 'offline'}`);
  const message = JSON.stringify({ type: 'update', timestamp: Date.now() });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// notify clients
function notifierClients(roomCode, type = 'update', payload = {}) {
  const message = JSON.stringify({ type, timestamp: Date.now(), ...payload });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.roomCode === roomCode) {
      client.send(message);
    }
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/access', (req, res) => {
  const password = req.body.password;

  if (password === process.env.ADMIN_PASSWORD) {
    const dashboardPath = path.join(__dirname, 'private', 'index.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
      if (err) return res.status(500).send('error loading dashboard');
      res.send(data);
    });
  } else {
    res.redirect('/');
  }
});

app.get('/api/admin/dashboard', (req, res) => {
  db.all("SELECT code, createdAt, lastActivity FROM rooms", [], (err, rooms) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT roomCode, SUM(size) as totalSize FROM files GROUP BY roomCode", [], (err, filesRows) => {
      if (err) return res.status(500).json({ error: err.message });

      const sizeMap = {};
      filesRows.forEach(row => sizeMap[row.roomCode] = row.totalSize);
      const onlineMap = {};
      let totalOnline = 0;
      wss.clients.forEach(client => {
        if (client.roomCode) {
          onlineMap[client.roomCode] = (onlineMap[client.roomCode] || 0) + 1;
          totalOnline++;
        }
      });

      const enrichedRooms = rooms.map(room => ({
        code: room.code,
        createdAt: room.createdAt,
        storageUsed: sizeMap[room.code] || 0,
        usersOnline: onlineMap[room.code] || 0
      }));

      // get global storage usage
      db.get("SELECT SUM(size) as totalGlobal FROM files", [], (err, row) => {
        const globalUsed = row ? row.totalGlobal || 0 : 0;

        res.json({
          settings: globalSettings,
          stats: {
            totalPeople: totalOnline,
            totalGroups: rooms.length,
            storageUsed: globalUsed,
            storageLimit: MAX_GLOBAL_STORAGE
          },
          rooms: enrichedRooms
        });
      });
    });
  });
});

app.put('/api/admin/settings', (req, res) => {
  const { maxRooms, maxStorageGB } = req.body;

  if (maxRooms) globalSettings.maxRooms = parseInt(maxRooms);
  // updating per room limit
  if (maxStorageGB) globalSettings.maxStoragePerRoom = parseFloat(maxStorageGB) * 1024 * 1024 * 1024;

  res.json(globalSettings);
});

// create room
app.post('/api/rooms', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'user id required' });

  db.get("SELECT count(*) as count FROM rooms", [], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });

    if (result && result.count >= globalSettings.maxRooms) {
      return res.status(403).json({ error: 'server full' });
    }

    const code = generateRoomCode();
    const now = new Date().toISOString();
    const defaultAiState = getAiStatus() ? 1 : 0;

    db.run(`INSERT INTO rooms (code, adminId, lastActivity, createdAt, maxTickets, aiEnabled, csvFilePath) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, userId, now, now, 1, defaultAiState, null],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ code, adminId: userId });
      }
    );
  });
});

// get room data
app.get('/api/rooms/:code', (req, res) => {
  const userId = req.query.userId;
  const roomCode = req.params.code;

  db.get(
    "SELECT code, adminId, maxTickets, aiEnabled, csvFilePath, forceName, createdAt FROM rooms WHERE code = ?",
    [roomCode],
    (err, room) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!room) return res.status(404).json({ error: "room not found" });

      if (!room.maxTickets) room.maxTickets = 1;

      room.reportEnabled = ENABLE_REPORT;

      // ai global status
      const isGlobalOnline = getAiStatus();
      room.aiEnabled = (room.aiEnabled === 1) && isGlobalOnline;

      room.forceName = room.forceName === 1;

      room.hasCsv = !!room.csvFilePath;
      delete room.csvFilePath;

      const isAdmin = userId && room.adminId === userId;
      room.isAdmin = isAdmin;
      delete room.adminId;

      // users online
      const usersOnline = [...clientRooms.values()]
        .filter(c => c.code === roomCode).length;
      
      room.usersOnline = usersOnline;
      room.connectedCount = usersOnline; 

      // storage used
      db.get(
        "SELECT SUM(size) as total FROM files WHERE roomCode = ?",
        [roomCode],
        (err, row) => {
          if (err) return res.status(500).json({ error: err.message });

          const storageUsed = row?.total || 0;

          room.storage = {
            used: storageUsed,
            max: globalSettings.maxStoragePerRoom
          };

          res.json(room);
        }
      );
    }
  );
});


// upload csv
app.post('/api/rooms/:code/csv', upload.single('file'), (req, res) => {
  const roomCode = req.params.code;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "missing file" });

  try {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      throw new Error("invalid extension");
    }

    const content = fs.readFileSync(file.path, 'utf8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

    if (lines.length === 0) {
      throw new Error("empty file");
    }

    const hasDelimiter = lines.some(line => line.includes(';'));
    if (!hasDelimiter) {
      throw new Error("missing semicolon delimiter");
    }

  } catch (e) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "invalid csv format or extension" });
  }

  db.run("UPDATE rooms SET csvFilePath = ? WHERE code = ?", [file.filename, roomCode], (err) => {
    if (err) {
      fs.unlinkSync(file.path);
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: "csv enabled" });
  });
});

// delete csv
app.delete('/api/rooms/:code/csv', (req, res) => {
  const roomCode = req.params.code;

  db.get("SELECT csvFilePath FROM rooms WHERE code = ?", [roomCode], (err, room) => {
    if (err) return res.status(500).json({ error: err.message });
    if (room && room.csvFilePath) {
      const p = path.join(UPLOAD_DIR, room.csvFilePath);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    db.run("UPDATE rooms SET csvFilePath = NULL WHERE code = ?", [roomCode], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "csv disabled" });
    });
  });
});

// check name usage
app.post('/api/rooms/:code/check-name', (req, res) => {
  const roomCode = req.params.code;
  const { nameQuery } = req.body;

  // get active names
  const activeNames = [];
  for (let [ws, data] of clientRooms) {
    if (data.code === roomCode && data.studentName) {
      activeNames.push(data.studentName);
    }
  }

  // check if name is taken (online)
  const isTaken = activeNames.some(n => n.toLowerCase() === nameQuery.toLowerCase());
  if (isTaken) {
    return res.json({ status: 'taken' });
  }

  db.get("SELECT csvFilePath FROM rooms WHERE code = ?", [roomCode], (err, room) => {
    // if no csv, just validated it wasn't taken above (if forceName is on)
    if (err || !room || !room.csvFilePath) return res.status(400).json({ error: "csv not active" });

    const p = path.join(UPLOAD_DIR, room.csvFilePath);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "file missing" });

    const content = fs.readFileSync(p, 'utf8');

    // parse csv but we already checked duplicates above, so passed list is empty for filter
    const results = parseAndSearchCsv(content, nameQuery, []);

    // exact match check in csv results
    const exactMatch = results.find(r => r.toLowerCase() === nameQuery.toLowerCase());

    if (exactMatch) return res.json({ status: 'found', name: exactMatch });
    if (results.length === 0) return res.json({ status: 'none' });

    return res.json({ status: 'multiple', options: results });
  });
});

// update settings
app.put('/api/rooms/:code', (req, res) => {
  const roomCode = req.params.code;
  const { maxTickets, aiEnabled, forceName } = req.body;

  let fields = [];
  let values = [];
  let updatePayload = {};

  if (maxTickets !== undefined) {
    fields.push("maxTickets = ?");
    values.push(maxTickets);
    updatePayload.refreshSettings = true;
  }

  if (aiEnabled !== undefined) {
    fields.push("aiEnabled = ?");
    values.push(aiEnabled ? 1 : 0);
    updatePayload.refreshSettings = true;
  }

  if (forceName !== undefined) {
    fields.push("forceName = ?");
    values.push(forceName ? 1 : 0);
    updatePayload.refreshSettings = true;
  }

  if (fields.length === 0) return res.status(400).json({ error: "no fields" });

  values.push(roomCode);

  const sql = `UPDATE rooms SET ${fields.join(", ")} WHERE code = ?`;

  db.run(sql, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });

    notifierClients(roomCode, 'update', updatePayload);
    res.json({ message: "settings updated", maxTickets, aiEnabled, forceName });
  });
});

// get tickets
app.get('/api/tickets/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode;
  db.all("SELECT * FROM tickets WHERE roomCode = ? ORDER BY dateCreation DESC", [roomCode], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// create ticket
app.post('/api/tickets', (req, res) => {
  let { nom, description, couleur, etat, userId, roomCode } = req.body;
  if (!nom || !userId || !roomCode) return res.status(400).json({ error: 'missing fields' });

  db.get("SELECT maxTickets, aiEnabled, csvFilePath, forceName FROM rooms WHERE code = ?", [roomCode], async (err, room) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!room) return res.status(404).json({ error: "room not found" });

    if (room.csvFilePath || room.forceName === 1) {
      const sessions = [...clientRooms.values()].filter(c =>
        c.code === roomCode && c.userId === userId
      );
      const session = sessions.find(s => s.studentName) || sessions[0];
      if (!session || !session.studentName) {
        return res.status(403).json({ error: "session invalid" });
      }
      nom = session.studentName;
    }

    if (room.aiEnabled === 1) {
      const combinedText = `${nom} ${description || ''}`;
      const isSafe = await validateContent(combinedText);
      if (!isSafe) return res.status(400).json({ error: "blocked by ai" });
    }

    const limit = room.maxTickets || 1;

    db.get("SELECT count(*) as count FROM tickets WHERE roomCode = ? AND userId = ? AND etat = 'en cours'",
      [roomCode, userId],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        if (result.count >= limit) {
          return res.status(403).json({ error: `limit reached` });
        }

        const id = Date.now().toString();
        const dateCreation = new Date().toISOString();

        db.run(`
          INSERT INTO tickets (id, nom, description, couleur, etat, dateCreation, userId, roomCode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [id, nom, description || '', couleur || '#cdcdcd', etat || 'en cours', dateCreation, userId, roomCode],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            updateRoomActivity(roomCode);
            notifierClients(roomCode);
            res.status(201).json({ id, nom, description, couleur, etat, dateCreation, userId, roomCode });
          });
      });
  });
});

// update ticket
app.put('/api/tickets/:id', (req, res) => {
  const { nom, description, couleur, etat, roomCode } = req.body;
  const id = req.params.id;

  db.get("SELECT roomCode FROM tickets WHERE id = ?", [id], (err, ticket) => {
    if (err || !ticket) return res.status(404).json({ error: "ticket not found" });

    const realRoomCode = ticket.roomCode;

    db.get("SELECT aiEnabled FROM rooms WHERE code = ?", [realRoomCode], async (err, room) => {
      if (err) return res.status(500).json({ error: err.message });

      if (room && room.aiEnabled === 1 && (nom || description)) {
        const combinedText = `${nom || ''} ${description || ''}`;
        const isSafe = await validateContent(combinedText);
        if (!isSafe) return res.status(400).json({ error: "blocked by ai" });
      }

      db.run(`
            UPDATE tickets SET
            nom = COALESCE(?, nom),
            description = COALESCE(?, description),
            couleur = COALESCE(?, couleur),
            etat = COALESCE(?, etat)
            WHERE id = ?
        `,
        [nom, description, couleur, etat, id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          updateRoomActivity(roomCode || realRoomCode);
          notifierClients(roomCode || realRoomCode);
          res.json({ id, nom, description, couleur, etat });
        });
    });
  });
});

// delete ticket
app.delete('/api/tickets/:id', (req, res) => {
  const { userId } = req.query;
  const id = req.params.id;

  db.get("SELECT t.*, r.adminId as roomAdminId FROM tickets t LEFT JOIN rooms r ON t.roomCode = r.code WHERE t.id = ?", [id], (err, ticket) => {
    if (!ticket) return res.status(404).json({ error: "ticket not found" });

    const isOwner = ticket.userId === userId;
    const isRoomAdmin = ticket.roomAdminId === userId;

    if (!isOwner && !isRoomAdmin) {
      return res.status(403).json({ error: "unauthorized" });
    }

    db.run("DELETE FROM tickets WHERE id = ?", [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      updateRoomActivity(ticket.roomCode);
      notifierClients(ticket.roomCode);
      res.json({ message: "ticket deleted" });
    });
  });
});

// post deposit (admin only)
app.post('/api/deposits', async (req, res) => {
  const { roomCode, userId, name, color, cloudProvider } = req.body;

  db.get("SELECT adminId FROM rooms WHERE code = ?", [roomCode], async (err, room) => {
    if (!room || room.adminId !== userId) return res.status(403).json({ error: "unauthorized" });

    const id = "dep_" + Date.now();
    let cloudAccount = null;
    let cloudPath = null;
    let cloudWebUrl = null;
    let tokenToUse = null;

    if (cloudProvider) {

      // handle local provider
      if (cloudProvider === 'local') { 
        // hide info for local
        cloudAccount = null;
        tokenToUse = 'local_token'; 
        cloudPath = null;
      }
      // handle external providers
      else {
        const roomSession = cloudManager.getRoomToken(roomCode);

        // logic to determine token
        if (roomSession && roomSession.provider === cloudProvider) {
          const userSession = cloudManager.getSession(req.cookies.sessionID);

          // prefer user session
          if (userSession && userSession.provider === cloudProvider) {
            cloudAccount = userSession.email;
            tokenToUse = userSession.token;
          } else if (roomSession.token) {
            // fallback to room admin
            cloudAccount = roomSession.token.email || 'Inconnu';
            tokenToUse = roomSession.token;
          }
          const rootPath = roomSession.basePath || process.env.CLOUD_BASE_PATH || 'Ticket-Edu';
          cloudPath = `${rootPath}/dépots/${roomCode}/${normalize(name)}`;
        }
      }

      // create folder logic (skip for local)
      if (tokenToUse && cloudPath && cloudProvider !== 'local') {
        try {
          const providerInstance = cloudManager.getProvider(cloudProvider);
          if (providerInstance) {
            cloudWebUrl = await providerInstance.createFolder(cloudPath, tokenToUse);
            console.log("folder created, url:", cloudWebUrl);

            // save token specifically for this deposit (RAM only)
            cloudManager.setDepositToken(id, {
              provider: cloudProvider,
              token: tokenToUse,
              email: cloudAccount
            });
          }
        } catch (e) {
          console.error("error creating cloud folder:", e.message);
        }
      }
    }

    db.run("INSERT INTO deposits (id, roomCode, name, color, cloudProvider, cloudAccount, cloudPath, cloudWebUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, roomCode, name, color || '#cdcdcd', cloudProvider || null, cloudAccount, cloudPath, cloudWebUrl, new Date().toISOString()],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        notifierClients(roomCode, 'update');
        res.status(201).json({ id, name, color, cloudProvider, cloudAccount, cloudPath, cloudWebUrl });
      }
    );
  });
});

// get deposits list
app.get('/api/rooms/:code/deposits', (req, res) => {
  const roomCode = req.params.code;

  // get deposits
  db.all("SELECT * FROM deposits WHERE roomCode = ?", [roomCode], (err, deposits) => {
    if (err) return res.status(500).json({ error: err.message });

    // get files for deposits
    db.all("SELECT * FROM files WHERE roomCode = ? AND depositId IS NOT NULL", [roomCode], (err, files) => {
      if (err) return res.status(500).json({ error: err.message });

      // map files to depositsch
      const result = deposits.map(d => {
        return {
          ...d,
          files: files.filter(f => f.depositId === d.id)
        };
      });

      res.json(result);
    });
  });
});

// upload file to deposit
app.post('/api/deposits/:id/upload', upload.single('file'), async (req, res) => {
  const depositId = req.params.id;
  const { userId, roomCode, customName } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: "no file" });

  db.get("SELECT cloudProvider, name FROM deposits WHERE id = ?", [depositId], async (err, deposit) => {
    // cleanup if deposit invalid
    if (err || !deposit) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(404).json({ error: "deposit not found" });
    }

    db.get("SELECT id FROM files WHERE depositId = ? AND userId = ?", [depositId, userId], async (err, existing) => {
      // prevent duplicates
      if (existing) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(403).json({ error: "already uploaded" });
      }

      // ai validation
      const isSafe = await validateContent(customName);
      if (!isSafe) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({ error: "blocked by ai" });
      }

      const ext = path.extname(file.originalname);
      let baseName = customName || path.basename(file.originalname, ext);
      const finalName = normalize(baseName) + ext;

      // check quota
      db.get("SELECT SUM(size) as total FROM files WHERE roomCode = ?", [roomCode], async (err, row) => {
        const current = row?.total || 0;
        if (current + file.size > globalSettings.maxStoragePerRoom) {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(413).json({ error: "quota exceeded" });
        }

        const fileId = "fdep_" + Date.now();
        let cloudFileId = null;
        let encryptedName = file.filename; // default local retention

        try {
          // handle cloud provider if present
          if (deposit.cloudProvider) {
            let session = cloudManager.getDepositToken(depositId);
            if (!session) session = cloudManager.getRoomToken(roomCode);
            
            // local bypass
            if (deposit.cloudProvider === 'local') {
              session = { provider: 'local', token: 'local_token' };
            }

            const provider = cloudManager.getProvider(deposit.cloudProvider);

            if (provider && session && session.provider === deposit.cloudProvider) {
              const fileStream = fs.createReadStream(file.path);
              const rootPath = session.basePath || CLOUD_BASE_PATH;
              
              // path ignored by local
              const folderPath = `${rootPath}/dépots/${roomCode}/${normalize(deposit.name)}`;

              const cloudMeta = {
                name: finalName,
                mimeType: file.mimetype,
                folderPath: folderPath,
                size: file.size
              };

              // upload stream
              const result = await provider.uploadStream(fileStream, cloudMeta, session.token);
              cloudFileId = result.id;

              // delete temp file
              if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
              }
              
              // handle local mapping
              if (deposit.cloudProvider === 'local') {
                // save as encrypted local
                encryptedName = result.id;
                cloudFileId = null;
              } else {
                encryptedName = null; // cloud only
              }

            } else {
              throw new Error("missing provider or session");
            }
          }
        } catch (e) {
          console.error("upload error", e);
          // cleanup local file if upload failed
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(500).json({ error: "upload failed" });
        }

        // db insert
        db.run(`INSERT INTO files (id, originalName, encryptedName, mimeType, size, roomCode, userId, depositId, cloudId)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fileId, finalName, encryptedName, file.mimetype, file.size, roomCode, userId, depositId, cloudFileId],
          (err) => {
            if (err) {
              if (encryptedName && fs.existsSync(file.path)) fs.unlinkSync(file.path);
              return res.status(500).json({ error: err.message });
            }
            notifierClients(roomCode, 'updateDeposit');
            res.status(201).json({ message: "uploaded" });
          }
        );
      });
    });
  });
});

// delete deposit
app.delete('/api/deposits/:id', (req, res) => {
  const { userId } = req.query;
  const depositId = req.params.id;

  db.get("SELECT d.*, r.adminId FROM deposits d JOIN rooms r ON d.roomCode = r.code WHERE d.id = ?", [depositId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "deposit not found" });
    if (row.adminId !== userId) return res.status(403).json({ error: "unauthorized" });

    db.all("SELECT encryptedName FROM files WHERE depositId = ?", [depositId], (err, files) => {
      if (files) {
        files.forEach(f => {
          const p = path.join(PATH_DEP, f.encryptedName);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
      }

      // cleanup cloud token
      cloudManager.deleteDepositToken(depositId);

      db.run("DELETE FROM files WHERE depositId = ?", [depositId], (err) => {
        db.run("DELETE FROM deposits WHERE id = ?", [depositId], (err) => {
          if (err) return res.status(500).json({ error: err.message });

          notifierClients(row.roomCode, 'updateAnnonce');
          res.json({ message: "deposit deleted" });
        });
      });
    });
  });
});


// get files
app.get('/api/files/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode;
  db.all("SELECT * FROM files WHERE roomCode = ?", [roomCode], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const usage = rows.reduce((acc, file) => acc + file.size, 0);
    res.json({
      files: rows,
      usage: usage,
      limit: globalSettings.maxStoragePerRoom
    });
  });
});

// upload file
app.post('/api/files', upload.single('file'), (req, res) => {
  const { roomCode, userId } = req.body;
  const file = req.file;

  if (!file || !roomCode || !userId) {
    if (file) fs.unlinkSync(file.path);
    return res.status(400).json({ error: 'missing data' });
  }

  // check total server storage first
  db.get("SELECT SUM(size) as totalGlobal FROM files", [], (err, globalRow) => {
    if (err) {
      fs.unlinkSync(file.path);
      return res.status(500).json({ error: err.message });
    }

    const currentGlobal = globalRow ? globalRow.totalGlobal || 0 : 0;
    if (currentGlobal + file.size > MAX_GLOBAL_STORAGE) {
      fs.unlinkSync(file.path);
      return res.status(413).json({ error: 'server storage full' });
    }

    // check room storage
    db.get("SELECT SUM(size) as totalRoom FROM files WHERE roomCode = ?", [roomCode], (err, row) => {
      if (err) {
        fs.unlinkSync(file.path);
        return res.status(500).json({ error: err.message });
      }

      const currentRoomUsage = row ? row.totalRoom || 0 : 0;

      if (currentRoomUsage + file.size > globalSettings.maxStoragePerRoom) {
        fs.unlinkSync(file.path);
        return res.status(413).json({ error: 'room quota exceeded' });
      }

      const id = Date.now().toString();

      db.run(`INSERT INTO files (id, originalName, encryptedName, mimeType, size, roomCode, userId)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, file.originalname, file.filename, file.mimetype, file.size, roomCode, userId],
        (err) => {
          if (err) {
            fs.unlinkSync(file.path);
            return res.status(500).json({ error: err.message });
          }

          updateRoomActivity(roomCode);
          notifierClients(roomCode, 'newFile', {
            file: { id, originalName: file.originalname, size: file.size, userId }
          });

          res.status(201).json({ message: 'file uploaded' });
        }
      );
    });
  });
});

app.get('/api/files/download/:fileId', (req, res) => {
  const fileId = req.params.fileId;

  // get file and provider info
  const query = `
    SELECT f.*, d.cloudProvider 
    FROM files f 
    LEFT JOIN deposits d ON f.depositId = d.id
    WHERE f.id = ?`;

  db.get(query, [fileId], async (err, file) => {
    if (err) return res.status(500).send('database error');
    if (!file) return res.status(404).send('file not found');

    // check consistency (allow local with null cloudId)
    const isLocal = file.cloudProvider === 'local';
    if ((!file.cloudId && !isLocal) || !file.cloudProvider) {
      return res.status(400).send('not a cloud file');
    }

    try {
      let tokenToUse = null;

      // bypass auth for local provider
      if (isLocal) {
        tokenToUse = 'local_token';
      } else {
        // try deposit token for external clouds
        if (file.depositId) {
          const depSession = cloudManager.getDepositToken(file.depositId);
          if (depSession && depSession.provider === file.cloudProvider) {
            tokenToUse = depSession.token;
          }
        }

        // try room or user token fallback
        if (!tokenToUse) {
          const roomSession = cloudManager.getRoomToken(file.roomCode);
          const userSession = cloudManager.getSession(req.cookies.sessionID);

          if (roomSession && roomSession.provider === file.cloudProvider) {
            tokenToUse = roomSession.token;
          } else if (userSession && userSession.provider === file.cloudProvider) {
            tokenToUse = userSession.token;
          }
        }
      }

      if (!tokenToUse) {
        return res.status(403).send('cloud auth missing');
      }

      const provider = cloudManager.getProvider(file.cloudProvider);
      if (!provider) return res.status(500).send('provider not found');

      // headers
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');

      // determine correct id to fetch (encryptedName for local, cloudId for others)
      const targetId = isLocal ? file.encryptedName : file.cloudId;

      // stream
      const stream = await provider.getDownloadStream(targetId, tokenToUse);
      stream.pipe(res);

    } catch (e) {
      console.error("download error:", e);
      if (!res.headersSent) res.status(500).send('download failed');
    }
  });
});

// delete file
app.delete('/api/files/:fileId', (req, res) => {
  const { userId } = req.query;
  const fileId = req.params.fileId;

  const query = `
    SELECT f.*, r.adminId as roomAdminId, d.cloudProvider 
    FROM files f 
    LEFT JOIN rooms r ON f.roomCode = r.code 
    LEFT JOIN deposits d ON f.depositId = d.id
    WHERE f.id = ?`;

  db.get(query, [fileId], async (err, file) => {
    if (!file) return res.status(404).json({ error: "file not found" });

    const isOwner = file.userId === userId;
    const isRoomAdmin = file.roomAdminId === userId;

    if (!isOwner && !isRoomAdmin) {
      return res.status(403).json({ error: "unauthorized" });
    }

    // cloud delete
    if (file.cloudId && file.cloudProvider) {
      let tokenToUse = null;

      // NEW: check deposit token first
      if (file.depositId) {
        const depSession = cloudManager.getDepositToken(file.depositId);
        if (depSession && depSession.provider === file.cloudProvider) {
          tokenToUse = depSession.token;
        }
      }

      if (!tokenToUse) {
        // get sessions fallback
        const roomSession = cloudManager.getRoomToken(file.roomCode);
        const userSession = cloudManager.getSession(req.cookies.sessionID);

        //room admin token
        if (roomSession && roomSession.provider === file.cloudProvider) {
          tokenToUse = roomSession.token;
        }
        //current user session
        else if (userSession && userSession.provider === file.cloudProvider) {
          tokenToUse = userSession.token;
        }
      }

      if (tokenToUse) {
        const provider = cloudManager.getProvider(file.cloudProvider);
        if (provider) {
          console.log(`deleting cloud file ${file.cloudId}...`);
          provider.deleteFile(file.cloudId, tokenToUse).catch(e => console.error("cloud delete error:", e));
        }
      } else {
        console.warn("cannot delete cloud file: no valid session found");
      }
    }

    // local delete
    let targetDir = UPLOAD_DIR;
    if (file.depositId) targetDir = PATH_DEP;
    else if (file.announcementId) targetDir = PATH_ANN;

    const filePath = path.join(targetDir, file.encryptedName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.run("DELETE FROM files WHERE id = ?", [fileId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      updateRoomActivity(file.roomCode);
      if (file.depositId) {
        notifierClients(file.roomCode, 'updateDeposit');
      } else {
        notifierClients(file.roomCode, 'updateAnnonce');
      }
      res.json({ message: "file deleted" });
    });
  });
});

// get announcement history
app.get('/api/announcements/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode;

  db.all("SELECT * FROM announcements WHERE roomCode = ? ORDER BY createdAt DESC", [roomCode], (err, annonces) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all("SELECT * FROM files WHERE roomCode = ? AND announcementId IS NOT NULL", [roomCode], (err, files) => {
      if (err) return res.status(500).json({ error: err.message });

      const result = annonces.map(a => {
        return {
          ...a,
          files: files.filter(f => f.announcementId === a.id)
        };
      });

      res.json(result);
    });
  });
});

// create announcement
app.post('/api/announcements', upload.array('files'), async (req, res) => {
  const { roomCode, userId, content, color } = req.body;
  const files = req.files || [];

  if ((!content || content.trim() === "") && files.length === 0) {
    files.forEach(f => fs.unlinkSync(f.path));
    return res.status(400).json({ error: "empty" });
  }

  // check room storage quota (announcements included)
  const incomingSize = files.reduce((acc, f) => acc + f.size, 0);

  db.get(
    "SELECT SUM(size) as total FROM files WHERE roomCode = ?",
    [roomCode],
    (err, row) => {
      if (err) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(500).json({ error: err.message });
      }

      const currentUsage = row?.total || 0;

      if (currentUsage >= globalSettings.maxStoragePerRoom ||
        currentUsage + incomingSize > globalSettings.maxStoragePerRoom) {
        files.forEach(f => fs.unlinkSync(f.path));
        return res.status(413).json({ error: "room quota exceeded" });
      }

      createAnnouncement();
    }
  );

  function createAnnouncement() {
    db.get(
      "SELECT adminId, aiEnabled FROM rooms WHERE code = ?",
      [roomCode],
      async (err, room) => {
        if (!room) {
          files.forEach(f => fs.unlinkSync(f.path));
          return res.status(404).json({ error: "room not found" });
        }

        if (room.adminId !== userId) {
          files.forEach(f => fs.unlinkSync(f.path));
          return res.status(403).json({ error: "unauthorized" });
        }

        // ai check
        if (room.aiEnabled === 1 && content) {
          const isSafe = await validateContent(content);
          if (!isSafe) {
            files.forEach(f => fs.unlinkSync(f.path));
            return res.status(400).json({ error: "blocked by ai" });
          }
        }

        const id = Date.now().toString();
        const now = new Date().toISOString();

        db.run(
          `INSERT INTO announcements (id, roomCode, userId, content, color, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, roomCode, userId, content || "", color || "#cdcdcd", now],
          (err) => {
            if (err) {
              files.forEach(f => fs.unlinkSync(f.path));
              return res.status(500).json({ error: err.message });
            }

            if (files.length > 0) {
              const stmt = db.prepare(
                `INSERT INTO files
                 (id, originalName, encryptedName, mimeType, size, roomCode, userId, announcementId)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              );

              files.forEach(f => {
                const fileId = Date.now().toString() + Math.round(Math.random() * 1000);
                stmt.run(
                  fileId,
                  f.originalname,
                  f.filename,
                  f.mimetype,
                  f.size,
                  roomCode,
                  userId,
                  id
                );
              });

              stmt.finalize();
            }

            updateRoomActivity(roomCode);
            notifierClients(roomCode, 'updateAnnonce');
            res.status(201).json({ message: "created" });
          }
        );
      }
    );
  }
});


// delete announcement file
app.delete('/api/announcements/:id/files/:fileId', (req, res) => {
  const { userId } = req.query
  const { id, fileId } = req.params

  const query = `
    select f.*, a.content, r.adminId, r.code as roomCode
    from files f
    join announcements a on f.announcementId = a.id
    join rooms r on a.roomCode = r.code
    where f.id = ? and a.id = ?
  `

  db.get(query, [fileId, id], (err, data) => {
    if (err) return res.status(500).json({ error: err.message })
    if (!data) return res.status(404).json({ error: "not found" })

    if (data.adminId !== userId) {
      return res.status(403).json({ error: "unauthorized" })
    }

    const filePath = path.join(PATH_ANN, data.encryptedName)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    db.run("delete from files where id = ?", [fileId], (err) => {
      if (err) return res.status(500).json({ error: err.message })

      // check if announcement is now empty
      db.get(
        "select count(*) as count from files where announcementId = ?",
        [id],
        (err, row) => {
          if (err) {
            updateRoomActivity(data.roomCode)
            notifierClients(data.roomCode, 'updateAnnonce')
            return res.json({ message: "file deleted" })
          }

          if (row.count === 0 && (!data.content || data.content.trim() === "")) {
            db.run(
              "delete from announcements where id = ?",
              [id],
              () => {
                updateRoomActivity(data.roomCode)
                notifierClients(data.roomCode, 'updateAnnonce')
                return res.json({ message: "file deleted", announcementDeleted: true })
              }
            )
            return
          }

          updateRoomActivity(data.roomCode)
          notifierClients(data.roomCode, 'updateAnnonce')
          res.json({ message: "file deleted" })
        }
      )
    })
  })
})

// delete announcement
app.delete('/api/announcements/:id', (req, res) => {
  const { userId } = req.query;
  const id = req.params.id;

  db.get("SELECT a.*, r.adminId as roomAdminId FROM announcements a JOIN rooms r ON a.roomCode = r.code WHERE a.id = ?", [id], (err, item) => {
    if (!item) return res.status(404).json({ error: "not found" });

    if (item.roomAdminId !== userId) return res.status(403).json({ error: "unauthorized" });
    db.all("SELECT * FROM files WHERE announcementId = ?", [id], (err, files) => {
      if (files) {
        files.forEach(f => {
          const p = path.join(PATH_ANN, f.encryptedName);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
      }

      db.run("DELETE FROM files WHERE announcementId = ?", [id], (err) => {
        db.run("DELETE FROM announcements WHERE id = ?", [id], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          updateRoomActivity(item.roomCode);
          notifierClients(item.roomCode, 'updateAnnonce');
          res.json({ message: "deleted" });
        });
      });
    });
  });
});

// report route
app.post('/api/report', (req, res) => {
  // check env var
  if (!ENABLE_REPORT) {
    return res.status(403).json({ error: "reporting disabled" });
  }

  const { logs, description, context, clientData, aiData } = req.body;

  // basic validation
  if (!logs && !description) {
    return res.status(400).json({ error: "empty report" });
  }

  const reportId = Date.now();
  const filename = `report-${reportId}.json`;
  const filePath = path.join(REPORT_DIR, filename);

  const reportContent = {
    id: reportId,
    timestamp: new Date().toISOString(),
    context: context || "unknown",
    description: description || "no description",
    aiContextData: aiData || null,
    clientData: clientData || {},
    logs: logs || []
  };

  // write file
  fs.writeFile(filePath, JSON.stringify(reportContent, null, 2), (err) => {
    if (err) {
      console.log("report write error", err);
      return res.status(500).json({ error: "server error" });
    }
    console.log(`new report received: ${filename}`);
    res.status(201).json({ message: "report saved", id: reportId });
  });
});

// auto cleanup tickets
function supprimerTicketsExpires() {
  const now = Date.now();
  const limitEnCours = 3 * 60 * 60 * 1000 + 10 * 60 * 1000;
  const limitTermine = 60 * 60 * 1000;

  db.all("SELECT * FROM tickets", [], (err, rows) => {
    if (err) return;
    rows.forEach(ticket => {
      const age = now - new Date(ticket.dateCreation).getTime();
      if ((ticket.etat === "en cours" && age > limitEnCours) ||
        (ticket.etat === "terminé" && age > limitTermine)) {

        db.run("DELETE FROM tickets WHERE id = ?", ticket.id);
        notifierClients(ticket.roomCode);
      }
    });
  });
}

// auto cleanup rooms
function supprimerRoomsInactives() {
  const now = Date.now();
  const inactiveLimit = 30 * 60 * 1000;

  db.all("SELECT * FROM rooms", [], (err, rooms) => {
    if (err) return;

    rooms.forEach(room => {
      const lastActivity = new Date(room.lastActivity || room.createdAt).getTime();
      const isInactive = (now - lastActivity) > inactiveLimit;

      if (isInactive) {
        db.get("SELECT count(*) as count FROM tickets WHERE roomCode = ?", [room.code], (err, row) => {
          if (row && row.count === 0) {
            db.all("SELECT * FROM files WHERE roomCode = ?", [room.code], (err, files) => {
              if (files) {
                files.forEach(f => {
                  // check if local file exists
                  if (!f.encryptedName) return;

                  let target = UPLOAD_DIR;
                  if (f.depositId) target = PATH_DEP;
                  else if (f.announcementId) target = PATH_ANN;

                  const p = path.join(target, f.encryptedName);
                  if (fs.existsSync(p)) fs.unlinkSync(p);
                });
                db.run("DELETE FROM files WHERE roomCode = ?", [room.code]);
              }

              if (room.csvFilePath) {
                const p = path.join(UPLOAD_DIR, room.csvFilePath);
                if (fs.existsSync(p)) fs.unlinkSync(p);
              }

              db.run("DELETE FROM announcements WHERE roomCode = ?", [room.code]);
              db.run("DELETE FROM rooms WHERE code = ?", room.code, () => {
                console.log(`room ${room.code} deleted`);
                notifierClients(null, 'adminUpdate');
              });
            });
          }
        });
      }
    });
  });
}

// auto cleanup deposits
function supprimerDepositsExpires() {
  const now = Date.now();

  db.all("SELECT * FROM deposits", [], (err, rows) => {
    if (err || !rows) return;

    rows.forEach(dep => {
      const age = now - new Date(dep.createdAt).getTime();
      if (age > DEPOT_EXPIRATION) {
        // find associated files
        db.all("SELECT encryptedName FROM files WHERE depositId = ?", [dep.id], (err, files) => {
          if (files) {
            files.forEach(f => {
              // skip cloud files
              if (!f.encryptedName) return;

              const p = path.join(PATH_DEP, f.encryptedName);
              if (fs.existsSync(p)) fs.unlinkSync(p);
            });
          }
          // delete entries
          db.run("DELETE FROM files WHERE depositId = ?", [dep.id]);
          // cleanup deposit token
          cloudManager.deleteDepositToken(dep.id);

          db.run("DELETE FROM deposits WHERE id = ?", [dep.id]);
          console.log(`deposit ${dep.id} expired and deleted`);
        });
      }
    });
  });
}

// intervals
setInterval(() => {
  supprimerTicketsExpires();
  supprimerRoomsInactives();
  supprimerDepositsExpires();
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`api running on ${PORT}`));

// print available cloud providers
const providers = getActiveProviders();
if (providers.length > 0) {
  console.log('available cloud providers:', providers.join(', '));
} else {
  console.log('no cloud providers configured');
}