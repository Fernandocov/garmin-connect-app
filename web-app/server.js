#!/usr/bin/env node
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as readline from 'readline';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const DB_PATH = join(__dirname, 'activities.db');

const GARMIN_EMAIL = process.env.GARMIN_EMAIL;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD;

if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
  console.error('Missing GARMIN_EMAIL or GARMIN_PASSWORD environment variables.');
  console.error('Run: GARMIN_EMAIL=you@email.com GARMIN_PASSWORD=yourpass node server.js');
  process.exit(1);
}

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    activity_id TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    synced_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at INTEGER NOT NULL,
    count     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const stmts = {
  upsert: db.prepare(`
    INSERT INTO activities (activity_id, data, synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at
  `),
  list: db.prepare(`
    SELECT data FROM activities ORDER BY json_extract(data, '$.startTimeGMT') DESC LIMIT ? OFFSET ?
  `),
  count:    db.prepare(`SELECT COUNT(*) as n FROM activities`),
  lastSync: db.prepare(`SELECT synced_at, count FROM sync_log ORDER BY id DESC LIMIT 1`),
  logSync:  db.prepare(`INSERT INTO sync_log (synced_at, count) VALUES (?, ?)`),

  // users
  userInsert: db.prepare(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`),
  userList:   db.prepare(`SELECT id, username, created_at FROM users ORDER BY id ASC`),
  userDelete: db.prepare(`DELETE FROM users WHERE id = ?`),
};

function getActivitiesFromDB(limit, offset) {
  return stmts.list.all(limit, offset).map(r => JSON.parse(r.data));
}

function getTotalCount() {
  return stmts.count.get().n;
}

function getLastSync() {
  return stmts.lastSync.get() ?? null;
}

const upsertMany = db.transaction((activities) => {
  const now = Date.now();
  for (const a of activities) {
    const id = String(a.activityId ?? a.activityUUID ?? Math.random());
    stmts.upsert.run(id, JSON.stringify(a), now);
  }
});

// ── MCP Client ────────────────────────────────────────────────────────────────

class MCPClient {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const mcpPath = join(__dirname, '..', 'build', 'index.js');

      this.proc = spawn('node', [mcpPath], {
        env: { ...process.env, GARMIN_EMAIL, GARMIN_PASSWORD },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) console.error('[MCP]', msg);
      });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch {}
      });

      this.proc.on('error', reject);

      this.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'garmin-web-app', version: '1.0.0' },
      }).then((result) => {
        this.notify('notifications/initialized', {});
        this.ready = true;
        console.log('✓ MCP connected:', result?.serverInfo?.name ?? 'garmin-connect-mcp');
        resolve();
      }).catch(reject);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args = {}) {
    const result = await this.send('tools/call', { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error('Empty response from MCP tool');
    return JSON.parse(text);
  }

  stop() { this.proc?.kill(); }
}

// ── Sync logic ────────────────────────────────────────────────────────────────

const mcp = new MCPClient();
let syncing = false;

async function syncFromGarmin(limit = 100) {
  if (syncing) throw new Error('Sync already in progress');
  syncing = true;
  try {
    console.log(`⟳  Syncing ${limit} activities from Garmin…`);
    const data = await mcp.callTool('get_activities', { start: 0, limit });
    const activities = Array.isArray(data) ? data : [];
    upsertMany(activities);
    const total = getTotalCount();
    stmts.logSync.run(Date.now(), activities.length);
    console.log(`✓  Synced ${activities.length} activities (${total} total in DB)`);
    return { fetched: activities.length, total };
  } finally {
    syncing = false;
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /api/activities — served from DB
  if (req.method === 'GET' && url.pathname === '/api/activities') {
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '20', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const activities = getActivitiesFromDB(limit, offset);
    const total = getTotalCount();
    const lastSync = getLastSync();
    return json(res, 200, { activities, total, lastSync });
  }

  // POST /api/sync — fetch from MCP and store in DB
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    if (!mcp.ready) return json(res, 503, { error: 'MCP not ready yet' });
    if (syncing)    return json(res, 409, { error: 'Sync already in progress' });
    try {
      const result = await syncFromGarmin(100);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // GET /api/users — list all users
  if (req.method === 'GET' && url.pathname === '/api/users') {
    return json(res, 200, stmts.userList.all());
  }

  // POST /api/users — add a user { username, password }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) return json(res, 400, { error: 'username and password are required' });
        stmts.userInsert.run(username, password, Date.now());
        return json(res, 201, { ok: true });
      } catch (e) {
        const duplicate = e.message.includes('UNIQUE');
        return json(res, duplicate ? 409 : 500, { error: duplicate ? 'Username already exists' : e.message });
      }
    });
    return;
  }

  // DELETE /api/users/:id — remove a user
  const deleteMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    stmts.userDelete.run(Number(deleteMatch[1]));
    return json(res, 200, { ok: true });
  }

  // GET /api/status — DB stats
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, {
      total: getTotalCount(),
      lastSync: getLastSync(),
      mcpReady: mcp.ready,
      syncing,
    });
  }

  // Serve index.html
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch {
      res.writeHead(404); return res.end('index.html not found');
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

mcp.start().then(() => {
  server.listen(PORT, () => {
    const total = getTotalCount();
    const lastSync = getLastSync();
    console.log(`\n🚀  http://localhost:${PORT}`);
    console.log(`    DB: ${total} activities cached${lastSync ? `, last synced ${new Date(lastSync.synced_at).toLocaleString()}` : ' (never synced)'}`);
    console.log(`    POST /api/sync to fetch latest from Garmin\n`);
  });
}).catch((err) => {
  console.error('Failed to start MCP:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { mcp.stop(); process.exit(0); });
