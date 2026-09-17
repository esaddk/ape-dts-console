'use strict';
const fs = require('fs');

// Incrementally reads lines appended to a file since the last poll().
// Resets to the start if the file shrinks (log rotation/truncation).
class Tailer {
  // fromStart: read the whole file on the first poll() (used by tests against fixtures).
  // Default is tail-from-now — a live SSE connection has no use for a task's full
  // history, and reading/parsing/re-sending it on every page open or reload is what
  // made the detail page feel slow for a long-running task.
  constructor(filePath, { fromStart = false } = {}) {
    this.filePath = filePath;
    this.partial = '';
    this.offset = fromStart ? 0 : this.currentSize();
  }

  currentSize() {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  poll() {
    let size;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return []; // file not created yet
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];

    const fd = fs.openSync(this.filePath, 'r');
    const length = size - this.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, this.offset);
    fs.closeSync(fd);
    this.offset = size;

    const chunk = this.partial + buffer.toString('utf8');
    const lines = chunk.split('\n');
    this.partial = lines.pop(); // last (possibly incomplete) line kept for next poll
    return lines.filter(Boolean);
  }
}

// Reads only the last `maxBytes` of a file — enough lines to recover the latest
// value per counter/position kind without the cost of parsing a task's full
// history. Used once on SSE connect to seed current state; Tailer then picks up
// live from EOF. Bounded regardless of how long the task has been running.
function readTailLines(filePath, maxBytes = 65536) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, start);
  fs.closeSync(fd);
  const lines = buffer.toString('utf8').split('\n').filter(Boolean);
  if (start > 0) lines.shift(); // first line may be cut mid-way through
  return lines;
}

// "2026-09-15 09:25:02.348920 | pipeline |  | sinked_count | latest=0"
function parseMonitorLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 4) return null;
  const [ts, component, , counter, ...rest] = parts;
  const values = {};
  for (const part of rest) {
    for (const kv of part.split(/\s+/)) {
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      values[kv.slice(0, eq)] = Number(kv.slice(eq + 1));
    }
  }
  return { ts, component, counter, values };
}

// "2026-09-15 09:25:02.354907 | checkpoint_position | {"type":"None"}"
function parsePositionLine(line) {
  const idx1 = line.indexOf('|');
  const idx2 = line.indexOf('|', idx1 + 1);
  if (idx1 === -1 || idx2 === -1) return null;
  const ts = line.slice(0, idx1).trim();
  const kind = line.slice(idx1 + 1, idx2).trim(); // current_position | checkpoint_position
  const jsonText = line.slice(idx2 + 1).trim();
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (data.type === 'None') return null; // no position yet — noise
  return { ts, kind, data };
}

// "2026-09-15 09:25:01.356151 - WARN - [257039885711200] - heartbeat disabled, ..."
function parseDefaultLogLine(line) {
  const match = line.match(/^(\S+ \S+) - (\w+) - \[(\d+)\] - (.*)$/);
  if (!match) return { ts: null, level: null, thread: null, message: line, isError: /panic/i.test(line) };
  const [, ts, level, thread, message] = match;
  return { ts, level, thread, message, isError: level === 'ERROR' || /panic/i.test(message) };
}

module.exports = { Tailer, readTailLines, parseMonitorLine, parsePositionLine, parseDefaultLogLine };
