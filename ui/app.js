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
document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (!button) return;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab === button);
  const target = button.dataset.tab;
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === target);
  if (target === 'errors') resetErrorBadge();
});

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
    for (const name of status.tables) tablesEl.append(el('li', null, name));
  }

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
    return;
  }

  for (const entry of result.logs) appendLog(entry.level, entry.message);
  if (!result.ok) {
    appendLog('error', result.error || 'Command failed.');
    addError(command.name, result.error || 'Command failed.');
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
