import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

const sseClients = new Set();
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function broadcast(table, event, row, old = null) {
  const payload = JSON.stringify({ table, event, new: row || null, old });
  for (const res of sseClients) {
    try { res.write(`event: change\ndata: ${payload}\n\n`); } catch { sseClients.delete(res); }
  }
}
function columnsFor(table, select) {
  if (!select || select === '*') return '*';
  const allowed = {
    poker_users: new Set(['username','password_hash','chips','avatar_url','dealer_image_url']),
    poker_rooms: new Set(['code','name','host_name','player_count','status','updated_at','state']),
    poker_messages: new Set(['id','room_code','username','text','created_at']),
  }[table];
  if (!allowed) throw new Error('unknown table');
  return select.split(',').map(x => x.trim()).filter(x => allowed.has(x)).join(',') || '*';
}
function safeColumn(table, column) {
  const allowed = {
    poker_users: ['username','password_hash','chips','avatar_url','dealer_image_url'],
    poker_rooms: ['code','name','host_name','player_count','status','updated_at','state'],
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
function tableExists(table) { return ['poker_users','poker_rooms','poker_messages'].includes(table); }
function publicRow(table, row) {
  if (!row) return null;
  if (table === 'poker_rooms') return { ...row, state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state };
  return row;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(': connected\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
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
      const isUpsert = rows.some(row => row.__upsert);
      const results = [];
      for (const inputRow of rows) {
        const row = { ...inputRow };
        delete row.__upsert;
        const keys = Object.keys(row);
        if (table === 'poker_messages') {
          const now = new Date().toISOString();
          const stmt = db.prepare(`INSERT INTO poker_messages(room_code,username,text,created_at) VALUES(?,?,?,?)`);
          const info = stmt.run(row.room_code, row.username, row.text, row.created_at || now);
          const saved = db.prepare('SELECT * FROM poker_messages WHERE id=?').get(info.lastInsertRowid);
          results.push(saved); broadcast(table, 'INSERT', saved);
        } else if (isUpsert) {
          const conflict = table === 'poker_users' ? 'username' : 'code';
          const vals = keys.map(k => k === 'state' && typeof row[k] !== 'string' ? JSON.stringify(row[k]) : row[k]);
          const updateKeys = keys.filter(k => k !== conflict);
          const updateSql = updateKeys.map(k => `${safeColumn(table, k)}=excluded.${safeColumn(table, k)}`).join(',');
          db.prepare(`INSERT INTO ${table}(${keys.map(k => safeColumn(table,k)).join(',')}) VALUES(${keys.map(()=>'?').join(',')}) ON CONFLICT(${safeColumn(table, conflict)}) DO UPDATE SET ${updateSql}`).run(...vals);
          const saved = db.prepare(`SELECT * FROM ${table} WHERE ${safeColumn(table, conflict)}=?`).get(row[conflict]);
          results.push(publicRow(table, saved)); broadcast(table, 'UPSERT', publicRow(table, saved));
        } else {
          const vals = keys.map(k => k === 'state' && typeof row[k] !== 'string' ? JSON.stringify(row[k]) : row[k]);
          db.prepare(`INSERT INTO ${table}(${keys.map(k => safeColumn(table,k)).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...vals);
          const saved = table === 'poker_messages' ? db.prepare('SELECT * FROM poker_messages ORDER BY id DESC LIMIT 1').get() : row;
          results.push(publicRow(table, saved)); broadcast(table, 'INSERT', publicRow(table, saved));
        }
      }
      return sendJson(res, 200, { data: Array.isArray(body) ? results : results[0], error: null });
    }
    if (req.method === 'PATCH') {
      const keys = Object.keys(body);
      const vals = keys.map(k => k === 'state' && typeof body[k] !== 'string' ? JSON.stringify(body[k]) : body[k]);
      const stmt = db.prepare(`UPDATE ${table} SET ${keys.map(k=>`${safeColumn(table,k)}=?`).join(',')}${where}`);
      stmt.run(...vals, ...values);
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
  if (!fs.existsSync(dist)) {
    return sendJson(res, 503, {
      error: 'dist not built. Run npm run build first.'
    });
  }

  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/') {
    pathname = '/index.html';
  }

  let file = path.resolve(dist, '.' + pathname);

  if (!file.startsWith(path.resolve(dist))) {
    return sendJson(res, 403, {
      error: 'forbidden'
    });
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dist, 'index.html');
  }

  const type = contentType(file);

  res.statusCode = 200;

  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    file.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable'
  );

  if (req.method === 'HEAD') {
    return res.end();
  }

  const stream = fs.createReadStream(file);

  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
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
