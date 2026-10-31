import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInspect } from '../lib/workspace-metadata.js';

test('sqlite: resolves FK, flags key columns and synthesizes the integer primary key index', () => {
  const result = normalizeInspect('sqlite', {
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, default: null, primaryKey: true },
      { name: 'customer_id', type: 'INTEGER', nullable: false, default: null, primaryKey: false },
    ],
    indexes: [{ name: 'idx_orders_customer_id', unique: false, columns: ['customer_id'], origin: 'c' }],
    foreignKeys: [{ id: 0, seq: 0, table: 'customers', from: 'customer_id', to: 'id' }],
    definition: 'CREATE TABLE orders (...)',
  });
  assert.deepEqual(result.primaryKey, ['id']);
  assert.deepEqual(result.indexes.map((i) => [i.name, i.primary, Boolean(i.synthetic)]),
    [['PRIMARY KEY', true, true], ['idx_orders_customer_id', false, false]]);
  assert.deepEqual(result.foreignKeys, [{ name: null, column: 'customer_id', referencedSchema: 'main', referencedTable: 'customers', referencedColumn: 'id' }]);
  assert.deepEqual(result.columns.map((c) => c.foreignKey), [false, true]);
  assert.equal(result.definition, 'CREATE TABLE orders (...)');
});

test('sqlite: an automatic primary-key index is not duplicated by a synthetic one', () => {
  const result = normalizeInspect('sqlite', {
    columns: [{ name: 'code', type: 'TEXT', nullable: false, default: null, primaryKey: true }],
    indexes: [{ name: 'sqlite_autoindex_t_1', unique: true, columns: ['code'], origin: 'pk' }],
    foreignKeys: [],
  });
  assert.deepEqual(result.indexes.map((i) => [i.name, i.primary]), [['sqlite_autoindex_t_1', true]]);
});

test('postgres: groups per-column index rows, keeps expression columns visible', () => {
  const result = normalizeInspect('postgres', {
    columns: [{ name: 'id', type: 'integer', nullable: false, default: null, primaryKey: true }],
    indexes: [
      { name: 'orders_pkey', unique: true, primary: true, column: 'id', position: 1 },
      { name: 'idx_lower_status', unique: false, primary: false, column: null, position: 1 },
      { name: 'idx_pair', unique: false, primary: false, column: 'a', position: 1 },
      { name: 'idx_pair', unique: false, primary: false, column: 'b', position: 2 },
    ],
    foreignKeys: [
      { name: 'orders_customer_fk', column: 'customer_id', referencedSchema: 'public', referencedTable: 'customers', referencedColumn: 'id' },
    ],
  });
  assert.deepEqual(result.indexes.map((i) => [i.name, i.columns, i.unique, i.primary]), [
    ['orders_pkey', ['id'], true, true],
    ['idx_lower_status', ['(expression)'], false, false],
    ['idx_pair', ['a', 'b'], false, false],
  ]);
  assert.equal(result.foreignKeys[0].name, 'orders_customer_fk');
});

test('mysql: string bigints, PRIMARY name and composite indexes', () => {
  const result = normalizeInspect('mysql', {
    columns: [{ name: 'id', type: 'int', nullable: 0, default: null, primaryKey: 1 }],
    indexes: [
      { name: 'cmp', column: 'a', nonUnique: '0', position: '1' },
      { name: 'cmp', column: 'b', nonUnique: '0', position: '2' },
      { name: 'PRIMARY', column: 'id', nonUnique: '0', position: '1' },
      { name: 'idx_x', column: 'x', nonUnique: '1', position: '1' },
    ],
    foreignKeys: [],
  });
  assert.deepEqual(result.indexes.map((i) => [i.name, i.columns, i.unique, i.primary]), [
    ['PRIMARY', ['id'], true, true],
    ['cmp', ['a', 'b'], true, false],
    ['idx_x', ['x'], false, false],
  ]);
  assert.equal(result.columns[0].primaryKey, true);
  assert.equal(result.columns[0].nullable, false);
});

test('mssql: YES/NO nullability, 0/1 flags', () => {
  const result = normalizeInspect('mssql', {
    columns: [
      { name: 'id', type: 'int', nullable: 'NO', default: null, primaryKey: 1 },
      { name: 'note', type: 'nvarchar', nullable: 'YES', default: null, primaryKey: 0 },
    ],
    indexes: [{ name: 'PK_orders', column: 'id', unique: true, primary: true, position: 1 }],
    foreignKeys: [],
  });
  assert.deepEqual(result.columns.map((c) => [c.nullable, c.primaryKey]), [[false, true], [true, false]]);
  assert.deepEqual(result.indexes.map((i) => [i.name, i.primary]), [['PK_orders', true]]);
});

import { describeServer } from '../lib/workspace-server-engines.js';

test('describeServer names the product and trims vendor suffixes', () => {
  assert.deepEqual(describeServer('postgres', '16.4 (Debian 16.4-1.pgdg120+1)'), { product: 'PostgreSQL', version: '16.4' });
  assert.deepEqual(describeServer('mysql', '8.4.2'), { product: 'MySQL', version: '8.4.2' });
  assert.deepEqual(describeServer('mysql', '10.11.6-MariaDB-1:10.11.6+maria~ubu2204'), { product: 'MariaDB', version: '10.11.6' });
  assert.deepEqual(describeServer('mssql', '16.0.4135.4'), { product: 'SQL Server', version: '16.0.4135.4' });
});
