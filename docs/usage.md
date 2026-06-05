# Usage

This toolkit currently ships with a real SQLite implementation, PostgreSQL support through the `pg` driver, and a compatible command structure for MySQL and SQL Server through their command-line clients.

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
