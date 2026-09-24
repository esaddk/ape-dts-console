'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const schema = require('./schema.json');
const { toIni, validate } = require('./lib/ini.js');
const docker = require('./lib/docker.js');
const { Tailer, readTailLines, parseMonitorLine, parsePositionLine } = require('./lib/logs.js');
const introspect = require('./lib/introspect.js');
const { readCheckResult } = require('./lib/checklog.js');
const { nextStatus } = require('./lib/status.js');
const retry = require('./lib/retry.js');
const { checkFormFromTaskForm, cdcFormFromMigrateForm } = require('./public/formdata.js');
const pgslot = require('./lib/pgslot.js');
const auth = require('./lib/auth.js');

const RUNS_DIR = path.join(__dirname, 'runs');
const PORT = process.env.PORT || 8787;
// Login is required from first run (see the setup gate below), but default to
// localhost-only anyway — belt and suspenders against exposing Docker control before
// setup is complete. Explicit opt-in via env var for anyone who wants LAN/remote access.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json());

// ---- CSRF / drive-by protection ----
// Runs even when login is off — without this, any webpage open in the same browser
// could silently POST here (browsers don't block outbound requests, only reading a
// cross-origin response) and start/stop/remove tasks. Per the Fetch spec, browsers
// attach Origin on same-origin requests too for unsafe methods, so a same-origin
// fetch/form POST always carries it — only non-browser clients (curl, scripts) send
// neither Origin nor Referer, and those are left alone rather than broken.
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://${HOST}:${PORT}`]);
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch { /* malformed referer, ignore */ }
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

// ---- Setup + login gates ----
// A brand-new install has no accounts, so the first visitor is forced through
// /setup.html to create the admin account (rather than left with open access, or
// stuck needing shell access to run a seed script). Once that account exists, every
// route requires a logged-in session, and the admin can add more from /users.html.
// Sessions are a signed cookie (lib/auth.js), no server-side store.
const SETUP_HTML = fs.readFileSync(path.join(__dirname, 'public', 'setup.html'), 'utf8');
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function currentSession(req) {
  return auth.verifySession(parseCookies(req.headers.cookie).session);
}

app.post('/api/setup', (req, res) => {
  if (auth.hasUsers()) return res.status(403).json({ error: 'Already set up' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  auth.addUser(username, password, 'admin');
  res.cookie('session', auth.createSessionToken(username, 'admin'), {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: auth.SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (auth.hasUsers()) return next();
  if (req.path === '/setup.html' || req.path === '/api/setup' || req.path === '/favicon.svg') return next();
  res.status(200).send(SETUP_HTML);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && password && auth.verifyLogin(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  res.cookie('session', auth.createSessionToken(user.username, user.role), {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: auth.SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: session.u, role: session.role });
});

function requireAdmin(req, res, next) {
  const session = currentSession(req);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.get('/api/users', requireAdmin, (req, res) => res.json(auth.listUsers()));

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Role must be "admin" or "user"' });
  auth.addUser(username, password, role);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (['/login.html', '/api/login', '/setup.html', '/api/setup', '/favicon.svg'].includes(req.path)) return next();
  if (currentSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.status(401).send(LOGIN_HTML);
});

// ---- Docker availability gate ----
// Every ape-dts task runs as its own Docker container (docker.start() below) — with
// no daemon reachable this app can't do the one thing it exists for. Block the whole
// UI behind a "backend not running" page instead of letting it load into a state
// where every action fails, cached briefly so a full page load's handful of asset
// requests don't each spawn a `docker version` process.
const DOCKER_PING_TTL_MS = 2000;
let dockerPingCache = { ok: false, ts: 0 };
async function isDockerUp() {
  if (Date.now() - dockerPingCache.ts < DOCKER_PING_TTL_MS) return dockerPingCache.ok;
  const ok = await docker.ping();
  dockerPingCache = { ok, ts: Date.now() };
  return ok;
}

const DOCKER_DOWN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'docker-down.html'), 'utf8');

app.get('/api/health', async (req, res) => {
  res.json({ dockerUp: await isDockerUp() });
});

app.use(async (req, res, next) => {
  if (await isDockerUp()) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'Docker is not reachable — this UI launches tasks as Docker containers and needs it running. Start Docker and retry.' });
  }
  res.status(503).send(DOCKER_DOWN_HTML);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- run registry: in-memory, backed by runs/<id>/meta.json ----
const runs = new Map();

// Normalises an old (7-field) meta.json to the current 11-field shape. No on-disk
// migration needed — missing keys just read undefined, so this runs on every load.
function withDefaults(meta) {
  return {
    name: null,
    kind: 'cdc',
    checkOf: null,
    finishedAt: null,
    exitCode: null,
    migrateOf: null,
    cdcTaskId: null,
    slotName: null,
    startLsn: null,
    pubName: null,
    retryCount: 0,
    ...meta,
  };
}

// Parses a pg connection URL back into discrete fields for pgslot.createSlot,
// which needs a real pg Client, not a URL string. Must run on the raw (pre-
// dockerizeUrl) URL — dockerizeUrl's host.docker.internal is only resolvable
// from inside a container, not from this Node process.
function parsePgUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database: (u.pathname || '/').slice(1) || 'postgres',
  };
}

function loadRunsFromDisk() {
  if (!fs.existsSync(RUNS_DIR)) return;
  for (const id of fs.readdirSync(RUNS_DIR)) {
    const metaPath = path.join(RUNS_DIR, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      runs.set(id, withDefaults(JSON.parse(fs.readFileSync(metaPath, 'utf8'))));
    } catch { /* skip corrupt meta */ }
  }
}

function saveMeta(meta) {
  fs.writeFileSync(path.join(RUNS_DIR, meta.id, 'meta.json'), JSON.stringify(meta, null, 2));
}

function genId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function runPaths(id) {
  const dir = path.join(RUNS_DIR, id);
  return { dir, iniPath: path.join(dir, 'task_config.ini'), logsDir: path.join(dir, 'logs') };
}

// ---- routes ----
app.get('/api/schema', (req, res) => res.json(schema));

app.get('/api/networks', async (req, res) => {
  try {
    res.json(await docker.listNetworks());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/introspect', async (req, res) => {
  const { db_type, host, port, username, password, database, schema: pgSchema, want } = req.body || {};
  if (!db_type || !host || !port) return res.status(400).json({ error: 'db_type, host and port are required' });
  try {
    let items;
    if (want === 'databases') items = await introspect.listDatabases({ db_type, host, port, username, password });
    else if (want === 'schemas') {
      if (db_type !== 'pg') return res.status(400).json({ error: 'schemas are only applicable to db_type=pg' });
      if (!database) return res.status(400).json({ error: 'database is required' });
      items = await introspect.listSchemas({ host, port, username, password, database });
    } else if (want === 'tables') {
      if (!database) return res.status(400).json({ error: 'database is required' });
      items = await introspect.listTables({ db_type, host, port, username, password, database, schema: pgSchema });
    } else {
      return res.status(400).json({ error: 'want must be one of: databases, schemas, tables' });
    }
    res.json({ items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tasks', (req, res) => {
  res.json([...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/api/tasks/:id', async (req, res) => {
  const meta = runs.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  const state = meta.containerName ? await docker.inspect(meta.id).catch(() => null) : null;
  res.json({ ...meta, container: state });
});

// Shared by POST /api/tasks and POST /api/tasks/:id/check — writes the ini, starts
// the container, and returns the finished meta (status starting|failed already applied).
async function createRun({ formData, network, name, kind, checkOf, migrateOf }) {
  const errors = validate(formData, schema);
  if (errors.length) return { errors };

  // The container can't reach 'localhost' — rewrite to host.docker.internal so a form
  // built against Test Connection's localhost (which runs on the host process) still
  // works unmodified once it's actually started as a container.
  if (formData.extractor && formData.extractor.url) formData.extractor.url = docker.dockerizeUrl(formData.extractor.url);
  if (formData.sinker && formData.sinker.url) formData.sinker.url = docker.dockerizeUrl(formData.sinker.url);

  const id = genId();
  const { iniPath, logsDir } = runPaths(id);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(iniPath, toIni(formData, schema));

  let meta = withDefaults({
    id,
    createdAt: new Date().toISOString(),
    formData,
    network: network || null,
    status: 'starting',
    containerName: null,
    error: null,
    name: name || null,
    kind,
    checkOf: checkOf || null,
    migrateOf: migrateOf || null,
  });
  runs.set(id, meta);
  saveMeta(meta);

  try {
    const { name: containerName } = await docker.start({ id, iniPath, logsDir, network });
    meta = { ...meta, status: 'running', containerName };
  } catch (err) {
    meta = { ...meta, status: 'failed', error: err.message };
  }
  runs.set(id, meta);
  saveMeta(meta);
  return { meta };
}

app.post('/api/tasks', async (req, res) => {
  const { formData, network, name, syncMode } = req.body || {};
  if (!formData) return res.status(400).json({ error: 'formData is required' });
  const trimmedName = typeof name === 'string' ? name.trim().slice(0, 120) : '';

  // Zero-downtime migrate: reserve the replication slot (capturing its LSN) BEFORE
  // the snapshot phase reads a single row, so nothing written between "snapshot done"
  // and "CDC slot created" is lost. See docs/en/tutorial/snapshot_and_cdc_without_data_loss.md.
  if (syncMode === 'migrate') {
    const srcType = formData.extractor && formData.extractor.db_type;
    const dstType = formData.sinker && formData.sinker.db_type;
    if (srcType !== 'pg' || dstType !== 'pg') {
      return res.status(400).json({ error: 'migrate is only supported for db_type=pg on both source and target' });
    }

    let slotConn;
    try {
      slotConn = parsePgUrl(formData.extractor.url);
    } catch (err) {
      return res.status(400).json({ error: `could not parse source URL: ${err.message}` });
    }

    const slotName = 'ape_dts_migrate_' + genId().replace(/-/g, '_');
    let slot;
    try {
      slot = await pgslot.createSlot({ ...slotConn, slotName });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { errors, meta } = await createRun({ formData, network, name: trimmedName || null, kind: 'migrate' });
    if (errors) return res.status(400).json({ errors });

    const patched = { ...meta, slotName: slot.slotName, startLsn: slot.lsn, pubName: slot.pubName };
    runs.set(patched.id, patched);
    saveMeta(patched);

    if (patched.status === 'failed') return res.status(500).json(patched);
    return res.status(201).json(patched);
  }

  const kind = formData.extractor && formData.extractor.extract_type === 'snapshot' ? 'snapshot' : 'cdc';
  const { errors, meta } = await createRun({ formData, network, name: trimmedName || null, kind });
  if (errors) return res.status(400).json({ errors });

  if (meta.status === 'failed') return res.status(500).json(meta);
  res.status(201).json(meta);
});

// Derives and starts a standalone data-verification (sink_type=check) task from an
// existing task's formData, reusing both URLs verbatim so it hits the same endpoints.
app.post('/api/tasks/:id/check', async (req, res) => {
  const parent = runs.get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'not found' });

  const dbType = parent.formData && parent.formData.extractor && parent.formData.extractor.db_type;
  if (!['mysql', 'pg', 'mongo'].includes(dbType)) {
    return res.status(400).json({ error: `data verification is not supported for db_type=${dbType}` });
  }

  const alreadyRunning = [...runs.values()].some(
    (m) => m.checkOf === parent.id && (m.status === 'starting' || m.status === 'running')
  );
  if (alreadyRunning) return res.status(409).json({ error: 'a data verification task is already running for this task' });

  const formData = checkFormFromTaskForm(parent.formData);
  const { errors, meta } = await createRun({
    formData,
    network: parent.network,
    name: parent.name ? `check: ${parent.name}` : null,
    kind: 'check',
    checkOf: parent.id,
  });
  if (errors) return res.status(400).json({ errors });

  if (meta.status === 'failed') return res.status(500).json(meta);
  res.status(201).json(meta);
});

// :id is the PARENT task's id — returns the newest check task's parsed result.
app.get('/api/tasks/:id/check-result', (req, res) => {
  const parent = runs.get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'not found' });

  const checkTasks = [...runs.values()]
    .filter((m) => m.checkOf === parent.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = checkTasks[0];
  if (!latest) return res.json({ checkTaskId: null, status: null, finishedAt: null, tables: [], totals: null });

  const { logsDir } = runPaths(latest.id);
  const result = readCheckResult(path.join(logsDir, 'check'));
  res.json({ checkTaskId: latest.id, status: latest.status, finishedAt: latest.finishedAt, ...result });
});

app.post('/api/tasks/:id/stop', async (req, res) => {
  const meta = runs.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    await docker.stop(meta.id);
    meta.status = 'stopped';
    saveMeta(meta);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/remove', async (req, res) => {
  const meta = runs.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    await docker.remove(meta.id);
    meta.status = 'removed';
    meta.containerName = null;
    saveMeta(meta);

    // Removing a migrate task's CDC child (the container the UI actually targets,
    // see streamId/activeId in app.js) must also remove the parent row, or the
    // parent — the one visible in Task Center, since children are filtered out —
    // is left behind forever with a stale status.
    const parent = [...runs.values()].find((m) => m.cdcTaskId === meta.id);
    if (parent) {
      await docker.remove(parent.id).catch(() => {});
      const patchedParent = { ...parent, status: 'removed', containerName: null };
      runs.set(parent.id, patchedParent);
      saveMeta(patchedParent);
    }

    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- SSE monitoring stream ----
app.get('/api/tasks/:id/stream', (req, res) => {
  const meta = runs.get(req.params.id);
  if (!meta) return res.status(404).end();
  const { logsDir } = runPaths(meta.id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const monitorTailer = new Tailer(path.join(logsDir, 'monitor.log'));
  const positionTailer = new Tailer(path.join(logsDir, 'position.log'));

  const checkpointSecs = (meta.formData.pipeline && Number(meta.formData.pipeline.checkpoint_interval_secs)) || 2;
  const intervalMs = Math.min(5000, Math.max(500, checkpointSecs * 1000));

  // current_position (source read position) and checkpoint_position (sink-confirmed
  // position) are separate log lines; track the latest of each so the client can
  // diff them into a sync/lag indicator instead of only ever seeing whichever kind
  // happened to be logged last.
  let latestCurrent = null;
  let latestCheckpoint = null;

  // Tailers start from EOF (no full-history replay), which otherwise leaves the
  // header/metric cards blank until fresh data is written — slow for an idle-but-
  // in-sync task. Seed immediate state from a bounded tail-read instead.
  for (const p of readTailLines(path.join(logsDir, 'position.log')).map(parsePositionLine).filter(Boolean)) {
    if (p.kind === 'current_position') latestCurrent = p;
    else if (p.kind === 'checkpoint_position') latestCheckpoint = p;
  }
  if (latestCurrent || latestCheckpoint) send('position', { current: latestCurrent, checkpoint: latestCheckpoint });
  const seedCounters = readTailLines(path.join(logsDir, 'monitor.log')).map(parseMonitorLine).filter(Boolean);
  if (seedCounters.length) send('counters', seedCounters);

  const tick = async () => {
    const counters = monitorTailer.poll().map(parseMonitorLine).filter(Boolean);
    if (counters.length) send('counters', counters);

    const positions = positionTailer.poll().map(parsePositionLine).filter(Boolean);
    for (const p of positions) {
      if (p.kind === 'current_position') latestCurrent = p;
      else if (p.kind === 'checkpoint_position') latestCheckpoint = p;
    }
    if (positions.length) send('position', { current: latestCurrent, checkpoint: latestCheckpoint });

    // Emitted even once the container is gone so Page 3 renders "removed" instead
    // of hanging on its last-known state (was gated on containerName before).
    const state = meta.containerName ? await docker.inspect(meta.id).catch(() => null) : null;
    send('status', state);

    res.write(': heartbeat\n\n'); // keeps idle proxies from silently closing the stream
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  req.on('close', () => clearInterval(timer));
});

// ---- status reconciler ----
// meta.status can otherwise never reach a terminal success — nothing else writes
// completed, so a finished task reads "running" forever. Runs independently of the
// SSE tick, which only fires while a client has the detail page open.
async function reconcileStatuses() {
  const pending = [...runs.values()].filter((m) => m.status === 'starting' || m.status === 'running');
  for (const meta of pending) {
    if (!meta.containerName) continue;
    const state = await docker.inspect(meta.id).catch(() => null);
    const patch = nextStatus(state);
    if (!patch) continue;

    // CDC tasks (plain, or a migrate's chained child) can panic instead of failing
    // cleanly when the source connection drops — see memory/ape_dts_pg_cdc_panic.md.
    // Auto-restart the SAME container (never a new task/slot) when the failure looks
    // transient; a permanent misconfiguration (bad auth, missing table, ...) is left
    // failed instead of crash-looping. Capped at retry.MAX_RETRIES.
    if (patch.status === 'failed' && meta.kind === 'cdc') {
      const logText = await docker.logs(meta.id);
      if (retry.shouldRetry({ retryCount: meta.retryCount, logText })) {
        const bumped = { ...meta, retryCount: meta.retryCount + 1 };
        runs.set(meta.id, bumped);
        saveMeta(bumped);
        try {
          await docker.restart(meta.id);
        } catch (err) {
          const stillFailed = { ...bumped, ...patch, error: `auto-retry failed to restart container: ${err.message}` };
          runs.set(meta.id, stillFailed);
          saveMeta(stillFailed);
        }
        continue;
      }
    }

    const updated = { ...meta, ...patch };
    runs.set(meta.id, updated);
    saveMeta(updated);

    // Phase 2: a migrate task that finished its snapshot cleanly starts CDC from the
    // slot's captured LSN. A failed snapshot starts nothing and keeps the slot alive
    // (see pgslot.js) so the UI can warn instead of silently losing replayable WAL.
    if (updated.status === 'completed' && updated.kind === 'migrate' && !updated.cdcTaskId) {
      try {
        const cdcForm = cdcFormFromMigrateForm(updated.formData, { slotName: updated.slotName, startLsn: updated.startLsn, pubName: updated.pubName });
        const { meta: cdcMeta, errors } = await createRun({
          formData: cdcForm,
          network: updated.network,
          name: updated.name ? `${updated.name} (cdc)` : null,
          kind: 'cdc',
          migrateOf: updated.id,
        });
        if (errors) throw new Error(errors.join('; '));
        const withChild = { ...updated, cdcTaskId: cdcMeta.id };
        runs.set(updated.id, withChild);
        saveMeta(withChild);
      } catch (err) {
        console.error(`migrate ${updated.id}: failed to start chained CDC task:`, err.message);
      }
    }
  }
}

loadRunsFromDisk();
setInterval(reconcileStatuses, 3000);
app.listen(PORT, HOST, () => console.log(`ape-dts UI listening on http://${HOST}:${PORT}`));
