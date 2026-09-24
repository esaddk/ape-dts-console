'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { toIni, parseIni, validate } = require('../lib/ini.js');
const { parseMonitorLine, parsePositionLine, parseDefaultLogLine, Tailer, readTailLines } = require('../lib/logs.js');
const { parseCheckLine, aggregateCheckLogs, readCheckResult } = require('../lib/checklog.js');
const { nextStatus } = require('../lib/status.js');
const { isTransient, shouldRetry, MAX_RETRIES } = require('../lib/retry.js');
const { dockerizeUrl } = require('../lib/docker.js');
const { hashPassword, verifyPassword, createSessionToken, verifySession, addUser, listUsers, verifyLogin, hasUsers } = require('../lib/auth.js');
const { buildUrl, buildFormData, checkFormFromTaskForm, cdcFormFromMigrateForm, mergeFormData } = require('../public/formdata.js');
const {
  describeEngine, describeInstance, computeSyncStatus, lagSeconds, pipelineState,
  snapshotPipelineState, statusBucket, countByStatus, taskLabel, filterTasks, paginate, formatCreatedAt,
} = require('../public/view.js');

const schema = require('../schema.json');
const REPO_ROOT = path.join(__dirname, '..', '..');
const RUN_DIRS = [path.join(REPO_ROOT, 'run'), path.join(REPO_ROOT, 'run_mysql')].filter(fs.existsSync);

test('real log fixtures exist (run/, run_mysql/ from prior CDC tests)', () => {
  assert.ok(RUN_DIRS.length > 0, 'expected at least one of run/ or run_mysql/ to exist on disk');
});

for (const dir of RUN_DIRS) {
  const name = path.basename(dir);

  test(`${name}: task_config.ini round-trips through parseIni/toIni`, () => {
    const iniPath = path.join(dir, 'task_config.ini');
    const original = fs.readFileSync(iniPath, 'utf8');
    const parsed = parseIni(original);
    assert.ok(parsed.extractor && parsed.extractor.db_type, 'extractor.db_type missing after parse');
    assert.ok(parsed.sinker && parsed.sinker.url, 'sinker.url missing after parse');

    const reformatted = toIni(parsed, schema);
    const reparsed = parseIni(reformatted);
    assert.deepEqual(reparsed, parsed, 'round-trip through toIni should preserve all parsed values');
  });

  test(`${name}: every monitor.log line parses`, () => {
    const lines = fs.readFileSync(path.join(dir, 'logs', 'monitor.log'), 'utf8').trim().split('\n');
    const parsed = lines.map(parseMonitorLine);
    assert.ok(parsed.every(Boolean), 'every monitor.log line should parse');
    assert.ok(parsed.every((p) => typeof p.component === 'string' && p.component.length > 0));
    assert.ok(parsed.every((p) => Object.values(p.values).every((v) => typeof v === 'number' && !Number.isNaN(v))));
  });

  test(`${name}: position.log parses and filters {"type":"None"} noise`, () => {
    const lines = fs.readFileSync(path.join(dir, 'logs', 'position.log'), 'utf8').trim().split('\n');
    const parsed = lines.map(parsePositionLine);
    assert.ok(parsed.some((p) => p === null), 'expected some None-position lines to be filtered to null');
    for (const p of parsed) {
      if (p === null) continue;
      assert.ok(p.kind === 'current_position' || p.kind === 'checkpoint_position');
      assert.notEqual(p.data.type, 'None');
    }
  });

  test(`${name}: default.log parses into ts/level/message`, () => {
    const lines = fs.readFileSync(path.join(dir, 'logs', 'default.log'), 'utf8').trim().split('\n');
    const parsed = lines.map(parseDefaultLogLine);
    assert.equal(parsed.length, lines.length);
    assert.ok(parsed.every((p) => typeof p.isError === 'boolean'));
    assert.ok(parsed.some((p) => p.level === 'INFO'), 'expected at least one INFO line');
  });
}

test('run_mysql: default.log flags the known ERROR/panic lines from that run', () => {
  const lines = fs.readFileSync(path.join(REPO_ROOT, 'run_mysql', 'logs', 'default.log'), 'utf8').trim().split('\n');
  const parsed = lines.map(parseDefaultLogLine);
  assert.ok(parsed.some((p) => p.isError), 'this fixture is known to contain an ERROR/panic line');
});

test('Tailer: incremental reads, partial-line buffering, truncation reset', () => {
  const tmp = path.join(require('os').tmpdir(), `tailer-test-${Date.now()}.log`);
  fs.writeFileSync(tmp, 'line1\nline2\n');
  const t = new Tailer(tmp, { fromStart: true });
  assert.deepEqual(t.poll(), ['line1', 'line2']);
  assert.deepEqual(t.poll(), []);

  fs.appendFileSync(tmp, 'partial-no-newline');
  assert.deepEqual(t.poll(), [], 'partial line without trailing newline should not be emitted yet');
  fs.appendFileSync(tmp, ' done\n');
  assert.deepEqual(t.poll(), ['partial-no-newline done']);

  fs.writeFileSync(tmp, 'after-truncate\n'); // simulates log rotation
  assert.deepEqual(t.poll(), ['after-truncate']);
  fs.unlinkSync(tmp);
});

test('Tailer: default (fromStart unset) skips pre-existing content — live SSE connections should not replay history', () => {
  const tmp = path.join(require('os').tmpdir(), `tailer-test-${Date.now()}-live.log`);
  fs.writeFileSync(tmp, 'old-line-1\nold-line-2\n');
  const t = new Tailer(tmp);
  assert.deepEqual(t.poll(), [], 'must not read content written before the tailer was constructed');
  fs.appendFileSync(tmp, 'new-line\n');
  assert.deepEqual(t.poll(), ['new-line']);
  fs.unlinkSync(tmp);
});

test('readTailLines: bounded read still recovers the latest lines regardless of file size', () => {
  const tmp = path.join(require('os').tmpdir(), `tail-test-${Date.now()}.log`);
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`line-${i}`);
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  const tail = readTailLines(tmp, 200); // tiny cap, well under the file's real size
  assert.ok(tail.length > 0 && tail.length < 500, 'must not replay the whole file');
  assert.equal(tail[tail.length - 1], 'line-499', 'must recover the most recent line');
  fs.unlinkSync(tmp);
});

test('readTailLines: missing file returns empty, no throw', () => {
  assert.deepEqual(readTailLines('/nonexistent/path.log'), []);
});

test('validate: cdc_mysql preset is valid as-is', () => {
  const errors = validate(schema.presets.cdc_mysql.values, schema);
  assert.deepEqual(errors, []);
});

test('validate: rejects unknown enum value before any container would be created', () => {
  const form = JSON.parse(JSON.stringify(schema.presets.cdc_mysql.values));
  form.parallelizer.parallel_type = 'not_a_real_type';
  const errors = validate(form, schema);
  assert.ok(errors.some((e) => e.includes('parallel_type')));
});

test('validate: server_id required for mysql cdc (requiredIf)', () => {
  const form = JSON.parse(JSON.stringify(schema.presets.cdc_mysql.values));
  delete form.extractor.server_id;
  const errors = validate(form, schema);
  assert.ok(errors.some((e) => e.includes('server_id')));
});

test('buildUrl: per db_type, with default-port fill-in', () => {
  assert.equal(buildUrl({ db_type: 'pg', host: 'src-pg', port: 5432, database: 'orders' }), 'postgres://src-pg:5432/orders');
  assert.equal(buildUrl({ db_type: 'pg', host: 'src-pg', database: 'orders' }), 'postgres://src-pg:5432/orders', 'missing port should fall back to the pg default');
  assert.equal(buildUrl({ db_type: 'mysql', host: 'src-mysql' }), 'mysql://src-mysql:3306?ssl-mode=disabled');
  assert.equal(buildUrl({ db_type: 'mongo', host: 'src-mongo' }), 'mongodb://src-mongo:27017');
  assert.throws(() => buildUrl({ db_type: 'pg' }), /host and port/);
});

test('buildUrl: embeds credentials in the URL authority (pinned ape-dts image ignores separate username/password ini keys)', () => {
  assert.equal(
    buildUrl({ db_type: 'pg', host: 'src-pg', port: 5432, database: 'orders', username: 'postgres', password: 'p@ss/word' }),
    'postgres://postgres:p%40ss%2Fword@src-pg:5432/orders',
    'credentials must be percent-encoded into the URL authority'
  );
  assert.equal(
    buildUrl({ db_type: 'mysql', host: 'src-mysql', username: 'root', password: '' }),
    'mysql://root:@src-mysql:3306?ssl-mode=disabled'
  );
});

test('buildFormData: pg source produces empty do_dbs + schema-qualified do_tbs, auto slot_name', () => {
  const formData = buildFormData({
    source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1', 'tb_2'] },
    dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
  });
  assert.equal(formData.extractor.db_type, 'pg');
  assert.equal(formData.extractor.extract_type, 'cdc');
  assert.equal(formData.extractor.url, 'postgres://postgres:postgres@src-pg:5432/postgres');
  assert.ok(formData.extractor.slot_name, 'pg source should get an auto-generated slot_name');
  assert.equal(formData.filter.do_dbs, '');
  assert.equal(formData.filter.do_tbs, 'test_db_1.tb_1,test_db_1.tb_2');
  assert.deepEqual(formData.filter.do_events, ['insert', 'update', 'delete']);
  assert.equal(formData.sinker.url, 'postgres://postgres:postgres@dst-pg:5432/postgres');

  const errors = validate(formData, schema);
  assert.deepEqual(errors, [], 'a pg CDC form built this way must pass the same validate() the server runs');
});

test('buildFormData: no opts still produces the default CDC form (regression guard)', () => {
  const args = {
    source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1'] },
    dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
  };
  const withoutOpts = buildFormData(args);
  const withCdcOpt = buildFormData(args, { extract_type: 'cdc' });
  assert.equal(withoutOpts.extractor.extract_type, 'cdc');
  assert.deepEqual(withoutOpts, withCdcOpt, 'omitting opts must be byte-identical to explicit extract_type: cdc');
});

test('buildFormData: extract_type=snapshot on a pg source — no slot_name, snapshot parallel_type, insert-only, validates', () => {
  const formData = buildFormData(
    {
      source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1', 'tb_2'] },
      dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
    },
    { extract_type: 'snapshot' }
  );
  assert.equal(formData.extractor.extract_type, 'snapshot');
  assert.equal(formData.extractor.slot_name, undefined, 'snapshot extract_type must not carry a cdc-only field');
  assert.equal(formData.extractor.server_id, undefined, 'snapshot extract_type must not carry a cdc-only field');
  assert.equal(formData.parallelizer.parallel_type, 'snapshot');
  assert.deepEqual(formData.filter.do_events, ['insert']);

  const errors = validate(formData, schema);
  assert.deepEqual(errors, [], 'a snapshot form built this way must pass the same validate() the server runs');
});

test('buildFormData: mysql source filters by database name, not schema, auto server_id', () => {
  const formData = buildFormData({
    source: { db_type: 'mysql', host: 'src-mysql', port: 3306, username: 'root', password: '123456', database: 'test_db', tables: [] },
    dest: { db_type: 'mysql', host: 'dst-mysql', port: 3306, username: 'root', password: '123456', database: 'test_db' },
  });
  assert.equal(typeof formData.extractor.server_id, 'number');
  assert.equal(formData.filter.do_dbs, 'test_db');
  assert.equal(formData.filter.do_tbs, '', 'no tables checked means all tables in the database');

  const errors = validate(formData, schema);
  assert.deepEqual(errors, []);
});

test('mergeFormData: an explicit Advanced-panel override wins over the simple-panel base', () => {
  const base = buildFormData({
    source: { db_type: 'mysql', host: 'src-mysql', port: 3306, database: 'test_db', tables: [] },
    dest: { db_type: 'mysql', host: 'dst-mysql', port: 3306, database: 'test_db' },
  });
  assert.equal(base.parallelizer.parallel_size, 2);

  const merged = mergeFormData(base, { parallelizer: { parallel_size: 16 } });
  assert.equal(merged.parallelizer.parallel_size, 16, 'advanced override should win');
  assert.equal(merged.parallelizer.parallel_type, 'rdb_merge', 'untouched keys in the same section should survive the merge');
  assert.equal(merged.extractor.url, base.extractor.url, 'sections the override never mentions should pass through unchanged');
});

test('checkFormFromTaskForm: derives from a real CDC formData, reuses both URLs verbatim, drops slot_name, validates', () => {
  const cdcForm = buildFormData({
    source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1', 'tb_2'] },
    dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
  });
  assert.ok(cdcForm.extractor.slot_name, 'sanity: the source CDC form does carry a slot_name');

  const checkForm = checkFormFromTaskForm(cdcForm);
  assert.equal(checkForm.extractor.url, cdcForm.extractor.url, 'must hit the same source endpoint the running task uses');
  assert.equal(checkForm.sinker.url, cdcForm.sinker.url, 'must hit the same target endpoint the running task uses');
  assert.equal(checkForm.extractor.extract_type, 'snapshot');
  assert.equal(checkForm.extractor.slot_name, undefined, 'snapshot extract_type has no slot to drop into');
  assert.equal(checkForm.sinker.sink_type, 'check');
  assert.equal(checkForm.filter.do_tbs, cdcForm.filter.do_tbs);

  assert.deepEqual(validate(checkForm, schema), []);
});

test('cdcFormFromMigrateForm: patches a snapshot form into the migrate flow\'s CDC phase, preserves both URLs, validates', () => {
  const snapshotForm = buildFormData(
    {
      source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1'] },
      dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
    },
    { extract_type: 'snapshot' }
  );
  assert.deepEqual(snapshotForm.filter.do_events, ['insert'], 'sanity: snapshot phase is insert-only before patching');

  const cdcForm = cdcFormFromMigrateForm(snapshotForm, { slotName: 'ape_dts_migrate_abc123', startLsn: '0/1A2B3C4', pubName: 'ape_dts_migrate_abc123_publication_for_all_tables' });

  assert.equal(cdcForm.extractor.extract_type, 'cdc');
  assert.equal(cdcForm.extractor.slot_name, 'ape_dts_migrate_abc123');
  assert.equal(cdcForm.extractor.start_lsn, '0/1A2B3C4');
  assert.equal(cdcForm.extractor.pub_name, 'ape_dts_migrate_abc123_publication_for_all_tables', 'must reuse the publication pgslot.js pre-created, never let the engine auto-create its own (catalog-visibility race)');
  assert.equal(cdcForm.extractor.recreate_slot_if_exists, false, 'must never let the engine drop the pre-created slot');
  assert.deepEqual(cdcForm.filter.do_events, ['insert', 'update', 'delete']);
  assert.equal(cdcForm.parallelizer.parallel_type, 'rdb_merge');
  assert.equal(cdcForm.extractor.url, snapshotForm.extractor.url, 'must hit the same source endpoint the snapshot phase used');
  assert.equal(cdcForm.sinker.url, snapshotForm.sinker.url, 'must hit the same target endpoint the snapshot phase used');

  assert.deepEqual(validate(cdcForm, schema), []);
});

test('check task ini round-trip: sink_type=check and parallel_type=rdb_check survive toIni/parseIni, no [checker] section', () => {
  const cdcForm = buildFormData({
    source: { db_type: 'pg', host: 'src-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres', schema: 'test_db_1', tables: ['tb_1'] },
    dest: { db_type: 'pg', host: 'dst-pg', port: 5432, username: 'postgres', password: 'postgres', database: 'postgres' },
  });
  const formData = checkFormFromTaskForm(cdcForm);
  const ini = toIni(formData, schema);
  assert.match(ini, /sink_type=check/);
  assert.match(ini, /parallel_type=rdb_check/);
  assert.doesNotMatch(ini, /\[checker\]/, '2.0.22 image cannot parse a [checker] section');

  const reparsed = parseIni(ini);
  assert.equal(reparsed.sinker.sink_type, 'check');
  assert.equal(reparsed.parallelizer.parallel_type, 'rdb_check');
});

// --- lib/checklog.js ------------------------------------------------------
// kind comes from the filename in both parseCheckLine's caller (readCheckResult)
// and these tests — never from an in-line discriminator. 2.0.22 lines happen to
// also carry "log_type":"Miss"/"Diff", but that field is ignored on purpose: it
// does not exist at all on HEAD/2.0.26 lines (dt-connector/src/checker/check_log.rs).

test('parseCheckLine: a 2.0.22-shaped line (log_type present) parses via filename-derived kind', () => {
  const line = '{"log_type":"Diff","schema":"test_db_1","tb":"one_pk_multi_uk","id_col_values":{"f_0":"5"},"diff_col_values":{"f_1":{"src":"5","dst":"5000"}}}';
  const entry = parseCheckLine(line, 'diff');
  assert.equal(entry.kind, 'diff');
  assert.equal(entry.schema, 'test_db_1');
  assert.equal(entry.tb, 'one_pk_multi_uk');
  assert.deepEqual(entry.id_col_values, { f_0: '5' });
  assert.deepEqual(entry.diff_col_values, { f_1: { src: '5', dst: '5000' } });
});

test('parseCheckLine: a HEAD/2.0.26-shaped line (no log_type, has target_schema) parses the same way', () => {
  const line = '{"schema":"src_s","tb":"src_t","target_schema":"dst_s","target_tb":"src_t","id_col_values":{"id":"1"},"diff_col_values":{"name":{"src":null,"dst":"dst","src_type":"None","dst_type":"String"}}}';
  const entry = parseCheckLine(line, 'diff');
  assert.equal(entry.kind, 'diff');
  assert.equal(entry.schema, 'src_s');
  assert.equal(entry.tb, 'src_t');
  assert.deepEqual(entry.diff_col_values.name, { src: null, dst: 'dst', src_type: 'None', dst_type: 'String' });
});

test('parseCheckLine: column names with commas/backslashes must be JSON.parse-d, never string-split', () => {
  const line = JSON.stringify({
    schema: 's1',
    tb: 't1',
    id_col_values: { 'col,with,commas': '1' },
    diff_col_values: { 'weird\\"col': { src: 'a,b', dst: 'c\\d' } },
  });
  const entry = parseCheckLine(line, 'diff');
  assert.equal(entry.diff_col_values['weird\\"col'].src, 'a,b');
  assert.equal(entry.diff_col_values['weird\\"col'].dst, 'c\\d');
});

test('parseCheckLine: empty, blank, and truncated lines return null without throwing', () => {
  assert.equal(parseCheckLine('', 'miss'), null);
  assert.equal(parseCheckLine('   ', 'miss'), null);
  assert.equal(parseCheckLine('{"schema":"s1","tb":', 'miss'), null);
  assert.equal(parseCheckLine('not json at all', 'miss'), null);
});

test('aggregateCheckLogs: miss and diff are counted separately, per table', () => {
  const missLine = (schema, tb) => JSON.stringify({ schema, tb, id_col_values: {}, diff_col_values: {} });
  const diffLine = (schema, tb) => JSON.stringify({ schema, tb, id_col_values: {}, diff_col_values: { f: { src: '1', dst: '2' } } });
  const result = aggregateCheckLogs({
    miss: [missLine('s1', 't1'), missLine('s1', 't1'), missLine('s2', 't2')],
    diff: [diffLine('s1', 't1')],
  });
  const t1 = result.tables.find((t) => t.schema === 's1' && t.tb === 't1');
  const t2 = result.tables.find((t) => t.schema === 's2' && t.tb === 't2');
  assert.equal(t1.miss, 2);
  assert.equal(t1.diff, 1);
  assert.equal(t1.total, 3);
  assert.equal(t1.status, 'bad');
  assert.equal(t2.miss, 1);
  assert.equal(t2.status, 'bad');
  assert.equal(result.totals.miss, 3);
  assert.equal(result.totals.diff, 1);
  assert.equal(result.totals.total, 4);
});

test('aggregateCheckLogs: all-empty input is the normal healthy result — zero totals, no tables', () => {
  const result = aggregateCheckLogs({ miss: [], diff: [] });
  assert.deepEqual(result.tables, []);
  assert.deepEqual(result.totals, { miss: 0, diff: 0, total: 0 });
  assert.equal(result.truncated, false);
});

for (const dir of RUN_DIRS) {
  const name = path.basename(dir);
  test(`${name}: readCheckResult against the real run's logs/ dir never throws`, () => {
    const result = readCheckResult(path.join(dir, 'logs'));
    assert.ok(Array.isArray(result.tables));
    assert.equal(typeof result.totals.total, 'number');
  });
}

test('readCheckResult: a check dir with no log files at all is the healthy empty result', () => {
  const result = readCheckResult(path.join(REPO_ROOT, 'this-dir-does-not-exist-checklog-test'));
  assert.deepEqual(result.tables, []);
  assert.deepEqual(result.totals, { miss: 0, diff: 0, total: 0 });
});

// --- lib/status.js ---------------------------------------------------------

test('nextStatus: a still-running container means no change', () => {
  assert.equal(nextStatus({ running: true, exitCode: null, finishedAt: null }), null);
});

test('nextStatus: exit 0 becomes completed with a finishedAt', () => {
  const patch = nextStatus({ running: false, exitCode: 0, finishedAt: '2026-09-15T10:00:00Z' });
  assert.equal(patch.status, 'completed');
  assert.equal(patch.exitCode, 0);
  assert.equal(patch.finishedAt, '2026-09-15T10:00:00Z');
});

test('nextStatus: a non-zero exit (e.g. 137, OOM-killed) becomes failed', () => {
  const patch = nextStatus({ running: false, exitCode: 137, finishedAt: '2026-09-15T10:00:00Z' });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.exitCode, 137);
});

// --- lib/retry.js ------------------------------------------------------------

test('isTransient: matches the known PG replication-disconnect panic signatures', () => {
  assert.equal(isTransient('thread panicked: unexpected replication stream error: db error'), true);
  assert.equal(isTransient('io error: Connection reset by peer'), true);
  assert.equal(isTransient('FATAL: terminating connection due to administrator command\nconnection closed'), true);
});

test('isTransient: does not match permanent misconfiguration errors', () => {
  assert.equal(isTransient('FATAL: password authentication failed for user "postgres"'), false);
  assert.equal(isTransient('ERROR: relation "test_db_1.tb_missing" does not exist'), false);
  assert.equal(isTransient(''), false);
  assert.equal(isTransient(undefined), false);
});

test('shouldRetry: only transient failures under the retry cap are retried', () => {
  assert.equal(shouldRetry({ retryCount: 0, logText: 'connection reset by peer' }), true);
  assert.equal(shouldRetry({ retryCount: MAX_RETRIES, logText: 'connection reset by peer' }), false, 'must stop at the cap to avoid an infinite crash-loop');
  assert.equal(shouldRetry({ retryCount: 0, logText: 'password authentication failed' }), false, 'permanent errors are never retried regardless of budget');
});

test('nextStatus: a null inspect result (container gone) becomes removed', () => {
  const patch = nextStatus(null);
  assert.equal(patch.status, 'removed');
  assert.equal(patch.containerName, null);
});

test('dockerizeUrl: localhost/127.0.0.1 become host.docker.internal, everything else is untouched', () => {
  assert.equal(dockerizeUrl('postgres://postgres:postgres@localhost:15432/postgres'), 'postgres://postgres:postgres@host.docker.internal:15432/postgres');
  assert.equal(dockerizeUrl('mysql://root:pw@127.0.0.1:3306'), 'mysql://root:pw@host.docker.internal:3306');
  assert.equal(dockerizeUrl('postgres://postgres:postgres@db.example.com:5432/postgres'), 'postgres://postgres:postgres@db.example.com:5432/postgres');
  assert.equal(dockerizeUrl('not a url'), 'not a url');
});

// --- public/view.js ---------------------------------------------------------

test('statusBucket: all six real statuses, including completed and removed->stopped', () => {
  assert.equal(statusBucket({ status: 'starting' }), 'running');
  assert.equal(statusBucket({ status: 'running' }), 'running');
  assert.equal(statusBucket({ status: 'stopped' }), 'stopped');
  assert.equal(statusBucket({ status: 'removed' }), 'stopped');
  assert.equal(statusBucket({ status: 'failed' }), 'failed');
  assert.equal(statusBucket({ status: 'completed' }), 'completed');
});

test('formatCreatedAt: ISO string truncated to minute, missing value is a dash', () => {
  assert.equal(formatCreatedAt('2026-09-16T04:46:41.592Z'), '2026-09-16 04:46');
  assert.equal(formatCreatedAt(null), '-');
  assert.equal(formatCreatedAt(undefined), '-');
});

test('countByStatus: "all" equals the array length', () => {
  const metas = [{ status: 'running' }, { status: 'stopped' }, { status: 'failed' }, { status: 'completed' }, { status: 'removed' }];
  const counts = countByStatus(metas);
  assert.equal(counts.all, metas.length);
  assert.equal(counts.running, 1);
  assert.equal(counts.stopped, 2);
  assert.equal(counts.failed, 1);
  assert.equal(counts.completed, 1);
});

test('filterTasks: matches by name and by id, case-insensitively', () => {
  const metas = [
    { id: 'abc123', name: 'prod-cdc-pg' },
    { id: 'xyz789', name: 'staging sync' },
  ];
  assert.deepEqual(filterTasks(metas, { query: 'PROD' }).map((m) => m.id), ['abc123']);
  assert.deepEqual(filterTasks(metas, { query: 'XYZ' }).map((m) => m.id), ['xyz789']);
  assert.deepEqual(filterTasks(metas, { query: 'nomatch' }), []);
});

test('paginate: last partial page, a page past the end, and an empty array', () => {
  const items = [1, 2, 3, 4, 5];
  const last = paginate(items, 2, 3);
  assert.deepEqual(last.items, [4, 5]);
  assert.equal(last.pages, 2);

  const pastEnd = paginate(items, 99, 3);
  assert.equal(pastEnd.page, 2, 'clamps to the last real page');

  const empty = paginate([], 1, 10);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pages, 1, 'pages must be >= 1 so the pager never renders "Page 1 of 0"');
});

test('lagSeconds: 0 for equal timestamps, a finite number for a real lagging pair, null for null input', () => {
  const equal = { data: { timestamp: '2026-09-15 10:00:00.000000' } };
  assert.equal(lagSeconds(equal, equal), 0);

  const current = { data: { timestamp: '2026-09-15 10:00:05.000000' } };
  const checkpoint = { data: { timestamp: '2026-09-15 10:00:02.500000' } };
  assert.equal(lagSeconds(current, checkpoint), 2.5);

  assert.equal(lagSeconds(null, checkpoint), null);
  assert.equal(lagSeconds(current, null), null);
});

test('computeSyncStatus: unchanged after extracting lagSeconds — in sync, catching up with a lag, and waiting', () => {
  const same = { data: { type: 'None' } };
  assert.deepEqual(computeSyncStatus(same, same), { label: 'in sync', cls: 'running' });

  const current = { data: { timestamp: '2026-09-15 10:00:05.000000' } };
  const checkpoint = { data: { timestamp: '2026-09-15 10:00:02.500000' } };
  const status = computeSyncStatus(current, checkpoint);
  assert.equal(status.label, 'catching up · lag 2.5s');
  assert.equal(status.cls, 'starting');

  assert.deepEqual(computeSyncStatus(null, null), { label: 'waiting…', cls: '' });
});

test('pipelineState: staleness overrides an in-sync verdict, catching-up keeps its lag text', () => {
  assert.equal(pipelineState({ label: 'in sync', cls: 'running' }, true).cls, 'state-stale');
  assert.equal(pipelineState({ label: 'in sync', cls: 'running' }, false).cls, 'state-ok');
  const lagState = pipelineState({ label: 'catching up · lag 3.2s', cls: 'starting' }, false);
  assert.equal(lagState.cls, 'state-lag');
  assert.equal(lagState.text, 'catching up · lag 3.2s');
});

test('snapshotPipelineState: reads container status + cumulative row count instead of a position diff', () => {
  assert.deepEqual(snapshotPipelineState('completed', 25), { cls: 'state-ok', text: 'Snapshot complete — 25 rows copied' });
  assert.deepEqual(snapshotPipelineState('completed', 1), { cls: 'state-ok', text: 'Snapshot complete — 1 row copied' });
  assert.deepEqual(snapshotPipelineState('failed', 10), { cls: 'state-stale', text: 'Snapshot failed — 10 rows copied' });
  assert.deepEqual(snapshotPipelineState('stopped', null), { cls: '', text: 'Snapshot stopped' });
  assert.deepEqual(snapshotPipelineState('removed', 5), { cls: '', text: 'Snapshot stopped — 5 rows copied' });
  assert.deepEqual(snapshotPipelineState('running', null), { cls: 'state-lag', text: 'Copying…' });
  assert.deepEqual(snapshotPipelineState('running', 12), { cls: 'state-lag', text: 'Copying… — 12 rows copied' });
});

test('auth: hashPassword/verifyPassword round-trip, wrong password rejected', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
  assert.equal(verifyPassword('correct horse battery staple', 'not:a-real-hash-format'), false);
});

test('auth: session token round-trips, tampering invalidates it', () => {
  const token = createSessionToken('alice', 'admin');
  const session = verifySession(token);
  assert.equal(session.u, 'alice');
  assert.equal(session.role, 'admin');
  assert.equal(verifySession(null), null);
  assert.equal(verifySession('garbage'), null);
  assert.equal(verifySession(token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a')), null);
});

test('auth: addUser/listUsers/verifyLogin round-trip with roles', () => {
  // addUser/listUsers write the real (git-ignored) auth/users.json — snapshot and
  // restore it so running the test suite never disturbs an actual deployment's accounts.
  const usersPath = path.join(__dirname, '..', 'auth', 'users.json');
  const before = fs.existsSync(usersPath) ? fs.readFileSync(usersPath, 'utf8') : null;
  try {
    fs.rmSync(usersPath, { force: true });
    assert.equal(hasUsers(), false);
    addUser('admin1', 'adminpass123', 'admin');
    addUser('user1', 'userpass123', 'user');
    assert.equal(hasUsers(), true);
    const users = listUsers().sort((a, b) => a.username.localeCompare(b.username));
    assert.deepEqual(users, [{ username: 'admin1', role: 'admin' }, { username: 'user1', role: 'user' }]);
    assert.deepEqual(verifyLogin('admin1', 'adminpass123'), { username: 'admin1', role: 'admin' });
    assert.equal(verifyLogin('admin1', 'wrong'), null);
    assert.equal(verifyLogin('nobody', 'x'), null);
  } finally {
    if (before === null) fs.rmSync(usersPath, { force: true });
    else fs.writeFileSync(usersPath, before);
  }
});
