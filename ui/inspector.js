import { $, el, button, icon, state, actions, settings, activeTab } from './core.js';
import { levelsFor } from './models.js';
import { baseName } from './format.js';

const narrow = () => matchMedia('(max-width:1200px)').matches;

export function inspectorVisible() {
  const tab = activeTab();
  if (state.view !== 'workspace' || tab?.kind !== 'table') return false;
  return narrow() ? state.inspectorDrawer : settings.get().inspectorOpen;
}

export function toggleInspector() {
  if (narrow()) state.inspectorDrawer = !state.inspectorDrawer;
  else settings.update({ inspectorOpen: !settings.get().inspectorOpen });
  renderInspector();
  const tab = activeTab();
  if (tab) actions.paint(tab, ['toolbar']);
}

const chip = (text) => el('span', 'chip', text);
function section(title, iconName, ...children) {
  const node = el('section', 'insp-section');
  const heading = el('h3');
  heading.append(icon(iconName), document.createTextNode(title));
  node.append(heading, ...children);
  return node;
}
function row(name, iconName, ...right) {
  const node = el('div', 'insp-row');
  const left = el('span', 'name');
  if (iconName) left.append(icon(iconName));
  left.append(document.createTextNode(name));
  node.append(left, ...right);
  return node;
}

function rowsText(tab) {
  if (tab.countBusy) return 'Counting…';
  if (Number.isFinite(tab.total)) return tab.total.toLocaleString();
  if (tab.data) return `${(tab.offset + (tab.data.rows?.length ?? 0)).toLocaleString()}${tab.data.hasMore || tab.total === null ? '+' : ''}`;
  return '—';
}

function detailsBody(tab) {
  const levels = levelsFor(tab.profile.engine);
  const meta = tab.metadata;
  const view = tab.objectType === 'view';
  const body = el('div');
  const title = el('div', 'insp-title');
  title.append(icon(view ? 'view' : 'table'), document.createTextNode(levels.schema ? `${tab.schema}.${tab.table}` : tab.table));
  const facts = el('dl', 'kv');
  const add = (name, value) => { facts.append(el('dt', '', name), el('dd', '', value)); };
  add('Database', tab.profile.engine === 'sqlite' ? baseName(tab.profile.settings.file) : tab.database);
  if (levels.schema) add('Schema', tab.schema);
  add(view ? 'View' : 'Table', tab.table);
  add('Rows', rowsText(tab));
  add('Columns', meta ? String(meta.columns.length) : (tab.data?.columns?.length ?? '—'));
  body.append(title, facts);
  if (tab.metaBusy && !meta) { body.append(el('p', 'hint', 'Loading details…')); return body; }
  if (tab.metaError && !meta) {
    body.append(el('p', 'error', tab.metaError), button('Retry', () => actions.loadMetadata(tab, true), 'small'));
    return body;
  }
  if (!meta) return body;
  const typeOf = (name) => meta.columns.find((column) => column.name === name)?.type ?? '';
  if (meta.primaryKey.length) body.append(section('Primary key', 'key', ...meta.primaryKey.map((name) => row(name, 'link', chip(typeOf(name))))));
  if (meta.foreignKeys.length) {
    body.append(section('Foreign key', 'link', ...meta.foreignKeys.map((key) => {
      const target = key.referencedSchema && key.referencedSchema !== tab.schema ? `${key.referencedSchema}.${key.referencedTable}` : key.referencedTable;
      return row(`${key.column} → ${target}.${key.referencedColumn}`, null, chip(typeOf(key.column)));
    })));
  }
  body.append(section('Columns', 'list', ...meta.columns.map((column) => row(column.name, 'table', chip(column.type || 'unknown'),
    el('span', 'tag', column.primaryKey ? 'Primary key' : column.foreignKey ? 'Foreign key' : '')))));
  if (meta.indexes.length) {
    const rows = meta.indexes.flatMap((index) => [
      row(index.name, 'schema', chip(index.primary ? 'Primary key' : index.unique ? 'Unique' : 'Index')),
      el('div', 'insp-cols', index.columns.join(', ')),
    ]);
    body.append(section('Indexes', 'schema', ...rows));
  }
  if (meta.definition) {
    const details = el('details', 'insp-def');
    details.append(el('summary', '', 'Definition'), el('pre', '', meta.definition));
    const holder = el('section', 'insp-section');
    holder.append(details);
    body.append(holder);
  }
  return body;
}

export function renderInspector() {
  const root = $('inspector');
  const visible = inspectorVisible();
  root.hidden = !visible;
  $('appShell').classList.toggle('with-inspector', visible);
  root.replaceChildren();
  if (!visible) return;
  const head = el('div', 'inspector-head');
  const close = el('button', 'icon-button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close table details');
  close.append(icon('close'));
  close.addEventListener('click', toggleInspector);
  head.append(el('h2', '', 'Table details'), close);
  root.append(head, detailsBody(activeTab()));
}

export function initInspector() {
  matchMedia('(max-width:1200px)').addEventListener('change', () => { state.inspectorDrawer = false; renderInspector(); });
  actions.toggleInspector = toggleInspector;
}

// ---- Structure view: the same metadata as full-width, readable tables ---------------------------------------
function table(headers, rows) {
  const node = el('table', 'struct-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const text of headers) { const cell = el('th', '', text); cell.scope = 'col'; headRow.append(cell); }
  head.append(headRow);
  const body = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const value of cells) tr.append(value instanceof Node ? (() => { const td = el('td'); td.append(value); return td; })() : el('td', '', value));
    body.append(tr);
  }
  node.append(head, body);
  return node;
}

export function renderStructure(tab, root) {
  root.replaceChildren();
  const meta = tab.metadata;
  if (!meta && tab.metaError) {
    root.append(el('p', 'error', tab.metaError), button('Retry', () => actions.loadMetadata(tab, true), 'small'));
    return;
  }
  if (!meta) {
    // A restored Structure tab has no metadata yet: start loading (a no-op when the tab is blocked) and show progress.
    if (!tab.metaBusy) queueMicrotask(() => actions.loadMetadata(tab));
    root.append(el('p', 'hint loading', 'Loading structure…'));
    return;
  }
  const wrap = el('div', 'structure');
  const block = (title, node) => { const section = el('section'); section.append(el('h3', '', title), node); return section; };
  wrap.append(block('Columns', table(['Name', 'Type', 'Nullable', 'Default', 'Key'], meta.columns.map((column) => [
    column.name, column.type || '—', column.nullable ? 'Yes' : 'No', column.default ?? '—',
    [column.primaryKey ? 'Primary key' : '', column.foreignKey ? 'Foreign key' : ''].filter(Boolean).join(', ') || '—',
  ]))));
  if (meta.indexes.length) {
    wrap.append(block('Indexes', table(['Name', 'Columns', 'Type'], meta.indexes.map((index) => [
      index.name, index.columns.join(', '), index.primary ? 'Primary key' : index.unique ? 'Unique' : 'Index']))));
  }
  if (meta.foreignKeys.length) {
    wrap.append(block('Foreign keys', table(['Column', 'References', 'Constraint'], meta.foreignKeys.map((key) => [
      key.column, `${key.referencedSchema ? key.referencedSchema + '.' : ''}${key.referencedTable}.${key.referencedColumn}`, key.name ?? '—']))));
  }
  if (meta.definition) {
    const details = el('details');
    details.open = true;
    details.append(el('summary', '', 'Definition'), el('pre', 'insp-def-pre', meta.definition));
    wrap.append(block('SQL', details));
  }
  root.append(wrap);
}
