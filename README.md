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
```

## Example workflow

```bash
node db.js init
node db.js update schemas/update_schema.sql
node db.js migrate
node db.js backup
```

## Configuration

Copy `.env.example` to `.env` and adjust the values for your environment.

The default SQLite file is `data/toolkit.db`.

You can also configure a database with one URL instead of separate host/user/password fields:

```env
LOCAL_DATABASE_URL=postgresql://devuser:%26Pf56ngsrkk@localhost:5432/gdfsg
```

`DATABASE_URL` is also supported as a fallback.

## Design choices

- One CLI entry point instead of many one-off scripts.
- Safe destructive operations with confirmation prompts.
- Versioned SQL files for schema changes and migrations.
- Minimal dependencies so the toolkit can run on server hosts with just Node.js.
- `scan` checks local CLI tools and reports whether the active engine is already connected.
- `install` can use `winget` or `choco` to show install commands for selected database clients.
- If `LOCAL_DATABASE_URL` points to PostgreSQL, the CLI uses `pg` directly and `psql` is optional.
- If `LOCAL_DATABASE_URL` points to MySQL and the client is missing, the CLI can still show install commands.
- PostgreSQL uses `schemas/postgres/schema.sql` and `schemas/postgres/update_schema.sql` by default.
- Set `DB_TOOLKIT_EMOJI=true` to enable emoji status markers in terminal output.
- If automatic installer launches are blocked, the CLI prints copy-paste install commands instead.
- Use `node db.js set postgres` to generate `db-toolkit.manifest.json` for the selected engine.
- Use `node db.js set postgres --url` to reuse the `LOCAL_DATABASE_URL` or `DATABASE_URL` already loaded from your env file.
- Use `node db.js install postgres --apply` only from a shell that is allowed to modify the machine.
