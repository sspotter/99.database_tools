import { $, el, icon, engineBadge, state, bus, actions, popover, menuItem, menuKeys, profileById, activeTab, safeStorage } from './core.js';
import { buildTree, nodeKey } from './models.js';
import { selectConnection, chooseDatabase, chooseSchema, loadCatalog, refreshTree, ensureDatabases } from './nav.js';
import { showView } from './shell.js';

const TREE_KEY = 'database-toolkit-tree-v1';
const GROUPS_KEY = 'database-toolkit-tree-groups-v1';
let rows = [];
let focusKey = null;
let knownGroups = new Set();
let scheduled = false;

const persistExpanded = () => safeStorage.set(TREE_KEY, [...state.expanded]);

function currentObject() {
  const tab = activeTab();
  return tab?.kind === 'table' ? { profileId: tab.profile.id, database: tab.database, schema: tab.schema, name: tab.table } : null;
}

function toggle(row, open = !state.expanded.has(row.key)) {
  if (open) state.expanded.add(row.key); else state.expanded.delete(row.key);
  persistExpanded();
  if (open && row.kind === 'database') { const profile = profileById(row.profileId); if (profile) loadCatalog(profile, row.database); }
  if (open && row.kind === 'connection') { const profile = profileById(row.profileId); if (profile && state.connected.has(profile.id)) ensureDatabases(profile); }
  bus.emit('tree');
}

function activate(row) {
  focusKey = row.key;
  const profile = row.profileId ? profileById(row.profileId) : null;
  if (row.kind === 'group' || row.kind === 'folder') return toggle(row);
  if (row.kind === 'connection') {
    selectConnection(row.profileId);
    showView('workspace');
    return row.connected ? toggle(row) : undefined;
  }
  if (row.kind === 'database') {
    if (profile) chooseDatabase(profile, row.database);
    return toggle(row, true);
  }
  if (row.kind === 'schema') {
    if (profile) chooseSchema(profile, row.database, row.schema);
    return toggle(row);
  }
  if (row.kind === 'object') { showView('workspace'); actions.openTable(row); }
  return undefined;
}

function openMenu(row, anchor) {
  const profile = row.profileId ? profileById(row.profileId) : null;
  if (!profile || !['connection', 'database', 'object'].includes(row.kind)) return;
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const run = (fn) => () => { handle.close(true); fn(); };
  if (row.kind === 'connection') {
    menu.append(
      menuItem(row.connected ? 'Disconnect' : 'Connect', 'plug', run(() => actions.toggleConnection(profile)), { disabled: state.pendingConnections.has(profile.id) }),
      menuItem('Refresh objects', 'refresh', run(() => refreshTree(profile)), { disabled: !row.connected }),
      menuItem('Edit', 'sliders', run(() => actions.openConnection(profile))),
      menuItem('Duplicate', 'plus', run(() => actions.openConnection(profile, true))),
      menuItem(profile.favorite ? 'Remove from favorites' : 'Add to favorites', 'star', run(() => actions.favorite(profile))),
      menuItem('Delete', 'close', run(() => actions.deleteConnection(profile)), { danger: true }),
    );
  } else if (row.kind === 'database') menu.append(menuItem('Refresh objects', 'refresh', run(() => loadCatalog(profile, row.database, { force: true }))));
  else if (row.kind === 'object') {
    menu.append(
      menuItem('Open', 'table', run(() => actions.openTable(row))),
      menuItem('Open in new tab', 'plus', run(() => actions.openTable(row, { fresh: true }))),
      menuItem('Open structure', 'list', run(() => actions.openTable(row, { view: 'structure' }))),
      menuItem('New SQL tab here', 'sql', run(() => actions.openQuery({ profileId: row.profileId, database: row.database, schema: row.schema }))),
    );
  }
  menuKeys(menu);
  const handle = popover(anchor, menu);
  menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
}

function iconFor(row) {
  if (row.kind === 'connection') return engineBadge(row.engine);
  const name = { group: 'folder', database: 'database', schema: 'schema' }[row.kind]
    ?? (row.kind === 'folder' ? (row.folder === 'views' ? 'view' : 'table') : row.objectType === 'view' ? 'view' : 'table');
  return icon(name);
}

function rowElement(row) {
  if (row.kind === 'status') {
    const node = el('div', `tree-row kind-status${row.error ? ' error' : ''}`);
    node.setAttribute('role', 'treeitem');
    node.setAttribute('aria-disabled', 'true');
    node.setAttribute('aria-level', String(row.depth));
    node.dataset.key = row.key;
    node.style.setProperty('--depth', row.depth);
    node.append(el('span', 'tree-label', row.label));
    if (row.retry) {
      const retry = el('button', 'tree-action', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', (event) => { event.stopPropagation(); const profile = profileById(row.retry.profileId); if (profile) loadCatalog(profile, row.retry.database, { force: true }); });
      node.append(retry);
    }
    return node;
  }
  const node = el('div', `tree-row kind-${row.kind}${row.selected ? ' selected' : ''}${row.current ? ' current' : ''}`);
  node.dataset.key = row.key;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', String(row.depth));
  if (row.expandable) node.setAttribute('aria-expanded', String(row.expanded));
  if (row.kind === 'connection' || row.kind === 'object') node.setAttribute('aria-selected', String(Boolean(row.selected || row.current)));
  node.tabIndex = row.key === focusKey ? 0 : -1;
  node.style.setProperty('--depth', row.depth);

  const twisty = el('span', row.expandable ? 'twisty' : 'twisty leaf');
  twisty.append(icon('chevron'));
  twisty.addEventListener('click', (event) => { event.stopPropagation(); focusKey = row.key; toggle(row); });
  const label = el('span', `tree-label${row.environment === 'production' ? ' environment-production' : ''}`, row.label);
  label.title = row.label;
  node.append(twisty, el('span', 'tree-icon'), label);
  node.querySelector('.tree-icon').append(iconFor(row));

  if (row.kind === 'folder') node.append(el('span', 'tree-count', String(row.count)));
  if (row.kind === 'connection') {
    if (row.environment !== 'development') node.append(el('span', `tree-pill${row.environment === 'production' ? ' production' : ''}`, row.environment));
    const pendingNow = state.pendingConnections.has(row.profileId);
    if (!row.connected || pendingNow) {
      const connect = el('button', 'tree-action tree-connect', pendingNow ? 'Working…' : 'Connect');
      connect.type = 'button';
      connect.disabled = pendingNow;
      connect.addEventListener('click', (event) => { event.stopPropagation(); const profile = profileById(row.profileId); if (profile) actions.toggleConnection(profile); });
      node.append(connect);
    }
    node.append(el('span', `tree-dot${row.connected ? ' on' : ''}${pendingNow ? ' busy' : ''}`));
    const more = el('button', 'icon-button tree-more');
    more.type = 'button';
    more.setAttribute('aria-label', `Actions for ${row.label}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.append(icon('more'));
    more.addEventListener('click', (event) => { event.stopPropagation(); openMenu(row, more); });
    node.append(more);
  }
  node.addEventListener('click', () => activate(row));
  node.addEventListener('contextmenu', (event) => {
    if (!['connection', 'database', 'object'].includes(row.kind)) return;
    event.preventDefault();
    openMenu(row, { getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }) });
  });
  return node;
}

function focusRow(key) {
  focusKey = key;
  for (const node of $('connectionTree').children) {
    const on = node.dataset.key === key;
    node.tabIndex = on ? 0 : -1;
    if (on) node.focus();
  }
}

function onKeydown(event) {
  const node = event.target.closest?.('.tree-row');
  if (!node || event.target !== node) return;
  const index = rows.findIndex((row) => row.key === node.dataset.key);
  const row = rows[index];
  if (!row || row.kind === 'status') return;
  const move = (to) => { const target = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (target) focusRow(target.key); };
  const handled = (fn) => { event.preventDefault(); fn(); };
  switch (event.key) {
    case 'ArrowDown': return handled(() => move(index + 1));
    case 'ArrowUp': return handled(() => move(index - 1));
    case 'Home': return handled(() => move(0));
    case 'End': return handled(() => move(rows.length - 1));
    case 'ArrowRight': return handled(() => (row.expandable && !row.expanded ? toggle(row, true) : row.expanded ? move(index + 1) : undefined));
    case 'ArrowLeft': return handled(() => {
      if (row.expandable && row.expanded) toggle(row, false);
      else { for (let i = index - 1; i >= 0; i--) if (rows[i].depth < row.depth) { move(i); break; } }
    });
    case 'Enter': return handled(() => activate(row));
    case ' ': return handled(() => (row.expandable ? toggle(row) : activate(row)));
    case 'ContextMenu': return handled(() => openMenu(row, node));
    case 'F10': return event.shiftKey ? handled(() => openMenu(row, node)) : undefined;
    default: return undefined;
  }
}

export function renderTree() {
  const root = $('connectionTree');
  const hadFocus = root.contains(document.activeElement);
  rows = buildTree({
    profiles: state.profiles, connected: state.connected, databasesByProfile: state.databasesByProfile, catalogs: state.catalogs,
    expanded: state.expanded, selectedId: state.selectedId, currentObject: currentObject(),
  });
  root.replaceChildren();
  if (!state.profiles.length) {
    root.append(el('p', 'hint tree-empty', 'No connections yet. Add a SQLite file or server connection to start exploring.'));
    return;
  }
  if (!rows.some((row) => row.key === focusKey)) focusKey = rows.find((row) => row.kind !== 'status')?.key ?? null;
  for (const row of rows) root.append(rowElement(row));
  if (hadFocus && focusKey) [...root.children].find((node) => node.dataset.key === focusKey)?.focus();
}

// New groups open by default; groups the user collapsed stay collapsed.
function openNewGroups() {
  let changed = false;
  for (const profile of state.profiles) {
    const name = profile.favorite ? 'Favorites' : profile.group;
    if (!name || knownGroups.has(name)) continue;
    knownGroups.add(name);
    state.expanded.add(nodeKey('g', name));
    changed = true;
  }
  if (changed) { persistExpanded(); safeStorage.set(GROUPS_KEY, [...knownGroups]); }
}

export function initTree() {
  const stored = safeStorage.get(TREE_KEY, []);
  if (Array.isArray(stored)) state.expanded = new Set(stored.filter((key) => typeof key === 'string'));
  const groups = safeStorage.get(GROUPS_KEY, []);
  if (Array.isArray(groups)) knownGroups = new Set(groups.filter((name) => typeof name === 'string'));
  const root = $('connectionTree');
  root.addEventListener('keydown', onKeydown);
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; renderTree(); });
  };
  bus.on('profiles', () => { openNewGroups(); schedule(); });
  for (const name of ['tree', 'tabs', 'target']) bus.on(name, schedule);
  renderTree();
}
