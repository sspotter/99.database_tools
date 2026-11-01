import { $, el, button, icon, engineBadge, state, bus, actions, runRequest, cancelOwner, api, notice, log, recordRun, recordHistory, safeStorage, settings, profileById, selected, activeTab, environment, capability, targetText } from './core.js';
import { renderToolbar, renderGridRegion, renderFooter } from './grid.js';
import { renderInspector, renderStructure, initInspector } from './inspector.js';
import { renderQuery, renderQueryTools } from './query.js';

const TABS_KEY = 'database-toolkit-tabs-v1';
let restored = false;
let queryCounter = 0;

export function tabBlockReason(tab) {
  const current = profileById(tab.profile.id);
  if (!current) return 'This connection was deleted. Open a tab from another saved connection.';
  if (current.revision !== tab.profile.revision) return 'This connection changed. Reconnect and reopen this target to use the new revision.';
  if (!state.connected.has(tab.profile.id)) return 'Connection disconnected. Connect this profile to run again.';
  return '';
}

export function makeTab(target, kind) {
  return {
    id: crypto.randomUUID(), kind, profile: structuredClone(target.profile), database: target.database || '', schema: target.schema || '', table: target.table || '',
    objectType: target.objectType || 'table', seq: kind === 'query' ? ++queryCounter : 0, view: target.view === 'structure' ? 'structure' : 'data',
    generation: 0, requestId: null, busy: false, data: null, error: '',
    metadata: null, metaError: '', metaBusy: false,
    total: undefined, countKey: '', countBusy: false, countRun: 0,
    sql: '', limit: settings.get().pageSize, offset: 0, sortColumn: '', sortDirection: 'asc',
    filterColumn: '', filterValue: '', filterNull: false, selectedRow: -1,
  };
}

// ---- persistence of tab locations (shape stays readable by older versions: `view` is optional) --------------
export function rememberTabLocations() {
  if (!restored) return;
  safeStorage.set(TABS_KEY, state.tabs.map((tab) => ({
    profileId: tab.profile.id, revision: tab.profile.revision, database: tab.database, schema: tab.schema, table: tab.table, kind: tab.kind, view: tab.view,
  })));
}
export function restoreTabLocations() {
  if (restored) return;
  restored = true;
  const saved = safeStorage.get(TABS_KEY, []);
  for (const location of Array.isArray(saved) ? saved.slice(0, 30) : []) {
    if (!location || typeof location.profileId !== 'string' || !Number.isInteger(location.revision) || !['query', 'table'].includes(location.kind)) continue;
    if (['database', 'schema', 'table'].some((key) => typeof location[key] !== 'string')) continue;
    const profile = profileById(location.profileId) || { id: location.profileId, name: 'Deleted connection', environment: 'unavailable', readOnly: true, settings: {} };
    state.tabs.push(makeTab({ profile: { ...profile, revision: location.revision }, database: location.database, schema: location.schema, table: location.table, view: location.view }, location.kind));
  }
  state.activeTab = state.tabs.at(-1)?.id || null;
}

export function invalidateTabs() {
  for (const tab of state.tabs) {
    if (!tabBlockReason(tab)) continue;
    tab.generation++;
    cancelOwner(tab.id);
    Object.assign(tab, { requestId: null, busy: false, countBusy: false, metaBusy: false });
  }
  renderTabs();
  renderTab();
}

// ---- partial repaint: only the parts whose data changed (keeps focus, popovers and scroll position) ----------
export function paint(tab, parts = ['toolbar', 'region', 'footer', 'inspector']) {
  if (state.activeTab !== tab.id) return;
  const root = $('tabContent');
  const blocked = Boolean(tabBlockReason(tab));
  const toolbar = root.querySelector('.tab-toolbar');
  const region = root.querySelector('.tab-region');
  const footer = root.querySelector('.tab-footer');
  if (parts.includes('toolbar') && toolbar) (tab.kind === 'query' ? renderQueryTools : renderToolbar)(tab, toolbar, blocked);
  if (parts.includes('region') && region) (tab.kind === 'table' && tab.view === 'structure' ? renderStructure : renderGridRegion)(tab, region);
  if (parts.includes('footer') && footer) renderFooter(tab, footer, blocked);
  if (parts.includes('inspector')) renderInspector();
}

// ---- strip ----------------------------------------------------------------------------------------------------
export function selectTab(tab, focus = false) {
  state.activeTab = tab.id;
  renderTabs();
  renderTab();
  if (focus) $('tab-' + tab.id)?.focus();
}

export function renderTabs() {
  rememberTabLocations();
  const root = $('workspaceTabs');
  root.replaceChildren();
  for (const tab of state.tabs) {
    const active = tab.id === state.activeTab;
    const blocked = tabBlockReason(tab);
    const title = tab.kind === 'query' ? `SQL query ${tab.seq}` : tab.table;
    const full = `${targetText(tab)} · ${environment(tab.profile)}${blocked ? ' · unavailable' : ''}`;
    const item = el('div', `tab-item${active ? ' active' : ''}${blocked ? ' unavailable' : ''}`);
    const select = el('button', 'tab-select');
    select.type = 'button';
    select.id = 'tab-' + tab.id;
    select.title = full;
    select.tabIndex = active ? 0 : -1;
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(active));
    select.setAttribute('aria-controls', 'tabContent');
    select.setAttribute('aria-label', `${title} — ${full}`);
    select.append(tab.kind === 'query' ? icon('sql') : engineBadge(tab.profile.engine), el('span', 'tab-title', title));
    if (environment(tab.profile) === 'production') select.append(el('span', 'tab-env', 'PROD'));
    select.addEventListener('click', () => selectTab(tab, true));
    select.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = state.tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
      selectTab(state.tabs[next], true);
    });
    const close = el('button', 'icon-button close-tab');
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${title}`);
    close.append(icon('close'));
    close.addEventListener('click', () => closeTab(tab));
    item.append(select, close);
    root.append(item);
  }
  const add = el('button', 'tab-add', '+');
  add.type = 'button';
  add.setAttribute('aria-label', 'New SQL tab');
  add.title = 'New SQL tab';
  add.addEventListener('click', () => openQuery());
  root.append(add);
  bus.emit('tabs');
}

export function closeTab(tab) {
  tab.generation++;
  cancelOwner(tab.id);
  state.tabs = state.tabs.filter((item) => item !== tab);
  if (state.activeTab === tab.id) state.activeTab = state.tabs.at(-1)?.id || null;
  renderTabs();
  renderTab();
}

// ---- body -----------------------------------------------------------------------------------------------------
function renderEmpty(root) {
  const profile = selected();
  const empty = el('div', 'empty-state');
  if (profile && !state.connected.has(profile.id)) {
    empty.append(el('h2', '', profile.name), el('p', '', 'This connection is not connected. Nothing connects automatically.'),
      button(state.pendingConnections.has(profile.id) ? 'Working…' : 'Connect', () => actions.toggleConnection(profile), 'primary', state.pendingConnections.has(profile.id)));
  } else if (profile) {
    empty.append(el('h2', '', profile.name), el('p', '', 'Pick a table or view in the tree to browse it, or open a SQL tab with the + button.'));
  } else {
    empty.append(el('h2', '', 'A workspace for your databases.'), el('p', '', 'Keep your connections together. Explore a table, inspect its structure, or run SQL in an independent tab.'),
      button('Add a connection', () => actions.openConnection(), 'primary'),
      el('p', 'hint', 'Start with an existing SQLite file or connect to PostgreSQL, MySQL or SQL Server. Nothing connects automatically.'));
  }
  root.append(empty);
}

export function renderTab() {
  const root = $('tabContent');
  root.replaceChildren();
  root.setAttribute('role', 'tabpanel');
  const tab = activeTab();
  if (tab) root.setAttribute('aria-labelledby', 'tab-' + tab.id); else root.removeAttribute('aria-labelledby');
  if (!tab) { renderEmpty(root); renderInspector(); return; }
  const reason = tabBlockReason(tab);
  if (reason) root.append(el('p', 'error', reason));
  if (tab.kind === 'query') renderQuery(tab, root, Boolean(reason));
  else for (const name of ['tab-toolbar', 'tab-region', 'tab-footer']) root.append(el('div', name));
  paint(tab);
}

// ---- opening --------------------------------------------------------------------------------------------------
export function openTable(object, { view = 'data', fresh = false } = {}) {
  const profile = profileById(object.profileId);
  if (!profile) return;
  const same = (tab) => tab.kind === 'table' && tab.profile.id === profile.id && tab.profile.revision === profile.revision
    && tab.database === object.database && tab.schema === object.schema && tab.table === object.name;
  const existing = fresh ? undefined : state.tabs.find(same);
  if (existing) {
    if (view !== existing.view) actions.setView(existing, view);
    selectTab(existing);
  } else {
    const tab = makeTab({ profile, database: object.database, schema: object.schema, table: object.name, objectType: object.objectType, view }, 'table');
    state.tabs.push(tab);
    state.activeTab = tab.id;
    renderTabs();
    renderTab();
    executeTab(tab);
  }
  if (matchMedia('(max-width:680px)').matches) {
    $('sidebar').classList.remove('open');
    $('sidebarToggle').setAttribute('aria-expanded', 'false');
    $('workspace').focus();
  }
}

export function openQuery(at) {
  const target = at ?? state.target;
  const profile = target && profileById(target.profileId);
  if (!profile || !state.connected.has(profile.id)) { notice('Connect to a connection first, then open a SQL tab.', true); return; }
  const tab = makeTab({ profile, database: target.database, schema: target.schema }, 'query');
  state.tabs.push(tab);
  state.activeTab = tab.id;
  renderTabs();
  renderTab();
}

// ---- loading: rows -> inspect (once) -> count (when the filter changes) ---------------------------------------
export async function executeTab(tab) {
  if (tab.busy || tabBlockReason(tab)) return;
  if (tab.kind === 'query' && !tab.sql.trim()) { tab.error = 'Enter one SQL statement first.'; paint(tab); return; }
  const generation = ++tab.generation;
  const requestId = crypto.randomUUID();
  const started = performance.now();
  tab.requestId = requestId; tab.busy = true; tab.error = ''; tab.selectedRow = -1;
  const task = { action: tab.kind === 'query' ? 'query' : 'rows', database: tab.database, schema: tab.schema, table: tab.table, limit: tab.limit, offset: tab.offset };
  if (tab.kind === 'query') task.sql = tab.sql;
  else {
    if (tab.sortColumn) { task.sortColumn = tab.sortColumn; task.sortDirection = tab.sortDirection; }
    if (tab.filterColumn) { task.filterColumn = tab.filterColumn; task.filterValue = tab.filterNull ? null : tab.filterValue; }
  }
  paint(tab);
  if (tab.kind === 'query') recordHistory(tab);
  try {
    const data = await runRequest(tab.id, tab, task, requestId);
    if (generation !== tab.generation || !state.tabs.includes(tab) || tabBlockReason(tab)) return;
    tab.data = data;
    recordRun(true, data.durationMs ?? performance.now() - started, tab.kind === 'query' ? 'Query completed' : 'Rows loaded');
    log(`${tab.kind === 'query' ? 'Ran query against' : 'Loaded rows from'} ${targetText(tab)}.`);
  } catch (error) {
    if (generation !== tab.generation || !state.tabs.includes(tab)) return;
    tab.data = null; tab.error = error.message;
    recordRun(false, 0, 'Request');
    log(`Database request failed for ${targetText(tab)}: ${error.message}`, true);
  } finally {
    if (generation === tab.generation) { tab.requestId = null; tab.busy = false; paint(tab); }
  }
  if (tab.kind === 'table' && generation === tab.generation && tab.data) {
    await loadMetadata(tab);
    await loadCount(tab);
  }
}

export async function loadMetadata(tab, force = false) {
  if (tab.kind !== 'table' || tab.metaBusy || (tab.metadata && !force) || tabBlockReason(tab) || !capability(tab.profile, 'inspect')) return;
  tab.metaBusy = true; tab.metaError = '';
  paint(tab, ['region', 'inspector']);
  try {
    const data = await runRequest(tab.id, tab, { action: 'inspect', database: tab.database, schema: tab.schema, table: tab.table });
    if (!state.tabs.includes(tab) || tabBlockReason(tab)) return;
    tab.metadata = data;
  } catch (error) {
    if (state.tabs.includes(tab)) tab.metaError = error.message;
  } finally {
    tab.metaBusy = false;
    paint(tab, ['toolbar', 'region', 'inspector']);
  }
}

async function loadCount(tab) {
  if (tab.kind !== 'table' || tabBlockReason(tab)) return;
  const key = JSON.stringify([tab.filterColumn, tab.filterNull ? null : tab.filterValue, tab.filterNull]);
  if (tab.countKey === key && (tab.countBusy || tab.total !== undefined)) return;
  const run = ++tab.countRun;
  tab.countKey = key; tab.countBusy = true; tab.total = undefined;
  paint(tab, ['footer', 'inspector']);
  const task = { action: 'count', database: tab.database, schema: tab.schema, table: tab.table, countTimeoutMs: settings.get().countTimeoutMs };
  if (tab.filterColumn) { task.filterColumn = tab.filterColumn; task.filterValue = tab.filterNull ? null : tab.filterValue; }
  try {
    const result = await runRequest(tab.id, tab, task);
    if (run !== tab.countRun || !state.tabs.includes(tab)) return;
    tab.total = result.exact ? result.total : null;       // null = timed out → "100+ rows"
  } catch {
    if (run === tab.countRun && state.tabs.includes(tab)) tab.total = null;   // a failed count must never block the grid
  } finally {
    if (run === tab.countRun) { tab.countBusy = false; paint(tab, ['footer', 'inspector']); }
  }
}

export async function cancelTab(tab) {
  if (!tab.requestId) return;
  const requestId = tab.requestId;
  try {
    const response = await api('/api/workspace/cancel', { requestId });
    if (tab.requestId !== requestId) return;
    if (!response.cancelled) { notice('This request has already finished.'); return; }
    tab.generation++; tab.requestId = null; tab.busy = false; tab.error = 'Request cancelled. It was not retried.';
    paint(tab);
    log(`Cancelled database request for ${targetText(tab)}.`);
  } catch (error) { notice(`Could not cancel request: ${error.message}`, true); }
}

// ---- user actions (registered for grid/inspector/query modules) ----------------------------------------------
function setView(tab, view) {
  tab.view = view;
  rememberTabLocations();
  if (view === 'structure') loadMetadata(tab);
  paint(tab);
}
function applyFilter(tab, column, value, isNull) {
  Object.assign(tab, { filterColumn: column, filterValue: value, filterNull: Boolean(column) && isNull, offset: 0 });
  executeTab(tab);
}
function sortBy(tab, column) {
  tab.sortDirection = tab.sortColumn === column && tab.sortDirection === 'asc' ? 'desc' : 'asc';
  tab.sortColumn = column; tab.offset = 0;
  executeTab(tab);
}
function goToPage(tab, page) { tab.offset = Math.max(0, (page - 1) * tab.limit); executeTab(tab); }
function setPageSize(tab, limit) { tab.limit = limit; tab.offset = 0; executeTab(tab); }
function refreshTab(tab) { tab.countKey = ''; tab.total = undefined; executeTab(tab); }

export function initTabs() {
  Object.assign(actions, { paint, executeTab, cancelTab, loadMetadata, setView, applyFilter, sortBy, goToPage, setPageSize, refreshTab, openTable, openQuery, closeTab });
  initInspector();
  bus.on('settings', () => { const tab = activeTab(); if (tab) paint(tab); else renderInspector(); });
  bus.on('view', renderInspector);
  bus.on('profiles', () => { if (!activeTab()) renderTab(); });
  bus.on('target', () => { if (!activeTab()) renderTab(); });
}
