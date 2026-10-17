# Database Toolkit Improvements Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only if the user chooses delegation. Steps use checkbox syntax for tracking. This document authorizes planning only; implementation is a separate action.

**Goal:** Resolve all nine audit findings, then add the proposed features in an order that builds on reliable database operations.

**Architecture:** Keep the Node.js CLI, engine adapters, HTTP server, and vanilla web UI. Put database guarantees in the engine adapters and share command validation between CLI and web callers. Add focused modules for process execution, migration coordination, and table references only where their responsibilities justify them.

**Tech stack:** JavaScript ES modules, Node's `node:sqlite`, `pg`, native PostgreSQL/MySQL client tools, `node:test`, HTML, and CSS. Keep production dependencies unchanged for the safety release unless verification demonstrates a concrete need.

**Spec:** The [scope and decisions](#scope-and-decisions) below encode the audit delivered in this chat on 2026-10-17. The older [fix plan](../../fix-plan.md) is historical context; it contains tasks that are already implemented and is not the execution checklist for this work.

## Scope and decisions

The user requested a plan for the audit fixes. Tasks 1-10 form the safety release. The feature roadmap records all eight suggested additions, but those feature designs and their detailed implementation plans remain subject to selection before execution.

Observed baseline: 37 tests passed on Node 23.9.0 during the audit. A disposable SQLite database reproduced an unrecorded partial migration and replacement of a valid database by an invalid restore file. PostgreSQL/MySQL/SQL Server findings were inspected in source, not exercised against live servers.

Decisions made for this draft:

- Treat the application as a local, single-operator development tool that may connect to remote databases. Do not expand it into a hosted multi-user service.
- Deliver safety fixes before adding new database editing features.
- Propose Node 24.x as the supported runtime for this release; verify native SQLite behavior on Windows and Linux before setting the package requirement. The current Node 23.9.0 audit result is not that verification.
- Use SQLite `journal_mode=DELETE`, `synchronous=FULL`, and foreign keys enabled by default. WAL can be an explicit future configuration; never remove recovery files during ordinary open.
- Treat restore/reset as maintenance operations. External applications must stop using the target during SQLite replacement; toolkit locks cannot control unrelated database clients.
- Default PostgreSQL restore to an empty target database. Refuse populated targets with actionable guidance. Do not silently delete a database, merge data, or promise overwrite semantics. Existing users must explicitly back up/reset their target first.
- PostgreSQL migrations use one connection, one transaction per file, and a database advisory lock for the whole migration run. SQLite uses a write transaction per file and rechecks the ledger while holding it.
- MySQL schema changes can commit implicitly. Use a database lock and durable started/applied/failed tracking; never claim general rollback support. Stop on an incomplete migration and require explicit repair after operator inspection.
- Keep SQL Server marked experimental. Its backup/restore and row browsing remain unavailable; migration execution must fail clearly until that path has equivalent safety coverage.
- Preserve existing migration filenames and applied ledger rows when introducing engine-specific files. Never silently reapply or rewrite already-applied migrations.
- Keep the current visual identity. Fix operation safety, access, responsiveness, and accessibility without a visual redesign.

## Global constraints

- No tests, restore drills, or migrations against the configured project database. Use disposable files and explicitly selected disposable server databases.
- Keep the server bound to `127.0.0.1` and preserve API token checks.
- Never include credentials in command logs, errors, test fixtures, or committed configuration. Child processes receive passwords through their supported environment variables.
- Keep existing CLI commands where possible; document intentional changes to table references and populated-target restore.
- Verify operation capabilities on the server. Hiding a browser control does not enforce a restriction.
- Every behavior-changing task includes a failing regression test, the implementation, passing focused checks, and relevant documentation updates in the same commit.
- Use `clean-code-guard`, `test-guard`, and `docs-guard` for their corresponding final review surfaces. Do not add tests that merely repeat implementation details.
- Existing untracked `docs/showcase/` content belongs to the user and must remain untouched.

## Review focus

1. Invalid, truncated, same-file, and interrupted restores preserve the previous working database (Task 2).
2. A migration failure or two toolkit processes racing cannot silently create an applied-but-unrecorded migration (Task 4).
3. Duplicate table names and names containing dots or quote characters resolve to the intended schema/table (Task 6).
4. Dump output larger than 50 MB, child-process failure, and paths containing spaces do not produce a successful partial backup (Task 3).
5. Status failure, repeated clicks, keyboard-only operation, and a narrow viewport never present a failed operation as success (Tasks 8-9).

## Delivery order and coverage

| Phase | Tasks | Audit findings | Release gate |
|---|---|---|---|
| A: SQLite durability | 1-2 | 1, 2 | Safe opens, consistent backups, validated restore |
| B: Backup and restore | 3 | 3, 7 | PostgreSQL round-trip and streamed dumps |
| C: Migration correctness | 4-5 | 4, 5 | Failure/concurrency handling and correct SQL dialects |
| D: Table identity | 6 | 6 | Schema-aware preview/drop/reset |
| E: API and interface | 7-9 | 8, 9; shared safeguards | Honest status, controlled operations, accessible UI |
| F: Release verification | 10 | All | Disposable integration matrix and accurate docs |

Execute Tasks 1-10 in order. Each task is one reviewable deliverable. Features start after Phase F passes.

## File ownership

Existing files to modify as needed:

- `lib/engines/sqlite.js`: durable SQLite access, backup, restore, and transactional migrations.
- `lib/engines/postgres.js`: PostgreSQL dump/restore, migrations, and qualified table access.
- `lib/engines/external.js`: streamed MySQL backup and honest engine capabilities.
- `lib/commands.js`, `db.js`: command routing, arguments, confirmations, and cancellation/error behavior.
- `lib/server.js`: authenticated API, shared operation validation, status, and request coordination.
- `config/database.js`, `lib/manifest.js`, `lib/env.js`: engine-specific migration/seed defaults and compatible manifests.
- `lib/toolchain.js`: detect tools needed by the selected operation, including `pg_dump` and `psql`.
- `ui/app.js`, `ui/index.html`, `ui/styles.css`: status, operation feedback, schema/table selectors, accessibility, and responsive layout.
- `test/*.test.js`: existing unit suite plus focused regression coverage.
- `README.md`, `docs/usage.md`, `functions.md`, `package.json`, `package-lock.json`: supported behavior, prerequisites, scripts, and dependency metadata.

New focused modules/files proposed by this plan:

- `lib/process-runner.js`: asynchronous child process lifecycle and streamed output files.
- `lib/migrations.js`: migration selection, content validation, and coordinator contract.
- `lib/table-ref.js`: schema/table reference validation, quoting, and display.
- `lib/operations.js`: command allowlist, input validation, and target identity.
- `schemas/postgres/seed.sql`, `schemas/mysql/seed.sql`, `migrations/postgres/*.sql`, `migrations/mysql/*.sql`: engine-specific SQL.
- `test/integration/*.test.js`, `test/helpers/*.js`: disposable server fixtures and integration cases.
- `.github/workflows/test.yml`, `compose.test.yaml`: reproducible verification; server integration runs on Linux, unit tests on Windows and Linux.

These are proposed paths, not claims that those modules or interfaces already exist.

## Task 1: Restore SQLite durability

**Files:** Modify `lib/engines/sqlite.js`; extend `test/sqlite-engine.test.js`; update SQLite notes in `docs/usage.md`.

**Interface:** Preserve `open()`, `close()`, `runSql()`, and configuration shape. `open()` must not delete sidecar files. Ordinary read operations must not alter recovery settings on unrelated existing connections without a deliberate maintenance transition.

- [ ] Add regression cases named `open_preserves_existing_recovery_files`, `open_uses_durable_defaults`, and `reopen_preserves_committed_data`. Build a real WAL fixture through a separate SQLite connection; verify committed rows, not just file existence.
- [ ] Run `node --test test/sqlite-engine.test.js`; confirm the recovery/settings cases fail on the current implementation.
- [ ] Remove ordinary-open sidecar cleanup and apply the selected durable defaults. If an existing writer prevents changing journal mode, return a clear busy error rather than deleting recovery data. Keep foreign keys enabled and release failed-open handles.
- [ ] Verify rollback of a multi-statement transaction and reopening after a child writer exits. Run the focused suite and `npm test`; both must pass.
- [ ] Review and commit only the task's files with message `fix: restore SQLite durability safeguards`.

## Task 2: Make SQLite backup and restore preserve working data

**Files:** Modify `lib/engines/sqlite.js`, `lib/commands.js`; extend `test/sqlite-engine.test.js`; add `test/sqlite-restore.test.js`; update restore documentation.

**Interfaces:** `backup(outputPath): Promise<string>` uses Node's native SQLite backup API. `restore(inputPath): Promise<string>` validates a sibling staged database, preserves the old target, and only then replaces it. Callers already await engine methods; update direct tests accordingly. Reject input/output paths that resolve to the active file, including existing-file aliases where detectable.

- [ ] Add failing cases for invalid/truncated input, same-file paths, a populated target, simulated staging/replacement failure, committed WAL data in backup, and a file held open by another toolkit operation. Assert the original target's rows remain readable after every failure before replacement.
- [ ] Run `node --test test/sqlite-engine.test.js test/sqlite-restore.test.js`; confirm the data-preservation tests fail before implementation.
- [ ] Implement snapshot backup into a unique temporary output. Validate restore input with SQLite integrity checks before replacement. Acquire an exclusive toolkit maintenance lock keyed by canonical target path; preserve a uniquely named recovery copy. On replacement/reopen failure, restore the previous target and report both errors if recovery itself fails.
- [ ] Handle obsolete sidecars only inside the exclusive maintenance workflow after candidate validation and target checkpoint/closure. Document that unrelated applications must close their connections. On platforms with locked-file rename failures, return a failure with the original/recovery file intact.
- [ ] Run the focused suite on Windows and Linux, then `npm test`. Review and commit as `fix: validate SQLite restores before replacing data`.

## Task 3: Stream database dumps and use a compatible PostgreSQL restore

**Files:** Create `lib/process-runner.js`, `test/process-runner.test.js`, `test/postgres-restore.test.js`; modify PostgreSQL/MySQL adapters, `lib/toolchain.js`, CLI restore messaging, and backup documentation.

**Interfaces:** Add `runProcess(command, args, { env, inputFile, outputFile, timeoutMs }): Promise<{ exitCode: number }>` using asynchronous `spawn`, bounded diagnostic capture, and streamed file I/O. Engine `backup(outputPath)` retains `Promise<string>`; PostgreSQL `restore(inputPath)` invokes `psql` with stop-on-error and one transaction against an empty target. Use a documented 10-minute initial process timeout with clear failure, not silent retry.

- [ ] Test a Node fixture emitting 60 MB, a child exiting nonzero after partial output, a missing executable, timeout, a path containing spaces, existing destination collision, and password redaction. Add a PostgreSQL scratch-database round-trip fixture containing text, nulls, quotes, and multiline values.
- [ ] Run `node --test test/process-runner.test.js test/postgres-restore.test.js`; confirm new functionality is absent/failing. Keep live round-trip cases separate from unit cases and require explicit disposable connection variables.
- [ ] Implement streaming to a unique temporary file with exclusive creation; rename only after zero exit status. Preserve existing output files by default and make automatic backup names collision-resistant. Delete only task-created partial files. Use consistent MySQL transactional-dump settings and document limitations for nontransactional tables.
- [ ] Implement operation-specific client detection and PostgreSQL plain-dump restoration through `psql`. Preserve supported host/port/user/TLS settings from connection configuration without passwords in argv. Reject a populated user-schema target; correct CLI/UI copy that currently promises overwrite. Do not silently fall back to `pg.query()`.
- [ ] Verify a 60 MB streamed backup, dump failure, concurrent HTTP responsiveness, PostgreSQL backup/restore into a fresh database, and nonempty-target refusal. Run `npm test`; review and commit as `fix: stream dumps and restore PostgreSQL with psql`.

## Task 4: Coordinate migrations and make failures explicit

**Files:** Create `lib/migrations.js`, `test/migrations.test.js`; modify all engine adapters and the `migrate` command; add engine integration cases and migration documentation.

**Interfaces:** Add engine `applyMigration({ filename, sql, checksum }): Promise<void>` and `withMigrationLock(callback): Promise<unknown>`. The engine owns the SQL and ledger write on the same connection. The coordinator loads pending files and invokes these methods. Retain `listAppliedMigrations()` for current callers; extend ledger columns compatibly instead of replacing existing rows.

- [ ] Add failing tests for a second SQL statement failing, ledger insertion failing, two processes targeting one database, a changed already-applied file, and an interrupted MySQL migration. A migration that fails on SQLite/PostgreSQL must leave neither schema changes nor an applied ledger row.
- [ ] Run `node --test test/migrations.test.js`; confirm the partial-change regression fails. Use genuine two-process fixtures for locking; mocks alone do not prove exclusion.
- [ ] Implement SQLite per-file write transactions with the applied check inside the transaction, PostgreSQL advisory locking with a dedicated connection and transactional ledger writes, and MySQL named locking plus started/applied/failed entries. Release locks and connections on every outcome. Reject transaction-control statements in toolkit-managed transaction files with a documented actionable error; do not naively split SQL on semicolons.
- [ ] Add SHA-256 content checksums for newly applied files. Existing filename-only records remain applied and are labeled legacy/unverified; never silently bless unknown historical content. For MySQL started/failed entries, refuse automatic rerun and provide the inspected filename and repair guidance. Leave automated repair/rollback commands out of this task.
- [ ] Run focused and disposable PostgreSQL/MySQL concurrency/failure tests, then `npm test`. Review and commit as `fix: coordinate migration execution and ledger writes`.

## Task 5: Resolve migrations and seeds by engine

**Files:** Modify `config/database.js`, `lib/manifest.js`, `lib/env.js`; create engine-specific migration/seed files and `test/sql-defaults.test.js`; extend `test/config.test.js`; update configuration examples.

**Interfaces:** Keep `config.defaults.migrationsDir` and `config.defaults.seedFile`. Resolve an explicit custom path first; otherwise select engine-specific defaults. Version-1 manifests using the old generic defaults need a documented compatibility rule rather than being mistaken for deliberate custom overrides.

- [ ] Test fresh defaults for SQLite/PostgreSQL/MySQL, explicit path overrides, old manifests, missing SQL Server assets, and existing applied filenames. Assert SQLite retains the current migration filenames and ledger history.
- [ ] Run `node --test test/config.test.js test/sql-defaults.test.js`; confirm missing engine-specific selection fails.
- [ ] Keep the current SQLite migration files in place. Add equivalent PostgreSQL/MySQL migrations with the same logical filenames, correct identity/default syntax, and engine-specific seed conflict handling. Preserve existing objects through idempotent initial setup; do not change identifiers of existing rows.
- [ ] Update generated manifests/env templates with the new defaults. For legacy generic defaults, select engine-specific assets only for recognized built-in paths; preserve explicit custom paths. Reject unsupported SQL Server migration setup clearly rather than feeding it SQLite SQL.
- [ ] Verify fresh init/migrate/seed and repeated migrate/seed on disposable SQLite/PostgreSQL/MySQL databases. Verify upgrade from a legacy ledger without replay. Run `npm test`; review and commit as `fix: select migration and seed SQL by engine`.

## Task 6: Preserve schema-qualified table identity

**Files:** Create `lib/table-ref.js`, `test/table-ref.test.js`; modify engine adapters, `lib/commands.js`, `db.js`, `lib/server.js`, `ui/app.js`; add PostgreSQL schema integration tests; update table-command docs.

**Interfaces:** Define `TableRef = { schema: string | null, name: string }`. Add `listTableRefs(): Promise<TableRef[]> | TableRef[]`, `previewRows(ref, limit)`, and `dropTable(ref)` across engines. Keep `listTables()` as a compatibility wrapper only while audited callers transition. JSON carries schema/name separately; never reconstruct identity by splitting a display label on dots. CLI accepts `--schema-name` plus the existing table positional.

- [ ] Add two-schema fixtures with `sales.orders` and `archive.orders`, plus names containing dots/quotes. Assert preview/drop affects only the selected object and reset handles the intended supported user schemas. Reject an ambiguous unqualified CLI name.
- [ ] Run `node --test test/table-ref.test.js`; confirm the old plain-name contract cannot satisfy the cases.
- [ ] Return structured references from catalog queries, quote each identifier separately, and thread the references through API/UI/CLI. Display qualified labels while preserving the underlying object. Define the migration ledger's schema explicitly rather than relying on search path.
- [ ] Replace implicit PostgreSQL `CASCADE` on ordinary table drop with dependency refusal by default. Any cascading action requires an explicit option and a confirmation that names the target and dependency effect; the server validates it too.
- [ ] Verify duplicate-name preview/drop/reset in PostgreSQL, existing SQLite browsing, and argument/API compatibility. Run `npm test`; review and commit as `fix: preserve schema identity in table operations`.

## Task 7: Validate browser operations and coordinate target changes

**Files:** Create `lib/operations.js`, `test/server.test.js`; modify `lib/server.js`, `lib/commands.js`, and `ui/app.js`.

**Interfaces:** Define `validateOperation({ command, args, options, target }): ValidatedOperation` with a browser command allowlist and per-command option validation. Define `target` as a canonical engine/host/port/database or SQLite file identity without credentials. Destructive requests require explicit confirmation and the target identity the user reviewed; mismatch returns HTTP 409.

- [ ] Add API tests for missing/invalid tokens, blocked commands, unsupported browser options, malformed bodies, unconfirmed destructive requests, changed target identity, and overlapping commands/status requests.
- [ ] Run `node --test test/server.test.js`; confirm the current unconditional browser confirmation fails the new request contract.
- [ ] Share validation between the browser entry point and command execution. Preserve existing CLI confirmation behavior. Reject browser-triggered installers/service recovery. Serialize status reads and commands that touch the same target; ensure cleanup remains in `finally` blocks.
- [ ] Make status discovery read-only: inspect the migration ledger without creating it and do not create an absent SQLite database file. A missing database/ledger is an explicit not-initialized state; an inaccessible ledger is an error. Return enough sanitized target information for confirmations.
- [ ] Verify authenticated normal commands still work, invalid operations make no engine calls, and merely opening/refreshing the dashboard changes no schema. Run `npm test`; review and commit as `fix: validate and coordinate dashboard operations`.

## Task 8: Show honest status and prevent duplicate submissions

**Files:** Modify `ui/app.js`, `ui/index.html`, `ui/styles.css`; extend API/UI verification fixtures.

**Interfaces:** Status exposes separate connection, table, and migration outcomes. Migration outcome includes `state: 'ready' | 'not-initialized' | 'error'` and an optional error message. The UI consumes Task 7's target identity and confirmation contract.

- [ ] Add focused browser cases for connection success with migration discovery failure, missing ledger, stale/out-of-order responses, a slow command, double-click, and a refused target mismatch. Check visible text and request count.
- [ ] Run those cases against the existing UI and record failures before editing. Use disposable SQLite data and server fixtures; do not use the configured target.
- [ ] Render unavailable migration counts as unknown/error, not green zeroes. Clear stale status after failures. Track one active command in the UI, disable conflicting controls, and restore them on both success and failure.
- [ ] Show the exact sanitized target and affected object in confirmation text. Keep progress visible until completion, distinguish cancellation from success, and suppress stale row/status responses after target/table selection changes.
- [ ] Verify failure and success flows in the browser and run `npm test`. Review and commit as `fix: show accurate dashboard status and command state`.

## Task 9: Repair keyboard access, contrast, and narrow layouts

**Files:** Modify `ui/index.html`, `ui/app.js`, `ui/styles.css`; add only targeted interaction regression coverage to the existing browser checks.

**Interfaces:** Native links/buttons activate table browsing. Dialogs have an accessible name, focus entry/containment/return, Escape dismissal, and inert background content. Forms have persistent visible labels; asynchronous status uses appropriate live announcements.

- [ ] Exercise table browsing and destructive confirmation entirely by keyboard. Check initial focus, Tab/Shift+Tab containment, Escape, cancel, focus return, and labels. Record the existing failures.
- [ ] Replace interactive spans, label generated inputs and table selector, add tab state semantics, and implement accessible dialog behavior using native `<dialog>` where supported by the chosen browser baseline.
- [ ] Darken danger backgrounds or adjust foreground colors to achieve at least 4.5:1 for normal-size text in default/hover/focus states. Add visible focus indicators. Preserve text/icon cues so color alone is never the only outcome signal.
- [ ] Verify 360 px and desktop widths, 200% zoom, long qualified table names, and long errors. Wrap/scroll navigation intentionally, collapse card grids when needed, and keep the primary touch controls at least 44 px high. Keep table overflow inside its container.
- [ ] Run the Impeccable detector once, verify its findings in context, check desktop/mobile screenshots and keyboard behavior, then run `npm test`. Review and commit as `fix: make dashboard controls accessible and responsive`.

## Task 10: Release verification and documentation

**Files:** Add `compose.test.yaml`, `.github/workflows/test.yml`, disposable integration helpers/tests, and package scripts; update `README.md`, `docs/usage.md`, `functions.md`, `IMPLEMENTATION_PHASES.md`, and runtime metadata where needed.

**Interfaces:** Add proposed `npm run test:integration` for `test/integration/*.test.js`. Unit tests remain `npm test`, with its discovery narrowed to `test/*.test.js` so they cannot accidentally run server integration cases. Integration setup requires explicitly provided test-only credentials/database names, rejects names outside the `dbtk_test_` namespace, and never falls back to `DATABASE_URL`/`LOCAL_DATABASE_URL`.

- [ ] Create disposable PostgreSQL and MySQL fixtures using pinned major versions (proposed PostgreSQL 16 and MySQL 8.4). Each test owns uniquely named databases and cleans up only verified test targets. Do not request elevated access to the user's project database.
- [ ] Run unit tests on Node 24.x under Windows and Linux. Run server integration on Linux: init/migrate/seed, repeated execution, failed migration, concurrent migration, duplicate schema names, streamed backup failure, and restore round-trip.
- [ ] Verify missing-client diagnostics, credentials redaction, paths with spaces, target mismatch, and all nine audit regressions. Verify SQL Server capability failures are honest; mark untested SQL Server paths experimental.
- [ ] Apply production-code, test, and documentation review skills. Check documented commands against CLI help and route validation. Update all changed behavior, especially restore semantics, runtime support, engine-specific assets, and maintenance requirements.
- [ ] Record actual commands, pass/fail counts, skipped cases, browser evidence, and remaining limitations in the release notes. Commit as `test: verify safe database workflows across engines` only after the supported matrix passes.

## Feature roadmap after the safety release

These are planned outcomes, not currently implemented APIs. For each selected feature, write a separate task-level plan before touching product code. Carry forward the safety release's target identity, engine capabilities, tests, and documentation rules.

### F1: Connection profiles and read-only mode

**Priority:** First. **Depends on:** Tasks 6-7 and 10.

- Store named connection metadata with references to environment-variable secrets. Migrate the existing single connection into a default profile without copying passwords into the manifest.
- Show active profile, engine, host/file, database, and environment in a persistent header. Freeze profile switching while an operation is running.
- Enforce read-only capabilities in CLI/server operations; hide unavailable UI actions as a secondary measure. Use database credentials with read-only privileges for a real database-level guarantee; a toolkit command guard alone is not a SQL sandbox.
- **Acceptance:** switching profiles changes both displayed and actual target; stale confirmations fail; read-only requests cannot invoke write operations; secrets do not appear in saved files or status responses.
- **Likely files:** configuration/manifest/env modules, `lib/operations.js`, server, CLI, UI, and profile tests.

### F2: Backup manager and verification

**Priority:** First. **Depends on:** Tasks 2-3 and F1.

- List toolkit-owned backups with engine, profile, creation time, size, and SHA-256 checksum. Label imported/legacy files as unverified rather than inventing provenance.
- Verify checksum and format before restore. Restore-test server dumps only into explicitly created scratch databases. Keep retention/delete actions manual initially, with confirmations that identify exact files.
- **Acceptance:** altered/truncated backups fail verification; a scratch restore preserves representative data; failed backup jobs never appear as valid completed backups; deletion cannot escape the selected backup directory.
- **Likely files:** new backup catalog module, engine adapters, command routing, server routes, UI, and backup tests.

### F3: Migration preview and integrity view

**Priority:** First. **Depends on:** Tasks 4-5 and F1.

- Show ordered pending filenames and SQL without executing it. Display checksums, legacy/unverified entries, and incomplete/failed states.
- Bind execution to the reviewed target and pending-file checksums; refuse when files or target change after preview.
- Keep automatic rollback out until paired reverse migrations and their engine limits have a separate design.
- **Acceptance:** preview makes no writes; changed applied content is visible; file changes between preview and execution are rejected; failed MySQL migrations cannot be silently rerun.
- **Likely files:** migration coordinator, adapters, commands, server, UI, and migration tests.

### F4: Schema inspector

**Priority:** Next. **Depends on:** Tasks 6, 10, and F1.

- Show column names/types/nullability/defaults, primary keys, indexes, foreign keys, and relationship links. Start with verified SQLite/PostgreSQL metadata; mark unsupported engine fields explicitly.
- **Acceptance:** empty tables are inspectable; composite keys and schema-qualified relationships retain identity; inspection succeeds with read-only credentials and changes no schema.
- **Likely files:** adapter metadata methods, server route, UI inspector, and catalog fixtures.

### F5: Table browsing, filtering, and export

**Priority:** Next. **Depends on:** F1 and F4.

- Add stable pagination ordered by a unique key, per-column sorting, parameterized filters, search over selected supported columns, and CSV/JSON export of an explicitly selected scope.
- For tables with no unique ordering key, label pagination as unstable and avoid promises of complete duplicate-free traversal. Clamp page size to 1-1000; stream large exports with a declared maximum selected scope.
- Prevent spreadsheet formula execution in CSV text cells by default and document the export transformation. Preserve correct quoting, null handling, large integers, and Unicode.
- **Acceptance:** keyed pages have no duplicates in a stable dataset; malicious filter input is treated as data; displayed/exported scope is clear; large exports do not buffer the full dataset.
- **Likely files:** row-query/export modules or adapter methods, server, table view, and query/export tests.

### F6: Operation history and progress

**Priority:** Next. **Depends on:** Tasks 3, 7-8, and F1.

- Record operation ID, sanitized target/profile, command, start/end time, outcome, duration, and redacted diagnostics in a local store separate from the inspected databases.
- Show running/finished/failed/interrupted states; stream bounded log output. Show stages or elapsed time unless a real measurable total exists. Start with manual history clear and a proposed 30-day retention default documented in configuration.
- Do not add cancellation until each operation has an explicit safe interruption contract. A closed browser must not imply rollback.
- **Acceptance:** history survives browser/server restart; interrupted jobs are not success; credentials are absent; log retention is bounded; target operations cannot write history into a read-only inspected database.
- **Likely files:** operation store, process runner, server event stream, history UI, and restart/redaction tests.

### F7: Read-only SQL workspace

**Priority:** Later. **Depends on:** F1, F5, and F6.

- Start with one query per execution, a 5-second timeout, at most 1000 result rows, session history, and export. Use engine-level read-only transactions/connections and dedicated read-only credentials.
- Do not classify safety with a `SELECT` prefix or a SQL regex. Functions and engine-specific statements need database-enforced permissions; refuse engines without a verified read-only execution path.
- **Acceptance:** reads succeed; writes/DDL/multiple statements are rejected; long queries are cancelled at the database, not merely hidden by an HTTP timeout; rows/time limits hold; queries and results do not leak across profiles.
- **Likely files:** adapter query methods, server endpoint, SQL workspace UI, operation history, and adversarial integration tests.

### F8: Schema comparison

**Priority:** Later. **Depends on:** F1 and F4.

- Compare same-engine schema snapshots and show added/removed/changed columns, indexes, and constraints. Start with a read-only diff and exportable report; do not automatically apply generated destructive SQL.
- Treat cross-engine comparison and data comparison as separate future projects.
- **Acceptance:** snapshots are taken without writes; ordering does not create false differences; engine/version limitations are shown; comparison never invokes migrations or DDL.
- **Likely files:** schema snapshot/diff module, server, comparison UI, and deterministic catalog fixtures.

## Final acceptance checklist

- [ ] Each audit finding maps to a passing regression or explicitly recorded engine/platform verification.
- [ ] Invalid SQLite restore preserves the original data; toolkit backup captures committed WAL data.
- [ ] PostgreSQL backup/restore round-trips in a disposable database; populated-target refusal is documented.
- [ ] Migration failures, concurrent runners, and legacy ledger upgrades behave as specified per engine.
- [ ] Fresh SQLite/PostgreSQL/MySQL setup uses compatible migration/seed SQL.
- [ ] Duplicate schema/table names cannot redirect preview, drop, or reset.
- [ ] Large dumps stream, failures keep partial files out of the backup catalog, and the UI stays responsive.
- [ ] API authentication, server-side operation checks, target confirmation, and read-only status discovery are verified.
- [ ] Migration errors remain visible; repeated clicks cannot duplicate a pending operation.
- [ ] Keyboard, contrast, narrow layout, and zoom checks are recorded.
- [ ] Supported runtime/platform matrix passes; SQL Server limitations remain explicit.
- [ ] No live project database or user-owned showcase file was modified by verification.

## Handoff

Review the draft scope decisions before execution. Recommended starting scope is Tasks 1-10 as a safety release, followed by separate plans for F1-F3. No production implementation, dependency installation, commit, or database change is part of creating this plan.
