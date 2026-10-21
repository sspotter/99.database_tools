# Database Toolkit

Single-entry database operations CLI for development, staging, and production workflows.

## What works now

- SQLite operations use Node's built-in `node:sqlite`.
- PostgreSQL uses the `pg` driver directly, so `init` works from `LOCAL_DATABASE_URL` without `psql`.
- The web workspace uses direct PostgreSQL, MySQL, and SQL Server drivers. Native clients are only needed for applicable CLI operations, not workspace browsing or SQL.
- The command structure is unified behind `db.js`.
- Migrations are applied in filename order and tracked in `schema_migrations`.

## Run it

```bash
node db.js help
node db.js init
node db.js tables
node db.js scan
node db.js install postgres mysql
node db.js create-env postgres --database app_database --user postgres --password change_me
```

## Example workflow

```bash
node db.js init
node db.js update schemas/update_schema.sql
node db.js migrate
node db.js backup
```

## Web UI

Start the local multi-connection workspace (run `npm install` first):

```bash
node db.js ui            # default port 4321
node db.js ui --port 8080
```

The command prints a URL that includes a server-session access token, for example
`http://127.0.0.1:4321/?token=<token>`. Open that URL — requests without the
token are rejected.

The workspace starts disconnected. Add multiple connection profiles using URLs
or individual fields, or select an existing SQLite file. Test, save, group,
favorite, duplicate, and switch connections without rewriting `.env`.

- Explore accessible databases, schemas, tables, and views.
- Open independent table and SQL tabs. Each tab keeps its original connection
  revision and target; edits and disconnects disable stale tabs.
- Browse bounded row pages, filter by exact value, sort, inspect columns/keys/
  indexes, and export the loaded page as CSV or JSON.
- Run SQL with bounded results, a 30-second request timeout, and cancellation.
  New connections default to read-only SQL. Enable writes explicitly per profile.
- Restore tab locations without rerunning queries. SQL history is session-only
  unless explicitly enabled in the browser.
- See workspace status and activity in Dashboard and Logs.

Profiles live outside Git in `%LOCALAPPDATA%\db-toolkit` on Windows (otherwise
`~/.local/share/db-toolkit` when `LOCALAPPDATA` is unset). Remembered Windows
passwords use user-scoped DPAPI; other systems offer session-only credentials.
Disconnect clears session-only passwords. Profile duplication requires password
re-entry. Certificate verification is enabled by default.

SQL Server browsing is available, but its arbitrary SQL editor is disabled for
read-only profiles because this adapter cannot enforce a read-only session.
Writable SQL Server tabs accept one parser-supported SELECT/INSERT/UPDATE/DELETE
statement, including supported CTE and UNION forms. Administrative statements and
unsupported syntax are rejected. When a schema is selected, explicitly qualify
physical tables as `[schema].[table]`. Read-only mode is not a sandbox for server
functions. SQL Server live integration and real TLS handshakes remain unverified.

Management commands such as reset, restore, migrations, and row editing are not
exposed by the new workspace. Existing CLI commands remain available. See
[workspace details and limitations](docs/usage.md#local-workspace).

It is a **localhost-only development tool** bound to `127.0.0.1` — do not expose
the port. The `ui`/`serve` commands cannot be triggered from the browser itself.

## Configuration

Copy `.env.example` to `.env` and adjust the values for your environment.

The default SQLite file is `data/toolkit.db`.

You can also configure a database with one URL instead of separate host/user/password fields:

```env
LOCAL_DATABASE_URL=postgresql://devuser:change_me@127.0.0.1:5432/app_database
```

`DATABASE_URL` is also supported as a fallback.

Generate a fresh env template and manifest for a specific engine:

```bash
node db.js create-env sqlite
node db.js create-env postgres --database app_database --user postgres --password change_me
node db.js create-env mysql --database app_database --user root --password change_me
```

On Ubuntu, PostgreSQL and MySQL need the server packages running, not just the client tools:

```bash
sudo apt-get update && sudo apt-get install -y postgresql postgresql-client
sudo systemctl enable --now postgresql

sudo apt-get update && sudo apt-get install -y mysql-server default-mysql-client
sudo systemctl enable --now mysql
```

## Design choices

- One CLI entry point instead of many one-off scripts.
- Destructive CLI operations have confirmation prompts; the earlier backend safety plan remains incomplete apart from the SQLite opening/recovery fix.
- Versioned SQL files for schema changes and migrations.
- SQLite uses the bundled Node API; server workspace connections use npm drivers.
- `scan` checks local CLI tools and reports whether the active engine is already connected.
- `install` can show install commands for Linux (`apt`, `dnf`, `pacman`, `zypper`) and Windows (`winget`, `choco`) package managers.
- If `LOCAL_DATABASE_URL` points to PostgreSQL, the CLI uses `pg` directly and `psql` is optional.
- If `LOCAL_DATABASE_URL` points to MySQL and the client is missing, the CLI can still show install commands.
- PostgreSQL uses `schemas/postgres/schema.sql` and `schemas/postgres/update_schema.sql` by default.
- Emoji status markers (✅/⚠️/❌) and green/colored output are on by default; set `DB_TOOLKIT_EMOJI=false` to disable the emoji (e.g. when logging to a plain file).
- If automatic installer launches are blocked, the CLI prints copy-paste install commands instead.
- Use `node db.js set postgres` to generate `db-toolkit.manifest.json` for the selected engine.
- Use `node db.js set postgres --url` to reuse the `LOCAL_DATABASE_URL` or `DATABASE_URL` already loaded from your env file.
- On Ubuntu, install optional local clients with commands such as `sudo apt-get update && sudo apt-get install -y sqlite3 postgresql-client default-mysql-client`.
- Use `node db.js install postgres --apply` only from a shell that is allowed to modify the machine.

## Tests

```bash
npm test
```

The default suite uses temporary local fixtures and needs no database server when
the opt-in integration variables are unset. Eight live PostgreSQL/MySQL tests in
`test/workspace-integration.test.js` run only with explicitly supplied disposable
database URLs. See [test setup and remaining verification](docs/usage.md#tests).
