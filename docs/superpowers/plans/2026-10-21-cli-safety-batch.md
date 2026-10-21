# CLI backup, restore, and migration safety

> **For agentic workers:** Use superpowers:subagent-driven-development with the explicitly requested parallel execution and disjoint ownership below.

**Goal:** Complete the first three safety priorities in REMAINING_AND_SUGGESTIONS.md before adding management UI controls.

**Architecture:** Preserve CLI entry points and engine adapters. SQLite snapshots/restores remain adapter-owned. An asynchronous process runner streams native server dumps/restores. A migration coordinator owns per-engine execution sessions and ledger consistency without sharing mutable adapter connections across requests.

**Tech Stack:** Existing Node.js, node:sqlite, pg, mysql2, native database clients, and node:test. No new production dependency.

**Spec:** Existing safety requirements in `docs/superpowers/plans/2026-10-17-database-toolkit-improvements.md`, Tasks 2-4. This batch narrows execution to backup/restore and migration coordination; remaining schema identity, engine-specific SQL assets, and platform release gates remain separately tracked.

**Implementation status (2026-10-21):** Implemented, reviewed, and verified on Windows / Node 23.9.0: 145 tests, 144 passed, zero failed, one skipped because Windows symlink privilege was unavailable. All explicit workspace/migration/native server integration targets were enabled against isolated local fixtures. Native PostgreSQL/MySQL round trips and migration concurrency/interruption cases passed. Read-only demo counts remained 150 orders per engine. See [usage limits](../../usage.md#cli-backup-and-restore) and [remaining gates](../../../REMAINING_AND_SUGGESTIONS.md).

## Global constraints

- Continue in the user-selected `mega-branch` checkout. No new branches, pushes, merges, or publishing.
- Never test against the configured project database or modify the visible seeded demo tables. Server integration uses independently created `dbtk_test_*` scratch databases and explicit test-only connection variables.
- Keep workspace management endpoints disabled. This batch fixes CLI infrastructure, not UI capability claims.
- Preserve existing CLI method signatures where possible. CLI already awaits backup/restore; existing synchronous SQLite callers must continue to work or be updated with meaningful verification.
- Credentials travel through supported environment variables, not child arguments. Sanitize diagnostics; no shell interpolation of inputs. Delete only operation-owned partial files.
- Native dumps publish only on success; existing destination files are preserved. PostgreSQL restore accepts an unused empty target and trusted native plain pg_dump output, with transaction/stop-on-error protection. Arbitrary SQL/client-control scripts are outside this contract.
- SQLite restore requires external applications to stop using the target; detect busy/recovery state and preserve the old database on failure. Never delete another connection's WAL/journal recovery files.
- Write/observe focused failing tests before implementations. The parent owns final integration checks, review, documentation, and local commits.

## Review focus

1. WAL-only committed pages, corrupted/truncated/same-file restore input, publication failure, and open external handles preserve correct SQLite data.
2. Dumps exceeding 50 MiB, stderr overflow, timeout/nonzero exit, credentials, spaces in paths, and destination collisions cannot produce successful partial backups.
3. PostgreSQL native dump syntax and populated-target refusal, with TLS/auth settings retained and no silent pg.query fallback.
4. Failed SQL/ledger writes and concurrent migration runners cannot create an applied-but-unrecorded SQLite/PostgreSQL migration.
5. MySQL implicit DDL commits and process interruption leave durable incomplete state that blocks automatic reruns; SQL Server migrations fail before any write.

## Task 1: SQLite snapshot backup and validated restore (agent A)

**Own:** `lib/engines/sqlite.js`, `test/sqlite-engine.test.js`, optionally focused `lib/sqlite-files.js` / `test/sqlite-backup.test.js`.

- [x] Reproduce current loss/corruption failure cases using disposable SQLite files, including genuine committed WAL data and two connections.
- [x] Implement consistent snapshot backup to a unique sibling stage with safe no-clobber publication and cleanup. Preserve backup(outputPath) return behavior.
- [x] Validate restore input/staged contents before modifying the target. Reject same-file aliases, handle target sidecars through SQLite checkpoint/locking rather than deletion, and atomically replace only after validation. Keep the original on busy/validation/publication failure.
- [x] Add focused SQLite tests and document maintenance/recovery limits: external applications must stop, recovery sidecars are never manually deleted, and failed rollback retains the original path for manual recovery. Power-loss and cross-platform guarantees remain pending.

## Task 2: Streamed native server operations (agent B)

**Own:** `lib/process-runner.js`, `lib/engines/postgres.js`, `lib/engines/external.js`, process-runner/server-backup tests. Do not edit toolchain/commands/docs.

**Interface:** `runProcess(command,args,{env,inputFile,outputFile,timeoutMs=600000,signal,redact?}) -> Promise<{exitCode:0}>`. outputFile uses an operation-owned sibling partial, refuses existing destinations, publishes only after child and stream success, and removes only its partial. inputFile streams stdin. Bound diagnostic capture; reject timeout/abort/nonzero/spawn/I/O errors safely. Optional injected process runner on adapter construction is permitted for testing the child-process boundary against native clients inside isolated containers; default behavior remains ordinary local executables.

- [x] Add failure tests for >60 MiB output, nonzero partial output, missing binary, timeout, paths with spaces, collisions, redaction, and I/O failure.
- [x] Stream PostgreSQL/MySQL backups, using consistent MySQL transactional dump options and explicit limitations. Keep existing outputs safe.
- [x] Restore trusted PostgreSQL plain dumps through psql --single-transaction/ON_ERROR_STOP against a verified empty target. Retain supported connection/TLS settings via client environment. Refuse populated targets; do not drop databases or fall back to pg.query. Arbitrary client/transaction-control scripts are outside this contract.
- [x] Add native PostgreSQL scratch round-trip coverage for null/quotes/multiline/COPY and a separate transactional MySQL dump/restore fixture. Tests use explicit scratch targets and leave seeded demo tables untouched. Parent owns the fresh integrated result and exact native-client checks.

## Task 3: Migration coordination (agent C)

**Own:** `lib/migrations.js`, optional focused SQL-validation helper, `test/migrations.test.js` and migration integration tests. Do not edit engine adapters/commands/docs.

**Interface:** `runMigrations(engine,directory,{onApplied?}={}) -> Promise<{applied:[filename],skipped:[filename]}>`; consume `engine.config.engine`, config connection fields, and `engine.open()` for SQLite. Parent wires CLI. Sessions/transactions/locks belong inside this module to avoid competing adapter edits.

- [x] Add failure tests for partial SQL, ledger insertion, two real processes, changed applied files, legacy rows, transaction controls, and SQL Server pre-write rejection; reproduce and fix SQLite automatic-rollback error masking.
- [x] SQLite uses BEGIN IMMEDIATE per file; recheck ledger under lock and commit SQL+ledger together. PostgreSQL uses one Client and database advisory lock for the run, one transaction per file, and ledger insert on that session.
- [x] Preserve existing ledger rows/filenames. Store/verify checksums for newly applied files; label legacy entries unverified rather than silently reapplying.
- [x] MySQL uses one direct-driver session and GET_LOCK; retain applied ledger compatibility and durable started/applied/failed attempt state. Refuse automatic retry after incomplete attempts, with actionable manual-repair guidance. Reject unsupported DELIMITER/client directives, top-level SET statements, and transaction-control scripts before partial execution.
- [x] Require explicit disposable server targets for live tests, never project env fallback; verify concurrent processes on all three engines, killed SQLite/PostgreSQL rollback, and durable MySQL started/failed attempts. MySQL's DDL effects require manual repair; SQL Server/TLS remain unverified.

## Task 4: Parent integration, review, and docs

**Own:** `lib/commands.js`, `lib/toolchain.js`, CLI/config integration tests, README/usage/functions/remaining docs, this plan.

- [x] Run baseline suite, wire runMigrations, and correct restore confirmation semantics and operation-specific native client detection.
- [x] Run fresh complete suite, live scratch integration, stream/failure/concurrency tests, and source/code/test review. Fix integration defects without conflicting edits.
- [x] Update REMAINING_AND_SUGGESTIONS.md and usage against actual delivered behavior, preserving unverified SQL Server/TLS/platform limitations. Record counts, failures, and explicit deferrals.
- [x] Commit verified changes locally on mega-branch and confirm clean status.

## Execution rulings

- User delegated routine decisions and explicitly requested parallel continuation. No additional design approval is needed for this prioritized safety batch.
- Keep legacy table identity, SQL assets, native-client platform matrix, and management UI outside this batch so those tasks do not compete with three independent integrity fixes.


## Final review and verification

Independent review reproduced and fixed: SQLite objects named `trigger` escaping
transaction validation; MySQL arithmetic dashes hiding controls; quoted SET
identifiers changing parser/session modes; SQLite busy timeout initialized after
lock-sensitive pragmas; inherited PostgreSQL native routing/TLS overrides;
MySQL dump transport differing from restore; and a MySQL restore prompt naming
the display database instead of the actual driver target. Regression tests cover
each case. CLI backup names also include a UUID to avoid same-second collisions.

The final `npm test` run completed in 48.3 seconds with every live integration
variable described in usage enabled and native clients invoked inside the demo
containers. Temporary MySQL scratch databases were removed afterward; the three
saved demo connections and seeded databases remain available. SQL Server, real
TLS handshakes, Linux/Node 24, power-loss durability, legacy schema identity, and
engine-specific SQL defaults remain explicit follow-up work.
