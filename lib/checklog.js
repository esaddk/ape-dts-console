'use strict';
const fs = require('fs');
const path = require('path');

// Parses one line of miss.log or diff.log into {kind, schema, tb, id_col_values, diff_col_values}.
// `kind` ('miss'|'diff') comes from the filename — the one signal that hasn't
// changed between the pinned image (2.0.22) and HEAD (2.0.26):
//   2.0.22 CheckLog carries {"log_type":"Miss"|"Diff"|"Unknown", schema, tb,
//     id_col_values, diff_col_values} (dt-connector/src/check_log/check_log.rs @ v2.0.22).
//   2.0.26 CheckLog dropped log_type entirely and added optional db/target_db/
//     target_schema/target_tb/src_row/dst_row (dt-connector/src/checker/check_log.rs).
// There is no third "extra" kind in either version for a sink_type=check task:
// target-only rows are folded into miss (checker_engine.rs build_missing_target_entry
// sets diff_cols:None -> is_miss()==true). A separate extra.log/log_extra! does exist
// in 2.0.22, but only for sink_type=struct's compare_struct DDL diff, writing plain
// "key: ..., dst_sql: ..." text, not JSON CheckLog lines — out of scope here.
function parseCheckLine(line, kind) {
  const text = (line || '').trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  if (typeof data.schema !== 'string' || typeof data.tb !== 'string') return null;
  return {
    kind,
    schema: data.schema,
    tb: data.tb,
    id_col_values: data.id_col_values || {},
    diff_col_values: data.diff_col_values || {},
  };
}

// {miss:[line,...], diff:[line,...]} -> {tables:[{schema,tb,miss,diff,total,status,samples}], totals, truncated}
function aggregateCheckLogs({ miss = [], diff = [] } = {}) {
  const tables = new Map();
  const SAMPLE_LIMIT = 5;
  let truncated = false;

  const ingest = (lines, kind) => {
    for (const rawLine of lines) {
      const entry = parseCheckLine(rawLine, kind);
      if (!entry) continue;
      const key = `${entry.schema}.${entry.tb}`;
      let row = tables.get(key);
      if (!row) {
        row = { schema: entry.schema, tb: entry.tb, miss: 0, diff: 0, samples: [] };
        tables.set(key, row);
      }
      row[kind] += 1;
      if (row.samples.length < SAMPLE_LIMIT) {
        row.samples.push(entry);
      } else {
        truncated = true;
      }
    }
  };
  ingest(miss, 'miss');
  ingest(diff, 'diff');

  const result = [...tables.values()].map((row) => {
    const total = row.miss + row.diff;
    return { ...row, total, status: total === 0 ? 'ok' : 'bad' };
  });

  const totals = result.reduce(
    (acc, row) => ({ miss: acc.miss + row.miss, diff: acc.diff + row.diff, total: acc.total + row.total }),
    { miss: 0, diff: 0, total: 0 }
  );

  return { tables: result, totals, truncated };
}

// One-shot read of a finished check task's log dir (runs/<id>/logs/check/). Not a
// Tailer: the container has already exited, the files are immutable, and the
// aggregate groups by schema.tb across the *whole* file — a partial read would give
// a wrong count, not just a smaller one.
function readCheckResult(logsDir) {
  const readLines = (file) => {
    const p = path.join(logsDir, file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  };
  return aggregateCheckLogs({ miss: readLines('miss.log'), diff: readLines('diff.log') });
}

module.exports = { parseCheckLine, aggregateCheckLogs, readCheckResult };
