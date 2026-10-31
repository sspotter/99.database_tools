// Converts each engine's raw inspect rows into the single shape the UI renders (see CONTRACT: Inspect).
const truthy = (value) => value === true || value === 1 || value === '1' || value === 'YES' || value === 't';

function normalizeForeignKeys(engine, rows) {
  return rows.map((row) => engine === 'sqlite'
    ? { name: null, column: row.from, referencedSchema: 'main', referencedTable: row.table, referencedColumn: row.to }
    : {
      name: row.name ?? null, column: row.column, referencedSchema: row.referencedSchema ?? null,
      referencedTable: row.referencedTable, referencedColumn: row.referencedColumn,
    });
}

function normalizeIndexes(engine, rows) {
  if (engine === 'sqlite') {
    return rows.map((row) => ({ name: row.name, columns: [...row.columns], unique: truthy(row.unique), primary: row.origin === 'pk' }));
  }
  const byName = new Map();
  for (const row of rows) {
    let entry = byName.get(row.name);
    if (!entry) {
      entry = {
        name: row.name, columns: [],
        unique: engine === 'mysql' ? Number(row.nonUnique) === 0 : truthy(row.unique),
        primary: engine === 'mysql' ? row.name === 'PRIMARY' : truthy(row.primary),
      };
      byName.set(row.name, entry);
    }
    entry.columns.push(row.column ?? '(expression)');
  }
  return [...byName.values()];
}

export function normalizeInspect(engine, raw) {
  const rawColumns = raw.columns ?? [];
  const primaryKey = rawColumns.filter((column) => truthy(column.primaryKey)).map((column) => column.name);
  const foreignKeys = normalizeForeignKeys(engine, raw.foreignKeys ?? []);
  const foreignColumns = new Set(foreignKeys.map((key) => key.column));
  const columns = rawColumns.map((column) => ({
    name: column.name, type: column.type ?? '', nullable: truthy(column.nullable),
    default: column.default ?? null, primaryKey: truthy(column.primaryKey), foreignKey: foreignColumns.has(column.name),
  }));
  let indexes = normalizeIndexes(engine, raw.indexes ?? []);
  // SQLite INTEGER PRIMARY KEY is the rowid and has no index entry; show it like the other engines do.
  if (primaryKey.length && !indexes.some((index) => index.primary)) {
    indexes = [{ name: 'PRIMARY KEY', columns: primaryKey, unique: true, primary: true, synthetic: true }, ...indexes];
  }
  indexes.sort((a, b) => Number(b.primary) - Number(a.primary));
  return { columns, primaryKey, indexes, foreignKeys, ...(raw.definition ? { definition: raw.definition } : {}) };
}
