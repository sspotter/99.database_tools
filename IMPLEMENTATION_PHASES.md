# Implementation Phases

This document lays out the next steps for making `db-toolkit` safe and repeatable across different machines.

## Phase 1: Project Manifest

Goal:
- Generate a project manifest that records which database engine the project uses.

Command:
```bash
node db.js set postgres
```

Outputs:
- `db-toolkit.manifest.json`

What it stores:
- active engine
- preferred environment variable
- schema file paths
- update file paths
- migrations folder
- seed file
- backup folder

Why:
- Keeps the project portable.
- Lets the toolkit know which engine to use on any machine.

## Phase 2: Safe Install Mode

Goal:
- Prevent unexpected machine changes during setup.

Behavior:
- `node db.js install postgres` shows the install commands by default.
- `node db.js install postgres --apply` actually runs installers.

Why:
- Some machines cannot run installers.
- Some environments do not have admin rights.
- We want the toolkit to be safe by default.

## Phase 3: Driver Strategy

Goal:
- Use the right connection method for each engine.

Current plan:
- SQLite: built-in Node support.
- PostgreSQL: `pg` driver.
- MySQL: optional CLI or driver path later.
- SQL Server: optional CLI or driver path later.

Why:
- Different machines have different tool availability.
- The toolkit should still work even when a CLI is missing.

## Phase 4: Machine Validation

Goal:
- Verify the toolkit works on multiple machines without manual cleanup.

Checks:
- `node db.js help`
- `node db.js set postgres`
- `node db.js init`
- `node db.js tables`
- `node db.js scan`
- `node db.js install postgres`
- `node db.js install postgres --apply`

Why:
- Confirms the manifest path is stable.
- Confirms installs are safe.
- Confirms the project uses the correct engine for the selected environment.
