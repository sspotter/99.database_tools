# Local database workspace

Status: first release implemented on `mega-branch`. The user accepted the recommended defaults and authorized parallel implementation. Final local verification completed on 2026-10-21; SQL Server live integration and TLS handshakes remain unverified.

## Intent and confirmed decisions

Build on `mega-branch` in this repository. The user wants a mainly local UI that remembers multiple database connections, displays their accessible databases and tables, and makes switching between projects and configurations quick.

Keep the existing Node.js ES modules, engine adapters, CLI, local HTTP server, and vanilla HTML/CSS/JavaScript UI. This stack choice and the staged delivery below are proposed implementation decisions, not additional user requirements.

PostgreSQL, MySQL, SQLite, and SQL Server are connection types. DBeaver and psql are clients of those databases, not separate engine types. Importing DBeaver profiles is a later feature.

## Scope

The complete first release provides saved profiles, credential persistence on Windows, a searchable connection list, independent connection contexts, accessible database/schema discovery, a paginated table browser, schema inspection, and basic SQL tabs with history and cancellation. Deliver it in the milestones below; identify partial engine support honestly throughout.

The application remains a single-operator local tool bound to `127.0.0.1`, with its existing authenticated API entry mechanism. It can connect to remote database servers. No hosted login system, accounts, roles, or team sharing are included.

## Existing foundation and prerequisite work

The current dashboard selects one configuration through `loadDatabaseConfig`. Both status and row requests reconstruct that configuration. UI commands can override the URL, but there is no saved-profile registry or consistent target context across requests.

SQLite and PostgreSQL have direct adapters. MySQL and SQL Server currently run command-line clients, and their row preview explicitly reports unsupported. SQLite currently opens with journaling and synchronous writes disabled and removes recovery sidecars.

The October 17 plan at `docs/superpowers/plans/2026-10-17-database-toolkit-improvements.md` is an unexecuted safety plan, not evidence of completed fixes. Implement and verify its SQLite durability prerequisites before opening existing SQLite databases through the new workspace. Do not expose new restore, reset, migration, or data-editing flows until the relevant safety tasks in that plan pass. Read-only exploration must not create migration tables as a status side effect.

## Connection profiles

A profile has an immutable ID, display name, engine, connection settings, environment label, optional project group, favorite flag, and connection-specific options. Names need not be unique; IDs are authoritative.

Users can add a profile by URL or by host/port/database/user/password fields. SQLite uses a file picker/path rather than server credentials. Parse server-side, validate supported protocols and options, and preserve supported SSL settings without silently weakening certificate verification. Never create a missing SQLite file simply because the user clicked Test Connection.

Actions: test without saving, save, connect, disconnect, rename, duplicate, edit, favorite, and delete. Failed connection tests preserve entered values and show a sanitized actionable error. Saving does not require a reachable server. Duplication requires explicitly choosing whether to reuse credentials.

Store profile metadata outside the repository in the current user's application-data directory. Do not rewrite `.env` or the project manifest when switching UI connections. Import the currently configured connection only through an explicit Add Current Configuration action. Avoid connecting automatically on startup.

Connection-specific settings include SSL, connection/query timeouts, default database/schema, and the read-only preference. Operations paths belong to the selected profile/project context and must not silently inherit another project's migration or seed files. SSH tunnels are deferred.

## Credentials and local access

On Windows, use user-scoped DPAPI protection for persisted secrets, accessed only by the backend. Persist encrypted secrets separately from display metadata; do not put credentials in browser storage, responses, URLs after profile submission, logs, history, or exports. Redact driver errors and URL-shaped strings at output boundaries. Do not invent an application-wide plaintext encryption key.

For other operating systems, the initial implementation may offer session-only credentials and environment-variable references until a supported OS credential-store integration exists. Make this limitation visible; never silently persist plaintext. The initial delivery target is this Windows machine.

Editing a profile displays masked credentials and allows keeping, replacing, or clearing them without returning the stored secret. An unavailable/unreadable secret requires re-entry and must not delete the profile. Profile export excludes secrets. Disconnect closes sessions and clears session-only credentials; forgetting a saved password is a separate explicit action.

Remembering a password enables reconnection; it does not guarantee an indefinitely valid database session. No extra application account login is needed for this local design.

## Target identity and lifecycle

Each API operation carries an explicit profile ID and selected database/schema when applicable. Each table or SQL tab retains its own immutable target snapshot. Selecting another connection changes navigation; it never retargets an existing tab.

Profile edits advance a revision. Existing tabs are marked stale and require reopening or an explicit reconnect to the revised profile before execution. Profile deletion disconnects sessions and disables affected tabs. In-flight results retain their original target label and cannot replace results belonging to a newer selection.

Do not mutate `process.env` or use one process-wide active connection for UI requests. Resolve settings per request/session. Bound connection resources, apply idle cleanup, and close resources on disconnect/shutdown. A failed endpoint must not block unrelated profiles.

## Explorer and table browser

The left sidebar contains search, groups/favorites, recent profiles, and connection status. Expand a connected profile into databases, schemas where applicable, and tables/views. Lazy-load branches and provide per-branch refresh. SQLite exposes its selected file and objects without pretending to support server-wide database discovery.

Discovery reflects the connected account's permissions. A denied database is an unavailable branch, not evidence that the connection failed. PostgreSQL requires reconnecting to another database on the same server; adapter behavior must accommodate that without changing profile credentials. Distinguish empty results from permission and network errors.

Opening an object creates a table tab labeled with connection, database, schema, and object. Browse pages with a bounded page size, parameterized filters, sorting through validated column identifiers, visible NULL values, and explicit handling of large values. Never fetch the entire table to paginate in the browser. Counts are optional/on demand because exact counts can be expensive.

Prefer stable ordering by an available unique key. For objects without one, explain that pages can shift as data changes. Show column types, defaults, nullability, keys, indexes, and view/table definitions in an inspector. Export the loaded result/page first; whole-table streaming export is deferred.

## SQL workspace and read-only behavior

Provide multiple query tabs, explicit target labels, Run/Cancel, bounded results, execution time, errors, and local history. History is attached to a profile/database and user-clearable. Never include connection secrets. SQL text can contain sensitive data: retain it for the current session by default and make cross-restart history opt-in.

Start with one statement per execution. Do not claim cross-request transactions; transaction editing, multi-statement scripts, autocomplete, and saved-query organization are subsequent enhancements. Query cancellation must cancel or terminate the actual server operation through the adapter, not only stop rendering results. Do not automatically retry statements after a lost connection.

Use read-only database credentials where possible. A profile's read-only mode must be enforced by an engine-supported connection/session mechanism; SQL keyword checks and disabled buttons are insufficient. If an engine cannot enforce the requested read-only mode, disable arbitrary query execution and explain what credential/setup is required. Arbitrary SQL can call server functions, so the UI must not describe read-only mode as a complete sandbox.

Writes require explicitly enabling them for that profile and a persistent visible writable badge. Destructive management commands remain outside the first release's SQL workflow until their safety work is complete. The ordinary query editor must still clearly warn that enabling writes permits changes through SQL.

## UI structure and behavior

Expand the current visual identity rather than replace it. Use a persistent connection sidebar, a compact target breadcrumb, and a tabbed workspace. Keep existing dashboard/logs available. Connection creation/editing uses one focused form with URL and field entry modes; a separate operations view holds existing commands.

Production labels remain visible in tab titles and the target header. Use text as well as color. Provide keyboard-accessible navigation, visible focus, labeled fields, password visibility controls, and a resizable/scrollable result area. On narrow screens, collapse the sidebar behind a labeled control without hiding the active target.

Required states: first run with no saved connections, disconnected, connecting, connected, invalid credentials, certificate failure, insufficient privileges, expired/lost connection, empty database/table, unsupported capability, query running/cancelled/failed, and stale/deleted profile. Never replace an error with an empty success state.

## Delivery milestones

1. **Connection foundation:** address SQLite durability prerequisites; add profile storage, Windows secret protection, credential redaction, connection testing, capability reporting, and explicit per-request targeting. Add Connections UI and switch existing PostgreSQL/SQLite browsing to selected profiles. MySQL/SQL Server profiles can be saved/tested only to the extent their real capabilities support; label gaps.
2. **Multi-engine browsing:** add direct MySQL and SQL Server drivers, database/schema discovery, schema-qualified object identities, paginated browsing, filters/sorting, and the schema inspector across supported engines. Keep native CLI tools only for operations that need them.
3. **SQL workspace:** add independent tabs, bounded results, cancellation, enforced read-only behavior, and session history. Enable each engine only after its behavior is verified.
4. **Later management:** complete applicable earlier safety tasks, then add row editing with a pending-change preview, imports, safer backups/restores, migration management, and schema changes. Cross-database comparisons, ER diagrams, SSH, DBeaver imports, and AI-generated SQL remain outside the first release.

## Verification and acceptance

Use disposable SQLite files and explicitly selected disposable server databases. Do not inspect, mutate, migrate, or restore the configured real project database during development verification. Never include real credentials in fixtures or screenshots.

Required evidence includes profile persistence without plaintext secrets; incorrect/missing secrets; independent simultaneous profiles; delayed results after switching; revision/deletion handling; correct database/schema routing with duplicate table names; permission and SSL failures; bounded data loading; real query cancellation; and keyboard/desktop/narrow-screen UI checks. Use focused automated tests for backend guarantees and browser verification for user flows.

Run the existing test suite before implementation and after relevant changes. Report integration checks unavailable without disposable servers rather than claiming full engine support from unit tests. No implementation milestone is complete until its actual capabilities, limitations, and setup are documented.

## Decisions left to implementation

Choose maintained driver versions after inspecting current official documentation. Choose the smallest testable DPAPI bridge that avoids credentials in process arguments or shell interpolation. Choose bounded resource/page/time limits and the metadata file schema. Reuse current helpers where safe; add modules only for responsibilities that need separation. Dependency changes, migration of profile metadata, and any limitation discovered during implementation must be recorded with the relevant milestone.
