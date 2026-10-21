# Local Database Workspace Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with parallel, disjoint file ownership. Steps use checkbox syntax for tracking. The user authorized execution with parallel subagents and delegated remaining design decisions on 2026-10-20.

**Goal:** Deliver a local multi-connection database workspace on `mega-branch`.

**Architecture:** Keep the CLI and vanilla web UI; add a user-local profile store, isolated worker-based database requests, and authenticated profile-targeted API routes. Avoid a mutable global active connection. Workers bound query time and allow real cancellation without blocking the HTTP server.

**Tech Stack:** Node.js ES modules, node:sqlite, pg, direct MySQL/SQL Server drivers, Windows DPAPI, node:test, vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-20-local-database-workspace-design.md`.

## Global constraints

- Work in the user's explicit `mega-branch` checkout; do not create another branch or worktree.
- Single-operator localhost-only service; preserve API token validation.
- Never read the project's `.env` secrets into tool output or connect to its configured databases for tests.
- Use disposable fixtures. Store profiles outside Git; secrets never reach list/detail responses or logs.
- Preserve the current dark UI identity and CLI compatibility.
- Defer row editing/import/restore/migrations; block unsafe management routes for saved profiles.
- User chose the recommended defaults and requested no further routine questions. Parent integrates and makes local milestone commits only; no push or merge.

## Review focus

1. Redaction and secret encryption fail closed, including error paths and edited credentials.
2. Profile revision/deletion and delayed responses never retarget an existing tab.
3. Query cancellation releases resources and doesn't block other connections.
4. Browsing is read-only, schema-aware, parameterized, and bounded.
5. SQLite connection tests never create missing files or destroy recovery sidecars.

## Shared contracts

Profiles: `{id, revision, name, engine, group, environment, favorite, readOnly, credentialMode, credentialStatus, settings:{host,port,user,database,file,sslMode,sslCa}}`. Private profiles add `settings.password`. Engines: `sqlite|postgres|mysql|mssql`. Credential modes: `saved|session|none`. URL input is accepted by the store but never returned; public settings omit passwords. Revision increments on every edit.

Store export: `createConnectionStore({directory?,cwd?})`, returning async `list()`, `get(id,{includeSecrets=false}={})`, `save(input)`, `remove(id,revision)`, and `clearSessionSecrets(id)`. `save` updates when input.id is present and requires the current input.revision. Default directory is current-user app data; override only through server construction/tests. `save` returns the public profile. Private retrieval throws on missing/unreadable required credentials. Expose a sanitizing `redactError(error)` helper.

Database export: `runDatabaseTask(profile, task, {signal,timeoutMs}={})` and `getCapabilities(engine)`. Tasks use `action:test|databases|schemas|tables|rows|inspect|query`, and optional `database,schema,table,limit,offset,sortColumn,sortDirection,filterColumn,filterValue,sql`. `test` returns `{ok:true}`; databases/schemas return `{databases:[string]}` / `{schemas:[string]}`; tables returns `{tables:[{schema,name,type}]}`; rows/query return `{columns:[string],rows:[object],hasMore?,durationMs?,rowCount?}`; inspect returns `{columns:[object],indexes:[object],foreignKeys:[object],definition?:string}`. Bound rows to 500 by default/max 1000, explicit validated identifiers, parameterized values. Capabilities describe actual browsing/query/readOnlyQuery support.

API: authenticated GET `/api/connections` -> `{profiles,capabilities,credentialPersistence}`; POST `/api/connections` -> `{profile}`; DELETE `/api/connections/:id` body `{revision}`; POST `/api/connections/test` body `{profile}` tests unsaved input through nonpersisting normalization; POST `/api/connections/:id/connect` body `{revision}` -> `{profile,databases}`; POST `/api/connections/:id/disconnect`; POST `/api/connections/import-current` explicit action; POST `/api/workspace` body `{profileId,revision,requestId,task}` -> task result; POST `/api/workspace/cancel` body `{requestId}`. All workspace requests validate saved revision and connected state. Connect establishes logical connected state; each operation opens a short-lived worker/database session. Disconnect aborts active tasks, clears session-only credentials. Import only normalizes existing config on explicit user action. Test route accepts URL or settings via exported normalization from storage module; coordinate exact function with parent.

## Task 1: Profile storage (parallel agent A)

**Files:** create `lib/connections.js`, optional focused secret helper, `test/connections.test.js`.

- [x] Write failing tests for URL normalization, protocol/options validation, plaintext exclusion, revisions, deletion, session clearing, and error redaction using temp directories.
- [x] Verify the tests fail before implementation.
- [x] Implement shared store contract, atomic metadata writes, validation, DPAPI via stdin (no secrets in arguments), and non-Windows session-only behavior. Export `normalizeConnectionInput(input,{cwd?}={})` for unsaved connection tests, returning a private normalized profile without persistence.
- [x] Run focused tests and a real Windows encrypt/decrypt round trip; report evidence.

## Task 2: Database tasks and SQLite safety (parallel agent B)

**Files:** create `lib/workspace-db.js`, `lib/workspace-worker.js`, focused workspace helpers/tests; modify `lib/engines/sqlite.js`, its tests, and package/lock for drivers.

- [x] Write and observe failing disposable tests: missing SQLite file, existing WAL recovery, read-only browsing, literal dotted table names, pagination/filter/sort, metadata, SQL writes rejected, bounded results, timeout/cancellation.
- [x] Implement runDatabaseTask/getCapabilities using worker threads and direct drivers for four engines. Use one task per worker, close connection in finally, terminate on abort/timeout. Browsing is always read-only independently of write preference. SQL Server read-only arbitrary SQL must be disabled if not enforceable.
- [x] Fix existing SQLite open to preserve sidecars and enable durable settings without disturbing existing WAL files; verify legacy suite remains green.
- [x] Validate live SQLite behavior; exercise server-engine behavior only against disposable servers if available, otherwise report unverified integration explicitly.

## Task 3: Workspace UI (parallel agent C)

**Files:** `ui/index.html`, `ui/app.js`, `ui/styles.css` only.

- [x] Build on the existing dark identity with searchable/grouped profiles and a single add/edit form (URL/fields, credential mode, SSL, environment, group, readOnly).
- [x] Add connect/disconnect, duplication without credentials by default, revision-aware independent table/query tabs, database/schema/table exploration, pagination/filter/sort, metadata, loaded-page CSV/JSON export, SQL run/cancel, and session-only history with opt-in persistent history.
- [x] Keep target identity visible, ignore obsolete responses, clearly label production/writable modes, distinguish unsupported/permission/empty/error states, and use textContent for untrusted data.
- [x] Maintain existing status/log surfaces without auto-loading real configured databases; legacy operations require explicit navigation/action and remain separate from saved profiles.
- [x] Verify syntax and report API assumptions to the parent. Parent owns browser verification.

## Task 4: API integration (parent)

**Files:** `lib/server.js`, `test/server.test.js`; optional small workspace routing module.

- [x] Write failing HTTP tests with disposable SQLite for authentication, CRUD redaction, connect state, request revisions, independent databases, cancellation, and profile deletion/disconnect.
- [x] Implement contract with injectable profile directory, strict body and origin checks, no-store JSON responses, sanitized failures, explicit targets, unique bounded running request IDs, server-side cancellation, profile edit/deletion invalidation, and server shutdown cleanup.
- [x] Remove status migration-ledger creation; keep legacy CLI intact. Saved profile APIs cannot invoke legacy destructive command handlers.
- [x] Run focused and full tests.

## Task 5: Review, documentation, and delivery (parent + fresh review agents)

**Files:** README, usage docs, this plan/spec status, package/runtime metadata where needed.

- [x] Review each independent deliverable for contract/safety defects and fix integration gaps.
- [x] Run complete suite, syntax and diff checks, browser QA on disposable SQLite fixtures (desktop/narrow and keyboard), Windows credential smoke check, and dependency audit.
- [x] Run a fresh broad security/correctness review using clean-code-guard and test-guard; review documentation against actual supported behavior with docs-guard.
- [x] Document setup, profile storage, credentials, capability limitations, query semantics, tests and unverified live integrations. Commit verified local milestones on `mega-branch` only.

## Execution record

- Baseline: Node 23.9.0; `npm test` passes 37/37. SQLite emits Node's experimental warning.
- Ruling: use the user's existing feature branch in place with disjoint agent file ownership, because they explicitly chose this branch and requested parallel work.
- Ruling: proceed without further design approvals, because the user explicitly requested all questions up front and then authorized execution with parallel subagents.
- Implemented profile storage, Windows DPAPI credentials, four direct engine adapters, worker cancellation, authenticated profile-targeted APIs, and the multi-tab local UI. Preserved the CLI and current dark identity.
- Review fixes: bounded metadata writes, revision-scoped credential clearing, replacement-password tests, race-free connect response, crash-released profile locking, schema-aware SQL, SQL Server alias/CTE validation, duplicate result rejection with write rollback, MySQL UPDATE result handling, and composite foreign-key pairing.
- Ruling: use a separate `connections-lock.sqlite` solely for cross-process OS locking, replacing a persistent directory lock that could remain after a crash. Metadata remains JSON; secrets remain DPAPI-protected files.
- Live PostgreSQL 16 and MySQL 8.4 verification passed all eight opt-in tests during implementation (the then-current full suite passed 85/85). Disposable fixtures covered schema routing, committed writes, read-only rejection, actual server cancellation, duplicate-result rollback, JSON bounds, and composite keys. No project database was used.
- Final verification on 2026-10-21: `npm test` passed 80 tests, with 8 opt-in live tests skipped and no failures. Syntax and diff checks passed. Dependency audit reported 0 vulnerabilities. Docker's engine was unavailable for a fresh live rerun after the final offline SQL Server and profile-lock fixes.
- Browser QA passed on desktop and 390px viewport: empty startup without database access, test/save/connect, 100/20-row pagination, inspector, SQL, read-only rejection, target restoration without autorun, no horizontal document overflow, keyboard dialog navigation, and no browser runtime errors.
- Remaining verification limits: SQL Server live integration, live TLS/certificate handshakes, and non-Windows credential behavior. Broader legacy backup/restore/migration safety work remains outside this first release.
