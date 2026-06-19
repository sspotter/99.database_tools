# Fix Plan — db-toolkit

Derived from the clean-code review ([code-review.md](code-review.md)) and the
docs-guard pass. Ordered by impact and dependency: correctness first, then a
safety net, then cleanup, then features. Each task is self-contained and
verifiable.

Legend: **[P0]** breaks real usage · **[P1]** risk / drift · **[P2]** feature ·
**[P3]** polish.

---

## Phase 1 — Correctness (P0/P1)

### Task 1.1 [P0] Fix PostgreSQL `backup`
- **Problem:** `node db.js backup` on postgres throws `PostgreSQL backup is not
  implemented in driver mode yet` ([postgres.js:186-188](../lib/engines/postgres.js#L186-L188)).
  A working `pg_dump` path already exists but is unreachable dead code in
  [external.js:391-411](../lib/engines/external.js#L391-L411).
- **Fix:** Implement `PostgresEngine.backup(outputPath)` by shelling out to
  `pg_dump` (mirror the external.js logic: build args from `config.postgres`,
  set `PGPASSWORD` env, write `result.stdout` to `outputPath` via `ensureDirSync`
  + `fs.writeFileSync`). If `pg_dump` is missing, throw a clear "install
  postgresql-client" error.
- **Files:** [lib/engines/postgres.js](../lib/engines/postgres.js).
- **Verify:** `node db.js backup` against the live DB writes a non-empty `.sql`
  file in `backups/`; restore it into a scratch DB and confirm tables exist.

### Task 1.2 [P1] Centralize `normalizeEngineName`
- **Problem:** Duplicated in [commands.js:23](../lib/commands.js#L23),
  [config/database.js:33](../config/database.js#L33), [env.js:6](../lib/env.js#L6)
  (and a sibling in `toolchain.normalizeToolName`). They diverge — env.js accepts
  the `sqllite` typo, others don't.
- **Fix:** Add one `normalizeEngineName` to [lib/utils.js](../lib/utils.js)
  (include the `sqllite` alias so behavior is the superset), import it in all
  three modules, delete the local copies.
- **Files:** lib/utils.js + the three above.
- **Verify:** `create-env sqllite`, `set sqllite`, and `--engine sqllite` all
  resolve to sqlite consistently; existing commands unaffected.

### Task 1.3 [P1] Remove the dead postgres branch in `external.js`
- **Problem:** `ExternalCliEngine` only ever runs mysql/mssql
  ([engines/index.js:14](../lib/engines/index.js#L14)), so every
  `if (this.engine === 'postgres')` block is unreachable.
- **Fix:** After Task 1.1 confirms postgres backup lives in `PostgresEngine`,
  delete the postgres branches from `binaryForEngine`, `buildConnectionArgs`,
  `buildConnectionEnv`, `createDatabase`, `listTables`, `runSql`, and `backup`.
- **Files:** [lib/engines/external.js](../lib/engines/external.js).
- **Verify:** mysql/mssql code paths unchanged; `node db.js help` and a mysql
  smoke test (if available) still work.

### Task 1.4 [P1] Implement or honestly retire `rollback`
- **Problem:** `rollback` throws `scaffolded but not implemented`
  ([commands.js](../lib/commands.js)); docs list it as a command.
- **Decision needed:** implement real down-migrations, or remove the command +
  alias + doc references for now.
- **Recommended (smaller):** remove `rollback` from `resolveCommand` aliases
  ([db.js](../db.js)), the switch case, and `functions.md`; revisit with
  down-migrations later (Task 4.3).
- **Files:** db.js, lib/commands.js, functions.md.
- **Verify:** `node db.js rollback` gives a clean "unknown command" instead of a
  scaffold error; docs no longer advertise it.

---

## Phase 2 — Safety net (P1)

### Task 2.1 [P1] Add a SQLite-based test suite (`node:test`, zero deps)
- **Problem:** No automated tests for a tool that drops/restores databases.
- **Fix:** Add `tests/` using the built-in `node:test` + `node:assert`. Target
  the SQLite engine (in-process, no server) and the pure helpers. Add
  `"test": "node --test"` to [package.json](../package.json) scripts.
- **Coverage to start:**
  - `SqliteEngine`: createDatabase → runSqlFile(schema) → listTables → dropTable
    → reset → health → migrate (ensure/list/record) round-trip, against a temp
    file DB in `os.tmpdir()`.
  - `config/database.js`: `parseDatabaseUrl` for postgres/mysql/sqlite/file URLs;
    engine + schema-path resolution.
  - `lib/utils.js`: `quoteIdentifier`/`quoteLiteral` escaping, `formatList`,
    `listSqlFiles` ordering.
  - `normalizeEngineName` (post Task 1.2) including the `sqllite` alias.
- **Files:** new `tests/*.test.js`, package.json.
- **Verify:** `npm test` passes; deliberately reintroducing a Task 1.2-style
  divergence makes a test fail.

---

## Phase 3 — Cleanup (P3)

### Task 3.1 [P3] Strip dead code
- Remove unused: `exportSql`/`dumpSchema` (all engines),
  `createMigrationDatabaseTableIfNeeded` (pg + external),
  `canLaunchExternalCommands` and `getToolByName` ([toolchain.js](../lib/toolchain.js)),
  `dim` ([logger.js](../lib/logger.js)), and the unused `quoteLiteral` import in
  [sqlite.js:4](../lib/engines/sqlite.js#L4). Also the no-op temp-file dance in
  `ExternalCliEngine.exportSql` ([external.js:478-479](../lib/engines/external.js#L478-L479)).
- **Verify:** `grep` shows no remaining references; `npm test` + `node db.js help`
  still pass.

### Task 3.2 [P3] Fix docs drift
- [functions.md](../functions.md): `MySQL CLI` → `MySQL client`; remove/annotate
  the `rollback` entry; note that "Expected output" lines carry `[ok]`/`[warn]`
  tags.
- Add a **Web UI** section to [README.md](../README.md) documenting `node db.js ui`
  (localhost-only, `--port`, the printed token URL).
- **Verify:** docs-guard re-run is clean; every documented command/label matches
  source.

---

## Phase 4 — Features (P2)

### Task 4.1 [P2] `--json` output mode
- Add a `--json` flag that emits structured results for scriptable commands
  (`tables`, `scan`, `health`, `migrate`). Lets the Web UI consume data instead
  of scraping log lines.
- **Files:** db.js (flag parse already supports unknown? add `--json`),
  lib/commands.js, lib/logger.js.

### Task 4.2 [P2] Row/data browser for the Web UI
- Add a per-engine `previewRows(table, limit)` (sqlite + postgres return rows
  natively; mysql/mssql return text — handle or mark unsupported). Surface as a
  Dashboard table click → data view in [ui/app.js](../ui/app.js).
- **Depends on:** Task 4.1 (`/api/query` returning JSON rows).

### Task 4.3 [P2] Real down-migrations (enables `rollback`)
- Support paired `NNN_name.up.sql` / `.down.sql` (or a `-- down` marker),
  track applied order, and implement `rollback` to revert the last batch.
- **Depends on:** Task 1.4 decision.

---

## Suggested order

1. **1.1** (postgres backup) — unblocks real backups today.
2. **2.1** (tests) — lock behavior before refactoring.
3. **1.2 + 1.3** (centralize names, delete dead postgres branch) — now safe with tests.
4. **1.4 + 3.1 + 3.2** (rollback decision, dead code, docs).
5. **Phase 4** features as desired.

Phases 1–3 are the de-risking core; Phase 4 is growth.
