# Database Toolkit

Single-entry database operations CLI for development, staging, and production workflows.

## What works now

- SQLite support is fully implemented using Node's built-in `node:sqlite`.
- PostgreSQL uses the `pg` driver directly, so `init` works from `LOCAL_DATABASE_URL` without `psql`.
- MySQL and SQL Server are scaffolded through their native CLI tools.
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

Start a local dashboard for running commands from the browser:

```bash
node db.js ui            # default port 4321
node db.js ui --port 8080
```

The command prints a URL that includes a one-time access token, for example
`http://127.0.0.1:4321/?token=<token>`. Open that URL — requests without the
token are rejected.

The dashboard shows the active engine, connection status, applied/pending
migrations, and detected clients. From it you can:

- **View tables** in the active database and **drop** any table with a
  per-table confirm prompt.
- **Browse table contents** in the **Table View** tab — pick a table (or click a
  table name on the Dashboard), choose a row limit, and load the rows. Row
  preview is available for SQLite and PostgreSQL.
- **Run** the same commands as the CLI (init, migrate, seed, backup, reset, …),
  with destructive actions gated behind a confirmation modal.
- **See output anywhere** — every command pops a colored toast (click it to jump
  to Logs); the Logs tab keeps the full stream and the Errors tab collects
  failures.

It is a **localhost-only development tool** bound to `127.0.0.1` — do not expose
the port. The `ui`/`serve` commands cannot be triggered from the browser itself.

## Configuration

Copy `.env.example` to `.env` and adjust the values for your environment.

The default SQLite file is `data/toolkit.db`.

You can also configure a database with one URL instead of separate host/user/password fields:

```env
LOCAL_DATABASE_URL=postgresql://devuser:%26Pf56ngsrkk@localhost:5432/gdfsg
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
- Safe destructive operations with confirmation prompts.
- Versioned SQL files for schema changes and migrations.
- Minimal dependencies so the toolkit can run on server hosts with just Node.js.
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
