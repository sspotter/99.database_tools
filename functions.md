# Functions

This file is the quick terminal reference for `db-toolkit`.

Each entry includes:
- the command to run
- what it does
- the expected outcome or output shape

## All Commands

```bash
node db.js help
node db.js init
node db.js create
node db.js update schemas/update_schema.sql
node db.js reset
node db.js drop subscriptions
node db.js tables
node db.js scan
node db.js install postgres mysql
node db.js install postgres --apply
node db.js migrate
node db.js backup
node db.js restore backups/example.db
node db.js health
node db.js seed
node db.js set postgres
node db.js set postgres --url
```

## Help

```bash
node db.js help
```

What it does:
- Shows the full list of supported commands and flags.

Expected output:
- A usage summary.
- The available commands.
- The install and scan flags.

## Initialize Database

```bash
node db.js init
```

What it does:
- Creates the target database if needed.
- Applies the default schema file.
- For PostgreSQL URLs, it uses `LOCAL_DATABASE_URL` or `DATABASE_URL`.

Expected output:
- `Database ready: ...`
- `Initialized from ...`
- If a required client is missing, a warning and install prompt.

## List Tables

```bash
node db.js tables
```

What it does:
- Prints the current tables in the active database.

Expected output:
- One table name per line.
- Example:

```text
- schema_migrations
- subscriptions
```

## Scan Database Clients

```bash
node db.js scan
```

What it does:
- Checks local CLI tools and reports whether the active database engine is connected.
- Shows install hints when a client is missing.

Expected output:
- A scan report.
- `found` for installed clients.
- `missing` for unavailable clients.
- `PostgreSQL engine: connected via pg driver` when the project uses `LOCAL_DATABASE_URL`.

Example:

```text
Tool scan results:
- PostgreSQL engine: connected via pg driver (localhost:5432/gdfsg)
- SQLite CLI: found at C:\path\to\sqlite3.exe
- PostgreSQL CLI: not installed (optional; this project uses the pg driver)
- MySQL client: missing
```

## Install Clients

```bash
node db.js install postgres mysql
```

What it does:
- Shows selected database client install commands by default.
- Use `--apply` to actually run the installers.

Expected output:
- Copy-paste commands like `winget install --id ...` / `choco install ...`.
- With `--apply`, success messages for installed tools.

## Set Project

```bash
node db.js set postgres
node db.js set postgres --url
```

What it does:
- Generates `db-toolkit.manifest.json` for the selected engine.
- Sets the active engine and environment reference for the project.
- Uses the loaded `LOCAL_DATABASE_URL` or `DATABASE_URL` when `--url` is provided.

Expected output:
- `Project manifest written to ...`
- `Active engine set to postgres.`

## Update Schema

```bash
node db.js update schemas/update_schema.sql
```

What it does:
- Applies a schema update file to the active database.

Expected output:
- `Applied update file: ...`

## Apply Migrations

```bash
node db.js migrate
```

What it does:
- Scans the migrations folder.
- Applies pending `.sql` files in filename order.
- Records each migration in `schema_migrations`.

Expected output:
- `Applied migration: 001_initial_schema.sql`
- Or `No pending migrations found.`

## Backup Database

```bash
node db.js backup
```

What it does:
- Creates a backup file in the configured backup directory.

Expected output:
- `Backup written to ...`

## Restore Backup

```bash
node db.js restore backups/example.db
```

What it does:
- Restores a database from a backup file.

Expected output:
- `Restore completed from ...`

## Reset Database

```bash
node db.js reset --yes
```

What it does:
- Drops existing tables.
- Recreates the schema from the configured schema file.

Expected output:
- `Database reset completed.`

## Drop Table

```bash
node db.js drop subscriptions --yes
```

What it does:
- Drops the named table after confirmation.

Expected output:
- `Dropped table: subscriptions`

## Health Check

```bash
node db.js health
```

What it does:
- Runs a quick database health check.

Expected output:
- `Health check passed. Tables: ...`

## Seed Data

```bash
node db.js seed
```

What it does:
- Loads the default seed SQL file.

Expected output:
- `Seed data applied from ...`

## Environment URL

```env
LOCAL_DATABASE_URL=postgresql://devuser:%26Pf56ngsrkk@localhost:5432/gdfsg
```

What it does:
- Configures the toolkit from one URL instead of separate host/user/password fields.

Expected output:
- The toolkit parses:
  - host
  - port
  - user
  - password
  - database

## Emoji Output

```env
DB_TOOLKIT_EMOJI=true
```

What it does:
- Enables emoji prefixes in terminal output for easier scanning.

Expected output:
- `✅` for success
- `⚠️` for warnings
- `❌` for errors
- `ℹ️` for info

## Notes

- PostgreSQL uses `schemas/postgres/schema.sql` and `schemas/postgres/update_schema.sql` by default.
- The toolkit loads `.env`, `.env.local`, and `.ENV` if present.
- If automatic installers are unavailable, the CLI prints manual install commands instead of failing silently.
