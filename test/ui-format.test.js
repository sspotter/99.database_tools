import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellText, csvCell, toCsv, pageModel, isNumericColumn, isPillColumn, pillTone,
  shortPath, baseName, serverLabel, formatMs, engineMeta,
} from '../ui/format.js';

test('cellText renders NULL, objects and scalars', () => {
  assert.equal(cellText(null), 'NULL');
  assert.equal(cellText(undefined), 'NULL');
  assert.equal(cellText({ a: 1 }), '{"a":1}');
  assert.equal(cellText(12.5), '12.5');
});

test('CSV export keeps the spreadsheet formula guard and escapes quotes', () => {
  assert.equal(csvCell('=1+1'), `"'=1+1"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('x"y'), '"x""y"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(-5), '"-5"');
  assert.equal(toCsv(['a', '=b'], [{ a: 1, '=b': 'z' }]), `"a","'=b"\r\n"1","z"`);
});

test('pageModel: known total, first and last page', () => {
  const first = pageModel({ offset: 0, limit: 100, rowCount: 100, total: 150, hasMore: true });
  assert.equal(first.label, 'Showing 1–100 of 150 rows');
  assert.deepEqual(first.items, [1, 2]);
  assert.deepEqual([first.page, first.pageCount, first.hasPrev, first.hasNext, first.exact], [1, 2, false, true, true]);
  const last = pageModel({ offset: 100, limit: 100, rowCount: 50, total: 150, hasMore: false });
  assert.equal(last.label, 'Showing 101–150 of 150 rows');
  assert.deepEqual([last.page, last.hasPrev, last.hasNext], [2, true, false]);
});

test('pageModel: unknown total degrades to N+ and only offers reachable pages', () => {
  const first = pageModel({ offset: 0, limit: 100, rowCount: 100, total: null, hasMore: true });
  assert.equal(first.label, 'Showing 1–100 of 100+ rows');
  assert.deepEqual([first.pageCount, first.exact, first.hasNext, first.items], [null, false, true, [1, 2]]);
  assert.deepEqual(pageModel({ offset: 400, limit: 100, rowCount: 100, total: null, hasMore: true }).items, [1, '…', 4, 5, 6]);
  const tail = pageModel({ offset: 100, limit: 100, rowCount: 30, total: null, hasMore: false });
  assert.equal(tail.label, 'Showing 101–130 of 130 rows');
  assert.equal(tail.exact, true);
});

test('pageModel: empty results and many pages', () => {
  const empty = pageModel({ offset: 0, limit: 100, rowCount: 0, total: 0, hasMore: false });
  assert.deepEqual([empty.label, empty.items, empty.hasNext], ['No rows', [1], false]);
  assert.equal(pageModel({ offset: 100, limit: 100, rowCount: 0, total: null, hasMore: false }).label, 'No rows on this page');
  const many = pageModel({ offset: 900, limit: 100, rowCount: 100, total: 2000, hasMore: true });
  assert.deepEqual([many.page, many.pageCount, many.items], [10, 20, [1, '…', 9, 10, 11, '…', 20]]);
});

test('isNumericColumn: key columns never align right; known types are authoritative; values are the fallback', () => {
  const rows = [{ id: 1, total: 125.5, status: 'paid', zip: '10001', amount: '12.50' }, { id: 2, total: 89.99, status: 'pending', zip: '10002', amount: '3' }];
  assert.equal(isNumericColumn('id', rows), false);
  assert.equal(isNumericColumn('customer_id', rows, { type: 'integer' }), false);
  assert.equal(isNumericColumn('total', rows), true);
  assert.equal(isNumericColumn('status', rows), false);
  assert.equal(isNumericColumn('amount', rows, { type: 'numeric(10,2)' }), true);
  assert.equal(isNumericColumn('zip', rows, { type: 'text' }), false);
  assert.equal(isNumericColumn('amount', rows), true);
  assert.equal(isNumericColumn('n', [], undefined), false);
  assert.equal(isNumericColumn('x', rows, { type: 'interval' }), false);
  assert.equal(isNumericColumn('x', rows, { type: 'int(11)' }), true);
  assert.equal(isNumericColumn('x', rows, { type: 'double precision' }), true);
});

test('isPillColumn follows the documented rule', () => {
  const mk = (values) => values.map((status) => ({ status }));
  const statuses = mk(['paid', 'pending', 'shipped', 'paid', 'pending', 'shipped', 'paid', 'paid']);
  assert.equal(isPillColumn('status', statuses), true);
  assert.equal(isPillColumn('status', statuses.slice(0, 5)), false, 'needs at least 6 rows');
  assert.equal(isPillColumn('status', statuses, { primaryKey: true }), false);
  assert.equal(isPillColumn('status', statuses, { type: 'integer' }), false);
  assert.equal(isPillColumn('customer_name', statuses.map((r) => ({ customer_name: r.status }))), false);
  assert.equal(isPillColumn('user_id', statuses.map((r) => ({ user_id: r.status }))), false);
  assert.equal(isPillColumn('status', mk(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])), false, 'too many distinct values');
  assert.equal(isPillColumn('status', mk(['x y z', 'x y z', 'x y z', 'x y z', 'x y z', 'x y z', 'long '.repeat(6), 'x y z'])), false, 'values longer than 24 chars');
  assert.equal(isPillColumn('status', [...statuses.slice(0, 7), { status: null }]), true, 'nulls are ignored');
  assert.equal(isPillColumn('status', mk(['a', 'b', 'c', 'd', 'a', 'b'])), false, 'distinct × 2 must not exceed rows');
});

test('pillTone maps known words and hashes unknown words deterministically', () => {
  assert.deepEqual(['paid', 'Pending', 'shipped', 'CANCELLED'].map(pillTone), ['ok', 'warn', 'info', 'bad']);
  assert.equal(pillTone('mystery'), pillTone('mystery'));
  assert.ok(['a', 'b', 'c'].includes(pillTone('mystery')));
});

test('paths, labels and durations', () => {
  assert.equal(baseName('C:\\x\\y\\demo.sqlite'), 'demo.sqlite');
  assert.equal(shortPath('/a/b.db'), '/a/b.db');
  assert.equal(shortPath('C:\\Users\\mazen\\AppData\\Local\\Temp\\sandbox\\demo.sqlite'), '…\\sandbox\\demo.sqlite');
  assert.equal(serverLabel({ product: 'PostgreSQL', version: '16.4' }), 'PostgreSQL 16');
  assert.equal(serverLabel({ product: 'MySQL', version: '8.4.2' }), 'MySQL 8.4');
  assert.equal(serverLabel({ product: 'MariaDB', version: '10.11.6' }), 'MariaDB 10.11');
  assert.equal(serverLabel({ product: 'SQL Server', version: '16.0.4135.4' }), 'SQL Server 2022');
  assert.equal(serverLabel({ product: 'SQLite', version: '3.46.1' }), 'SQLite 3.46');
  assert.equal(serverLabel(null), '');
  assert.deepEqual([formatMs(12), formatMs(1500), formatMs(12500), formatMs(NaN)], ['12 ms', '1.50 s', '12.5 s', '']);
  assert.deepEqual(engineMeta('postgres'), { code: 'PG', name: 'PostgreSQL' });
  assert.deepEqual(engineMeta('weird'), { code: '??', name: 'weird' });
});
