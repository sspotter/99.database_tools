const tokenStorageKey = 'database-toolkit-token:' + location.origin;
const pageUrl = new URL(location.href);
let token = pageUrl.searchParams.get('token') || '';
try {
  if (token) sessionStorage.setItem(tokenStorageKey, token);
  else token = sessionStorage.getItem(tokenStorageKey) || '';
} catch { /* Token remains in memory if browser storage is disabled. */ }
if (pageUrl.searchParams.has('token')) {
  pageUrl.searchParams.delete('token');
  history.replaceState(null, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
}
const $ = (id) => document.getElementById(id);
const form = $('connectionForm');
const fields = form.elements;
const state = { profiles: [], profilesVersion: 0, capabilities: {}, selectedId: null, connected: new Set(), pendingConnections: new Set(), navigation: null, navigationVersion: 0, tabs: [], activeTab: null, editing: null, errors: 0, history: [], persistHistory: false, persistence: '' };
const HISTORY_KEY = 'database-toolkit-query-history-v1';
const HISTORY_OPT_IN = 'database-toolkit-history-enabled';
const TABS_KEY = 'database-toolkit-tabs-v1';
const RECENTS_KEY = 'database-toolkit-recents-v1';
let savedTabs = [];
let tabsRestored = false;
let recentProfiles = [];
let objectSearch = '';
try {
  state.persistHistory = localStorage.getItem(HISTORY_OPT_IN) === 'true';
  if (state.persistHistory) {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(stored)) state.history = stored.filter((item) => item && typeof item.sql === 'string' && typeof item.profileId === 'string').slice(0, 100);
  }
  const restored = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
  if (Array.isArray(restored)) savedTabs = restored.slice(0, 30);
  const recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
  if (Array.isArray(recents)) recentProfiles = recents.filter((id) => typeof id === 'string').slice(0, 8);
} catch { /* Browser storage may be disabled. Session history remains available. */ }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function button(text, action, className = '', disabled = false) {
  const node = el('button', className, text);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
function option(value, text = value) {
  const node = el('option', '', text);
  node.value = value;
  return node;
}
function label(text, control) {
  const node = el('label', '', text);
  node.append(control);
  return node;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
}
function log(message, error = false) {
  const row = el('div', error ? 'error' : '', `${new Date().toLocaleTimeString()} · ${message}`);
  $('logConsole').prepend(row);
  while ($('logConsole').children.length > 200) $('logConsole').lastChild.remove();
  if (error) $('errorCount').textContent = `(${++state.errors})`;
}
function fail(error, context) {
  notice(`${context}: ${error.message}`, true);
  log(`${context}: ${error.message}`, true);
}
function showView(view) {
  for (const name of ['workspace', 'dashboard', 'logs']) {
    $(name + 'View').hidden = name !== view;
    $(name + 'Nav').classList.toggle('active', name === view);
  }
  if (view === 'dashboard') renderDashboard();
  if (view === 'logs') { state.errors = 0; $('errorCount').textContent = ''; }
}
function profileById(id) { return state.profiles.find((profile) => profile.id === id); }
function selected() { return profileById(state.selectedId); }
function endpoint(profile, action) { return `/api/connections/${encodeURIComponent(profile.id)}/${action}`; }
function targetText(target) {
  return [target.profile.name, target.database || target.profile.settings?.file || target.profile.settings?.database, target.schema, target.table].filter(Boolean).join(' / ');
}
function environment(profile) { return profile.environment || 'development'; }
function capability(profile, key) { return state.capabilities[profile.engine]?.[key] === true; }
function tabBlockReason(tab) {
  const current = profileById(tab.profile.id);
  if (!current) return 'This connection was deleted. Open a tab from another saved connection.';
  if (current.revision !== tab.profile.revision) return 'This connection changed. Reconnect and reopen this target to use the new revision.';
  if (!state.connected.has(tab.profile.id)) return 'Connection disconnected. Connect this profile to run again.';
  return '';
}
function invalidateTabs() {
  for (const tab of state.tabs) {
    if (tabBlockReason(tab)) {
      tab.generation++;
      if (tab.requestId) api('/api/workspace/cancel', { requestId: tab.requestId }).catch(() => {});
      tab.requestId = null;
      tab.busy = false;
    }
  }
  renderTabs();
  renderTab();
}
function rememberTabLocations() {
  if (!tabsRestored) return;
  const locations = state.tabs.map((tab) => ({ profileId: tab.profile.id, revision: tab.profile.revision, database: tab.database, schema: tab.schema, table: tab.table, kind: tab.kind }));
  try { localStorage.setItem(TABS_KEY, JSON.stringify(locations)); }
  catch { /* Tabs still work for this session without browser storage. */ }
}
function restoreTabLocations() {
  if (tabsRestored) return;
  tabsRestored = true;
  for (const location of savedTabs) {
    if (!location || typeof location.profileId !== 'string' || !Number.isInteger(location.revision) || !['query', 'table'].includes(location.kind)) continue;
    if (['database', 'schema', 'table'].some((key) => typeof location[key] !== 'string')) continue;
    const profile = profileById(location.profileId) || { id: location.profileId, name: 'Deleted connection', environment: 'unavailable', readOnly: true, settings: {} };
    state.tabs.push(makeTab({ profile: { ...profile, revision: location.revision }, database: location.database, schema: location.schema, table: location.table }, location.kind));
  }
  state.activeTab = state.tabs.at(-1)?.id || null;
  savedTabs = [];
}
function rememberRecent(id) {
  recentProfiles = [id, ...recentProfiles.filter((previous) => previous !== id)].slice(0, 8);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recentProfiles)); }
  catch { /* Connection navigation does not depend on storage. */ }
}
async function refreshProfiles() {
  const version = ++state.profilesVersion;
  try {
    const data = await api('/api/connections');
    if (version !== state.profilesVersion) return;
    state.profiles = data.profiles || [];
    state.capabilities = data.capabilities || {};
    state.persistence = data.credentialPersistence;
    state.connected = new Set(state.profiles.filter((profile) => profile.connected).map((profile) => profile.id));
    restoreTabLocations();
    $('persistenceNote').textContent = data.credentialPersistence === 'windows-dpapi' ? 'Remembered passwords are protected by your Windows account.' : 'Password persistence is unavailable. Use session-only credentials.';
    fields.credentialMode.querySelector('[value="saved"]').disabled = data.credentialPersistence !== 'windows-dpapi';
    if (state.selectedId && !selected()) { state.selectedId = null; state.navigation = null; state.navigationVersion++; }
    if (state.navigation && (!selected() || state.navigation.profile.revision !== selected().revision || !state.connected.has(state.selectedId))) { state.navigation = null; state.navigationVersion++; }
    renderProfiles(); renderExplorer(); renderHeader(); invalidateTabs();
  } catch (error) { if (version === state.profilesVersion) fail(error, 'Could not load connections'); }
}
function renderProfiles() {
  const root = $('connectionList');
  root.replaceChildren();
  const search = $('connectionSearch').value.toLowerCase().trim();
  const profiles = state.profiles.filter((profile) => [profile.name, profile.group, profile.engine, profile.environment].join(' ').toLowerCase().includes(search)).sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name));
  if (!profiles.length) {
    root.append(el('p', 'hint', state.profiles.length ? 'No matching connections.' : 'No connections yet. Add a SQLite file or server connection to start exploring.'));
    return;
  }
  const recent = recentProfiles.map(profileById).filter(Boolean).filter((profile) => !search || [profile.name, profile.group, profile.environment].join(' ').toLowerCase().includes(search));
  if (recent.length) {
    root.append(el('h2', 'group-title', 'Recent connections'));
    for (const profile of recent.slice(0, 4)) root.append(button(profile.name, () => selectProfile(profile.id), 'connection-select recent-connection'));
  }
  let group;
  for (const profile of profiles) {
    const nextGroup = profile.favorite ? 'Favorites' : (profile.group || 'Ungrouped');
    if (nextGroup !== group) { root.append(el('h2', 'group-title', nextGroup)); group = nextGroup; }
    const row = el('div', `connection${profile.id === state.selectedId ? ' selected' : ''}`);
    const select = button(profile.name, () => selectProfile(profile.id), 'connection-select connection-name');
    select.setAttribute('aria-pressed', profile.id === state.selectedId ? 'true' : 'false');
    const connected = state.connected.has(profile.id);
    const meta = el('div', 'connection-meta', `${profile.engine} · ${environment(profile)} · ${connected ? 'connected' : 'disconnected'}`);
    if (environment(profile) === 'production') meta.classList.add('environment-production');
    row.append(select, meta);
    const actions = el('div', 'connection-actions');
    const pending = state.pendingConnections.has(profile.id);
    actions.append(button(pending ? 'Working…' : connected ? 'Disconnect' : 'Connect', () => toggleConnection(profile), connected ? 'status-connected' : '', pending));
    if (profile.id === state.selectedId) {
      actions.append(button('Edit', () => openConnection(profile)), button('Duplicate', () => openConnection(profile, true)), button(profile.favorite ? 'Unfavorite' : 'Favorite', () => favorite(profile)), button('Delete', () => deleteConnection(profile), 'danger'));
    }
    row.append(actions); root.append(row);
  }
}
function renderHeader() {
  const profile = selected();
  const root = $('targetHeader');
  root.replaceChildren();
  if (!profile) { root.textContent = 'No connection selected'; $('newQuery').disabled = true; return; }
  const heading = el('strong', environment(profile) === 'production' ? 'environment-production' : '', `${profile.name} · ${environment(profile)}`);
  root.append(heading, el('span', '', `${profile.engine} · ${profile.readOnly ? 'Read-only SQL' : 'Writable SQL'} · ${state.connected.has(profile.id) ? 'Connected' : 'Disconnected'}`));
  $('newQuery').disabled = !state.connected.has(profile.id) || !state.navigation || state.navigation.busy || !!state.navigation.error;
}
function renderDashboard() {
  const root = $('dashboardContent');
  root.replaceChildren();
  for (const [name, value] of [['Saved connections', state.profiles.length], ['Connected', state.connected.size], ['Open tabs', state.tabs.length], ['Credential storage', state.persistence === 'windows-dpapi' ? 'Windows account encryption' : 'Session only']]) {
    const row = el('div', 'status-row'); row.append(el('span', '', name), el('strong', '', value)); root.append(row);
  }
}
function selectProfile(id) {
  const changed = state.selectedId !== id;
  state.selectedId = id;
  rememberRecent(id);
  renderProfiles(); renderHeader();
  if (changed) { state.navigationVersion++; state.navigation = null; }
  if (state.connected.has(id) && !state.navigation) loadNavigation();
  else renderExplorer();
}
async function toggleConnection(profile) {
  if (state.pendingConnections.has(profile.id)) return;
  const disconnect = state.connected.has(profile.id);
  state.pendingConnections.add(profile.id);
  if (!disconnect) selectProfile(profile.id);
  renderProfiles();
  notice(`${disconnect ? 'Disconnecting' : 'Connecting'} ${profile.name}…`);
  try {
    const result = await api(endpoint(profile, disconnect ? 'disconnect' : 'connect'), { revision: profile.revision });
    if (disconnect) {
      state.connected.delete(profile.id);
      if (state.selectedId === profile.id) { state.navigation = null; state.navigationVersion++; }
      invalidateTabs(); renderProfiles(); renderExplorer(); renderHeader();
      notice('Disconnected. Session-only credentials were cleared.');
    } else {
      state.connected.add(profile.id);
      renderProfiles(); renderHeader();
      if (state.selectedId === profile.id) {
        state.navigation = null;
        await loadNavigation(result.databases);
      }
      notice(`Connected to ${profile.name}.`);
    }
    log(`${disconnect ? 'Disconnected from' : 'Connected to'} ${profile.name}.`);
  } catch (error) { fail(error, disconnect ? 'Disconnect failed' : 'Connection failed'); }
  finally { state.pendingConnections.delete(profile.id); renderProfiles(); renderTabs(); renderTab(); }
}
async function favorite(profile) {
  try { await api('/api/connections', { ...profile, favorite: !profile.favorite }); await refreshProfiles(); }
  catch (error) { fail(error, 'Could not update favorite'); }
}
async function deleteConnection(profile) {
  if (!confirm(`Delete "${profile.name}"? Its open tabs will be disabled. The database itself will not be deleted.`)) return;
  try {
    const response = await fetch(`/api/connections/${encodeURIComponent(profile.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-ui-token': token }, body: JSON.stringify({ revision: profile.revision }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Delete failed.');
    await refreshProfiles(); notice('Connection removed.'); log('Removed a connection profile.');
  } catch (error) { fail(error, 'Could not delete connection'); }
}
function openConnection(profile = null, duplicate = false) {
  form.reset();
  fields.credentialMode.value = state.persistence === 'windows-dpapi' ? 'saved' : 'session';
  state.editing = duplicate ? null : profile;
  $('connectionTitle').textContent = profile ? (duplicate ? 'Duplicate connection' : 'Edit connection') : 'Add connection';
  $('formMessage').textContent = duplicate ? 'The copy has no password. Enter credentials explicitly if it needs them.' : '';
  $('formMessage').className = '';
  for (const name of ['name', 'group', 'engine', 'environment', 'credentialMode']) {
    if (profile?.[name] !== undefined) fields[name].value = profile[name];
  }
  if (profile) {
    for (const name of ['host', 'port', 'user', 'database', 'file', 'sslMode', 'sslCa']) fields[name].value = profile.settings?.[name] ?? (name === 'sslMode' ? 'verify-full' : '');
    fields.readOnly.checked = profile.readOnly;
    fields.favorite.checked = profile.favorite;
  }
  if (profile && ![...fields.environment.options].some((entry) => entry.value === profile.environment)) {
    fields.environment.append(option(profile.environment)); fields.environment.value = profile.environment;
  }
  if (duplicate) { fields.name.value += ' copy'; fields.credentialMode.value = 'session'; fields.favorite.checked = false; }
  fields.password.type = 'password';
  $('showPassword').textContent = 'Show'; $('showPassword').setAttribute('aria-pressed', 'false');
  $('passwordStatus').textContent = state.editing ? `(${profile.credentialStatus || 'unknown'})` : '';
  syncConnectionForm();
  $('connectionDialog').showModal();
}
function syncConnectionForm() {
  const sqlite = fields.engine.value === 'sqlite';
  const url = fields.entryMode.value === 'url' && !sqlite;
  $('entryModeLabel').hidden = sqlite;
  $('urlFields').hidden = !url;
  $('sqliteFields').hidden = !sqlite;
  $('serverFields').hidden = sqlite || url;
  $('credentialFields').hidden = sqlite;
  $('passwordActionLabel').hidden = !state.editing || url;
  fields.password.disabled = !!state.editing && fields.passwordAction.value !== 'replace';
  if (fields.credentialMode.value === 'saved' && state.persistence !== 'windows-dpapi') fields.credentialMode.value = 'session';
}
function connectionInput() {
  const input = { ...(state.editing ? { id: state.editing.id, revision: state.editing.revision } : {}), name: fields.name.value.trim(), engine: fields.engine.value, group: fields.group.value.trim(), environment: fields.environment.value, favorite: fields.favorite.checked, readOnly: fields.readOnly.checked, credentialMode: fields.engine.value === 'sqlite' ? 'none' : fields.credentialMode.value };
  if (fields.entryMode.value === 'url' && input.engine !== 'sqlite') input.url = fields.url.value.trim();
  else if (input.engine === 'sqlite') input.settings = { file: fields.file.value.trim() };
  else {
    input.settings = {};
    for (const name of ['host', 'port', 'database', 'user', 'sslMode', 'sslCa']) if (fields[name].value) input.settings[name] = name === 'port' ? Number(fields[name].value) : fields[name].value.trim();
    if (!state.editing || fields.passwordAction.value === 'replace') input.settings.password = fields.password.value;
    if (state.editing && fields.passwordAction.value === 'clear') input.settings.password = '';
  }
  return input;
}
async function submitConnection(test) {
  if (!form.reportValidity()) return;
  const controls = [form.querySelector('[type="submit"]'), $('testConnection')];
  controls.forEach((control) => { control.disabled = true; });
  $('formMessage').className = '';
  $('formMessage').textContent = test ? 'Testing connection…' : 'Saving connection…';
  try {
    const input = connectionInput();
    await api(test ? '/api/connections/test' : '/api/connections', test ? { profile: input } : input);
    if (test) $('formMessage').textContent = 'Connection test succeeded. You can save this profile.';
    else {
      $('connectionDialog').close();
      fields.password.value = ''; fields.url.value = '';
      await refreshProfiles();
      notice('Connection saved. Choose Connect when ready.');
      log('Saved a connection profile.');
    }
  } catch (error) {
    $('formMessage').textContent = error.message;
    $('formMessage').className = 'error';
    // Form errors intentionally stay out of logs: unsaved values can include secrets.
  } finally { controls.forEach((control) => { control.disabled = false; }); }
}
async function workspaceRequest(target, task, requestId = crypto.randomUUID()) {
  const requestTask = { ...task };
  for (const key of ['database', 'schema', 'table', 'sortColumn', 'filterColumn']) {
    if (requestTask[key] === '') delete requestTask[key];
  }
  return api('/api/workspace', { profileId: target.profile.id, revision: target.profile.revision, requestId, task: requestTask });
}
async function loadNavigation(initialDatabases) {
  const profile = selected();
  if (!profile || !state.connected.has(profile.id)) return;
  const version = ++state.navigationVersion;
  objectSearch = '';
  const nav = { profile: structuredClone(profile), database: profile.settings?.database || '', schema: '', databases: [], schemas: [], tables: [], busy: true, error: '' };
  state.navigation = nav; renderExplorer(); renderHeader();
  try {
    const data = initialDatabases === undefined ? await workspaceRequest(nav, { action: 'databases' }) : { databases: Array.isArray(initialDatabases) ? initialDatabases : initialDatabases.databases || [] };
    if (version !== state.navigationVersion) return;
    nav.databases = data.databases || [];
    if (!nav.databases.includes(nav.database)) nav.database = nav.databases[0] || nav.database;
    await loadObjects(nav, version);
  } catch (error) {
    if (version !== state.navigationVersion) return;
    nav.error = error.message; nav.busy = false; renderExplorer();
  }
}
async function loadObjects(nav = state.navigation, version = ++state.navigationVersion) {
  if (!nav) return;
  nav.busy = true; nav.error = ''; nav.tables = []; renderExplorer();
  try {
    if (capability(nav.profile, 'schemas')) {
      const data = await workspaceRequest(nav, { action: 'schemas', database: nav.database });
      if (version !== state.navigationVersion) return;
      nav.schemas = data.schemas || [];
      if (!nav.schemas.includes(nav.schema)) nav.schema = nav.schemas.includes('public') ? 'public' : nav.schemas[0] || '';
    } else { nav.schemas = []; nav.schema = ''; }
    const data = await workspaceRequest(nav, { action: 'tables', database: nav.database, schema: nav.schema });
    if (version !== state.navigationVersion) return;
    nav.tables = data.tables || []; nav.busy = false; renderExplorer(); renderHeader();
  } catch (error) {
    if (version !== state.navigationVersion) return;
    nav.error = error.message; nav.busy = false; renderExplorer(); renderHeader();
  }
}
function renderExplorer() {
  const root = $('explorer'); root.replaceChildren();
  const profile = selected();
  if (!profile) { root.append(el('p', 'hint', 'Select a connection to explore its objects.')); return; }
  if (!state.connected.has(profile.id)) { root.append(el('h2', 'group-title', profile.name), el('p', 'hint', 'Disconnected. Connect to discover databases and tables.')); return; }
  const nav = state.navigation;
  if (!nav) { root.append(el('p', 'hint', 'Loading explorer…')); return; }
  const heading = el('div', 'section-head'); heading.append(el('h2', 'group-title', 'Database explorer'), button('Refresh', () => loadNavigation(), '', nav.busy)); root.append(heading);
  if (!capability(profile, 'browse')) { root.append(el('p', 'hint', 'Object browsing is unsupported for this engine.')); return; }
  if (profile.engine === 'sqlite') root.append(el('p', 'hint', profile.settings.file || 'SQLite file'));
  else {
    const databases = el('select'); databases.setAttribute('aria-label', 'Database');
    for (const database of nav.databases) databases.append(option(database));
    databases.value = nav.database; databases.disabled = nav.busy;
    databases.addEventListener('change', () => { nav.database = databases.value; nav.schema = ''; loadObjects(); renderHeader(); });
    root.append(label('Database', databases));
  }
  if (nav.schemas.length) {
    const schemas = el('select'); schemas.setAttribute('aria-label', 'Schema');
    for (const schema of nav.schemas) schemas.append(option(schema));
    schemas.value = nav.schema; schemas.disabled = nav.busy;
    schemas.addEventListener('change', () => { nav.schema = schemas.value; loadObjects(); });
    root.append(label('Schema', schemas));
  }
  if (nav.busy) { root.append(el('p', 'hint', 'Discovering objects…')); return; }
  if (nav.error) { root.append(el('p', 'error', nav.error), button('Retry discovery', () => loadNavigation())); return; }
  if (!nav.tables.length) { root.append(el('p', 'hint', 'No accessible tables or views in this branch.')); return; }
  const filter = el('input'); filter.type = 'search'; filter.placeholder = 'Find a table or view…'; filter.value = objectSearch; filter.setAttribute('aria-label', 'Find a table or view');
  const list = el('div', 'object-list');
  function renderObjects() {
    list.replaceChildren();
    const objects = nav.tables.filter((object) => object.name.toLowerCase().includes(objectSearch.toLowerCase()));
    for (const object of objects) list.append(button(`${object.name} · ${object.type || 'table'}`, () => openTable(nav, object)));
    if (!objects.length) list.append(el('p', 'hint', 'No matching objects.'));
  }
  filter.addEventListener('input', () => { objectSearch = filter.value; renderObjects(); });
  renderObjects(); root.append(filter, list);
}
function makeTab(target, kind) {
  return { id: crypto.randomUUID(), kind, profile: structuredClone(target.profile), database: target.database || '', schema: target.schema || '', table: target.table || '', generation: 0, requestId: null, busy: false, data: null, error: '', sql: '', limit: 100, offset: 0, sortColumn: '', sortDirection: 'asc', filterColumn: '', filterValue: '', inspect: false, metadata: null };
}
function openTable(nav, object) {
  const tab = makeTab({ ...nav, table: object.name, schema: object.schema || nav.schema }, 'table');
  state.tabs.push(tab); state.activeTab = tab.id;
  showView('workspace'); renderTabs(); renderTab(); executeTab(tab);
  if (matchMedia('(max-width:680px)').matches) {
    $('sidebar').classList.remove('open'); $('sidebarToggle').setAttribute('aria-expanded', 'false'); $('workspace').focus();
  }
}
function openQuery() {
  if (!state.navigation || !selected()) return;
  const tab = makeTab(state.navigation, 'query');
  state.tabs.push(tab); state.activeTab = tab.id;
  showView('workspace'); renderTabs(); renderTab();
}
function activeTab() { return state.tabs.find((tab) => tab.id === state.activeTab); }
function renderTabs() {
  rememberTabLocations();
  const root = $('workspaceTabs'); root.replaceChildren();
  for (const tab of state.tabs) {
    const item = el('div', `tab-item${tab.id === state.activeTab ? ' active' : ''}`);
    const title = `${tab.profile.name} / ${tab.table || 'SQL'} · ${environment(tab.profile)}${tabBlockReason(tab) ? ' · unavailable' : ''}`;
    const select = button(title, () => { state.activeTab = tab.id; renderTabs(); renderTab(); $('tab-' + tab.id).focus(); });
    select.id = 'tab-' + tab.id;
    select.tabIndex = tab.id === state.activeTab ? 0 : -1;
    select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.id === state.activeTab)); select.setAttribute('aria-controls', 'tabContent');
    select.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = state.tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
      state.activeTab = state.tabs[next].id; renderTabs(); renderTab();
      root.querySelectorAll('[role="tab"]')[next].focus();
    });
    const close = button('Close', () => closeTab(tab), 'close-tab'); close.setAttribute('aria-label', `Close ${title}`);
    item.append(select, close); root.append(item);
  }
}
function closeTab(tab) {
  tab.generation++;
  if (tab.requestId) api('/api/workspace/cancel', { requestId: tab.requestId }).catch(() => {});
  state.tabs = state.tabs.filter((item) => item !== tab);
  if (state.activeTab === tab.id) state.activeTab = state.tabs.at(-1)?.id || null;
  renderTabs(); renderTab();
}
function renderTab() {
  const root = $('tabContent'); root.replaceChildren(); root.setAttribute('role', 'tabpanel');
  const tab = activeTab();
  if (tab) root.setAttribute('aria-labelledby', 'tab-' + tab.id);
  else root.removeAttribute('aria-labelledby');
  if (!tab) {
    const empty = el('div', 'empty-state');
    empty.append(el('h2', '', 'A workspace for your databases.'), el('p', '', 'Keep your connections together. Explore a table, inspect its structure, or run SQL in an independent tab.'), button('Add a connection', () => openConnection(), 'primary'), el('p', 'hint', 'Start with an existing SQLite file or connect to PostgreSQL, MySQL or SQL Server. Nothing connects automatically.'));
    root.append(empty); return;
  }
  const strip = el('div', 'target-strip');
  strip.append(el('strong', '', targetText(tab)), el('span', `badge ${environment(tab.profile) === 'production' ? 'environment-production' : ''}`, environment(tab.profile)), el('span', `badge ${tab.profile.readOnly ? '' : 'writable'}`, tab.profile.readOnly ? 'Read-only SQL' : 'Writable SQL'), el('span', 'badge', `revision ${tab.profile.revision}`));
  root.append(strip);
  const reason = tabBlockReason(tab);
  if (reason) root.append(el('p', 'error', reason));
  if (tab.kind === 'query') renderQuery(tab, root, !!reason);
  else renderTableControls(tab, root, !!reason);
  if (tab.error) root.append(el('p', 'error', tab.error));
  if (tab.busy) root.append(el('p', 'result-meta', 'Running… Cancellation terminates the database request.'));
  if (tab.inspect && tab.metadata) renderMetadata(tab.metadata, root);
  else if (tab.data) renderResult(tab, root);
}
function renderQuery(tab, root, blocked) {
  if (tab.profile.engine === 'mssql') {
    root.append(el('p', 'hint', 'SQL Server uses your login’s default schema for unqualified names. Use [schema].[table] to target the schema shown on this tab.'));
  }
  const supported = capability(tab.profile, 'query') && (!tab.profile.readOnly || capability(tab.profile, 'readOnlyQuery'));
  if (!supported) root.append(el('p', 'hint', 'Arbitrary SQL is unavailable for this engine or its read-only mode. Table browsing remains available.'));
  const editor = el('textarea', 'sql-editor'); editor.value = tab.sql; editor.placeholder = 'Write one SQL statement…'; editor.spellcheck = false; editor.setAttribute('aria-label', 'SQL statement');
  editor.addEventListener('input', () => { tab.sql = editor.value; });
  editor.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!tab.busy && !blocked && supported && tab.sql.trim()) executeTab(tab); } });
  const tools = el('div', 'tab-tools');
  tools.append(button('Run SQL', () => executeTab(tab), 'primary', blocked || !supported || tab.busy), button('Cancel', () => cancelTab(tab), '', !tab.busy), el('span', 'hint', 'Ctrl / Cmd + Enter · One statement · No shared transaction'));
  root.append(editor, tools);
  renderHistory(tab, root);
}
function renderTableControls(tab, root, blocked) {
  const tools = el('div', 'tab-tools');
  const pageSize = el('select', 'page-size'); pageSize.setAttribute('aria-label', 'Rows per page');
  for (const count of [50, 100, 250, 500, 1000]) pageSize.append(option(String(count)));
  pageSize.value = String(tab.limit); pageSize.disabled = tab.busy;
  pageSize.addEventListener('change', () => { tab.limit = Number(pageSize.value); tab.offset = 0; executeTab(tab); });
  const filterColumn = el('select'); filterColumn.setAttribute('aria-label', 'Filter column'); filterColumn.append(option('', 'No filter'));
  for (const column of tab.data?.columns || []) filterColumn.append(option(column));
  filterColumn.value = tab.filterColumn;
  const filterValue = el('input'); filterValue.value = tab.filterValue; filterValue.placeholder = 'Exact value'; filterValue.setAttribute('aria-label', 'Filter value');
  filterColumn.addEventListener('change', () => { tab.filterColumn = filterColumn.value; });
  filterValue.addEventListener('input', () => { tab.filterValue = filterValue.value; });
  filterValue.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !blocked && !tab.busy) { tab.offset = 0; executeTab(tab); } });
  tools.append(label('Rows per page', pageSize), label('Filter column', filterColumn), label('Equals', filterValue), button('Apply filter', () => { tab.offset = 0; executeTab(tab); }, '', blocked || tab.busy), button('Refresh rows', () => { tab.inspect = false; executeTab(tab); }, '', blocked || tab.busy), button(tab.inspect ? 'Show rows' : 'Structure', () => { tab.inspect = !tab.inspect; if (tab.inspect && !tab.metadata) executeTab(tab, true); else renderTab(); }, '', blocked || tab.busy || !capability(tab.profile, 'inspect')));
  root.append(tools);
  const paging = el('div', 'tab-tools');
  paging.append(button('Previous page', () => { tab.offset = Math.max(0, tab.offset - tab.limit); executeTab(tab); }, '', blocked || tab.busy || tab.offset === 0), el('span', 'hint', `Page ${Math.floor(tab.offset / tab.limit) + 1}`), button('Next page', () => { tab.offset += tab.limit; executeTab(tab); }, '', blocked || tab.busy || !tab.data?.hasMore));
  root.append(paging, el('p', 'hint', 'Click a column heading to sort. Pages can shift as data changes; use a unique column for stable ordering.'));
}
async function executeTab(tab, inspect = false) {
  if (tab.busy || tabBlockReason(tab)) return;
  if (tab.kind === 'query' && !tab.sql.trim()) { tab.error = 'Enter one SQL statement first.'; renderTab(); return; }
  const generation = ++tab.generation;
  const requestId = crypto.randomUUID();
  tab.requestId = requestId; tab.busy = true; tab.error = '';
  if (!inspect) { tab.inspect = false; tab.data = null; }
  let task = { action: inspect ? 'inspect' : tab.kind === 'query' ? 'query' : 'rows', database: tab.database, schema: tab.schema, table: tab.table, limit: tab.limit, offset: tab.offset };
  if (tab.kind === 'query') task.sql = tab.sql;
  else if (!inspect) {
    if (tab.sortColumn) { task.sortColumn = tab.sortColumn; task.sortDirection = tab.sortDirection; }
    if (tab.filterColumn) { task.filterColumn = tab.filterColumn; task.filterValue = tab.filterValue; }
  }
  if (state.activeTab === tab.id) renderTab();
  if (tab.kind === 'query' && !inspect) recordHistory(tab);
  try {
    const data = await workspaceRequest(tab, task, requestId);
    if (generation !== tab.generation || !state.tabs.includes(tab) || tabBlockReason(tab)) return;
    if (inspect) tab.metadata = data;
    else tab.data = data;
    log(`${inspect ? 'Inspected' : tab.kind === 'query' ? 'Ran query against' : 'Loaded rows from'} ${targetText(tab)}.`);
  } catch (error) {
    if (generation !== tab.generation || !state.tabs.includes(tab)) return;
    tab.error = error.message; log(`Database request failed for ${targetText(tab)}: ${error.message}`, true);
  } finally {
    if (generation === tab.generation) { tab.requestId = null; tab.busy = false; if (state.activeTab === tab.id) renderTab(); }
  }
}
async function cancelTab(tab) {
  if (!tab.requestId) return;
  const requestId = tab.requestId;
  try {
    const response = await api('/api/workspace/cancel', { requestId });
    if (tab.requestId !== requestId) return;
    if (!response.cancelled) { notice('This request has already finished.'); return; }
    tab.generation++; tab.requestId = null; tab.busy = false; tab.error = 'Request cancelled. It was not retried.';
    if (state.activeTab === tab.id) renderTab();
    log(`Cancelled database request for ${targetText(tab)}.`);
  } catch (error) { fail(error, 'Could not cancel request'); }
}
function cellText(value) {
  if (value === null || value === undefined) return 'NULL';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function renderResult(tab, root) {
  const data = tab.data;
  const tools = el('div', 'tab-tools');
  tools.append(el('span', 'result-meta', `${data.rows?.length || 0} loaded rows · ${data.columns?.length || 0} columns${data.durationMs !== undefined ? ' · ' + data.durationMs + ' ms' : ''}${data.hasMore ? ' · more rows available' : ''}${data.truncatedValues ? ' · ' + data.truncatedValues + ' values truncated' : ''}`), button('Export loaded JSON', () => exportResult(tab, 'json')), button('Export loaded CSV', () => exportResult(tab, 'csv')));
  root.append(tools);
  if (!data.columns?.length) { root.append(el('p', 'hint', `Statement completed.${data.rowCount !== undefined ? ' Affected rows: ' + data.rowCount + '.' : ''}`)); return; }
  if (!data.rows?.length) root.append(el('p', 'hint', 'No rows returned for this page or filter.'));
  const wrap = el('div', 'data-table-wrap'); wrap.tabIndex = 0; wrap.setAttribute('aria-label', 'Result rows; scroll horizontally for more columns');
  const table = el('table', 'data-table'); const head = el('thead'); const headRow = el('tr');
  for (const column of data.columns) {
    const cell = el('th'); cell.scope = 'col';
    if (tab.kind === 'table') {
      const sort = button(`${column}${tab.sortColumn === column ? ' (' + tab.sortDirection + ')' : ''}`, () => { tab.sortDirection = tab.sortColumn === column && tab.sortDirection === 'asc' ? 'desc' : 'asc'; tab.sortColumn = column; tab.offset = 0; executeTab(tab); }, '', tab.busy || !!tabBlockReason(tab));
      sort.title = `Sort by ${column}`; cell.append(sort);
      if (tab.sortColumn === column) cell.setAttribute('aria-sort', tab.sortDirection === 'asc' ? 'ascending' : 'descending');
    } else cell.textContent = column;
    headRow.append(cell);
  }
  head.append(headRow); table.append(head);
  const body = el('tbody');
  for (const row of data.rows || []) {
    const tr = el('tr');
    for (const column of data.columns) {
      const value = row[column]; const text = cellText(value);
      const cell = el('td', value === null || value === undefined ? 'null-cell' : '', text.length > 1000 ? text.slice(0, 1000) + '…' : text);
      if (text.length > 1000) cell.title = 'Display truncated to 1,000 characters. Export loaded JSON for the full returned value.';
      else cell.title = text;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body); wrap.append(table); root.append(wrap);
}
function renderMetadata(metadata, root) {
  for (const [title, value] of [['Columns', metadata.columns], ['Indexes', metadata.indexes], ['Foreign keys', metadata.foreignKeys]]) {
    root.append(el('h3', '', title));
    root.append(el('pre', 'inspector', value?.length ? JSON.stringify(value, null, 2) : 'None reported.'));
  }
  if (metadata.definition) root.append(el('h3', '', 'Definition'), el('pre', 'inspector', metadata.definition));
}
function exportResult(tab, format) {
  const data = tab.data;
  const csvCell = (value) => {
    let text = value === null || value === undefined ? '' : cellText(value);
    // Spreadsheet programs treat these prefixes as formulas, even in quoted CSV.
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const content = format === 'json' ? JSON.stringify(data.rows || [], null, 2) : [data.columns.map(csvCell).join(','), ...(data.rows || []).map((row) => data.columns.map((column) => csvCell(row[column])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
  const anchor = el('a'); anchor.href = url; anchor.download = `loaded-${(tab.table || 'query').replace(/[^a-z0-9_-]/gi, '_')}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_OPT_IN, String(state.persistHistory));
    if (state.persistHistory) localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    else localStorage.removeItem(HISTORY_KEY);
  } catch { notice('Browser storage is unavailable. Query history is retained for this session only.'); state.persistHistory = false; }
}
function recordHistory(tab) {
  // Never retain URL credentials or password-setting statements in SQL history.
  if (/:\/\/[^\s]*@|\b(password|identified\s+by|secret|token)\b/i.test(tab.sql)) return;
  state.history.unshift({ profileId: tab.profile.id, database: tab.database, schema: tab.schema, sql: tab.sql, at: new Date().toISOString() });
  state.history = state.history.slice(0, 100); saveHistory();
}
function renderHistory(tab, root) {
  const section = el('details', 'history');
  section.append(el('summary', '', 'Query history'));
  const persistent = el('input'); persistent.type = 'checkbox'; persistent.checked = state.persistHistory;
  persistent.addEventListener('change', () => { state.persistHistory = persistent.checked; saveHistory(); });
  const check = label('Remember SQL history in this browser', persistent); check.className = 'check'; section.append(check, el('p', 'hint', 'Session-only by default. SQL may contain sensitive values. Password statements and credential URLs are excluded. Up to 100 entries are retained.'));
  section.append(button('Clear all history', () => { state.history = []; saveHistory(); renderTab(); }));
  const entries = state.history.filter((item) => item.profileId === tab.profile.id && item.database === tab.database);
  if (!entries.length) section.append(el('p', 'hint', 'No history for this connection and database.'));
  for (const item of entries.slice(0, 20)) {
    const row = el('div', 'history-row'); row.append(button(item.sql, () => { tab.sql = item.sql; renderTab(); }), el('span', 'hint', new Date(item.at).toLocaleString())); section.append(row);
  }
  root.append(section);
}
for (const name of ['workspace', 'dashboard', 'logs']) $(name + 'Nav').addEventListener('click', () => showView(name));
$('addConnection').addEventListener('click', () => openConnection());
$('closeConnection').addEventListener('click', () => $('connectionDialog').close());
$('connectionDialog').addEventListener('close', () => { fields.password.value = ''; fields.url.value = ''; });
$('connectionSearch').addEventListener('input', renderProfiles);
$('refreshConnections').addEventListener('click', refreshProfiles);
$('newQuery').addEventListener('click', openQuery);
$('clearLogs').addEventListener('click', () => { $('logConsole').replaceChildren(); state.errors = 0; $('errorCount').textContent = ''; });
$('sidebarToggle').addEventListener('click', () => { const open = $('sidebar').classList.toggle('open'); $('sidebarToggle').setAttribute('aria-expanded', String(open)); });
for (const name of ['engine', 'entryMode', 'credentialMode', 'passwordAction']) fields[name].addEventListener('change', syncConnectionForm);
$('showPassword').addEventListener('click', () => { const show = fields.password.type === 'password'; fields.password.type = show ? 'text' : 'password'; $('showPassword').textContent = show ? 'Hide' : 'Show'; $('showPassword').setAttribute('aria-pressed', String(show)); });
$('testConnection').addEventListener('click', () => submitConnection(true));
form.addEventListener('submit', (event) => { event.preventDefault(); submitConnection(false); });
$('importCurrent').addEventListener('click', async () => {
  if (!confirm('Add the project’s current configuration as a saved connection? This explicitly reads its configuration. It will not connect automatically.')) return;
  try { await api('/api/connections/import-current', {}); await refreshProfiles(); notice('Current configuration added. Select it and choose Connect when ready.'); }
  catch (error) { fail(error, 'Configuration import failed'); }
});
renderTabs(); renderTab(); refreshProfiles();
