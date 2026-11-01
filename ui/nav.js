import { state, bus, runRequest, activeTab, profileById, log, fail, rememberRecent } from './core.js';
import { catalogKey, levelsFor, nodeKey, folderSchema } from './models.js';

const TREE_OWNER = 'tree';
const pending = new Map();           // catalogKey -> in-flight promise
const autoExpanded = new Set();      // catalogKeys whose defaults were already opened once
const loadedRevision = new Map();    // profileId -> revision the loaded names belong to
const loadingDatabases = new Map();  // profileId -> in-flight ensureDatabases promise

export function defaultDatabase(profile) {
  const databases = state.databasesByProfile[profile.id] ?? [];
  const configured = profile.settings?.database;
  return databases.includes(configured) ? configured : databases[0] ?? configured ?? '';
}

export function clearProfileNav(id) {
  delete state.databasesByProfile[id];
  for (const key of Object.keys(state.catalogs)) if (key.startsWith(`${id}\u001f`)) { delete state.catalogs[key]; pending.delete(key); autoExpanded.delete(key); }
  loadedRevision.delete(id);
}

// Called after every profile refresh: drop loaded names for profiles that disconnected, vanished or changed revision.
export function syncProfiles() {
  for (const id of Object.keys(state.databasesByProfile)) {
    const profile = profileById(id);
    if (!profile || !state.connected.has(id) || loadedRevision.get(id) !== profile.revision) clearProfileNav(id);
  }
  if (state.target && !state.connected.has(state.target.profileId)) state.target = null;
  bus.emit('tree');
  bus.emit('target');
  // Connection state lives in the server process: after a page reload profiles are still connected but nothing is loaded.
  for (const profile of state.profiles) {
    if (!state.connected.has(profile.id) || state.databasesByProfile[profile.id]) continue;
    ensureDatabases(profile).then(() => {
      if (state.selectedId === profile.id && state.target?.profileId !== profile.id) chooseDatabase(profile, defaultDatabase(profile));
    });
  }
}

// Loads database names for an already-connected profile (once), then the catalog of every database the tree has open.
export function ensureDatabases(profile) {
  if (state.databasesByProfile[profile.id]) return Promise.resolve(state.databasesByProfile[profile.id]);
  if (loadingDatabases.has(profile.id)) return loadingDatabases.get(profile.id);
  const levels = levelsFor(profile.engine);
  const promise = loadDatabases(profile)
    .then((list) => {
      for (const database of list) {
        const wanted = levels.database ? state.expanded.has(nodeKey('d', profile.id, database)) : state.expanded.has(nodeKey('c', profile.id));
        if (wanted) loadCatalog(profile, database);
      }
      return list;
    })
    .catch((error) => { fail(error, `Could not load databases for ${profile.name}`); return []; })
    .finally(() => loadingDatabases.delete(profile.id));
  loadingDatabases.set(profile.id, promise);
  return promise;
}

export async function loadDatabases(profile, databases) {
  const list = databases ?? (await runRequest(TREE_OWNER, { profile }, { action: 'databases' })).databases ?? [];
  state.databasesByProfile[profile.id] = list;
  loadedRevision.set(profile.id, profile.revision);
  bus.emit('tree');
  return list;
}

function openDefaults(profile, database, catalog) {
  const levels = levelsFor(profile.engine);
  const schema = folderSchema(levels, catalog);
  state.expanded.add(nodeKey('c', profile.id));
  if (levels.database) state.expanded.add(nodeKey('d', profile.id, database));
  if (levels.schema) state.expanded.add(nodeKey('s', profile.id, database, schema));
  for (const folder of ['tables', 'views']) state.expanded.add(nodeKey('f', profile.id, database, schema, folder));
}

export function loadCatalog(profile, database, { force = false } = {}) {
  const key = catalogKey(profile.id, database);
  if (!force) {
    if (pending.has(key)) return pending.get(key);
    if (state.catalogs[key]?.status === 'ready') return Promise.resolve(state.catalogs[key]);
  }
  const entry = { status: 'loading', schemas: [], defaultSchema: '', error: '' };
  state.catalogs[key] = entry;
  const promise = (async () => {
    try {
      const data = await runRequest(TREE_OWNER, { profile }, { action: 'catalog', database });
      if (state.catalogs[key] !== entry) return entry;          // refreshed, edited or disconnected meanwhile
      Object.assign(entry, { status: 'ready', schemas: data.schemas ?? [], defaultSchema: data.defaultSchema ?? '' });
      if (!autoExpanded.has(key)) { autoExpanded.add(key); openDefaults(profile, database, entry); }
    } catch (error) {
      if (state.catalogs[key] !== entry) return entry;
      Object.assign(entry, { status: 'error', error: error.message });
      log(`Could not load objects for ${profile.name}: ${error.message}`, true);
    }
    bus.emit('tree');
    return entry;
  })().finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  bus.emit('tree');
  return promise;
}

function setTarget(target) {
  state.target = target;
  bus.emit('target');
}

export async function chooseDatabase(profile, database) {
  state.selectedId = profile.id;
  setTarget({ profileId: profile.id, database, schema: '' });
  const catalog = await loadCatalog(profile, database);
  const target = state.target;
  if (!target || target.profileId !== profile.id || target.database !== database) return;   // the user moved on
  setTarget({ ...target, schema: catalog.status === 'ready' ? folderSchema(levelsFor(profile.engine), catalog) : '' });
}

export function chooseSchema(profile, database, schema) {
  state.selectedId = profile.id;
  state.expanded.add(nodeKey('s', profile.id, database, schema));
  setTarget({ profileId: profile.id, database, schema });
  bus.emit('tree');
}

// Selecting a connected connection restores its default database/schema; selecting a disconnected one only highlights it.
export function selectConnection(id) {
  const profile = profileById(id);
  if (!profile) return;
  state.selectedId = id;
  rememberRecent(id);
  if (state.connected.has(id)) {
    const choose = () => { if (state.target?.profileId !== id) chooseDatabase(profile, defaultDatabase(profile)); else { bus.emit('tree'); bus.emit('target'); } };
    if (state.databasesByProfile[id]) choose(); else ensureDatabases(profile).then(choose);   // reload case: connected on the server, nothing loaded here yet
  } else { bus.emit('tree'); bus.emit('target'); }
}

export async function activateConnection(profile, databases) {
  state.selectedId = profile.id;
  rememberRecent(profile.id);
  state.expanded.add(nodeKey('c', profile.id));
  await loadDatabases(profile, databases);
  await chooseDatabase(profile, defaultDatabase(profile));
}

export async function refreshTree(profile) {
  try {
    clearProfileNav(profile.id);
    await loadDatabases(profile);
    await chooseDatabase(profile, defaultDatabase(profile));
  } catch (error) { fail(error, 'Could not refresh objects'); }
}

// The active tab owns the target: switching tabs moves the header selectors and reveals the object in the tree.
export function syncTargetFromTab(tab) {
  if (!tab) return;
  const target = state.target;
  if (target && target.profileId === tab.profile.id && target.database === tab.database && target.schema === tab.schema && state.selectedId === tab.profile.id) return;
  state.selectedId = tab.profile.id;
  state.target = { profileId: tab.profile.id, database: tab.database, schema: tab.schema };
  const levels = levelsFor(tab.profile.engine);
  state.expanded.add(nodeKey('c', tab.profile.id));
  if (levels.database) state.expanded.add(nodeKey('d', tab.profile.id, tab.database));
  if (levels.schema) state.expanded.add(nodeKey('s', tab.profile.id, tab.database, tab.schema));
  for (const folder of ['tables', 'views']) state.expanded.add(nodeKey('f', tab.profile.id, tab.database, tab.schema, folder));
  const profile = profileById(tab.profile.id);
  if (profile && tab.database && state.connected.has(profile.id)) ensureDatabases(profile).then(() => loadCatalog(profile, tab.database));   // so the tree can show the revealed object
  bus.emit('tree');
  bus.emit('target');
}

export function initNav() {
  bus.on('tabs', () => syncTargetFromTab(activeTab()));
}
