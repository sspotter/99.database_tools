# Usage

The CLI supports SQLite and PostgreSQL directly and uses native clients for MySQL and SQL Server operations. The local web workspace uses direct drivers for all four connection types; it does not require `psql`, `mysql`, or `sqlcmd` for browsing or SQL. Some CLI operations, such as PostgreSQL backup (`pg_dump`) and administrative recovery (`psql`), still need native clients.

## Quick start

```bash
node db.js init
node db.js tables
node db.js health
node db.js scan
node db.js install sqlite postgres mysql
node db.js create-env postgres --database app_database --user postgres --password change_me
```

## Commands

- `create [schema.sql]`
- `init [schema.sql]`
- `update [schema.sql]`
- `reset [schema.sql]`
- `drop <table>`
- `tables`
- `backup [output]`
- `restore <file>`
- `health`
- `seed [seed.sql]`
- `migrate [dir]`
- `scan`
- `install [tool...]`
- `set [engine] [--url]`
- `create-env [engine]`

## Local workspace

Run `npm install`, then `node db.js ui`. Open the token-bearing local URL printed
by the command. The server binds to `127.0.0.1`; do not expose or proxy it. The
token lasts for that server session. The UI removes it from the address bar and
keeps it in tab-scoped session storage so refresh works.

Choose **Add connection** to enter a name and engine, then an existing SQLite
file path or server URL/host fields. The optional group, environment, and favorite
settings organize the sidebar. **Test connection** does not save or create a
database. Saving does not connect; choose **Connect** explicitly. **Add current
configuration** imports the project's resolved configuration only when requested.

Server URL protocols are `postgresql:`, `postgres:`, `mysql:`, `mssql:`, and
`sqlserver:`. URL options currently accept `sslmode` and `sslca`; unsupported and
duplicate options fail rather than being ignored. SSL modes are `disable`,
`require` (encryption without certificate verification), `verify-ca`, and
`verify-full` (default). Supply a PEM CA path where needed. SQL Server's
`verify-ca` uses the stronger hostname-verifying behavior too. Windows-integrated
authentication, cloud token authentication, and SSH tunnels are not implemented.

Profiles are personal to the current OS user, outside the repository. Metadata is
stored in `%LOCALAPPDATA%\db-toolkit\connections.json` on Windows; if `LOCALAPPDATA`
is unset, the fallback is `~/.local/share/db-toolkit/connections.json`. Windows
saved passwords are separate `.dpapi` files protected for the current Windows
user. They cannot be portably copied to another account. Credentials are never
returned by profile APIs. On non-Windows systems choose session-only credentials.
For passwordless connections choose **No password**. The store permits at most
1,000 profiles within a 2 MiB metadata limit.

Session-only passwords last until disconnect or server restart. To replace or
forget a password, edit its profile and choose the corresponding password action.
Duplicating a profile copies settings without copying the password. If credentials
become unavailable, re-enter them; the profile remains intact. Profile mutations
use a separate `connections-lock.sqlite` file in the profile directory. It stores
no credentials, and its operating-system lock is released when a process exits,
including after a crash. Concurrent edits can report that the store is busy;
retry the change after the other edit finishes.

After connecting, select a database/schema and open a table or view. Discovery
depends on the account's permissions. SQLite shows its selected file and `main`
schema. Row/query results default to 100 rows in the UI, 500 when a backend request
omits the limit, and are capped at 1,000. Filters
use exact equality. Click a column heading to sort; **Structure** shows metadata.
Pages without a unique ordering can shift as data changes. Export downloads the
loaded page only. Strings are capped at 16,384 characters and binary values at
8,192 bytes (returned as hexadecimal text), with a truncation marker. JSON cells
are also bounded; oversized JSON is returned as truncated text. The UI displays
only the first 1,000 characters per cell. Exports contain the returned values,
including any backend truncation, rather than the original full cells. Duplicate
result column labels are rejected; give expressions distinct SQL aliases.

SQL tabs capture the connection revision and database/schema when opened.
Switching the sidebar does not retarget them. Profile edits invalidate existing
tabs; reconnect and reopen to use the new settings. Read-only profiles use
engine-enforced read-only execution where available; SQLite browsing opens the
existing file read-only. Enabling writes permits SQL changes and shows a writable
label. Cancellation is not a guarantee that already committed writes were undone,
and failed/cancelled requests are not automatically retried.

Queries have bounded results and a 30-second request timeout. Execute one statement
at a time; transactions do not span requests. Writable SQLite, PostgreSQL, and SQL
Server queries execute within a per-request transaction and commit on success;
commands that cannot run inside a transaction, such as SQLite/PostgreSQL `VACUUM`,
are unsupported. PostgreSQL applies the selected schema to the request's search
path. MySQL uses a per-request transaction too, but its server can implicitly
commit statements such as DDL.

Read-only SQLite SQL accepts SELECT and EXPLAIN; read-only MySQL accepts SELECT,
EXPLAIN, and SHOW. SQL Server cannot enforce a read-only arbitrary SQL session,
so its query editor is disabled for read-only profiles. With writes enabled it
accepts one parser-supported SELECT/INSERT/UPDATE/DELETE statement, including
supported CTE and UNION forms; unsupported dialect syntax is rejected. When a
schema is selected, explicitly qualify physical tables as `[schema].[table]`.
Read-only connections are not a sandbox for server functions.

Cancellation uses the drivers' cancellation mechanisms (or a killed child process
for SQLite). PostgreSQL cancellation currently relies on the deprecated
`pg` 8 `activeQuery` API; the dependency range excludes `pg` 9. SQL Server live
integration and actual TLS handshake/certificate-failure behavior remain
unverified; configuration-level tests alone do not establish those guarantees.

Browser storage remembers public tab locations and recent profile IDs. It does
not restore results, SQL text, or automatically execute queries. SQL history is
session-only by default; opt in to browser persistence inside a query tab. Up to
100 history entries are retained, with credential URLs and common password-setting
statements excluded. SQL can still contain private data; clear history as needed.

The Dashboard and Logs concern the workspace. Destructive command controls,
row editing, import, backup/restore, and migration management remain outside this
UI release; use the existing CLI where appropriate. The older safety plan has not
been completed by this feature, apart from the SQLite opening/recovery fix.

## Tests

```bash
npm install
npm test
```

Use a Node.js runtime with `node:sqlite` support; development verification uses
Node 23.9.0, which emits an experimental SQLite warning. With
`DB_TOOLKIT_TEST_POSTGRES_URL` and `DB_TOOLKIT_TEST_MYSQL_URL` unset, the suite uses
temporary local fixtures and skips its eight live server tests. It does not use
the project's `LOCAL_DATABASE_URL` or `DATABASE_URL` as integration targets.

To run live tests, provision disposable databases and accounts with permission to
create and drop the test objects. These tests write data: PostgreSQL creates and
drops temporary schemas; MySQL creates and drops uniquely named tables in the
selected database. Never supply an existing project or production database.
Set either or both variables explicitly. For example, in PowerShell, replace
these local-only example credentials with those of your disposable servers:

```powershell
$env:DB_TOOLKIT_TEST_POSTGRES_URL = 'postgresql://test_user:change_me@127.0.0.1:5432/toolkit_test?sslmode=disable'
$env:DB_TOOLKIT_TEST_MYSQL_URL = 'mysql://test_user:change_me@127.0.0.1:3306/toolkit_test?sslmode=disable'
node --test test/workspace-integration.test.js
Remove-Item Env:DB_TOOLKIT_TEST_POSTGRES_URL, Env:DB_TOOLKIT_TEST_MYSQL_URL
```

These examples disable TLS for disposable local servers and do not verify TLS.
The live tests cover discovery, bounded/filterable pages, inspection, read-only
rejection, writable routing, duplicate labels, and actual server cancellation,
plus PostgreSQL JSON bounds and composite foreign keys. SQL Server has no live
integration fixture in this suite. A passing local suite with skipped live tests
does not establish server integration or TLS behavior.

## Create env files

Use `create-env` to generate a fresh `.env.example` and matching `db-toolkit.manifest.json` for the selected engine.

```bash
node db.js create-env sqlite
node db.js create-env postgres --database app_database --user postgres --password change_me
node db.js create-env mysql --database app_database --user root --password change_me
node db.js create-env mssql --database app_database --user sa --password change_me
```

Supported flags:

- `--database=<name>`
- `--host=<host>` defaults to `127.0.0.1`
- `--port=<port>`
- `--user=<user>`
- `--password=<password>`

After generating the template on a server:

```bash
cp .env.example .env
node db.js scan
node db.js init
```

## Ubuntu database servers

Installing `psql` or `mysql` only installs client tools. PostgreSQL and MySQL also need server packages running.

PostgreSQL:

```bash
sudo apt-get update && sudo apt-get install -y postgresql postgresql-client
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'change_me';"
node db.js create-env postgres --database app_database --user postgres --password change_me
cp .env.example .env
node db.js init
```

MySQL:

```bash
sudo apt-get update && sudo apt-get install -y mysql-server
sudo systemctl enable --now mysql
node db.js create-env mysql --database app_database --user root --password change_me
cp .env.example .env
node db.js init
```

Some Ubuntu images use MariaDB instead of Oracle MySQL. Do not install MariaDB on top of conflicting `mysql-client` packages unless you intentionally want to switch stacks. On a clean MariaDB setup the service may be named `mariadb`:

```bash
sudo apt-get update && sudo apt-get install -y mariadb-server mariadb-client
sudo systemctl enable --now mariadb
```

If you want a non-root MySQL app user:

```bash
node db.js create-env mysql --database app_database --user devuser --password change_me
cp .env.example .env
node db.js init
```

If MySQL refuses the connection, the CLI asks whether to start a local MySQL-compatible service and tries `mysql`, `mysqld`, and `mariadb`. If none of those units exist, install `mysql-server`. If MySQL rejects the username or password, the CLI asks whether to create or update that user and grant access to the configured database using `sudo mysql`.

For PostgreSQL URLs, prefer `127.0.0.1` over `localhost` when you want TCP host/port behavior.

## Environment

- `DB_ENGINE`
- `DB_NAME`
- `DB_FILE`
- `LOCAL_DATABASE_URL`
- `DATABASE_URL`
- `DB_SCHEMA_FILE`
- `DB_UPDATE_FILE`
- `DB_MIGRATIONS_DIR`
- `DB_SEED_FILE`
- `DB_BACKUP_DIR`
- `DB_TOOLKIT_ASSUME_YES`

## Recovery prompts

When PostgreSQL returns `password authentication failed`, the CLI asks whether it should create or update the role from the local `postgres` admin account. This uses:

```bash
sudo -u postgres psql
```

If your server user cannot run that command, run the printed setup commands manually or adjust PostgreSQL roles yourself.

When MySQL refuses a connection on the configured host and port, the CLI asks whether it should start a local MySQL-compatible service.

When MySQL returns `Access denied`, the CLI asks whether it should create or update that user, create the configured database, and grant privileges using:

```bash
sudo mysql
```

When an operation fails because a required table is missing, the CLI asks whether it should initialize the configured schema before retrying.

## Notes

- `reset`, `drop`, and `restore` ask for confirmation unless `--yes` is set.
- SQLite backups are file copies, so the default backup extension is `.db`.
- PostgreSQL and MySQL backups are SQL dumps.
- The default SQLite database file is `data/toolkit.db`.
- `scan` checks local CLI tools and reports the active engine connection.
- `install` uses the available package manager to show or run selected client installs.
- You can set `LOCAL_DATABASE_URL` or `DATABASE_URL` to configure a database in one line.
- PostgreSQL init and schema operations use `pg`, so `psql` is optional for this toolkit.
- If that URL points to MySQL and the client is missing, the CLI can still generate install commands.
- The toolkit loads `.env`, `.env.local`, and `.ENV` if present.
- PostgreSQL defaults to `schemas/postgres/schema.sql` and `schemas/postgres/update_schema.sql`.
- MySQL defaults to `schemas/mysql/schema.sql` when that engine is active.
- Set `DB_TOOLKIT_EMOJI=true` to enable emoji status markers in output.
- `node db.js set postgres` generates `db-toolkit.manifest.json`.
- `node db.js set postgres --url` uses the loaded `LOCAL_DATABASE_URL` or `DATABASE_URL` value.
- `node db.js create-env postgres` writes a PostgreSQL `.env.example` and updates the manifest.
- `node db.js install postgres` prints the install commands by default.
- Add `--apply` only when you want the CLI to actually run installers.
