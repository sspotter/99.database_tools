# Code Review — Database Toolkit

Reviewed with clean-code-guard (review mode). Scope: `db.js` and everything under
`lib/`, `config/`. No code was changed — this is a findings report.

Date: 2026-06-17 · Reviewer: clean-code-guard pass

---

## Verdict

The toolkit is in good shape for a CLI of this size: SQL is parameterized or
identifier-quoted (injection-safe), unimplemented paths fail loudly instead of
faking success, and the error-recovery flow (auth repair, service start, schema
re-init) is genuinely thoughtful. The problems are not correctness landmines in
the happy path — they are **drift between two engine implementations** and a
layer of **dead code** that makes the real behavior hard to see. Fixing the dead
postgres path and the duplicated engine-name logic would remove most of the risk.

Severity legend: **[High]** behavioral / will surprise a user · **[Med]**
maintainability / drift · **[Low]** polish.

---

## [High] 1. Reachable PostgreSQL backup throws, while a working one sits dead

- `node db.js backup` with the postgres engine routes to `PostgresEngine.backup`,
  which throws `PostgreSQL backup is not implemented in driver mode yet.`
  ([postgres.js:186-188](../lib/engines/postgres.js#L186-L188)).
- A **complete `pg_dump` implementation exists** — but in
  `ExternalCliEngine.backup` ([external.js:391-411](../lib/engines/external.js#L391-L411)),
  which is never instantiated for postgres because `createEngine` sends postgres
  to `PostgresEngine` ([index.js:10-15](../lib/engines/index.js#L10-L15)).
- Net effect: the working code is unreachable and the reachable code fails. This
  also contradicts [docs/usage.md:143](usage.md#L143) ("PostgreSQL and MySQL
  backups are SQL dumps").
- Fix: either implement `PostgresEngine.backup` (shell out to `pg_dump`, or
  document it as driver-mode-unsupported) and reconcile the docs. Rule 18, Rule 11.

## [High] 2. Entire postgres branch in `external.js` is dead code

Because `ExternalCliEngine` only ever runs with `engine === 'mysql' | 'mssql'`
([index.js:14](../lib/engines/index.js#L14)), every `if (this.engine === 'postgres')`
block in that file is unreachable:
`binaryForEngine` postgres case, `buildConnectionArgs` postgres case
([external.js:40-51](../lib/engines/external.js#L40-L51)), `buildConnectionEnv`,
`createDatabase`, `listTables`, `runSql`, and `backup` postgres branches.
That is a large, convincing-looking chunk of code that can never run — the most
expensive kind of dead code because it reads as a second source of truth. Rule 21.
- Fix: delete the postgres branches from `ExternalCliEngine`, or (if the intent
  was a CLI fallback for postgres) make `createEngine` actually select it. Decide
  which engine owns postgres and keep exactly one.

## [High] 3. `normalizeEngineName` is duplicated four times — and they disagree

The same engine-name normalization rule is copy-pasted in:
[commands.js:23](../lib/commands.js#L23), [config/database.js:33](../config/database.js#L33),
[env.js:6](../lib/env.js#L6), plus a sibling in `toolchain.normalizeToolName`.
They are **not identical**: [env.js:18](../lib/env.js#L18) accepts the `sqllite`
typo; the others do not. This is exactly the DRY hazard — one rule, many copies,
silently diverging. A user who types `sqllite` succeeds via `create-env` but the
result may resolve differently elsewhere. Rule 11.
- Fix: extract one `normalizeEngineName` into `lib/utils.js` (or a small
  `engines/names.js`) and import it everywhere.

---

## [Med] 4. Fragile health check in `ExternalCliEngine`

`health()` decides success with `ok: /1/.test(result.stdout)`
([external.js:382](../lib/engines/external.js#L382)). Any stdout containing the
digit `1` anywhere passes — a table named `t1`, a row count, a warning line. The
SQLite and Postgres engines check the value precisely
([sqlite.js:111](../lib/engines/sqlite.js#L111),
[postgres.js:180](../lib/engines/postgres.js#L180)). Tighten to match, e.g. test
the trimmed line equals `1`. Rule 20.

## [Med] 5. Dead exports and functions

Confirmed via grep — defined, never called:
- `exportSql` / `dumpSchema` in all three engines
  ([sqlite.js:181](../lib/engines/sqlite.js#L181),
  [postgres.js:225](../lib/engines/postgres.js#L225),
  [external.js:477](../lib/engines/external.js#L477))
- `createMigrationDatabaseTableIfNeeded` ([postgres.js:221](../lib/engines/postgres.js#L221),
  [external.js:473](../lib/engines/external.js#L473))
- `canLaunchExternalCommands` ([toolchain.js:134](../lib/toolchain.js#L134))
- `getToolByName` ([toolchain.js:226](../lib/toolchain.js#L226))
- `dim` ([logger.js:44](../lib/logger.js#L44))
- Unused import: `quoteLiteral` in [sqlite.js:4](../lib/engines/sqlite.js#L4)
  (the engine uses parameterized `?` placeholders, never `quoteLiteral`)

`ExternalCliEngine.exportSql` is worse than unused — it creates a temp file then
immediately deletes it for no effect ([external.js:478-479](../lib/engines/external.js#L478-L479)).
- Fix: strip them. They are "someday" API with no caller today. Rule 21, Rule 14.

## [Med] 6. Duplicated schema-path resolution

`resolveEngineFile` ([config/database.js:10-26](../config/database.js#L10-L26))
and `resolveEngineDefaultFile` ([manifest.js:24-42](../lib/manifest.js#L24-L42))
encode the same "prefer `schemas/<engine>/<file>`, else generic" rule with
slightly different shapes. One rule, two implementations — they will drift.
Rule 11. Fix: share one helper.

## [Med] 7. Per-method engine type-tag branching (OCP)

`buildConnectionArgs`, `runSql`, `createDatabase`, and `listTables` in
`external.js` each re-branch on `this.engine`. Adding an engine means editing
every method and hoping you caught them all. Rule 8. This is acceptable at two
engines (mysql/mssql) but is the first thing to hurt if a third is added —
consider a small per-engine strategy object (`{ connectionArgs, showTables,
createDb }`).

---

## [Low] 8. `runCommand` is a ~300-line switch

[commands.js:287-604](../lib/commands.js#L287-L604). Each case is individually
small, but the function's cyclomatic complexity is well over the McCabe ceiling
of 10. A command dispatcher is a defensible exception; if it grows further,
split each case into a named `handleInit(context)` etc. and dispatch through a
map. Rule 2, Rule 13.

## [Low] 9. Sync/async sibling engines

`PostgresEngine` methods are `async`; the `ExternalCliEngine` equivalents are
synchronous (`spawnSync`). `commands.js` `await`s both, so it works, but the two
implementations of the same informal interface have different execution
semantics. Worth a comment, or normalize on one. Not a bug today.

---

## What I think about the code (overall)

- **Security posture is good.** Identifiers go through `quoteIdentifier`, values
  through `quoteLiteral` or bound parameters, and `ON_ERROR_STOP`/`-b` are set on
  the CLI engines. I did not find an injection path in the dynamic SQL.
- **Honest failure handling.** Unimplemented features throw with clear messages
  rather than returning fake success — this is the single most important
  AI-code-quality property and the codebase gets it right (mssql backup, pg
  driver export, rollback).
- **The recovery UX is the best part.** Auth-failure repair, "start the service?"
  prompts, and missing-table re-init ([commands.js:174-215](../lib/commands.js#L174-L215))
  are genuinely user-friendly and well-scoped.
- **The core weakness is two-engines-drift.** SQLite/Postgres (native drivers)
  and the CLI engines have overlapping-but-divergent implementations of the same
  conceptual interface, plus a dead postgres path inside the CLI engine. This is
  where bugs will come from: a reader can't tell which implementation is live.
  Collapsing the duplication (findings 1–3, 6) would meaningfully de-risk the
  project and shrink it.
- **Net:** solid, shippable for SQLite and the mysql happy path. Before relying
  on postgres `backup` or adding a new engine, resolve findings 1–3.

### Suggested order of fixing

1. Decide engine ownership for postgres; delete the dead branch (#2) and fix or
   document `PostgresEngine.backup` (#1).
2. Centralize `normalizeEngineName` (#3) and schema-path resolution (#6).
3. Strip dead exports / unused import (#5) and tighten the health check (#4).
4. Leave #7–#9 until a third engine or further growth forces them.
