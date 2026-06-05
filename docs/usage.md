# Usage

This toolkit currently ships with a real SQLite implementation, PostgreSQL support through the `pg` driver, and a compatible command structure for MySQL and SQL Server through their command-line clients.

## Quick start

```bash
node db.js init
node db.js tables
node db.js health
node db.js scan
node db.js install sqlite postgres mysql
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
- Set `DB_TOOLKIT_EMOJI=true` to enable emoji status markers in output.
- `node db.js set postgres` generates `db-toolkit.manifest.json`.
- `node db.js set postgres --url` uses the loaded `LOCAL_DATABASE_URL` or `DATABASE_URL` value.
- `node db.js install postgres` prints the install commands by default.
- Add `--apply` only when you want the CLI to actually run installers.
