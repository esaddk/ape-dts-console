'use strict';
// Pure functions turning the simple Source/Destination panels into the same
// formData shape lib/ini.js expects. Runs in both the browser (app.js) and
// Node (test/parse.test.js) — no bundler, so plain UMD-lite export.
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(global, factory());
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEFAULT_PORTS = { pg: 5432, mysql: 3306, mongo: 27017 };

  // Credentials are embedded in the URL authority (not left to the separate
  // username/password ini keys) because the pinned ape-dts image
  // (apecloud/ape-dts:2.0.22, see lib/docker.js) predates the
  // connection_auth_config overlay feature and silently ignores those keys —
  // without embedded creds it falls back to the OS user (root) and fails auth.
  function buildUrl({ db_type, host, port, username, password, database }) {
    const p = port || DEFAULT_PORTS[db_type];
    if (!host || !p) throw new Error('host and port are required');
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
    if (db_type === 'pg') return `postgres://${auth}${host}:${p}/${database || 'postgres'}`;
    if (db_type === 'mysql') return `mysql://${auth}${host}:${p}?ssl-mode=disabled`;
    if (db_type === 'mongo') return `mongodb://${auth}${host}:${p}`;
    throw new Error(`buildUrl: unsupported db_type "${db_type}"`);
  }

  // Deterministic (no Date.now/Math.random) so server_id/slot_name are
  // reproducible in tests and stable across resubmits of the same form.
  function stableId(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  // Shared by buildFormData and buildCheckForm — do_dbs/do_tbs derivation only
  // differs by db_type (pg is schema-qualified, mysql/mongo are database-qualified).
  function buildFilter(source, doEvents) {
    const filter = { do_events: doEvents };
    const tables = (source.tables || []).filter(Boolean);
    if (source.db_type === 'pg') {
      const schema = source.schema || 'public';
      filter.do_dbs = '';
      filter.do_tbs = tables.length ? tables.map((t) => `${schema}.${t}`).join(',') : '';
    } else {
      filter.do_dbs = source.database || '';
      filter.do_tbs = tables.length ? tables.map((t) => `${source.database}.${t}`).join(',') : '';
    }
    return filter;
  }

  // rdb_check for mysql/pg, mongo for mongo (ui/schema.json parallel_type enum,
  // 2.0.22-pinned image — see docs/en/config_changelog.md "removed in 2.0.26").
  function checkParallelType(db_type) {
    return db_type === 'mongo' ? 'mongo' : 'rdb_check';
  }

  // source/dest: { db_type, host, port, username, password, database, schema?, tables? }
  // opts.extract_type defaults to 'cdc' — omitting opts keeps this call byte-identical
  // to the pre-check-task behavior (test/parse.test.js pins that output).
  function buildFormData({ source, dest }, opts = {}) {
    const extractType = opts.extract_type || 'cdc';
    const seed = `${source.host}:${source.port}:${source.database}:${source.schema || ''}`;

    const extractor = {
      db_type: source.db_type,
      extract_type: extractType,
      url: buildUrl(source),
      username: source.username || '',
      password: source.password || '',
    };
    if (extractType === 'cdc') {
      if (source.db_type === 'mysql') {
        extractor.server_id = 1000 + (stableId(seed) % 8999);
      } else if (source.db_type === 'pg') {
        extractor.slot_name = 'ape_dts_' + stableId(seed).toString(36);
      }
    }

    const filter = buildFilter(source, extractType === 'snapshot' ? ['insert'] : ['insert', 'update', 'delete']);

    const sinker = {
      db_type: dest.db_type,
      sink_type: 'write',
      url: buildUrl(dest),
      username: dest.username || '',
      password: dest.password || '',
      batch_size: 200,
    };

    // Values proven end-to-end against real mysql/pg/mongo CDC runs; snapshot
    // uses the parallelizer schema.json's own snapshot preset uses instead.
    const parallelizer = extractType === 'snapshot'
      ? { parallel_type: 'snapshot', parallel_size: 2 }
      : { parallel_type: 'rdb_merge', parallel_size: 2 };
    const pipeline = { buffer_size: 4000, checkpoint_interval_secs: 1 };

    return { extractor, filter, sinker, parallelizer, pipeline, metrics: {}, metrics_enabled: false };
  }

  // Standalone data-verification task: extract_type=snapshot (one-shot), sink_type=check
  // (diffs against the target instead of writing), do_events=['insert'] (check ignores the
  // rest). Deliberately does NOT set check_log_dir — the container default
  // (LOG_DIR_PLACEHOLDER/check) already lands under the same -v ${logsDir}:/logs/ mount
  // a CDC task uses. No [checker] section: that's a 2.0.26 shape the pinned 2.0.22 image
  // (lib/docker.js) can't parse — batch size instead goes on [sinker], same as a write task.
  function buildCheckForm({ source, dest }) {
    const extractor = {
      db_type: source.db_type,
      extract_type: 'snapshot',
      url: buildUrl(source),
      username: source.username || '',
      password: source.password || '',
    };

    const filter = buildFilter(source, ['insert']);

    const sinker = {
      db_type: dest.db_type,
      sink_type: 'check',
      url: buildUrl(dest),
      username: dest.username || '',
      password: dest.password || '',
      batch_size: 200,
    };

    const parallelizer = { parallel_type: checkParallelType(source.db_type), parallel_size: 2 };
    const pipeline = { buffer_size: 4000, checkpoint_interval_secs: 1 };

    return { extractor, filter, sinker, parallelizer, pipeline, metrics: {}, metrics_enabled: false };
  }

  // Server-side: derives a check task's formData from an already-built CDC/snapshot
  // task's formData, reusing both URLs verbatim so the check hits the same endpoints
  // the running task does. Drops server_id/slot_name (snapshot extract_type needs
  // neither) rather than copying them from the source form.
  function checkFormFromTaskForm(formData) {
    const ext = (formData && formData.extractor) || {};
    const snk = (formData && formData.sinker) || {};
    const flt = (formData && formData.filter) || {};

    const extractor = {
      db_type: ext.db_type,
      extract_type: 'snapshot',
      url: ext.url,
      username: ext.username || '',
      password: ext.password || '',
    };

    const filter = {
      do_dbs: flt.do_dbs || '',
      do_tbs: flt.do_tbs || '',
      do_events: ['insert'],
    };

    const sinker = {
      db_type: snk.db_type,
      sink_type: 'check',
      url: snk.url,
      username: snk.username || '',
      password: snk.password || '',
      batch_size: 200,
    };

    const parallelizer = { parallel_type: checkParallelType(ext.db_type), parallel_size: 2 };
    const pipeline = { buffer_size: 4000, checkpoint_interval_secs: 1 };

    return { extractor, filter, sinker, parallelizer, pipeline, metrics: {}, metrics_enabled: false };
  }

  // Server-side: builds the CDC phase of a Migrate task from the already-run
  // snapshot phase's formData, so both phases hit identical endpoints. Not built
  // via buildFormData({extract_type:'cdc'}) — that regenerates slot_name from a
  // seed with no way to inject the pre-created one.
  function cdcFormFromMigrateForm(snapshotFormData, { slotName, startLsn, pubName }) {
    const ext = (snapshotFormData && snapshotFormData.extractor) || {};
    const snk = (snapshotFormData && snapshotFormData.sinker) || {};
    const flt = (snapshotFormData && snapshotFormData.filter) || {};

    const extractor = {
      ...ext,
      extract_type: 'cdc',
      slot_name: slotName,
      start_lsn: startLsn,
      // Pre-created by pgslot.js at slot-creation time, not left to the CDC
      // container's own auto-create — see the comment in pgslot.js for the
      // replication-connection catalog-visibility race that otherwise panics.
      pub_name: pubName,
      recreate_slot_if_exists: false,
    };

    const filter = { ...flt, do_events: ['insert', 'update', 'delete'] };

    const sinker = { ...snk };

    const parallelizer = { parallel_type: 'rdb_merge', parallel_size: 2 };
    const pipeline = { buffer_size: 4000, checkpoint_interval_secs: 1 };

    return { extractor, filter, sinker, parallelizer, pipeline, metrics: {}, metrics_enabled: false };
  }

  // Section-wise shallow merge: any key an Advanced-panel field actually set
  // wins over the simple-panel-derived base value for that same key.
  function mergeFormData(base, overrides) {
    const result = {};
    const sections = new Set([...Object.keys(base), ...Object.keys(overrides || {})]);
    for (const key of sections) {
      if (key === 'metrics_enabled') continue;
      result[key] = { ...(base[key] || {}), ...((overrides && overrides[key]) || {}) };
    }
    result.metrics_enabled = overrides && overrides.metrics_enabled !== undefined ? overrides.metrics_enabled : !!base.metrics_enabled;
    return result;
  }

  return { buildUrl, buildFormData, buildCheckForm, checkFormFromTaskForm, cdcFormFromMigrateForm, mergeFormData, DEFAULT_PORTS };
});
