import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  quoteIdentifier,
  quoteLiteral,
  formatList,
  listSqlFiles,
  timestampTag,
} from '../lib/utils.js';

// quoteIdentifier is the injection-safety boundary for dynamic DROP/CREATE
// statements, so the per-dialect wrapping AND the embedded-delimiter doubling
// both matter.
const identifierCases = [
  { style: undefined, input: 'users', expected: '"users"' },
  { style: 'postgres', input: 'users', expected: '"users"' },
  { style: 'mysql', input: 'users', expected: '`users`' },
  { style: 'mssql', input: 'users', expected: '[users]' },
  { style: undefined, input: 'we"ird', expected: '"we""ird"' },
  { style: 'mysql', input: 'we`ird', expected: '`we``ird`' },
  { style: 'mssql', input: 'we]ird', expected: '[we]]ird]' },
];

for (const { style, input, expected } of identifierCases) {
  test(`identifier "${input}" for ${style ?? 'default'} dialect is wrapped and escaped`, () => {
    assert.equal(quoteIdentifier(input, style), expected);
  });
}

test('literal with single quote is escaped by doubling', () => {
  assert.equal(quoteLiteral("O'Brien"), "'O''Brien'");
});

test('empty list formats as the (none) placeholder', () => {
  assert.equal(formatList([]), '(none)');
});

test('non-empty list formats as one dash-prefixed item per line', () => {
  assert.equal(formatList(['alpha', 'beta']), '- alpha\n- beta');
});

test('missing migrations directory yields an empty list', () => {
  assert.deepEqual(listSqlFiles(path.join(os.tmpdir(), 'dbtk-does-not-exist-xyz')), []);
});

test('sql files are returned sorted and non-sql files are filtered out', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtk-sql-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['002_b.sql', '001_a.sql', 'notes.txt', 'data.SQL']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  // Order is filename order (migrations must apply deterministically); the .SQL
  // extension is matched case-insensitively.
  assert.deepEqual(listSqlFiles(dir), ['001_a.sql', '002_b.sql', 'data.SQL']);
});

test('timestamp tag is filename-safe with no colons or dots', () => {
  const tag = timestampTag(new Date('2026-01-02T03:04:05.678Z'));
  assert.equal(tag, '2026-01-02T03-04-05');
});
