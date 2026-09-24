'use strict';
// Pure view helpers shared by the three page controllers in app.js. Lifted out
// (verbatim where noted) so they're require()-able from Node tests — app.js itself
// calls document.* at module scope and can't be. Same UMD-lite pattern as formdata.js.
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(global, factory());
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- lifted verbatim from app.js (describeEngine:364, describeInstance:376) ---

  function describeEngine(run) {
    const ext = (run.formData && run.formData.extractor) || {};
    const snk = (run.formData && run.formData.sinker) || {};
    if (!ext.db_type && !snk.db_type) return '';
    return ext.db_type === snk.db_type ? ext.db_type : `${ext.db_type || '?'} → ${snk.db_type || '?'}`;
  }

  function describeInstance(url) {
    if (!url) return '-';
    try {
      const u = new URL(url);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      return '-';
    }
  }

  // current_position = how far the source extractor has read; checkpoint_position =
  // how far the sinker has confirmed writes. Equal position data means the sinker
  // has fully caught up ("in sync"); otherwise lagSeconds carries the numeric gap
  // so the badge and the chart can never disagree about it.
  function lagSeconds(current, checkpoint) {
    if (!current || !checkpoint) return null;
    const tCur = Date.parse(((current.data && current.data.timestamp) || '').replace(' ', 'T'));
    const tChk = Date.parse(((checkpoint.data && checkpoint.data.timestamp) || '').replace(' ', 'T'));
    if (Number.isNaN(tCur) || Number.isNaN(tChk) || tCur < tChk) return null;
    return (tCur - tChk) / 1000;
  }

  function computeSyncStatus(current, checkpoint) {
    if (!current || !checkpoint) return { label: 'waiting…', cls: '' };
    if (JSON.stringify(current.data) === JSON.stringify(checkpoint.data)) {
      return { label: 'in sync', cls: 'running' };
    }
    const lag = lagSeconds(current, checkpoint);
    if (lag !== null) {
      return { label: `catching up · lag ${lag.toFixed(1)}s`, cls: 'starting' };
    }
    return { label: 'catching up', cls: 'starting' };
  }

  // Drives the Live Pipeline diagram/verdict on Page 3. Staleness (no position event
  // for >8s, computed by the caller) overrides the last-known sync label, since a
  // paused pipeline should read as "nothing is moving", not a stale "in sync".
  function pipelineState(sync, stale) {
    if (stale) return { cls: 'state-stale', text: 'No events received — the pipeline has gone quiet' };
    if (sync.cls === 'running') return { cls: 'state-ok', text: 'In sync — the target has caught up with the source' };
    return { cls: 'state-lag', text: sync.label };
  }

  // A snapshot task's checkpoint_position stays {"type":"None"} for its entire run
  // (parsePositionLine filters that out as noise), so computeSyncStatus/pipelineState
  // can never report anything but "waiting…" for one. Progress reads off the
  // container's own lifecycle (meta.status) plus the cumulative sinked_count counter
  // instead of a source/target position diff.
  function snapshotPipelineState(status, rowsCopied) {
    const rows = rowsCopied == null ? '' : ` — ${rowsCopied} row${rowsCopied === 1 ? '' : 's'} copied`;
    if (status === 'completed') return { cls: 'state-ok', text: `Snapshot complete${rows}` };
    if (status === 'failed') return { cls: 'state-stale', text: `Snapshot failed${rows}` };
    if (status === 'stopped' || status === 'removed') return { cls: '', text: `Snapshot stopped${rows}` };
    return { cls: 'state-lag', text: `Copying…${rows}` };
  }

  // --- new pure helpers for Page 2 (Task Center) ---

  // Real status enum is starting|running|failed|stopped|removed|completed. The
  // pill groups collapse starting+running -> running and stopped+removed -> stopped;
  // the badge elsewhere still shows the raw status.
  function statusBucket(meta) {
    const s = meta && meta.status;
    if (s === 'starting' || s === 'running') return 'running';
    if (s === 'stopped' || s === 'removed') return 'stopped';
    if (s === 'failed') return 'failed';
    if (s === 'completed') return 'completed';
    return 'stopped';
  }

  function countByStatus(metas) {
    const counts = { all: metas.length, running: 0, stopped: 0, failed: 0, completed: 0 };
    for (const meta of metas) counts[statusBucket(meta)] += 1;
    return counts;
  }

  // Deliberately not toLocaleString() — that's timezone/locale-dependent and makes
  // this untestable across machines. createdAt is always a new Date().toISOString()
  // from the server, so a straight string slice is enough.
  function formatCreatedAt(iso) {
    if (!iso) return '-';
    return iso.replace('T', ' ').slice(0, 16);
  }

  function taskLabel(meta) {
    return (meta && meta.name && meta.name.trim()) || (meta && meta.id) || '';
  }

  function kindLabel(kind) {
    return kind === 'migrate' ? 'snapshot + cdc' : kind;
  }

  function filterTasks(metas, { bucket, query } = {}) {
    let list = metas;
    if (bucket && bucket !== 'all') list = list.filter((m) => statusBucket(m) === bucket);
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((m) => (m.name || '').toLowerCase().includes(q) || (m.id || '').toLowerCase().includes(q));
    }
    return list;
  }

  // pages is always >= 1, even for an empty list, so the pager never renders "Page 1 of 0".
  function paginate(items, page, per) {
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / per));
    const clamped = Math.min(Math.max(1, page || 1), pages);
    const start = (clamped - 1) * per;
    return { items: items.slice(start, start + per), page: clamped, pages, total };
  }

  return {
    describeEngine, describeInstance, computeSyncStatus, lagSeconds, pipelineState,
    snapshotPipelineState, statusBucket, countByStatus, taskLabel, kindLabel, filterTasks, paginate, formatCreatedAt,
  };
});
