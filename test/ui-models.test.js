import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, nodeKey, catalogKey, levelsFor, folderSchema } from '../ui/models.js';

const pg = { id: 'p1', name: 'Demo · PostgreSQL', engine: 'postgres', group: 'Demo / Test' };
const my = { id: 'm1', name: 'Demo · MySQL', engine: 'mysql', group: 'Demo / Test' };
const lite = { id: 's1', name: 'Demo · SQLite', engine: 'sqlite', group: '' };
const obj = (schema, name, type = 'table') => ({ schema, name, type });
const pgCatalog = {
  status: 'ready', defaultSchema: 'public', error: '',
  schemas: [
    { name: 'public', objects: [obj('public', 'orders'), obj('public', 'customers'), obj('public', 'order_summary', 'view')] },
    { name: 'sales', objects: [obj('sales', 'leads')] },
  ],
};
const summarize = (rows) => rows.map((row) => `${row.depth}:${row.kind}:${row.label}`);
const base = { profiles: [], connected: new Set(), databasesByProfile: {}, catalogs: {}, expanded: new Set(), selectedId: null, currentObject: null };

test('levelsFor describes which levels each engine has', () => {
  assert.deepEqual(levelsFor('sqlite'), { database: false, schema: false });
  assert.deepEqual(levelsFor('mysql'), { database: true, schema: false });
  assert.deepEqual(levelsFor('postgres'), { database: true, schema: true });
  assert.deepEqual(levelsFor('mssql'), { database: true, schema: true });
});

test('postgres: group → connection → database → schema → Tables/Views → objects, sorted', () => {
  const rows = buildTree({
    ...base, profiles: [pg, lite], connected: new Set(['p1']), databasesByProfile: { p1: ['toolkit_demo'] },
    catalogs: { [catalogKey('p1', 'toolkit_demo')]: pgCatalog },
    expanded: new Set([nodeKey('g', 'Demo / Test'), nodeKey('c', 'p1'), nodeKey('d', 'p1', 'toolkit_demo'),
      nodeKey('s', 'p1', 'toolkit_demo', 'public'), nodeKey('f', 'p1', 'toolkit_demo', 'public', 'tables'), nodeKey('f', 'p1', 'toolkit_demo', 'public', 'views')]),
  });
  assert.deepEqual(summarize(rows), [
    '1:group:Demo / Test', '2:connection:Demo · PostgreSQL', '3:database:toolkit_demo', '4:schema:public',
    '5:folder:Tables', '6:object:customers', '6:object:orders', '5:folder:Views', '6:object:order_summary',
    '4:schema:sales', '1:connection:Demo · SQLite',
  ]);
  const tables = rows.find((row) => row.kind === 'folder');
  assert.equal(tables.count, 2);
  assert.deepEqual(rows.find((row) => row.label === 'orders'), {
    key: nodeKey('o', 'p1', 'toolkit_demo', 'public', 'table', 'orders'), kind: 'object', depth: 6, label: 'orders', objectType: 'table',
    engine: 'postgres', profileId: 'p1', database: 'toolkit_demo', schema: 'public', name: 'orders', current: false,
  });
});

test('a collapsed group hides its connections; ungrouped connections follow the groups', () => {
  const rows = buildTree({ ...base, profiles: [pg, lite] });
  assert.deepEqual(summarize(rows), ['1:group:Demo / Test', '1:connection:Demo · SQLite']);
  assert.equal(rows[0].expanded, false);
});

test('sqlite: no database or schema level', () => {
  const file = '/tmp/demo.sqlite';
  const rows = buildTree({
    ...base, profiles: [lite], connected: new Set(['s1']), databasesByProfile: { s1: [file] },
    catalogs: { [catalogKey('s1', file)]: { status: 'ready', defaultSchema: 'main', error: '', schemas: [{ name: 'main', objects: [obj('main', 'customers'), obj('main', 'order_summary', 'view')] }] } },
    expanded: new Set([nodeKey('c', 's1'), nodeKey('f', 's1', file, 'main', 'tables'), nodeKey('f', 's1', file, 'main', 'views')]),
  });
  assert.deepEqual(summarize(rows), ['1:connection:Demo · SQLite', '2:folder:Tables', '3:object:customers', '2:folder:Views', '3:object:order_summary']);
});

test('mysql: database level but no schema level', () => {
  const rows = buildTree({
    ...base, profiles: [my], connected: new Set(['m1']), databasesByProfile: { m1: ['toolkit_demo', 'sys'] },
    catalogs: { [catalogKey('m1', 'toolkit_demo')]: { status: 'ready', defaultSchema: 'toolkit_demo', error: '', schemas: [{ name: 'toolkit_demo', objects: [obj('toolkit_demo', 'orders')] }] } },
    expanded: new Set([nodeKey('g', 'Demo / Test'), nodeKey('c', 'm1'), nodeKey('d', 'm1', 'toolkit_demo'), nodeKey('f', 'm1', 'toolkit_demo', 'toolkit_demo', 'tables')]),
  });
  assert.deepEqual(summarize(rows), ['1:group:Demo / Test', '2:connection:Demo · MySQL', '3:database:toolkit_demo', '4:folder:Tables', '5:object:orders', '3:database:sys']);
  assert.equal(folderSchema(levelsFor('mysql'), { defaultSchema: 'x', schemas: [{ name: 'toolkit_demo' }] }), 'toolkit_demo');
});

test('loading, error and empty catalogs render a status row', () => {
  const expanded = new Set([nodeKey('g', 'Demo / Test'), nodeKey('c', 'p1'), nodeKey('d', 'p1', 'toolkit_demo')]);
  const common = { ...base, profiles: [pg], connected: new Set(['p1']), databasesByProfile: { p1: ['toolkit_demo'] }, expanded };
  assert.deepEqual(summarize(buildTree(common)).at(-1), '4:status:Loading…');
  const failed = buildTree({ ...common, catalogs: { [catalogKey('p1', 'toolkit_demo')]: { status: 'error', error: 'permission denied', schemas: [] } } }).at(-1);
  assert.deepEqual([failed.label, failed.error, failed.retry], ['permission denied', true, { profileId: 'p1', database: 'toolkit_demo' }]);
  const empty = buildTree({ ...common, catalogs: { [catalogKey('p1', 'toolkit_demo')]: { status: 'ready', defaultSchema: 'public', schemas: [] } } }).at(-1);
  assert.equal(empty.label, 'No tables or views');
});

test('favorites come first, groups alphabetical, ungrouped last', () => {
  const profiles = [{ id: 'a', name: 'Zed', engine: 'sqlite', group: 'B' }, { id: 'b', name: 'Amy', engine: 'sqlite', group: 'A', favorite: true }, { id: 'c', name: 'Solo', engine: 'sqlite' }];
  const rows = buildTree({ ...base, profiles, expanded: new Set([nodeKey('g', 'Favorites'), nodeKey('g', 'B')]) });
  assert.deepEqual(summarize(rows), ['1:group:Favorites', '2:connection:Amy', '1:group:B', '2:connection:Zed', '1:connection:Solo']);
});

test('selected and current flags, environment and connection state travel with the rows', () => {
  const production = { ...pg, environment: 'production' };
  const rows = buildTree({
    ...base, profiles: [production], connected: new Set(['p1']), selectedId: 'p1', databasesByProfile: { p1: ['toolkit_demo'] },
    catalogs: { [catalogKey('p1', 'toolkit_demo')]: pgCatalog },
    currentObject: { profileId: 'p1', database: 'toolkit_demo', schema: 'public', name: 'orders' },
    expanded: new Set([nodeKey('g', 'Demo / Test'), nodeKey('c', 'p1'), nodeKey('d', 'p1', 'toolkit_demo'), nodeKey('s', 'p1', 'toolkit_demo', 'public'), nodeKey('f', 'p1', 'toolkit_demo', 'public', 'tables')]),
  });
  const connection = rows.find((row) => row.kind === 'connection');
  assert.deepEqual([connection.selected, connection.connected, connection.environment, connection.expandable, connection.expanded], [true, true, 'production', true, true]);
  assert.equal(rows.find((row) => row.label === 'orders').current, true);
  assert.equal(rows.find((row) => row.label === 'customers').current, false);
});

test('a disconnected connection has no children and is not expandable', () => {
  const rows = buildTree({ ...base, profiles: [lite], expanded: new Set([nodeKey('c', 's1')]) });
  assert.deepEqual([rows.length, rows[0].expandable, rows[0].expanded, rows[0].connected], [1, false, false, false]);
});
