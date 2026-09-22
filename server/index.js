import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  applyAction,
  kickPlayer,
  leaveRoom,
  privateView,
  publicView,
  startHand,
  throwItem,
  validateRoomState,
} from '../supabase/functions/game-action/gameEngine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'river-poker.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS poker_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    chips INTEGER NOT NULL DEFAULT 1000,
    avatar_url TEXT,
    dealer_image_url TEXT
  );
  CREATE TABLE IF NOT EXISTS poker_rooms (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_name TEXT NOT NULL,
    player_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'waiting',
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS poker_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_poker_messages_room_time ON poker_messages(room_code, created_at);
`);

const roomColumns = db.prepare('PRAGMA table_info(poker_rooms)').all().map(row => row.name);
if (!roomColumns.includes('version')) {
  db.exec('ALTER TABLE poker_rooms ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}

const sseClients = new Set();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function broadcast(table, event, row, old = null) {
  const payload = JSON.stringify({ table, event, new: row || null, old });
  for (const res of sseClients) {
    try { res.write(`event: change\ndata: ${payload}\n\n`); }
    catch { sseClients.delete(res); }
  }
}

function columnsFor(table, select) {
  if (!select || select === '*') return '*';
  const allowed = {
    poker_users: new Set(['username','password_hash','chips','avatar_url','dealer_image_url']),
    poker_rooms: new Set(['code','name','host_name','player_count','status','updated_at','state','version']),
    poker_messages: new Set(['id','room_code','username','text','created_at']),
  }[table];
  if (!allowed) throw new Error('unknown table');
  return select.split(',').map(x => x.trim()).filter(x => allowed.has(x)).join(',') || '*';
}

function safeColumn(table, column) {
  const allowed = {
    poker_users: ['username','password_hash','chips','avatar_url','dealer_image_url'],
    poker_rooms: ['code','name','host_name','player_count','status','updated_at','state','version'],
    poker_messages: ['id','room_code','username','text','created_at'],
  }[table];
  if (!allowed?.includes(column)) throw new Error('invalid column');
  return column;
}

function buildWhere(url, table) {
  const clauses = [];
  const values = [];
  for (const [key, value] of url.searchParams) {
    if (key === 'eq' || key === 'neq') {
      const i = value.indexOf(':');
      if (i > 0) {
        const column = safeColumn(table, value.slice(0, i));
        clauses.push(`${column} ${key === 'eq' ? '=' : '!='} ?`);
        values.push(value.slice(i + 1));
      }
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}

function getRows(table, url) {
  const { sql: where, values } = buildWhere(url, table);
  let sql = `SELECT ${columnsFor(table, url.searchParams.get('select'))} FROM ${table}${where}`;
  const order = url.searchParams.get('order');
  if (order) {
    const [column, direction] = order.split('.');
    sql += ` ORDER BY ${safeColumn(table, column)} ${direction === 'asc' ? 'ASC' : 'DESC'}`;
  }
  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) sql += ` LIMIT ${Math.min(limit, 500)}`;
  return db.prepare(sql).all(...values);
}

function tableExists(table) {
  return ['poker_users','poker_rooms','poker_messages'].includes(table);
}

function publicRow(table, row) {
  if (!row) return null;
  if (table === 'poker_rooms') {
    return { ...row, state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state };
  }
  return row;
}

function readRoom(code) {
  const row = db.prepare('SELECT code,state,version,updated_at FROM poker_rooms WHERE code=?').get(code);
  if (!row) throw new Error('ROOM_NOT_FOUND');
  return {
    ...row,
    state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
  };
}

function writeRoom(code, state, expectedVersion, expectedUpdatedAt = '') {
  validateRoomState(state);
  const nextVersion = Number(expectedVersion) + 1;
  const nextUpdatedAt = new Date(
    Math.max(Date.now(), (Date.parse(expectedUpdatedAt || '') || 0) + 1)
  ).toISOString();

  const result = db.prepare(`
    UPDATE poker_rooms
    SET name=?, host_name=?, player_count=?, status=?, state=?, version=?, updated_at=?
    WHERE code=? AND version=?
  `).run(
    state.name,
    state.hostName,
    Array.isArray(state.players) ? state.players.length : 0,
    state.status || 'waiting',
    JSON.stringify(state),
    nextVersion,
    nextUpdatedAt,
    code,
    expectedVersion
  );

  if (!result.changes) throw new Error('ROOM_VERSION_CONFLICT');
  return { version: nextVersion, updated_at: nextUpdatedAt };
}

function playerFor(room, username, playerToken) {
  const p = room.state.players.find(x => x.name === username);
  if (!p || !playerToken || p.sessionToken !== playerToken) throw new Error('SESSION_INVALID');
  return p;
}

function token() {
  return crypto.randomUUID() + crypto.randomUUID();
}

function actionResult(state, username) {
  return privateView(state, username, username === '莫拉咕');
}

function localGameAction(payload) {
  const started = performance.now();
  const action = payload?.action;
  const code = String(payload?.roomCode || '').trim().toUpperCase();
  const username = String(payload?.username || '').trim();
  const playerToken = String(payload?.playerToken || '');

  const timing = { backend: 'local' };

  if (action === 'list_rooms') {
    const data = db.prepare(`
      SELECT code,name,host_name,player_count,status,version
      FROM poker_rooms
      WHERE status != 'closed'
      ORDER BY updated_at DESC
    `).all();
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return {
      success: true,
      rooms: data.map(r => ({
        code: r.code,
        name: r.name,
        hostName: r.host_name,
        playerCount: r.player_count,
        status: r.status,
        version: r.version,
      })),
      timing,
    };
  }

  if (action === 'create_room') {
    if (!username) throw new Error('USERNAME_REQUIRED');
    const roomCode = code || Array.from(
      { length: 5 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
    ).join('');
    const sessionToken = token();
    const chips = Math.max(100, Math.min(100000, Number(payload.startingChips) || 1000));
    const turnSeconds = Math.max(5, Math.min(300, Number(payload.turnSeconds) || 30));
    const avatar = String(payload.avatar || '') || null;
    const room = {
      code: roomCode,
      name: String(payload.name || `${username} 的牌桌`).trim(),
      hostName: username,
      status: 'waiting',
      stage: 'waiting',
      startingChips: chips,
      turnSeconds,
      players: [{
        name: username,
        avatar,
        chips,
        cards: [],
        folded: false,
        allIn: false,
        bet: 0,
        totalContributed: 0,
        hasActed: false,
        inHand: false,
        waitingForNext: false,
        kicked: false,
        sessionToken,
      }],
      dealerIndex: null,
      turnIndex: null,
      turnStartedAt: null,
      deck: [],
      community: [],
      pot: 0,
      currentBet: 0,
      minRaise: 20,
      log: [],
      handNumber: 0,
    };
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO poker_rooms(code,name,host_name,player_count,status,updated_at,state,version)
      VALUES(?,?,?,?,?,?,?,1)
    `).run(roomCode, room.name, username, 1, 'waiting', updatedAt, JSON.stringify(room));
    broadcast('poker_rooms', 'INSERT', publicRow('poker_rooms', {
      code: roomCode, name: room.name, host_name: username, player_count: 1,
      status: 'waiting', updated_at: updatedAt, state: room, version: 1,
    }));
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return { success: true, code: roomCode, playerToken: sessionToken, state: actionResult(room, username), version: 1, updatedAt, timing };
  }

  if (action === 'god_view') {
    if (username !== '莫拉咕') throw new Error('NOT_ADMIN');
    const room = readRoom(code);
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return { success: true, state: publicView(room.state, username, true), version: room.version, updatedAt: room.updated_at, timing };
  }

  if (action === 'get_room') {
    const room = readRoom(code);
    let state = room.state;
    let p = state.players.find(x => x.name === username);
    if (p && !p.sessionToken) {
      state = structuredClone(state);
      p = state.players.find(x => x.name === username);
      p.sessionToken = token();
      const saved = writeRoom(code, state, room.version, room.updated_at);
      room.version = saved.version;
      room.updated_at = saved.updated_at;
      broadcast('poker_rooms', 'UPDATE', publicRow('poker_rooms', {
        code, name: state.name, host_name: state.hostName,
        player_count: state.players.length, status: state.status,
        updated_at: saved.updated_at, state, version: saved.version,
      }));
    }
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    if (!p) {
      return {
        success: true,
        member: false,
        state: publicView(room.state),
        version: room.version,
        updatedAt: room.updated_at,
        playerToken: null,
        timing,
      };
    }
    return {
      success: true,
      member: true,
      state: actionResult(state, username),
      version: room.version,
      updatedAt: room.updated_at,
      playerToken: p.sessionToken,
      timing,
    };
  }

  if (!code || !username) throw new Error('ROOM_AND_USERNAME_REQUIRED');

  if (action === 'join_room') {
    const room = readRoom(code);
    const existing = room.state.players.find(x => x.name === username);
    if (existing) {
      timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
      return { success: true, state: actionResult(room.state, username), version: room.version, updatedAt: room.updated_at, playerToken: existing.sessionToken, timing };
    }
    if (room.state.players.length >= 8) throw new Error('ROOM_FULL');

    const p = {
      name: username,
      avatar: String(payload.avatar || '') || null,
      chips: Number(room.state.startingChips) || 1000,
      cards: [],
      folded: false,
      allIn: false,
      bet: 0,
      totalContributed: 0,
      hasActed: false,
      inHand: false,
      waitingForNext: room.state.status === 'playing',
      kicked: false,
      sessionToken: token(),
    };
    const next = structuredClone(room.state);
    next.players.push(p);
    const saved = writeRoom(code, next, room.version, room.updated_at);
    broadcast('poker_rooms', 'UPDATE', publicRow('poker_rooms', {
      code, name: next.name, host_name: next.hostName,
      player_count: next.players.length, status: next.status,
      updated_at: saved.updated_at, state: next, version: saved.version,
    }));
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return { success: true, state: actionResult(next, username), version: saved.version, updatedAt: saved.updated_at, playerToken: p.sessionToken, timing };
  }

  const room = readRoom(code);
  if (action === 'delete_room') {
    if (username !== '莫拉咕') throw new Error('NOT_ADMIN');
    const old = db.prepare('SELECT * FROM poker_rooms WHERE code=?').get(code);
    db.prepare('DELETE FROM poker_rooms WHERE code=?').run(code);
    if (old) broadcast('poker_rooms', 'DELETE', publicRow('poker_rooms', old));
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return { success: true, deleted: true, timing };
  }

  playerFor(room, username, playerToken);

  let next;
  switch (action) {
    case 'start_hand':
      if (room.state.hostName !== username) throw new Error('NOT_HOST');
      if (room.state.status !== 'waiting' || room.state.stage !== 'waiting') throw new Error('INVALID_GAME_STATE');
      if (room.state.players.length < 2) throw new Error('NOT_ENOUGH_PLAYERS');
      next = startHand(room.state);
      break;
    case 'next_hand':
      if (room.state.hostName !== username) throw new Error('NOT_HOST');
      if (room.state.status !== 'playing' || room.state.stage !== 'handover') throw new Error('INVALID_GAME_STATE');
      if (room.state.players.length < 2) throw new Error('NOT_ENOUGH_PLAYERS');
      next = startHand(room.state);
      break;
    case 'fold':
    case 'check':
    case 'call':
    case 'raise':
      next = applyAction(room.state, username, action, payload.amount);
      break;
    case 'throw':
      next = throwItem(room.state, username, String(payload.targetName || ''), String(payload.itemKey || ''));
      break;
    case 'kick':
      next = kickPlayer(room.state, username, String(payload.targetName || ''));
      break;
    case 'leave':
      next = leaveRoom(room.state, username);
      break;
    case 'update_avatar': {
      next = structuredClone(room.state);
      const p = next.players.find(x => x.name === username);
      if (!p) throw new Error('PLAYER_NOT_IN_ROOM');
      p.avatar = String(payload.avatar || '') || null;
      break;
    }
    case 'tick': {
      if (room.state.status !== 'playing' || !room.state.turnStartedAt) {
        timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
        return { success: true, state: actionResult(room.state, username), version: room.version, updatedAt: room.updated_at, timing };
      }
      const limit = Number(room.state.turnSeconds || 30) * 1000;
      if (Date.now() - Number(room.state.turnStartedAt) < limit) {
        timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
        return { success: true, state: actionResult(room.state, username), version: room.version, updatedAt: room.updated_at, timing };
      }
      const turnPlayer = room.state.players[room.state.turnIndex];
      if (!turnPlayer) {
        timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
        return { success: true, state: actionResult(room.state, username), version: room.version, updatedAt: room.updated_at, timing };
      }
      next = applyAction(room.state, turnPlayer.name, 'fold');
      next.log.push(`${turnPlayer.name} 行动超时，自动弃牌`);
      break;
    }
    default:
      throw new Error('UNKNOWN_ACTION');
  }

  if (next === null) {
    const old = db.prepare('SELECT * FROM poker_rooms WHERE code=?').get(code);
    db.prepare('DELETE FROM poker_rooms WHERE code=?').run(code);
    if (old) broadcast('poker_rooms', 'DELETE', publicRow('poker_rooms', old));
    timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
    return { success: true, deleted: true, timing };
  }

  const saved = writeRoom(code, next, room.version, room.updated_at);
  broadcast('poker_rooms', 'UPDATE', publicRow('poker_rooms', {
    code, name: next.name, host_name: next.hostName,
    player_count: next.players.length, status: next.status,
    updated_at: saved.updated_at, state: next, version: saved.version,
  }));

  timing.totalMs = Math.round((performance.now() - started) * 100) / 100;
  return {
    success: true,
    state: actionResult(next, username),
    version: saved.version,
    updatedAt: saved.updated_at,
    timing,
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
  }

  if (parts[1] === 'game-action') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
      return res.end();
    }
    if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'method not allowed' });
    try {
      const body = await parseBody(req);
      const result = localGameAction(body);
      return sendJson(res, 200, result);
    } catch (error) {
      const msg = error?.message || '操作失败';
      const map = {
        ROOM_NOT_FOUND: 404,
        PLAYER_NOT_IN_ROOM: 403,
        SESSION_INVALID: 403,
        NOT_YOUR_TURN: 409,
        ROOM_VERSION_CONFLICT: 409,
        ROOM_FULL: 409,
        NOT_HOST: 403,
        NOT_ENOUGH_PLAYERS: 409,
        NOT_ADMIN: 403,
        MINIMUM_RAISE: 400,
        REOPEN_REQUIRED: 400,
        INVALID_GAME_STATE: 409,
      };
      console.warn('[河畔牌局] local game-action failed', msg);
      return sendJson(res, map[msg] || 400, { success: false, error: msg, timing: { backend: 'local' } });
    }
  }

  if (parts[1] !== 'db') return sendJson(res, 404, { error: 'unknown api route' });
  const table = parts[2];
  if (!tableExists(table)) return sendJson(res, 404, { error: 'unknown table' });

  try {
    if (req.method === 'GET') {
      const rows = getRows(table, url).map(r => publicRow(table, r));
      return sendJson(res, 200, { data: url.searchParams.get('single') === '1' ? (rows[0] || null) : rows, error: null });
    }

    const body = await parseBody(req);
    const { sql: where, values } = buildWhere(url, table);

    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const results = [];
      for (const inputRow of rows) {
        const row = { ...inputRow };
        delete row.__upsert;
        const isUpsert = Boolean(inputRow.__upsert);
        const keys = Object.keys(row);

        if (table === 'poker_messages') {
          const now = new Date().toISOString();
          const info = db.prepare('INSERT INTO poker_messages(room_code,username,text,created_at) VALUES(?,?,?,?)').run(row.room_code, row.username, row.text, row.created_at || now);
          const saved = db.prepare('SELECT * FROM poker_messages WHERE id=?').get(info.lastInsertRowid);
          results.push(saved);
          broadcast(table, 'INSERT', saved);
        } else if (isUpsert) {
          const conflict = table === 'poker_users' ? 'username' : 'code';
          const vals = keys.map(k => k === 'state' && typeof row[k] !== 'string' ? JSON.stringify(row[k]) : row[k]);
          const updateKeys = keys.filter(k => k !== conflict);
          const updateSql = updateKeys.map(k => `${safeColumn(table, k)}=excluded.${safeColumn(table, k)}`).join(',');
          db.prepare(`INSERT INTO ${table}(${keys.map(k => safeColumn(table,k)).join(',')}) VALUES(${keys.map(()=>'?').join(',')}) ON CONFLICT(${safeColumn(table, conflict)}) DO UPDATE SET ${updateSql}`).run(...vals);
          const saved = db.prepare(`SELECT * FROM ${table} WHERE ${safeColumn(table, conflict)}=?`).get(row[conflict]);
          results.push(publicRow(table, saved));
          broadcast(table, 'UPSERT', publicRow(table, saved));
        } else {
          const vals = keys.map(k => k === 'state' && typeof row[k] !== 'string' ? JSON.stringify(row[k]) : row[k]);
          db.prepare(`INSERT INTO ${table}(${keys.map(k => safeColumn(table,k)).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...vals);
          const saved = table === 'poker_messages' ? db.prepare('SELECT * FROM poker_messages ORDER BY id DESC LIMIT 1').get() : row;
          results.push(publicRow(table, saved));
          broadcast(table, 'INSERT', publicRow(table, saved));
        }
      }
      return sendJson(res, 200, { data: Array.isArray(body) ? results : results[0], error: null });
    }

    if (req.method === 'PATCH') {
      const keys = Object.keys(body);
      const vals = keys.map(k => k === 'state' && typeof body[k] !== 'string' ? JSON.stringify(body[k]) : body[k]);
      db.prepare(`UPDATE ${table} SET ${keys.map(k => `${safeColumn(table,k)}=?`).join(',')}${where}`).run(...vals, ...values);
      const rows = getRows(table, new URL(url.toString()));
      rows.forEach(r => broadcast(table, 'UPDATE', publicRow(table, r)));
      return sendJson(res, 200, { data: rows.map(r => publicRow(table, r)), error: null });
    }

    if (req.method === 'DELETE') {
      const before = getRows(table, url);
      db.prepare(`DELETE FROM ${table}${where}`).run(...values);
      before.forEach(r => broadcast(table, 'DELETE', publicRow(table, r)));
      return sendJson(res, 200, { data: before.map(r => publicRow(table, r)), error: null });
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { data: null, error: { message: error.message } });
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(dist)) return sendJson(res, 503, { error: 'dist not built. Run npm run build first.' });

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  let file = path.resolve(dist, '.' + pathname);

  if (!file.startsWith(path.resolve(dist))) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType(file));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');

  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end('File error');
  });
  stream.pipe(res);
}

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  console.log(new Date().toISOString(), req.method, req.url, req.headers['user-agent']);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  return sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(port, '::', () => console.log(`River Poker local server: http://[::]:${port}`));
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
