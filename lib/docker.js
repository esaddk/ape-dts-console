'use strict';
const { execFile } = require('child_process');

const IMAGE = 'apecloud/ape-dts:2.0.22';
const NAME_PREFIX = 'ape-dts-ui-';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

function containerName(id) {
  return NAME_PREFIX + id;
}

// The task container can't reach 'localhost'/'127.0.0.1' — that resolves to the
// container itself, not the host machine. Test Connection runs on the host process
// so it needs the real localhost; only the URL actually written into the container's
// task_config.ini needs rewriting. Leaves any other hostname (real DBs, RDS, etc)
// untouched.
function dockerizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      u.hostname = 'host.docker.internal';
      return u.toString();
    }
  } catch {
    // not a parseable URL — leave it alone, validate() will have already caught this
  }
  return url;
}

// opts: { id, iniPath, logsDir, network } — iniPath/logsDir must be absolute host paths.
async function start(opts) {
  const name = containerName(opts.id);
  const args = ['run', '-d', '--name', name];
  if (opts.network) args.push('--network', opts.network);
  args.push(
    '-v', `${opts.iniPath}:/task_config.ini`,
    '-v', `${opts.logsDir}:/logs/`,
    IMAGE, '/task_config.ini'
  );
  const containerId = await run(args);
  return { name, containerId };
}

async function stop(id) {
  await run(['stop', '-t', '3', containerName(id)]);
}

async function remove(id) {
  await run(['rm', '-f', containerName(id)]);
}

// docker start on an already-exited (not removed) container reuses its existing
// bind mounts (task_config.ini, logsDir) unchanged — no new container, no new ini.
// Used by the auto-retry reconciler in server.js: resuming the exact same CDC
// container is safe because the engine clamps a stale start_lsn to the slot's own
// confirmed_flush_lsn (see pg_cdc_client.rs), so nothing needs to change on resume.
async function restart(id) {
  await run(['start', containerName(id)]);
}

// Never rejects — a log-fetch failure just means auto-retry classification treats it
// as "no transient pattern found" (fail safe: don't retry). Combines stdout+stderr
// since a Rust panic prints to stderr, not stdout.
function logs(id, { tail = 200 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', ['logs', '--tail', String(tail), containerName(id)], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve((stdout || '') + (stderr || ''));
    });
  });
}

async function inspect(id) {
  let stdout;
  try {
    stdout = await run(['inspect', containerName(id)]);
  } catch (err) {
    if (/no such object/i.test(err.message)) return null;
    throw err;
  }
  const [info] = JSON.parse(stdout);
  const state = info.State || {};
  return {
    status: state.Status,
    running: !!state.Running,
    exitCode: state.ExitCode,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt && state.FinishedAt !== '0001-01-01T00:00:00Z' ? state.FinishedAt : null,
    error: state.Error || null,
  };
}

async function listNetworks() {
  const stdout = await run(['network', 'ls', '--format', '{{.Name}}']);
  return stdout.split('\n').filter(Boolean);
}

module.exports = { start, stop, remove, restart, logs, inspect, listNetworks, containerName, dockerizeUrl };
