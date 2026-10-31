import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConnectionInput } from '../lib/connections.js';
import { runDatabaseTask } from '../lib/workspace-db.js';

// Read-only checks against the seeded demo servers (compose.demo.yaml + scripts/seed-demo*.mjs).
const targets = [
  ['postgres', 'DB_TOOLKIT_DEMO_POSTGRES_URL', 'public', 'PostgreSQL'],
  ['mysql', 'DB_TOOLKIT_DEMO_MYSQL_URL', 'toolkit_demo', 'MySQL'],
  ['mssql', 'DB_TOOLKIT_DEMO_MSSQL_URL', 'dbo', 'SQL Server'],
];

for (const [engine, variable, schema, product] of targets) {
  const url = process.env[variable];
  const skip = !url;
  const profile = url ? normalizeConnectionInput({ name: `Demo ${engine}`, engine, url, readOnly: true }) : null;
  const run = (task) => runDatabaseTask(profile, { database: profile.settings.database, schema, ...task });

  test(`${engine}: serverInfo names the product`, { skip }, async () => {
    const info = await run({ action: 'serverInfo' });
    assert.equal(info.product, product);
    assert.match(info.version, /^\d+(\.\d+)*/);
  });

  test(`${engine}: catalog lists demo tables and views, hides empty and fixed-role schemas`, { skip }, async () => {
    const result = await run({ action: 'catalog' });
    assert.equal(result.defaultSchema, schema);
    const main = result.schemas.find((entry) => entry.name === schema);
    assert.ok(main.objects.some((o) => o.name === 'orders' && o.type === 'table'));
    assert.ok(main.objects.some((o) => o.name === 'order_summary' && o.type === 'view'));
    assert.ok(result.schemas.every((entry) => entry.objects.length > 0));
    assert.ok(result.schemas.every((entry) => !/^(db_|guest$)/.test(entry.name)));
  });

  test(`${engine}: count matches the row filter, including NULL filters`, { skip }, async () => {
    assert.deepEqual(await run({ action: 'count', table: 'orders' }), { total: 150, exact: true });
    assert.deepEqual(await run({ action: 'count', table: 'orders', filterColumn: 'status', filterValue: 'paid' }), { total: 38, exact: true });
    assert.deepEqual(await run({ action: 'count', table: 'orders', filterColumn: 'notes', filterValue: null }), { total: 128, exact: true });
    await assert.rejects(run({ action: 'count', table: 'orders', filterColumn: 'nope', filterValue: 1 }), /Unknown column/);
  });

  test(`${engine}: inspect is normalized (keys, indexes, foreign keys)`, { skip }, async () => {
    const info = await run({ action: 'inspect', table: 'orders' });
    assert.deepEqual(info.primaryKey, ['id']);
    assert.equal(info.columns.find((c) => c.name === 'customer_id').foreignKey, true);
    assert.ok(info.foreignKeys.some((k) => k.column === 'customer_id' && k.referencedTable === 'customers' && k.referencedColumn === 'id'));
    assert.ok(info.indexes[0].primary && info.indexes[0].columns.join() === 'id');
    assert.ok(info.indexes.some((i) => i.name === 'idx_orders_customer_id' && i.columns.join() === 'customer_id' && !i.primary));
  });
}
