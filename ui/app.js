const token = new URLSearchParams(location.search).get('token') || '';

// One positional "arg" field maps to the command's args array; commands take at
// most one positional today (drop <table>, restore <file>, backup [output], …).
const COMMANDS = [
  { name: 'init', label: 'Init', desc: 'Create the database and apply the default schema.' },
  { name: 'create', label: 'Create', desc: 'Create the database (optionally a schema).' },
  { name: 'tables', label: 'List Tables', desc: 'Show tables in the active database.' },
  { name: 'health', label: 'Health Check', desc: 'Run a quick connectivity check.' },
  { name: 'scan', label: 'Scan Clients', desc: 'Check local CLI tools and engine connection.' },
  { name: 'migrate', label: 'Migrate', desc: 'Apply pending migration files in order.' },
  { name: 'seed', label: 'Seed', desc: 'Apply the default seed data.' },
  { name: 'update', label: 'Update', desc: 'Apply a schema update file.', arg: { label: 'Update SQL file (optional)', placeholder: 'schemas/update_schema.sql' } },
  { name: 'backup', label: 'Backup', desc: 'Write a backup to the backups folder.', arg: { label: 'Output path (optional)' } },
  { name: 'set', label: 'Set Engine', desc: 'Write the project manifest for an engine.', arg: { label: 'Engine', placeholder: 'sqlite | postgres | mysql | mssql', required: true } },
  { name: 'create-env', label: 'Create Env', desc: 'Write .env.example for an engine.', arg: { label: 'Engine', placeholder: 'sqlite | postgres | mysql | mssql', required: true } },
  { name: 'reset', label: 'Reset', desc: 'Drop all tables and rebuild the schema.', destructive: true },
  { name: 'drop', label: 'Drop Table', desc: 'Drop one table.', destructive: true, arg: { label: 'Table name', required: true } },
  { name: 'restore', label: 'Restore', desc: 'Restore from a backup file (overwrites data).', destructive: true, arg: { label: 'Backup file path', required: true } },
];

let errorCount = 0;

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-ui-token': token, ...(options.headers || {}) },
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- tabs ---------- */
function activateTab(target) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === target);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === target);
  if (target === 'errors') resetErrorBadge();
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (!button) return;
  activateTab(button.dataset.tab);
});

/* ---------- toasts (so output is visible from any tab) ---------- */
function toast(level, message) {
  const stack = document.getElementById('toastStack');
  const node = el('div', `toast ${level}`, message);
  node.title = 'Click to open Logs';
  node.addEventListener('click', () => {
    activateTab('logs');
    node.remove();
  });
  stack.append(node);
  setTimeout(() => node.remove(), 5000);
}

/* ---------- dashboard ---------- */
async function loadStatus() {
  const connectionEl = document.getElementById('connectionStatus');
  const tablesEl = document.getElementById('tablesList');
  const migrationsEl = document.getElementById('migrationsStatus');
  const toolsEl = document.getElementById('toolsStatus');
  connectionEl.textContent = 'checking…';

  let status;
  try {
    status = await api('/api/status');
  } catch (error) {
    connectionEl.innerHTML = '';
    connectionEl.append(dot('bad'), document.createTextNode(`status failed: ${error.message}`));
    return;
  }

  document.getElementById('enginePill').textContent = `engine: ${status.engine} · ${status.databaseName}`;

  connectionEl.innerHTML = '';
  if (status.connection?.ok) {
    connectionEl.append(dot('ok'), document.createTextNode(`connected · ${status.connection.tables ?? 0} tables`));
  } else {
    connectionEl.append(dot('bad'), document.createTextNode(status.connection?.error || 'not reachable'));
  }

  tablesEl.innerHTML = '';
  if (!status.tables.length) {
    tablesEl.append(el('li', 'muted', status.tablesError || '(no tables)'));
  } else {
    for (const name of status.tables) tablesEl.append(tableRow(name));
  }

  populateTableSelect(status.tables);

  migrationsEl.innerHTML = '';
  const applied = status.migrations.applied.length;
  const pending = status.migrations.pending.length;
  migrationsEl.append(dot(pending ? 'warn' : 'ok'));
  migrationsEl.append(document.createTextNode(`${applied} applied · ${pending} pending`));

  toolsEl.innerHTML = '';
  for (const tool of status.tools) {
    const row = el('div');
    row.append(dot(tool.installed ? 'ok' : 'warn'), document.createTextNode(`${tool.label}: ${tool.installed ? 'found' : 'missing'}`));
    toolsEl.append(row);
  }
}

function dot(kind) {
  const span = el('span', `dot ${kind}`);
  return span;
}

const DROP_COMMAND = COMMANDS.find((c) => c.name === 'drop');

function tableRow(name) {
  const li = el('li', 'table-row');
  const nameEl = el('span', 'table-name', name);
  nameEl.title = `View rows in "${name}"`;
  nameEl.addEventListener('click', () => openTableInView(name));
  li.append(nameEl);
  const dropBtn = el('button', 'drop-btn', 'Drop');
  dropBtn.title = `Drop table "${name}"`;
  dropBtn.addEventListener('click', () => confirmAndRun(DROP_COMMAND, [name], name));
  li.append(dropBtn);
  return li;
}

/* ---------- table view ---------- */
function populateTableSelect(tables) {
  const select = document.getElementById('tvTableSelect');
  const previous = select.value;
  select.innerHTML = '';
  if (!tables.length) {
    const option = el('option', null, '(no tables)');
    option.value = '';
    select.append(option);
    return;
  }
  for (const name of tables) {
    const option = el('option', null, name);
    option.value = name;
    select.append(option);
  }
  if (tables.includes(previous)) select.value = previous;
}

function openTableInView(name) {
  activateTab('tableview');
  const select = document.getElementById('tvTableSelect');
  if ([...select.options].some((option) => option.value === name)) {
    select.value = name;
    loadRows();
  }
}

async function loadRows() {
  const table = document.getElementById('tvTableSelect').value;
  const meta = document.getElementById('tvMeta');
  const resultEl = document.getElementById('tvResult');
  if (!table) {
    resultEl.innerHTML = '<p class="muted">No table selected.</p>';
    return;
  }
  const limit = document.getElementById('tvLimit').value || 100;
  meta.textContent = 'loading…';
  resultEl.innerHTML = '';

  let data;
  try {
    data = await api(`/api/rows?table=${encodeURIComponent(table)}&limit=${encodeURIComponent(limit)}`);
  } catch (error) {
    meta.textContent = '';
    resultEl.innerHTML = '';
    resultEl.append(el('p', 'tv-error', error.message));
    return;
  }
  renderRows(data);
}

function renderRows(data) {
  const meta = document.getElementById('tvMeta');
  const resultEl = document.getElementById('tvResult');
  resultEl.innerHTML = '';
  meta.textContent = `${data.rows.length} row(s) · ${data.columns.length} column(s)`;

  if (!data.columns.length) {
    resultEl.append(el('p', 'muted', '(table has no columns)'));
    return;
  }

  const table = el('table', 'data-table');
  const headRow = el('tr');
  for (const column of data.columns) headRow.append(el('th', null, column));
  const thead = el('thead');
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  if (!data.rows.length) {
    const row = el('tr');
    const cell = el('td', 'muted', '(no rows)');
    cell.colSpan = data.columns.length;
    row.append(cell);
    tbody.append(row);
  } else {
    for (const rowData of data.rows) {
      const row = el('tr');
      for (const column of data.columns) {
        const value = rowData[column];
        const cell = el('td', value === null ? 'null-cell' : null, value === null ? 'NULL' : String(value));
        row.append(cell);
      }
      tbody.append(row);
    }
  }
  table.append(tbody);

  const wrap = el('div', 'data-table-wrap');
  wrap.append(table);
  resultEl.append(wrap);
}

/* ---------- commands ---------- */
function buildCommandCards() {
  const grid = document.getElementById('commandGrid');
  for (const command of COMMANDS) {
    const card = el('div', `command${command.destructive ? ' destructive' : ''}`);
    card.append(el('h4', null, command.label));
    card.append(el('div', 'desc', command.desc || ''));

    let input = null;
    if (command.arg) {
      input = el('input');
      input.placeholder = command.arg.placeholder || command.arg.label;
      card.append(input);
    }

    const button = el('button', 'run-btn', command.destructive ? 'Run…' : 'Run');
    button.addEventListener('click', () => {
      const value = input ? input.value.trim() : '';
      if (command.arg?.required && !value) {
        input.focus();
        return;
      }
      const args = value ? [value] : [];
      if (command.destructive) {
        confirmAndRun(command, args, value);
      } else {
        runCommand(command, args);
      }
    });
    card.append(button);
    grid.append(card);
  }
}

/* ---------- confirm modal ---------- */
const modal = document.getElementById('modal');
let pendingConfirm = null;

function confirmAndRun(command, args, value) {
  document.getElementById('modalTitle').textContent = `Confirm: ${command.label}`;
  const target = value ? ` "${value}"` : '';
  document.getElementById('modalBody').textContent =
    `${command.desc} This affects the active database${target}. This cannot be undone.`;
  pendingConfirm = () => runCommand(command, args);
  modal.hidden = false;
}

document.getElementById('modalCancel').addEventListener('click', () => {
  modal.hidden = true;
  pendingConfirm = null;
});
document.getElementById('modalConfirm').addEventListener('click', () => {
  modal.hidden = true;
  const run = pendingConfirm;
  pendingConfirm = null;
  if (run) run();
});

/* ---------- run + output ---------- */
async function runCommand(command, args) {
  const display = `$ db ${command.name}${args.length ? ' ' + args.join(' ') : ''}`;
  appendLog('cmd', display);

  let result;
  try {
    result = await api('/api/run', { method: 'POST', body: JSON.stringify({ command: command.name, args }) });
  } catch (error) {
    appendLog('error', error.message);
    addError(command.name, error.message);
    toast('error', `${command.label}: ${error.message}`);
    return;
  }

  for (const entry of result.logs) appendLog(entry.level, entry.message);
  if (!result.ok) {
    appendLog('error', result.error || 'Command failed.');
    addError(command.name, result.error || 'Command failed.');
    toast('error', `${command.label}: ${result.error || 'failed'}`);
  } else {
    const lastOk = [...result.logs].reverse().find((entry) => entry.level === 'ok');
    toast('ok', `${command.label}: ${lastOk ? lastOk.message : 'done'}`);
  }
  loadStatus();
}

function appendLog(level, message) {
  const consoleEl = document.getElementById('logConsole');
  const placeholder = consoleEl.querySelector('.muted');
  if (placeholder) placeholder.remove();
  const line = el('div', `line ${level}`, message);
  consoleEl.append(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function addError(command, message) {
  const list = document.getElementById('errorList');
  const placeholder = list.querySelector('.muted');
  if (placeholder) placeholder.remove();
  const entry = el('div', 'error-entry');
  entry.append(el('div', 'cmd', `db ${command}`));
  entry.append(el('div', 'msg', message));
  entry.append(el('div', 'time', new Date().toLocaleTimeString()));
  list.prepend(entry);
  bumpErrorBadge();
}

function bumpErrorBadge() {
  errorCount += 1;
  const badge = document.getElementById('errorBadge');
  badge.textContent = String(errorCount);
  badge.hidden = false;
}

function resetErrorBadge() {
  errorCount = 0;
  document.getElementById('errorBadge').hidden = true;
}

document.getElementById('tvLoadBtn').addEventListener('click', loadRows);
document.getElementById('tvRefreshBtn').addEventListener('click', loadStatus);
document.getElementById('tvTableSelect').addEventListener('change', loadRows);
document.getElementById('refreshBtn').addEventListener('click', loadStatus);
document.getElementById('clearLogsBtn').addEventListener('click', () => {
  document.getElementById('logConsole').innerHTML = '<span class="muted">Cleared.</span>';
});
document.getElementById('clearErrorsBtn').addEventListener('click', () => {
  document.getElementById('errorList').innerHTML = '<p class="muted">No errors.</p>';
  resetErrorBadge();
});

/* ---------- init ---------- */
buildCommandCards();
loadStatus();
