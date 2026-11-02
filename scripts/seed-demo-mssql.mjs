// Disposable SQL Server demo only. Mirrors scripts/seed-demo.mjs; project .env and DATABASE_URL are never read.
import assert from 'node:assert/strict';
import mssql from 'mssql';

const setting = (name, fallback) => process.env[`DB_TOOLKIT_DEMO_${name}`] || fallback;
const host = setting('HOST', '127.0.0.1');
assert(['127.0.0.1', 'localhost', '::1'].includes(host), 'Demo host must be loopback');
const base = {
  server: host, port: Number(setting('MSSQL_PORT', '11433')), user: 'sa', password: setting('MSSQL_PASSWORD', 'Demo_password_1!'),
  options: { encrypt: true, trustServerCertificate: true }, connectionTimeout: 30000, requestTimeout: 60000,
};
const database = setting('DATABASE', 'toolkit_demo');
assert(/^[A-Za-z0-9_]+$/.test(database), 'Invalid demo database name');
const marker = 'mssql-demo';

const master = await mssql.connect({ ...base, database: 'master' });
await master.request().query(`IF DB_ID('${database}') IS NULL CREATE DATABASE [${database}]`);
await master.close();

const pool = await new mssql.ConnectionPool({ ...base, database }).connect();
const run = (sql) => pool.request().query(sql);
try {
  const existing = (await run("SELECT name FROM sys.tables WHERE name NOT LIKE 'sysdiagrams'")).recordset.map((row) => row.name);
  if (existing.includes('demo_metadata')) {
    const rows = (await run('SELECT engine_marker FROM demo_metadata WHERE id = 1')).recordset;
    assert.equal(rows[0]?.engine_marker, marker, 'Refusing database with a missing or different demo marker');
  } else assert.equal(existing.length, 0, 'Refusing to seed an existing unmarked database');

  const tables = [
    ['demo_metadata', 'id INT PRIMARY KEY, engine_marker VARCHAR(32) NOT NULL'],
    ['customers', 'id INT PRIMARY KEY, name NVARCHAR(120) NOT NULL, email NVARCHAR(200) NULL, city NVARCHAR(100) NULL, notes NVARCHAR(MAX) NULL'],
    ['products', 'id INT PRIMARY KEY, sku VARCHAR(32) NOT NULL UNIQUE, name NVARCHAR(120) NOT NULL, price DECIMAL(12,2) NOT NULL, category NVARCHAR(80) NULL'],
    ['orders', 'id INT PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), ordered_on DATE NOT NULL, status VARCHAR(20) NOT NULL, notes NVARCHAR(MAX) NULL'],
    ['order_items', 'id INT PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id), product_id INT NOT NULL REFERENCES products(id), quantity INT NOT NULL, unit_price DECIMAL(12,2) NOT NULL'],
  ];
  for (const [name, definition] of tables) await run(`IF OBJECT_ID('dbo.${name}','U') IS NULL CREATE TABLE dbo.${name} (${definition})`);
  for (const [table, column] of [['orders', 'customer_id'], ['order_items', 'order_id'], ['order_items', 'product_id']]) {
    const name = `idx_${table}_${column}`;
    await run(`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='${name}') CREATE INDEX ${name} ON dbo.${table} (${column})`);
  }

  const customers = Array.from({ length: 24 }, (_, i) => [i + 1, `Customer ${i + 1}`, i % 5 ? `customer${i + 1}@example.test` : null, i % 4 ? 'Cairo' : 'Alexandria', i === 0 ? "Notes with 'quotes', commas, and\na second line — مرحباً" : null]);
  const products = Array.from({ length: 12 }, (_, i) => [i + 1, `DEMO-${String(i + 1).padStart(3, '0')}`, ['Notebook', 'Desk lamp', 'Coffee mug', 'Keyboard'][i % 4] + ` ${i + 1}`, (12.5 + i * 7.25).toFixed(2), i % 3 ? 'Workspace' : null]);
  const orders = Array.from({ length: 150 }, (_, i) => [i + 1, i % 24 + 1, `2026-${String(i % 9 + 1).padStart(2, '0')}-${String(i % 27 + 1).padStart(2, '0')}`, ['pending', 'paid', 'shipped', 'cancelled'][i % 4], i % 7 ? null : 'Leave at reception']);
  const items = orders.flatMap(([id]) => [0, 1].map((offset) => {
    const product = products[(id + offset - 1) % products.length];
    return [(id - 1) * 2 + offset + 1, id, product[0], offset + 1, product[3]];
  }));
  const data = { demo_metadata: [[1, marker]], customers, products, orders, order_items: items };
  const columnsOf = { demo_metadata: 'id, engine_marker', customers: 'id, name, email, city, notes', products: 'id, sku, name, price, category', orders: 'id, customer_id, ordered_on, status, notes', order_items: 'id, order_id, product_id, quantity, unit_price' };
  const transaction = new mssql.Transaction(pool);
  await transaction.begin();
  try {
    for (const [table, rows] of Object.entries(data)) {
      for (const row of rows) {
        const request = new mssql.Request(transaction);
        row.forEach((value, index) => request.input(`p${index}`, value));
        const placeholders = row.map((_, index) => `@p${index}`).join(', ');
        await request.query(`IF NOT EXISTS (SELECT 1 FROM dbo.${table} WHERE id = @p0) INSERT INTO dbo.${table} (${columnsOf[table]}) VALUES (${placeholders})`);
      }
    }
    await transaction.commit();
  } catch (error) { await transaction.rollback(); throw error; }

  const view = (await run("SELECT name FROM sys.views WHERE name='order_summary'")).recordset;
  if (!view.length) await run('CREATE VIEW dbo.order_summary AS SELECT o.id AS order_id, c.name AS customer_name, o.ordered_on, o.status, SUM(i.quantity * i.unit_price) AS total FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id JOIN dbo.order_items i ON i.order_id = o.id GROUP BY o.id, c.name, o.ordered_on, o.status');

  const counts = {};
  for (const table of Object.keys(data)) counts[table] = Number((await run(`SELECT COUNT(*) AS total FROM dbo.${table}`)).recordset[0].total);
  assert.deepEqual(counts, { demo_metadata: 1, customers: 24, products: 12, orders: 150, order_items: 300 });
  assert.equal((await run('SELECT TOP 1 * FROM dbo.order_summary')).recordset.length, 1);
  console.log(JSON.stringify({ engine: 'mssql', marker, counts }));
} finally { await pool.close(); }
