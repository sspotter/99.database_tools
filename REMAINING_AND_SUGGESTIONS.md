# Remaining work and suggestions

Status: 2026-10-21. This describes the current local database workspace and the
older CLI separately. Implemented behavior is not evidence that every engine,
platform, or failure case has been exercised.

## Implemented in the workspace

- Multiple SQLite, PostgreSQL, MySQL, and SQL Server profiles; groups,
  environments, favorites, search, duplication, connection testing, and explicit
  connect/disconnect. Windows saved passwords use user-scoped DPAPI; session-only
  credentials are available too.
- Database/schema/object discovery, independent table and SQL tabs, bounded row
  pages, exact-value filtering, sorting, column/key/index inspection, and CSV/JSON
  export of the loaded page.
- One-statement SQL execution, bounded results, cancellation, a 30-second request
  timeout, read-only defaults, and explicit writable profiles. SQL Server's
  arbitrary SQL editor requires a writable profile; its read-only mode supports
  browsing instead.
- Tabs retain their original profile revision and target; profile edits and
  disconnects disable stale tabs. Browser restoration keeps tab locations without
  rerunning SQL. Query history is session-only unless the user opts in to browser
  persistence. Dashboard and Logs show workspace activity.
- Local HTTP binding and session-token authentication. Workspace database actions
  are distinct from the legacy CLI's management commands.

See [workspace usage and limits](docs/usage.md#local-workspace) for the supported
connection options, result truncation, transaction behavior, and credential rules.

## Verification boundaries

Workspace baseline verified on 2026-10-21 against the disposable local demo,
before the CLI safety batch:

- All 88 automated tests passed, with zero failures and zero skips, including
  all eight live PostgreSQL/MySQL integration cases.
- Browser checks connected all three demo profiles, paged `orders` as 100 then
  50 rows, opened metadata, queried each engine marker, exported loaded JSON,
  rejected read-only writes, and preserved independent tab targets.
- A long SQLite path initially caused horizontal overflow. The target-label CSS
  was fixed and the browser rerun passed at a 390 px viewport with no horizontal
  overflow. No browser runtime errors were observed.
- Authenticated API checks passed for each engine: NULL email values, Arabic and
  multiline notes, a decimal price of 12.5, an `order_summary` total of 52 for
  order 1, two `order_items` foreign keys and named indexes. The order count stayed
  at 150 after the read-only rejection checks.
- The three demo profiles were saved in the current Windows user's connection
  library under **Demo / Test**, with environment **test** and read-only SQL.
  All were connected; server credentials were ready through DPAPI and SQLite
  used no password. Both server containers were healthy with persistent volumes
  and loopback-only published ports. Provisioning on another machine still
  requires adding profiles as described below.

That baseline included disposable SQLite/profile/API fixtures and eight
opt-in PostgreSQL/MySQL workspace integration tests. See
[test setup](docs/usage.md#tests). Those live tests cover discovery, rows,
inspection, read-only rejection, writable routing, and server cancellation, plus
PostgreSQL JSON bounds and composite foreign keys. Separate CLI safety fixtures
now cover backup/restore and migration recovery; the historical 88-test count
above is not the current batch's final suite result.

Final CLI safety verification on Windows / Node 23.9.0 passed **144 of 145
tests**, with **zero failures** and **one skip** (Windows symlink privilege was
unavailable). All live integration variables were set: this included the eight
workspace PostgreSQL/MySQL cases, native server backup/restore round trips,
three-engine migration concurrency, killed-process recovery, and MySQL durable
incomplete-attempt blocking. Local tests also exercised WAL snapshots,
invalid/busy restores, failed publication, >60 MiB output, timeout/abort,
credentials, routing, and transaction-control regressions. Independent review
findings were fixed before this fresh full-suite run. Authenticated read-only
queries still returned 150 orders in each of the three saved demo profiles.

SQL Server live integration and real TLS handshakes/certificate rejection remain
unverified. Passing configuration tests does not establish either behavior.
The local demo disables TLS and cannot close that verification gap.

## Local demo databases and connections

Requirements: installed npm dependencies, a Node runtime with `node:sqlite`, and
Docker Compose with its engine running. From the repository root:

```powershell
npm install
docker compose -f compose.demo.yaml up -d --wait
node scripts/seed-demo.mjs
node db.js ui
```

Open the token-bearing URL printed by the UI command. Demo provisioning does not
save workspace profiles; on a new machine add them using the following settings.
Use group **Demo / Test**, environment **test**, and keep **Read-only SQL** enabled.

| Profile name | Engine/target | Local fixture credentials |
|---|---|---|
| Demo · SQLite | SQLite; absolute path to `data/demo/workspace-demo.sqlite` in this checkout | No password |
| Demo · PostgreSQL | PostgreSQL; host `127.0.0.1`, port `15432`, database `toolkit_demo`, SSL mode **Disabled** (`disable`) | User `toolkit_demo`, password `demo_password_local_only` |
| Demo · MySQL | MySQL; host `127.0.0.1`, port `13306`, database `toolkit_demo`, SSL mode **Disabled** (`disable`) | User `toolkit_demo`, password `demo_password_local_only` |

These are public credentials for disposable local fixtures only. On Windows,
choose saved credentials to retain the server passwords with DPAPI; on other
platforms use session-only credentials. PostgreSQL uses schema `public`, MySQL
uses `toolkit_demo`, and SQLite uses `main`.

[compose.demo.yaml](compose.demo.yaml) runs PostgreSQL 16 and MySQL 8.4, publishes
only loopback ports, and retains data in named volumes. The SQLite file is under
ignored `data/`. [scripts/seed-demo.mjs](scripts/seed-demo.mjs) uses its own demo
settings, does not load project `.env` files, and refuses a populated target
schema without its matching marker. It inserts missing fixture rows without replacing
existing rows and checks that a repeat insertion does not increase row counts.
Use its defaults for this fixture; it also supports explicit demo overrides.

Seed data includes 24 customers, 12 products, 150 orders, 300 order items,
`demo_metadata`, and the `order_summary` view. Open `orders` to try pagination;
inspect `order_items` for foreign keys, or run:

```sql
SELECT status, COUNT(*) AS order_count
FROM orders
GROUP BY status
ORDER BY status;
```

Stop the demo with `docker compose -f compose.demo.yaml stop`; start it again
with `docker compose -f compose.demo.yaml up -d --wait`. Named volumes and the
SQLite file remain. After restarting the workspace server, reconnect profiles
explicitly. For missing-container/connection errors, check
`docker compose -f compose.demo.yaml ps` and start the demo before retrying the
seed or connection test. Investigate a marker refusal instead of pointing the
script at an existing project database.

## Priority 1: CLI data safety delivered and remaining release gates

The workspace does not complete the
[earlier safety plan](docs/superpowers/plans/2026-10-17-database-toolkit-improvements.md).
The first three priorities are implemented in the
[CLI safety batch](docs/superpowers/plans/2026-10-21-cli-safety-batch.md), with
the operating limits below. Complete the remaining
release gates before adding backup, restore, reset, migration, or data-editing
controls to the workspace.

| Order | Status/work | Current source and verification limits |
|---|---|---|
| 1 | Delivered: SQLite snapshot backup and validated restore | `lib/sqlite-files.js` uses checked `VACUUM INTO` snapshots, same-file/alias checks, busy/recovery refusal, staged replacement, and retained originals when rollback fails. Stop external target users: idle handles and reopen races cannot be fully detected. Hard-link support is required; abrupt interruption can require lock/stage recovery. Full power-loss/platform guarantees remain unverified. |
| 2 | Delivered: streamed native dumps and PostgreSQL empty-target restore | `lib/process-runner.js` bounds diagnostics, streams I/O, handles timeout/abort, preserves existing outputs, and publishes only successful dumps. PostgreSQL uses trusted plain dumps through `psql --single-transaction`/`ON_ERROR_STOP`; requires an unused empty target. MySQL uses transactional dump options, but nontransactional tables/concurrent DDL need maintenance and restore can partially commit. Native clients, actual TLS, and broader OS/version coverage remain separate verification gates. |
| 3 | Delivered: coordinated migrations and durable MySQL attempts | `lib/migrations.js` locks sessions, checks new-file checksums, retains legacy rows as unverified, and commits SQLite/PostgreSQL SQL+ledger together. MySQL started/failed attempts block retry for manual repair because DDL is not atomic. SQL Server is rejected before writes. Transaction/client controls, top-level SET statements, and unsupported MySQL SQL modes/comments are refused. |
| 4 | Engine-specific migration/seed defaults and legacy table identity | `config/database.js` still defaults to generic `migrations` and `schemas/seed.sql`. Preserve applied filenames while selecting compatible SQL. Carry schema/table identity through legacy CLI operations and test duplicate names in different schemas before destructive use. |
| 5 | Pending: complete the safety release gates | Fresh integrated checks passed (144 passed, 1 privilege skip); run the remaining runtime/platform/API/TLS matrix on disposable targets. Keep unchecked tasks in the older plan distinct from this delivered subset. |

The older [fix plan](docs/fix-plan.md) is historical: it includes work already
present, including PostgreSQL backup, automated tests, and the Web UI. Use the
dated safety plan and current source when choosing the next implementation task.

## Priority 2: close provider and transport verification gaps

1. Add a disposable SQL Server fixture. Verify discovery, schema-qualified rows,
   metadata, writable statement routing, cancellation, and rejected syntax.
   Retain the read-only SQL editor restriction unless a database-enforced path is
   implemented and verified.
2. Exercise actual PostgreSQL/MySQL/SQL Server TLS connections: trusted CA,
   untrusted CA, hostname mismatch, and the explicit insecure modes. Check that
   certificate failures remain failures through the API and UI.
3. Record repeatable Windows/Linux runtime coverage. The current development
   runtime described in `docs/usage.md` is Node 23.9.0; the proposed Node 24.x
   support in the safety plan is a verification task, not a declared guarantee.
4. Evaluate Windows-integrated authentication, cloud token authentication, and
   SSH tunnels as separate provider features. None is currently implemented;
   add only the options required by a selected provider and verify their failure
   and credential-lifecycle behavior.

## Priority 3: improve everyday workspace use

- **Per-profile defaults:** add saved page size, query timeout, and default
  schema preferences if needed. Today page size is per tab and the API
  request timeout is fixed; the profile already stores connection/TLS/read-only
  settings.
- **SQL editor:** the current textarea supports Ctrl/Cmd+Enter and query history.
  Consider syntax highlighting, schema-aware completion, formatting, and explicit
  saved queries while preserving each tab's target and revision checks.
- **Browsing/export:** add richer parameterized filters and clearly scoped full
  exports. Current filtering is exact equality and export includes only loaded,
  possibly truncated values. Define stable pagination behavior for tables without
  a unique ordering key.
- **Schema comparison:** start with a read-only same-engine diff and report;
  automatic application of generated DDL needs a separate design.
- **Persistent operation history:** current Logs/Dashboard are workspace activity;
  durable management jobs need bounded storage, redaction, restart recovery, and
  truthful interrupted/failed states.

## Priority 4: add write and management workflows after safety gates

Row editing, import, and backup/restore/migration management are absent from the
workspace. Design row identity, optimistic conflict handling, validation,
preview/confirmation, and atomic batch behavior before adding editable grids or
bulk imports. Keep read-only browsing useful without granting write privileges.
Management jobs also need explicit target confirmation, server-side capability
checks, and interruption contracts built on the verified CLI safety work above.
