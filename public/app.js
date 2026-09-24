'use strict';

const SECTION_ORDER = ['extractor', 'filter', 'sinker', 'parallelizer', 'pipeline', 'metrics'];
const CONN_DB_TYPES = ['mysql', 'pg', 'mongo'];

// Throughput/latency cards on Page 3 — field names confirmed against real monitor.log
// (plan §2). Queue depth has one value per line, not an aggregate, hence field:null.
const PRIMARY_METRICS = [
  { key: 'sinker.record_count', field: 'avg_by_sec', label: 'Throughput', unit: 'rows/sec' },
  { key: 'sinker.rt_per_query', field: 'avg', label: 'Write latency', unit: 'ms' },
  { key: 'pipeline.buffer_size', field: null, label: 'Queue depth', unit: 'events' },
];

// A snapshot task terminates once the copy finishes, so "rows/sec right now" and
// "queue depth right now" both settle at 0/stale — the number worth surfacing is
// the running total, which pipeline.sinked_count already tracks cumulatively.
const SNAPSHOT_METRICS = [
  { key: 'pipeline.sinked_count', field: 'latest', label: 'Rows copied', unit: 'rows' },
  { key: 'extractor.record_count', field: 'avg_by_sec', label: 'Read rate', unit: 'rows/sec' },
  { key: 'sinker.rt_per_query', field: 'avg', label: 'Write latency', unit: 'ms' },
];

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  square: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
};

function emptyState(icon, title, hint) {
  return `<div class="empty-state">${icon}<div class="empty-title">${title}</div>${hint ? `<div class="empty-hint">${hint}</div>` : ''}</div>`;
}

// unit label (e.g. "s") is drawn at the min/max y so the scale is never a guess —
// a flat line at the bottom could mean "always 0s" or "always 500s" without it.
function drawSparkline(canvas, points, unit = '') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;
  const values = points.map((p) => p.v);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#4f46e5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((p.v - min) / range) * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (unit) {
    ctx.fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground') || '#71717a').trim();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(`${max.toFixed(1)}${unit}`, 6, 4);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${min.toFixed(1)}${unit}`, 6, h - 4);
  }
}

const state = {
  schema: null,
  formData: { extractor: {}, filter: {}, sinker: {}, parallelizer: {}, pipeline: {}, metrics: {}, metrics_enabled: false },
  conn: {
    src: { db_type: 'pg', connected: false, tables: [] },
    dst: { db_type: 'pg', connected: false },
  },
};

// ==================================================================================
// Shared connection-panel + form-builder logic used by Page 1 (Create Task).
// ==================================================================================

function connFields(side) {
  return {
    db_type: document.getElementById(`${side}-db_type`),
    host: document.getElementById(`${side}-host`),
    port: document.getElementById(`${side}-port`),
    username: document.getElementById(`${side}-username`),
    password: document.getElementById(`${side}-password`),
    database: document.getElementById(`${side}-database`),
    connectBtn: document.getElementById(`${side}-connect`),
    status: document.getElementById(`${side}-connect-status`),
  };
}

function initConnPanel(side) {
  const f = connFields(side);
  f.db_type.innerHTML = '';
  for (const t of CONN_DB_TYPES) f.db_type.appendChild(new Option(t, t));
  f.db_type.value = state.conn[side].db_type;
  f.port.value = DEFAULT_PORTS[f.db_type.value];
  if (side === 'src') {
    document.getElementById('src-schema-field').hidden = f.db_type.value !== 'pg';
    document.getElementById('ddl-sync-row').hidden = f.db_type.value !== 'mysql';
  }
  f.db_type.onchange = () => {
    state.conn[side].db_type = f.db_type.value;
    f.port.value = DEFAULT_PORTS[f.db_type.value];
    resetConnDownstream(side);
    if (side === 'src') {
      document.getElementById('src-schema-field').hidden = f.db_type.value !== 'pg';
      document.getElementById('ddl-sync-row').hidden = f.db_type.value !== 'mysql';
    }
    if (PageCreate.refreshMigrateAvailability) PageCreate.refreshMigrateAvailability();
  };
  f.connectBtn.onclick = () => connect(side);
  f.database.onchange = () => onDatabaseChange(side);
  if (side === 'src') document.getElementById('src-schema').onchange = () => loadTables();
}

function resetConnDownstream(side) {
  state.conn[side].connected = false;
  const f = connFields(side);
  f.database.innerHTML = '';
  f.database.disabled = true;
  f.status.textContent = '';
  f.status.className = 'conn-status';
  if (side === 'src') {
    const schemaSel = document.getElementById('src-schema');
    schemaSel.innerHTML = '';
    schemaSel.disabled = true;
    state.conn.src.tables = [];
    document.getElementById('mapping-src-body').innerHTML = emptyState(ICONS.inbox, 'Connect to a source to list tables');
    document.getElementById('mapping-src-head').textContent = 'Available source objects';
  } else {
    document.getElementById('mapping-dst-head').textContent = 'Mapped target objects';
  }
  renderMappingTargets();
}

async function connect(side) {
  const f = connFields(side);
  resetConnDownstream(side);
  f.status.textContent = 'connecting…';
  f.status.className = 'conn-status pending';
  const body = {
    db_type: f.db_type.value,
    host: f.host.value.trim(),
    port: Number(f.port.value),
    username: f.username.value,
    password: f.password.value,
    want: 'databases',
  };
  try {
    const res = await fetch('/api/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'connect failed');
    state.conn[side].connected = true;
    f.status.textContent = `connected (${data.items.length} database${data.items.length === 1 ? '' : 's'})`;
    f.status.className = 'conn-status ok';
    f.database.innerHTML = '';
    for (const d of data.items) f.database.appendChild(new Option(d, d));
    f.database.disabled = false;
    if (data.items.length) onDatabaseChange(side);
  } catch (err) {
    f.status.textContent = err.message;
    f.status.className = 'conn-status error';
  }
}

async function onDatabaseChange(side) {
  const f = connFields(side);
  if (side === 'dst') { renderMappingTargets(); return; } // destination needs no schema/table picker
  const database = f.database.value;
  if (!database) return;
  if (f.db_type.value === 'pg') {
    document.getElementById('src-schema-field').hidden = false;
    const schemaSel = document.getElementById('src-schema');
    schemaSel.innerHTML = '';
    schemaSel.disabled = true;
    try {
      const res = await fetch('/api/introspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_type: 'pg', host: f.host.value.trim(), port: Number(f.port.value), username: f.username.value, password: f.password.value, database, want: 'schemas' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to list schemas');
      for (const s of data.items) schemaSel.appendChild(new Option(s, s, s === 'public', s === 'public'));
      schemaSel.disabled = false;
    } catch (err) {
      document.getElementById('mapping-src-body').innerHTML = `<span class="connect-error">${err.message}</span>`;
      return;
    }
  }
  loadTables();
}

function toggleTable(t, checked) {
  const set = new Set(state.conn.src.tables);
  checked ? set.add(t) : set.delete(t);
  state.conn.src.tables = [...set];
  renderMappingTargets();
}

// Mirrors the checked source tables into the target column. ape-dts writes to the
// same table name it reads (no rename/mapping feature exists to back a real editor),
// so this is an honest preview of what will actually land on the destination.
function renderMappingTargets() {
  const dst = connFields('dst');
  const body = document.getElementById('mapping-dst-body');
  body.innerHTML = '';
  if (!state.conn.src.tables.length) {
    body.innerHTML = `<div class="mapping-row muted-row">Select source tables to map them</div>`;
    return;
  }
  const dbName = dst.database.value || '(unselected)';
  for (const t of state.conn.src.tables) {
    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.textContent = `${dbName}.${t}`;
    body.appendChild(row);
  }
}

async function loadTables() {
  const f = connFields('src');
  const database = f.database.value;
  const schema = f.db_type.value === 'pg' ? document.getElementById('src-schema').value : undefined;
  const pane = document.getElementById('mapping-src-body');
  pane.innerHTML = '(loading…)';
  try {
    const res = await fetch('/api/introspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_type: f.db_type.value, host: f.host.value.trim(), port: Number(f.port.value), username: f.username.value, password: f.password.value, database, schema, want: 'tables' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed to list tables');
    pane.innerHTML = '';
    state.conn.src.tables = [];
    document.getElementById('mapping-src-head').textContent = `Available source objects (${database})`;
    if (!data.items.length) pane.innerHTML = `<div class="mapping-row muted-row">No tables found</div>`;
    for (const t of data.items) {
      const row = document.createElement('label');
      row.className = 'mapping-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t;
      cb.onchange = () => toggleTable(t, cb.checked);
      row.append(cb, ' ' + t);
      pane.appendChild(row);
    }
    renderMappingTargets();
  } catch (err) {
    pane.innerHTML = `<span class="connect-error">${err.message}</span>`;
  }
}

// ---- Advanced form rendering (unchanged shape from the pre-redesign UI) ----

function setValue(section, key, value) {
  state.formData[section] = state.formData[section] || {};
  state.formData[section][key] = value;
}

function currentValue(section, field) {
  const v = state.formData[section] && state.formData[section][field.key];
  return v === undefined ? field.default : v;
}

function renderField(section, field) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (field.advanced ? ' advanced' : '');
  const label = document.createElement('label');
  label.textContent = field.label + (field.required ? ' *' : '');
  wrap.appendChild(label);

  const current = currentValue(section, field);
  let input;

  if (field.type === 'select') {
    input = document.createElement('select');
    const options = field.enum ? state.schema.enums[field.enum] : field.options || [];
    input.appendChild(new Option('(choose)', ''));
    for (const opt of options) input.appendChild(new Option(opt, opt, false, opt === current));
    input.onchange = () => setValue(section, field.key, input.value);
  } else if (field.type === 'multiselect') {
    input = document.createElement('div');
    input.className = 'multiselect';
    const options = state.schema.enums[field.enum] || [];
    const selected = new Set(Array.isArray(current) ? current : []);
    for (const opt of options) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt;
      cb.checked = selected.has(opt);
      cb.onchange = () => {
        const set = new Set(state.formData[section][field.key] || []);
        cb.checked ? set.add(opt) : set.delete(opt);
        setValue(section, field.key, [...set]);
      };
      l.append(cb, ' ' + opt);
      input.appendChild(l);
    }
  } else if (field.type === 'checkbox') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!current;
    input.onchange = () => setValue(section, field.key, input.checked);
  } else {
    input = document.createElement('input');
    input.type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
    input.value = current === undefined || current === null ? '' : current;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.oninput = () =>
      setValue(section, field.key, field.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value);
  }
  input.id = `f_${section}_${field.key}`;
  wrap.appendChild(input);

  if (field.help) {
    const help = document.createElement('span');
    help.className = 'help';
    help.textContent = field.help;
    wrap.appendChild(help);
  }
  return wrap;
}

function renderSection(section) {
  const def = state.schema.sections[section];
  const panel = document.createElement('div');
  panel.className = 'panel';
  const h2 = document.createElement('h2');
  h2.textContent = section;
  panel.appendChild(h2);

  if (section === 'metrics') {
    const row = document.createElement('label');
    row.className = 'checkbox-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state.formData.metrics_enabled;
    cb.onchange = () => (state.formData.metrics_enabled = cb.checked);
    row.append(cb, ' Enable metrics endpoint (Prometheus /metrics + /healthz on the container)');
    panel.appendChild(row);
  }

  const grid = document.createElement('div');
  grid.className = 'field-grid';
  for (const field of def.fields) grid.appendChild(renderField(section, field));
  panel.appendChild(grid);
  return panel;
}

function renderForm() {
  const container = document.getElementById('form-sections');
  container.innerHTML = '';
  container.className = document.getElementById('advanced-toggle').checked ? 'show-advanced' : '';
  for (const section of SECTION_ORDER) container.appendChild(renderSection(section));
}

function collectFormData() {
  const s = connFields('src');
  const d = connFields('dst');
  const source = {
    db_type: s.db_type.value,
    host: s.host.value.trim(),
    port: Number(s.port.value),
    username: s.username.value,
    password: s.password.value,
    database: s.database.value,
    schema: s.db_type.value === 'pg' ? document.getElementById('src-schema').value : undefined,
    tables: state.conn.src.tables,
  };
  const dest = {
    db_type: d.db_type.value,
    host: d.host.value.trim(),
    port: Number(d.port.value),
    username: d.username.value,
    password: d.password.value,
    database: d.database.value,
  };
  const syncMode = document.getElementById('sync-mode').value;
  // Migrate's first phase is a snapshot; the CDC phase is derived server-side once it completes.
  const extract_type = syncMode === 'migrate' ? 'snapshot' : syncMode;
  const base = buildFormData({ source, dest }, { extract_type });
  if (document.getElementById('ddl-sync-toggle').checked && !document.getElementById('ddl-sync-row').hidden) {
    base.filter = { ...base.filter, do_ddls: true };
  }
  return mergeFormData(base, state.formData);
}

// ==================================================================================
// Page 1 — Create Task (#/tasks/new)
// ==================================================================================

const PageCreate = {
  mount() {
    state.formData = { extractor: {}, filter: {}, sinker: {}, parallelizer: {}, pipeline: {}, metrics: {}, metrics_enabled: false };
    state.conn = {
      src: { db_type: 'pg', connected: false, tables: [] },
      dst: { db_type: 'pg', connected: false },
    };

    document.getElementById('task-name').value = '';
    document.getElementById('build-errors').textContent = '';
    document.getElementById('ddl-sync-toggle').checked = false;

    const syncModeHelp = {
      cdc: 'Streams inserts/updates/deletes as they happen. Rows already in the source are not copied. Target tables must already exist.',
      snapshot: 'One-time copy of rows already in the source. Changes made after the task starts are not captured — create a CDC task afterwards for ongoing replication. Target tables must already exist.',
      migrate: 'Zero-downtime move: reserves a replication slot, copies existing rows, then automatically streams everything written since — no gap, no need to pause the source. Postgres only, both sides.',
    };
    const syncModeSelect = document.getElementById('sync-mode');
    syncModeSelect.value = 'cdc';
    const migrateOption = syncModeSelect.querySelector('option[value="migrate"]');
    syncModeSelect.onchange = () => {
      document.getElementById('sync-mode-help').textContent = syncModeHelp[syncModeSelect.value];
    };
    // Called again from initConnPanel's db_type.onchange — migrate needs both ends pg.
    this.refreshMigrateAvailability = () => {
      const bothPg = state.conn.src.db_type === 'pg' && state.conn.dst.db_type === 'pg';
      migrateOption.disabled = !bothPg;
      migrateOption.title = bothPg ? '' : 'Requires Postgres on both source and target';
      if (!bothPg && syncModeSelect.value === 'migrate') syncModeSelect.value = 'cdc';
      syncModeSelect.onchange();
    };
    this.refreshMigrateAvailability();

    initConnPanel('src');
    initConnPanel('dst');
    resetConnDownstream('src');
    resetConnDownstream('dst');

    document.getElementById('select-all-tables').checked = false;
    document.getElementById('select-all-tables').onchange = (e) => {
      document.querySelectorAll('#mapping-src-body input[type=checkbox]').forEach((cb) => {
        cb.checked = e.target.checked;
        toggleTable(cb.value, cb.checked);
      });
    };

    this.populateSchemaUI();

    document.getElementById('apply-preset').onclick = () => {
      const name = document.getElementById('preset-select').value;
      const preset = state.schema.presets[name];
      if (!preset) return;
      for (const [section, values] of Object.entries(preset.values)) {
        state.formData[section] = { ...(state.formData[section] || {}), ...values };
      }
      renderForm();
      document.getElementById('preset-desc').textContent = preset.description;
    };
    document.getElementById('advanced-toggle').onchange = (e) => {
      document.getElementById('form-sections').className = e.target.checked ? 'show-advanced' : '';
    };

    document.getElementById('start-btn').onclick = () => this.start();
  },

  unmount() {},

  async populateSchemaUI() {
    const presetSelect = document.getElementById('preset-select');
    presetSelect.innerHTML = '';
    for (const [key, preset] of Object.entries(state.schema.presets)) {
      presetSelect.appendChild(new Option(preset.label, key));
    }
    document.getElementById('preset-desc').textContent = Object.values(state.schema.presets)[0]?.description || '';

    document.getElementById('advanced-toggle').checked = false;
    renderForm();

    const netSelect = document.getElementById('network-select');
    netSelect.innerHTML = '<option value="">(none)</option>';
    try {
      const nets = await (await fetch('/api/networks')).json();
      for (const n of nets) netSelect.appendChild(new Option(n, n));
    } catch { /* docker not reachable yet; leave (none) only */ }
  },

  async start() {
    const errBox = document.getElementById('build-errors');
    errBox.textContent = '';
    let formData;
    try {
      formData = collectFormData();
    } catch (err) {
      errBox.textContent = err.message;
      return;
    }
    const network = document.getElementById('network-select').value || undefined;
    const name = document.getElementById('task-name').value.trim();
    const syncMode = document.getElementById('sync-mode').value;
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formData, network, name, syncMode }),
    });
    const body = await res.json();
    if (!res.ok) {
      errBox.textContent = (body.errors || [body.error || 'failed']).join('\n');
      return;
    }
    location.hash = `#/tasks/${body.id}`;
  },
};

// ==================================================================================
// Page 2 — Task Center (#/tasks)
// ==================================================================================

const PageCenter = {
  filter: { bucket: 'all', query: '' },
  page: 1,
  tasks: [],
  timer: null,

  async mount() {
    this.filter = { bucket: 'all', query: '' };
    this.page = 1;
    const search = document.getElementById('task-search');
    search.value = '';
    search.oninput = (e) => {
      this.filter.query = e.target.value;
      this.page = 1;
      this.renderList();
    };
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), 3000);
  },

  unmount() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },

  async refresh() {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    // A removed task's container and control actions are gone — the server keeps its
    // meta/logs for later inspection, but Task Center has nothing left to do with it.
    // See view.js's visibleTasks for what else gets excluded and why.
    this.allTasks = tasks;
    this.tasks = visibleTasks(tasks);
    this.renderPills();
    this.renderList();
  },

  renderPills() {
    const counts = countByStatus(this.tasks);
    const pillsEl = document.getElementById('status-pills');
    pillsEl.innerHTML = '';
    const defs = [['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped'], ['failed', 'Failed'], ['completed', 'Completed']];
    for (const [bucket, label] of defs) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pill' + (this.filter.bucket === bucket ? ' active' : '');
      pill.innerHTML = `${label} <span class="pill-count">${counts[bucket]}</span>`;
      pill.onclick = () => {
        this.filter.bucket = bucket;
        this.page = 1;
        this.renderPills();
        this.renderList();
      };
      pillsEl.appendChild(pill);
    }
  },

  renderList() {
    const filtered = filterTasks(this.tasks, this.filter);
    const { items, page, pages } = paginate(filtered, this.page, 8);
    this.page = page;
    const body = document.getElementById('tasks-body');
    body.innerHTML = '';

    if (!items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'table-empty';
      td.innerHTML = emptyState(ICONS.inbox, 'No tasks', 'Create a task to see it here.');
      tr.appendChild(td);
      body.appendChild(tr);
    }

    for (const meta of items) {
      const tr = document.createElement('tr');
      const srcUrl = meta.formData && meta.formData.extractor && meta.formData.extractor.url;
      const dstUrl = meta.formData && meta.formData.sinker && meta.formData.sinker.url;

      // A migrate row shows its own two containers' progress instead of one status:
      // "phase 1/2 · snapshot" while copying, then the child CDC task's real status
      // once it exists, labelled "phase 2/2 · cdc".
      // Stop/Remove act on whichever container is actually alive: the snapshot
      // container while phase 1 runs, the CDC child once phase 2 has started.
      let statusCell = `<span class="badge ${meta.status}">${meta.status}</span>`;
      let activeId = meta.id;
      let activeStatus = meta.status;
      let retryCount = meta.retryCount || 0;
      if (meta.kind === 'migrate') {
        if (meta.cdcTaskId) {
          const child = (this.allTasks || []).find((t) => t.id === meta.cdcTaskId);
          activeId = meta.cdcTaskId;
          activeStatus = child ? child.status : 'starting';
          retryCount = child ? child.retryCount || 0 : 0;
          statusCell = `<span class="badge ${activeStatus}">${activeStatus}</span>`;
        } else {
          statusCell = `<span class="badge ${meta.status}">${meta.status}</span> <span class="muted" style="font-size:0.76rem">phase 1/2 · snapshot</span>`;
        }
      }
      // Auto-retry (server.js reconcileStatuses) resumes the same CDC container on a
      // transient disconnect — surface it so "why did status flicker" is answerable.
      if (retryCount > 0) {
        statusCell += ` <span class="muted" style="font-size:0.76rem">· auto-retried ${retryCount}x</span>`;
      }

      tr.innerHTML = `
        <td><div style="font-weight:550">${taskLabel(meta)}</div><div class="muted" style="font-size:0.76rem">${meta.id}</div></td>
        <td class="instance">${describeInstance(srcUrl)} → ${describeInstance(dstUrl)}</td>
        <td><span class="badge engine">${kindLabel(meta.kind)}</span></td>
        <td>${describeEngine(meta) || '-'}</td>
        <td class="muted">${formatCreatedAt(meta.createdAt)}</td>
        <td>${statusCell}</td>
        <td></td>`;
      const actions = document.createElement('td');
      actions.className = 'row-actions';
      const inner = document.createElement('div');
      inner.className = 'row-actions-inner';
      actions.appendChild(inner);
      const detailBtn = document.createElement('button');
      detailBtn.className = 'secondary icon-btn';
      detailBtn.title = detailBtn.ariaLabel = 'Open task detail';
      detailBtn.innerHTML = ICONS.eye;
      detailBtn.onclick = () => { location.hash = `#/tasks/${meta.id}`; };
      inner.appendChild(detailBtn);

      if (activeStatus === 'running' || activeStatus === 'starting') {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'secondary icon-btn';
        stopBtn.title = stopBtn.ariaLabel = 'Stop task';
        stopBtn.innerHTML = ICONS.square;
        stopBtn.onclick = async () => { await fetch(`/api/tasks/${activeId}/stop`, { method: 'POST' }); this.refresh(); };
        inner.appendChild(stopBtn);
      } else if (activeStatus !== 'removed') {
        const rmBtn = document.createElement('button');
        rmBtn.className = 'danger icon-btn';
        rmBtn.title = rmBtn.ariaLabel = 'Remove task';
        rmBtn.innerHTML = ICONS.trash;
        rmBtn.onclick = async () => { await fetch(`/api/tasks/${activeId}/remove`, { method: 'POST' }); this.refresh(); };
        inner.appendChild(rmBtn);
      }
      tr.lastElementChild.replaceWith(actions);
      body.appendChild(tr);
    }

    const pager = document.getElementById('tasks-pager');
    pager.innerHTML = '';
    if (filtered.length) {
      const info = document.createElement('span');
      info.textContent = `Page ${page} of ${pages} · ${filtered.length} task${filtered.length === 1 ? '' : 's'}`;
      const prevBtn = document.createElement('button');
      prevBtn.className = 'secondary';
      prevBtn.textContent = '‹ Prev';
      prevBtn.disabled = page <= 1;
      prevBtn.onclick = () => { this.page = page - 1; this.renderList(); };
      const nextBtn = document.createElement('button');
      nextBtn.className = 'secondary';
      nextBtn.textContent = 'Next ›';
      nextBtn.disabled = page >= pages;
      nextBtn.onclick = () => { this.page = page + 1; this.renderList(); };
      pager.append(info, prevBtn, nextBtn);
    }
  },
};

// ==================================================================================
// Page 3 — Task Detail (#/tasks/:id)
// ==================================================================================

const PageDetail = {
  id: null,
  meta: null,
  es: null,
  verifyTimer: null,
  livenessTimer: null,
  lastPositionAt: 0,
  lagSeries: [],
  metricsSeen: {},

  async mount(id) {
    this.id = id;
    this.streamId = id;
    this.lagSeries = [];
    this.metricsSeen = {};
    this.lastPositionAt = 0;
    this.current = null;
    this.checkpoint = null;
    this.bufferCap = null;
    document.getElementById('migrate-banner').hidden = true;

    document.getElementById('detail-breadcrumb-label').textContent = id;
    document.getElementById('metric-cards').innerHTML = '';
    document.getElementById('metric-cards-secondary').innerHTML = '';
    document.getElementById('lag-current').textContent = '-';
    document.getElementById('lag-updated').textContent = 'waiting for data…';
    document.getElementById('lag-live-dot').classList.add('idle');
    drawSparkline(document.getElementById('lag-canvas'), []);
    document.getElementById('pipe-diagram').className = 'pipe-diagram';
    document.getElementById('pipe-verdict').className = 'pipe-verdict';
    document.getElementById('pipe-verdict-text').textContent = 'waiting for data…';
    document.getElementById('pipe-verdict-icon').innerHTML = ICONS.check;
    document.getElementById('pipe-verify').hidden = true;

    // "is this graph actually running" has no honest answer from a single snapshot —
    // only from whether fresh position data keeps arriving. Poll rather than trust
    // the SSE 'open' event, which fires even if the stream then goes silent.
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = setInterval(() => this.checkLiveness(), 3000);

    document.getElementById('detail-stop-btn').onclick = () => this.stop();
    document.getElementById('detail-remove-btn').onclick = () => this.remove();
    document.getElementById('detail-verify-btn').onclick = () => this.triggerVerify();

    await this.loadMeta();
    this.openStream();
    await this.refreshVerify();
  },

  unmount() {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.verifyTimer) { clearInterval(this.verifyTimer); this.verifyTimer = null; }
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
  },

  checkLiveness() {
    const stale = !this.lastPositionAt || Date.now() - this.lastPositionAt > 8000;
    document.getElementById('lag-live-dot').classList.toggle('idle', stale);
    // SSE only pushes the raw container status, never the reconciled meta.status a
    // snapshot task needs (completed/failed) — poll the same interval to pick that up.
    this.loadMeta().then(() => this.renderPipeline());
  },

  async loadMeta() {
    const res = await fetch(`/api/tasks/${this.id}`);
    if (!res.ok) {
      document.getElementById('detail-status').textContent = 'not found';
      document.getElementById('detail-status').className = 'badge failed';
      return;
    }
    const meta = await res.json();
    this.meta = meta;

    let childMeta = null;
    if (meta.kind === 'migrate' && meta.cdcTaskId) {
      const childRes = await fetch(`/api/tasks/${meta.cdcTaskId}`);
      if (childRes.ok) childMeta = await childRes.json();
    }
    this.renderMigrateBanner(meta, childMeta);

    // Once phase 2 exists, follow ITS container/logs — that's where live events are.
    const activeMeta = childMeta || meta;
    const activeKind = childMeta ? childMeta.kind : meta.kind;
    const newStreamId = childMeta ? childMeta.id : meta.id;
    if (newStreamId !== this.streamId) {
      this.streamId = newStreamId;
      this.lagSeries = [];
      this.metricsSeen = {};
      this.lastPositionAt = 0;
      this.current = null;
      this.checkpoint = null;
      this.openStream();
    }

    document.getElementById('detail-status').textContent = meta.kind === 'migrate' ? activeMeta.status : meta.status;
    document.getElementById('detail-status').className = 'badge ' + (meta.kind === 'migrate' ? activeMeta.status : meta.status);
    const srcInst = describeInstance(activeMeta.formData && activeMeta.formData.extractor && activeMeta.formData.extractor.url);
    const dstInst = describeInstance(activeMeta.formData && activeMeta.formData.sinker && activeMeta.formData.sinker.url);
    this.srcInst = srcInst;
    this.dstInst = dstInst;
    const dbType = activeMeta.formData && activeMeta.formData.extractor && activeMeta.formData.extractor.db_type;
    const dstType = activeMeta.formData && activeMeta.formData.sinker && activeMeta.formData.sinker.db_type;
    document.getElementById('pipe-src-label').textContent = dbType ? `Source · ${dbType}` : 'Source';
    document.getElementById('pipe-src-sub').textContent = srcInst;
    document.getElementById('pipe-dst-label').textContent = dstType ? `Target · ${dstType}` : 'Target';
    document.getElementById('pipe-dst-sub').textContent = dstInst;
    this.bufferCap = Number(activeMeta.formData && activeMeta.formData.pipeline && activeMeta.formData.pipeline.buffer_size) || null;
    document.getElementById('verify-direction').textContent =
      `Compares source (${srcInst}) against target (${dstInst}) — flags rows missing on the target and rows whose values differ.`;
    document.getElementById('detail-verify-btn').hidden = !['mysql', 'pg', 'mongo'].includes(dbType);
    // Sync lag is a source-vs-target position diff; a snapshot's checkpoint never
    // carries real data (see snapshotPipelineState in view.js), so the chart would
    // just sit at "waiting for data…" forever — hide it instead of showing nothing.
    document.getElementById('lag-chart-panel').hidden = activeKind === 'snapshot' || activeKind === 'migrate';
  },

  // Renders the phase-1/phase-2 banner for a migrate task, and the slot-still-alive
  // warning when phase 1 fails (see design decision: never auto-drop the slot).
  renderMigrateBanner(meta, childMeta) {
    const banner = document.getElementById('migrate-banner');
    if (meta.kind !== 'migrate') { banner.hidden = true; return; }
    banner.hidden = false;

    const p1 = document.getElementById('migrate-phase-1');
    const p1Done = meta.status === 'completed';
    p1.className = 'migrate-phase ' + (p1Done ? 'done' : meta.status === 'failed' ? '' : 'active');
    const rows = this.metricsSeen && !childMeta ? this.metricsSeen['pipeline.sinked_count']?.values.latest : null;
    p1.innerHTML = `<span class="step-num">1</span> Snapshot — <span class="badge ${meta.status}">${meta.status}</span>${rows != null ? ` · ${rows} rows copied` : ''}`;

    const p2 = document.getElementById('migrate-phase-2');
    if (childMeta) {
      p2.className = 'migrate-phase ' + (childMeta.status === 'running' || childMeta.status === 'starting' ? 'active' : childMeta.status === 'completed' ? 'done' : '');
      p2.innerHTML = `<span class="step-num">2</span> CDC (from LSN ${meta.startLsn || '?'}) — <span class="badge ${childMeta.status}">${childMeta.status}</span>`;
    } else {
      p2.className = 'migrate-phase';
      p2.innerHTML = `<span class="step-num">2</span> CDC — <span class="muted">waiting for snapshot to finish</span>`;
    }

    const warning = document.getElementById('migrate-slot-warning');
    if (meta.status === 'failed' && meta.slotName) {
      warning.hidden = false;
      const dropPub = meta.pubName ? `\nDROP PUBLICATION ${meta.pubName};` : '';
      warning.innerHTML = `Snapshot failed — replication slot <strong>${meta.slotName}</strong> was left alive on purpose so a retry loses no writes. If you're abandoning this migration, drop it manually:<code>SELECT pg_drop_replication_slot('${meta.slotName}');${dropPub}</code>`;
    } else {
      warning.hidden = true;
    }
  },

  async stop() {
    await fetch(`/api/tasks/${this.streamId}/stop`, { method: 'POST' });
    this.loadMeta();
  },

  async remove() {
    // Mirrors PageCenter's activeId: target whichever container is actually alive
    // (the snapshot while phase 1 runs, the CDC child once phase 2 exists).
    await fetch(`/api/tasks/${this.streamId}/remove`, { method: 'POST' });
    location.hash = '#/tasks';
  },

  async triggerVerify() {
    const btn = document.getElementById('detail-verify-btn');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/tasks/${this.streamId}/check`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        document.getElementById('verify-detail').textContent = body.error || (body.errors && body.errors.join(', ')) || 'failed to start';
        return;
      }
      document.getElementById('verify-badge').textContent = 'running';
      document.getElementById('verify-badge').className = 'badge starting';
      this.pollVerify();
    } finally {
      btn.disabled = false;
    }
  },

  pollVerify() {
    if (this.verifyTimer) clearInterval(this.verifyTimer);
    this.verifyTimer = setInterval(() => this.refreshVerify(), 2000);
  },

  async refreshVerify() {
    const res = await fetch(`/api/tasks/${this.streamId}/check-result`);
    const result = await res.json();
    const badge = document.getElementById('verify-badge');
    const detail = document.getElementById('verify-detail');
    const body = document.getElementById('verify-body');

    if (!result.checkTaskId) {
      badge.textContent = 'never run';
      badge.className = 'badge';
      detail.textContent = '';
      body.innerHTML = '';
      return;
    }

    const running = result.status === 'starting' || result.status === 'running';
    let matched = false;
    if (running) {
      badge.textContent = 'running';
      badge.className = 'badge starting';
      if (!this.verifyTimer) this.pollVerify();
    } else {
      if (this.verifyTimer) { clearInterval(this.verifyTimer); this.verifyTimer = null; }
      if (result.status === 'failed') {
        badge.textContent = 'failed';
        badge.className = 'badge failed';
      } else if (result.totals && result.totals.total > 0) {
        badge.textContent = `${result.totals.total} inconsistencies`;
        badge.className = 'badge failed';
      } else {
        badge.textContent = 'matched';
        badge.className = 'badge running';
        matched = true;
      }
    }
    detail.textContent = result.finishedAt ? `last run ${new Date(result.finishedAt).toLocaleString()}` : '';

    const pipeVerify = document.getElementById('pipe-verify');
    pipeVerify.hidden = !matched;
    if (matched) {
      document.getElementById('pipe-verify-text').textContent =
        `Verified ${result.finishedAt ? new Date(result.finishedAt).toLocaleTimeString() : ''}`;
    }

    body.innerHTML = '';
    if (!result.tables || !result.tables.length) {
      if (!running) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'table-empty';
        td.innerHTML = emptyState(ICONS.inbox, 'No inconsistencies found');
        tr.appendChild(td);
        body.appendChild(tr);
      }
      return;
    }
    for (const t of result.tables) {
      const tr = document.createElement('tr');
      tr.className = 'consistency-row ' + t.status;
      const statusText = t.status === 'ok'
        ? 'matched'
        : [t.miss ? `${t.miss} missing on target` : null, t.diff ? `${t.diff} differ` : null].filter(Boolean).join(', ');
      tr.innerHTML = `<td>${t.schema}.${t.tb}</td><td>${t.miss}</td><td>${t.diff}</td><td><span class="badge ${t.status === 'ok' ? 'running' : 'failed'}">${statusText}</span></td>`;
      body.appendChild(tr);
    }
  },

  openStream() {
    if (this.es) this.es.close();
    const es = new EventSource(`/api/tasks/${this.streamId}/stream`);
    this.es = es;
    es.addEventListener('counters', (e) => JSON.parse(e.data).forEach((c) => this.pushCounter(c)));
    es.addEventListener('position', (e) => this.onPosition(JSON.parse(e.data)));
    es.addEventListener('status', (e) => this.onContainerStatus(JSON.parse(e.data)));
    es.onerror = () => this.onContainerStatus(null);
  },

  onContainerStatus(s) {
    // Docker's raw inspect status ("exited") is not the app's reconciled status
    // ("completed"/"failed") — loadMeta's periodic poll (via checkLiveness) already
    // keeps the badge in sync with that. Only step in here while still running, or a
    // terminal container flips the badge back to the raw word right after loadMeta
    // sets the real one.
    if (!s || !s.running) return;
    const el = document.getElementById('detail-status');
    el.textContent = s.status;
    el.className = 'badge running';
  },

  pushCounter(c) {
    this.metricsSeen[`${c.component}.${c.counter}`] = c;
    this.renderMetrics();
    this.renderPipeline();
  },

  renderMetrics() {
    const defs = this.meta && this.meta.kind === 'snapshot' ? SNAPSHOT_METRICS : PRIMARY_METRICS;
    const primary = document.getElementById('metric-cards');
    primary.innerHTML = '';
    for (const def of defs) {
      const c = this.metricsSeen[def.key];
      const value = c ? (def.field ? c.values[def.field] : Object.values(c.values)[0]) : null;
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = `<div class="label">${def.label}</div><div class="value">${value == null ? '-' : value + ' ' + def.unit}</div>`;
      primary.appendChild(card);
    }
    const secondary = document.getElementById('metric-cards-secondary');
    secondary.innerHTML = '';
    for (const [key, c] of Object.entries(this.metricsSeen)) {
      const value = c.values.latest ?? c.values.sum ?? Object.values(c.values)[0] ?? 0;
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = `<div class="label">${key}</div><div class="value">${value}</div>`;
      secondary.appendChild(card);
    }
  },

  onPosition({ current, checkpoint }) {
    this.lastPositionAt = Date.now();
    this.current = current;
    this.checkpoint = checkpoint;
    document.getElementById('lag-updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
    document.getElementById('lag-live-dot').classList.remove('idle');

    const lag = lagSeconds(current, checkpoint);
    document.getElementById('lag-current').textContent = lag === null ? '-' : `${lag.toFixed(1)}s`;
    if (lag !== null) {
      this.lagSeries.push({ t: Date.now(), v: lag });
      if (this.lagSeries.length > 120) this.lagSeries.shift();
      drawSparkline(document.getElementById('lag-canvas'), this.lagSeries, 's');
    }

    this.renderPipeline();
  },

  // Single place that paints the Live Pipeline diagram so the verdict, the flow
  // animation and the segment annotations can never disagree — every event that
  // could change any of them (position, counter, liveness poll) routes through here.
  renderPipeline() {
    let state;
    if (this.meta && this.meta.kind === 'snapshot') {
      const rowsCopied = this.metricsSeen['pipeline.sinked_count']?.values.latest ?? null;
      state = snapshotPipelineState(this.meta.status, rowsCopied);
    } else {
      const stale = this.lastPositionAt > 0 && Date.now() - this.lastPositionAt > 8000;
      state = pipelineState(computeSyncStatus(this.current, this.checkpoint), stale);
    }

    document.getElementById('pipe-diagram').className = `pipe-diagram ${state.cls}`;
    document.getElementById('pipe-verdict').className = `pipe-verdict ${state.cls}`;
    document.getElementById('pipe-verdict-text').textContent = state.text;
    document.getElementById('pipe-verdict-icon').innerHTML = state.cls === 'state-stale' ? ICONS.alert : ICONS.check;

    const inRate = this.metricsSeen['extractor.record_count'];
    const outRate = this.metricsSeen['sinker.record_count'];
    const queue = this.metricsSeen['pipeline.buffer_size'];
    document.getElementById('pipe-rate-in').textContent = inRate ? `${inRate.values.avg_by_sec} rows/sec` : '-';
    document.getElementById('pipe-rate-out').textContent = outRate ? `${outRate.values.avg_by_sec} rows/sec` : '-';
    const q = queue ? Object.values(queue.values)[0] : null;
    document.getElementById('pipe-queue').textContent =
      q == null ? '-' : this.bufferCap ? `${q} / ${this.bufferCap} queued` : `${q} queued`;
  },
};

// ==================================================================================
// Router
// ==================================================================================

function parseHash() {
  const h = (location.hash || '#/tasks').replace(/^#/, '');
  if (h === '/tasks/new') return { name: 'create' };
  const m = h.match(/^\/tasks\/([^/]+)$/);
  if (m) return { name: 'detail', id: decodeURIComponent(m[1]) };
  return { name: 'center' };
}

let currentPage = null;
function render() {
  const route = parseHash();
  if (currentPage && currentPage.unmount) currentPage.unmount();
  document.querySelectorAll('.page').forEach((s) => s.classList.remove('active'));
  if (route.name === 'create') {
    document.getElementById('page-create').classList.add('active');
    currentPage = PageCreate;
  } else if (route.name === 'detail') {
    document.getElementById('page-detail').classList.add('active');
    currentPage = PageDetail;
  } else {
    document.getElementById('page-center').classList.add('active');
    currentPage = PageCenter;
  }
  currentPage.mount(route.id);
}

async function init() {
  const res = await fetch('/api/schema');
  state.schema = await res.json();

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-route]');
    if (el) { e.preventDefault(); location.hash = el.dataset.route; }
  });
  window.addEventListener('hashchange', render);
  render();
}
init();
