// DOM-free tree model: state in, flat list of visible rows out. Covered by node:test.
const SEP = '\u001f';
export const nodeKey = (kind, ...parts) => [kind, ...parts].join(SEP);
export const catalogKey = (profileId, database) => `${profileId}${SEP}${database}`;

export function levelsFor(engine) {
  return { sqlite: { database: false, schema: false }, mysql: { database: true, schema: false } }[engine] ?? { database: true, schema: true };
}
// The schema name used in folder/object keys: the default schema, or the only schema when there is no schema level.
export const folderSchema = (levels, catalog) => (levels.schema ? catalog.defaultSchema : catalog.schemas[0]?.name ?? '');

const byName = (a, b) => a.name.localeCompare(b.name);

export function buildTree({ profiles, connected, databasesByProfile, catalogs, expanded, selectedId = null, currentObject = null }) {
  const rows = [];
  const open = (key) => expanded.has(key);
  const groupOf = (profile) => (profile.favorite ? 'Favorites' : profile.group || '');
  const sorted = [...profiles].sort(byName);
  const groups = [...new Set(sorted.map(groupOf).filter(Boolean))]
    .sort((a, b) => (a === 'Favorites' ? -1 : b === 'Favorites' ? 1 : a.localeCompare(b)));

  const status = (key, depth, label, extra = {}) => rows.push({ key, kind: 'status', depth, label, ...extra });

  function addFolders(profile, database, schema, objects, depth) {
    let any = false;
    for (const [folder, label, type] of [['tables', 'Tables', 'table'], ['views', 'Views', 'view']]) {
      const items = objects.filter((object) => object.type === type).sort(byName);
      if (!items.length) continue;
      any = true;
      const key = nodeKey('f', profile.id, database, schema, folder);
      rows.push({ key, kind: 'folder', depth, label, folder, count: items.length, expandable: true, expanded: open(key) });
      if (!open(key)) continue;
      for (const item of items) {
        rows.push({
          key: nodeKey('o', profile.id, database, schema, type, item.name), kind: 'object', depth: depth + 1, label: item.name, objectType: type,
          engine: profile.engine, profileId: profile.id, database, schema, name: item.name,
          current: Boolean(currentObject && currentObject.profileId === profile.id && currentObject.database === database
            && currentObject.schema === schema && currentObject.name === item.name),
        });
      }
    }
    if (!any) status(nodeKey('x', profile.id, database, schema), depth, 'No tables or views');
  }

  function addCatalog(profile, database, depth) {
    const levels = levelsFor(profile.engine);
    const catalog = catalogs[catalogKey(profile.id, database)];
    if (!catalog || catalog.status === 'loading') { status(nodeKey('x', profile.id, database), depth, 'Loading…'); return; }
    if (catalog.status === 'error') { status(nodeKey('x', profile.id, database), depth, catalog.error || 'Could not load objects', { error: true, retry: { profileId: profile.id, database } }); return; }
    if (!catalog.schemas.length) { status(nodeKey('x', profile.id, database), depth, 'No tables or views'); return; }
    if (!levels.schema) { addFolders(profile, database, folderSchema(levels, catalog), catalog.schemas.flatMap((schema) => schema.objects), depth); return; }
    for (const schema of catalog.schemas) {
      const key = nodeKey('s', profile.id, database, schema.name);
      rows.push({ key, kind: 'schema', depth, label: schema.name, profileId: profile.id, database, schema: schema.name, expandable: true, expanded: open(key) });
      if (open(key)) addFolders(profile, database, schema.name, schema.objects, depth + 1);
    }
  }

  function addConnection(profile, depth) {
    const key = nodeKey('c', profile.id);
    const isConnected = connected.has(profile.id);
    rows.push({
      key, kind: 'connection', depth, label: profile.name, profileId: profile.id, engine: profile.engine,
      environment: profile.environment || 'development', favorite: Boolean(profile.favorite), connected: isConnected,
      selected: selectedId === profile.id, expandable: isConnected, expanded: isConnected && open(key),
    });
    if (!isConnected || !open(key)) return;
    const levels = levelsFor(profile.engine);
    const databases = databasesByProfile[profile.id] ?? [];
    if (!levels.database) {
      if (databases.length) addCatalog(profile, databases[0], depth + 1);
      else status(nodeKey('x', profile.id), depth + 1, 'Loading…');
      return;
    }
    for (const database of databases) {
      const dkey = nodeKey('d', profile.id, database);
      rows.push({ key: dkey, kind: 'database', depth: depth + 1, label: database, profileId: profile.id, database, expandable: true, expanded: open(dkey) });
      if (open(dkey)) addCatalog(profile, database, depth + 2);
    }
  }

  for (const name of groups) {
    const key = nodeKey('g', name);
    rows.push({ key, kind: 'group', depth: 1, label: name, expandable: true, expanded: open(key) });
    if (open(key)) for (const profile of sorted.filter((candidate) => groupOf(candidate) === name)) addConnection(profile, 2);
  }
  for (const profile of sorted.filter((candidate) => !groupOf(candidate))) addConnection(profile, 1);
  return rows;
}

// ---- global search --------------------------------------------------------------------------------------------
export function buildSearchIndex({ profiles, connected, databasesByProfile, catalogs }) {
  const entries = [];
  for (const profile of profiles) {
    const base = { profileId: profile.id, engine: profile.engine };
    entries.push({ kind: 'connection', label: profile.name, detail: [profile.engine, profile.group, profile.environment].filter(Boolean).join(' · '), ...base });
    if (!connected.has(profile.id)) continue;
    const levels = levelsFor(profile.engine);
    for (const database of databasesByProfile[profile.id] ?? []) {
      if (levels.database) entries.push({ kind: 'database', label: database, detail: profile.name, ...base, database });
      const catalog = catalogs[catalogKey(profile.id, database)];
      if (catalog?.status !== 'ready') continue;
      for (const schema of catalog.schemas) {
        if (levels.schema) entries.push({ kind: 'schema', label: schema.name, detail: `${profile.name} · ${database}`, ...base, database, schema: schema.name });
        for (const object of schema.objects) {
          entries.push({
            kind: object.type, label: object.name,
            detail: [profile.name, levels.database ? database : '', levels.schema ? schema.name : ''].filter(Boolean).join(' · '),
            ...base, database, schema: schema.name, name: object.name, objectType: object.type,
          });
        }
      }
    }
  }
  return entries;
}

const KIND_ORDER = { connection: 0, database: 1, schema: 2, table: 3, view: 4 };
function wordStart(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1];
  return /[^a-z0-9]/i.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(text[index]));
}
function scoreLabel(label, query) {
  const text = label.toLowerCase();
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) if (wordStart(label, at)) return 60;
  const anywhere = text.indexOf(query);
  if (anywhere >= 0) return 40 - Math.min(anywhere, 20) / 2;
  if (query.length >= 3 && text[0] === query[0]) {        // in-order letters, anchored to the first one
    let from = 0;
    for (const char of query) { from = text.indexOf(char, from); if (from < 0) return 0; from++; }
    return 20;
  }
  return 0;
}
export function searchIndex(index, query, limit = 30) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const entry of index) {
    let score = scoreLabel(entry.label, needle);
    if (!score && entry.kind === 'connection' && entry.detail.toLowerCase().includes(needle)) score = 10;
    if (score) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
    || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label));
  return scored.slice(0, limit).map((item) => item.entry);
}
