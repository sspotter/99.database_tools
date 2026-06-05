import fs from 'node:fs';
import path from 'node:path';
import { formatList, listSqlFiles, resolvePath, timestampTag, writeTextFile } from './utils.js';
import { logInfo, logPlain, logSuccess, logWarn } from './logger.js';
import {
  chooseInstallManager,
  formatInstallHint,
  engineToToolKey,
  getInstalledTool,
  installDatabaseTools,
  printToolScanReport,
  scanDatabaseTools,
  normalizeToolName,
} from './toolchain.js';
import { ubuntuServerHints, writeEnvExample } from './env.js';
import { buildProjectManifest, writeProjectManifest } from './manifest.js';

function resolveMaybePath(baseDir, candidate, fallback) {
  const source = candidate || fallback;
  return source ? resolvePath(baseDir, source) : null;
}

function normalizeEngineName(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'postgress':
    case 'postgresql':
    case 'postgres':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlserver':
    case 'mssql':
      return 'mssql';
    case 'sqlite':
      return 'sqlite';
    default:
      return null;
  }
}

function defaultBackupName(config) {
  const extension = config.engine === 'sqlite' ? '.db' : '.sql';
  const baseName =
    config.engine === 'sqlite'
      ? path.parse(config.sqlite.file).name
      : config.databaseName;
  return `${baseName}-${timestampTag()}${extension}`;
}

async function requireExistingFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function ensureClientReady(config, confirm, options = {}) {
  const toolKey = engineToToolKey(config.engine);
  if (!toolKey || toolKey === 'sqlite') {
    return;
  }

  const installed = getInstalledTool(toolKey);
  if (installed?.installed) {
    return;
  }

  logWarn(`The ${toolKey} client is not installed.`);
  logPlain(`Run \`node db.js scan\` to inspect the available database clients.`);

  const shouldInstall = await confirm(`Install the missing ${toolKey} client now?`);
  if (!shouldInstall) {
    throw new Error(
      `Missing required client: ${toolKey}. Run \`node db.js scan\` or install it first with \`node db.js install ${toolKey}\`.`
    );
  }

  const result = installDatabaseTools([toolKey], {
    manager: options.manager,
    dryRun: false,
    force: false,
  });

  for (const entry of result.results) {
    if (entry.skipped) {
      logWarn(`${entry.tool.label}: ${entry.reason}`);
      continue;
    }
    if (entry.manual) {
      logWarn(`${entry.tool.label}: automatic installation is unavailable in this Node environment.`);
      entry.commands.forEach((command) => {
        logPlain(`  run: ${command}`);
      });
      continue;
    }
    logSuccess(`Installed ${entry.tool.label}`);
  }
}

function isPostgresAuthError(error) {
  return error?.code === '28P01' || /password authentication failed/i.test(error?.message || '');
}

function isMissingTableError(error) {
  const message = String(error?.message || '');
  return (
    error?.code === '42P01' ||
    /relation .* does not exist/i.test(message) ||
    /no such table/i.test(message) ||
    /table .* doesn't exist/i.test(message)
  );
}

function isConnectionRefusedError(error) {
  const message = String(error?.message || '');
  return (
    error?.code === 'ECONNREFUSED' ||
    /ECONNREFUSED/i.test(message) ||
    /can't connect to .*server.*\(111\)/i.test(message) ||
    /can't connect to .*server.*connection refused/i.test(message)
  );
}

function isMysqlAuthError(error) {
  const message = String(error?.message || '');
  return /ERROR 1045/i.test(message) || /access denied for user/i.test(message);
}

async function recoverPostgresAuth(engine, confirm) {
  if (typeof engine.createOrUpdateLoginRole !== 'function') {
    return false;
  }
  const settings = engine.getLoginSettings?.() || {};
  const label = settings.user ? `PostgreSQL user "${settings.user}"` : 'the PostgreSQL user from LOCAL_DATABASE_URL';
  if (!(await confirm(`${label} failed password authentication. Create or update that role from the local postgres admin account?`))) {
    return false;
  }
  const result = engine.createOrUpdateLoginRole();
  logSuccess(`PostgreSQL role ready: ${result.user}`);
  return true;
}

async function recoverMysqlAuth(engine, confirm) {
  if (typeof engine.createOrUpdateLoginRole !== 'function') {
    return false;
  }
  const settings = engine.getLoginSettings?.() || {};
  const label = settings.user
    ? `MySQL user "${settings.user}"`
    : 'No MySQL username/password is configured; create default user "devuser" with password "change_me"';
  if (!(await confirm(`${label} and grant access to "${settings.database}" using sudo mysql?`))) {
    return false;
  }
  const result = engine.createOrUpdateLoginRole();
  logSuccess(`MySQL user ready: ${result.user}@${result.host}`);
  logSuccess(`MySQL database ready: ${result.database}`);
  if (result.usedDefaults) {
    logWarn('Default MySQL credentials were used for this run: devuser/change_me. Save them in .env with `node db.js create-env mysql --user devuser --password change_me`.');
  }
  return true;
}

async function recoverServerConnection(engineName, engine, confirm) {
  if (engineName !== 'mysql' || typeof engine.startServerService !== 'function') {
    return false;
  }
  if (!(await confirm('MySQL refused the connection on the configured host/port. Try starting a local MySQL or MariaDB service now?'))) {
    return false;
  }
  const result = engine.startServerService();
  logSuccess(`Service started: ${result.service}`);
  return true;
}

async function runWithRecovery(action, context, recoveryAction = null, attemptsRemaining = 3) {
  try {
    return await action();
  } catch (error) {
    if (attemptsRemaining <= 0) {
      throw error;
    }

    if (isConnectionRefusedError(error)) {
      const recovered = await recoverServerConnection(context.config.engine, context.engine, context.confirm);
      if (recovered) {
        return runWithRecovery(action, context, recoveryAction, attemptsRemaining - 1);
      }
    }

    if (context.config.engine === 'postgres' && isPostgresAuthError(error)) {
      const recovered = await recoverPostgresAuth(context.engine, context.confirm);
      if (recovered) {
        return runWithRecovery(action, context, recoveryAction, attemptsRemaining - 1);
      }
    }

    if (context.config.engine === 'mysql' && isMysqlAuthError(error)) {
      const recovered = await recoverMysqlAuth(context.engine, context.confirm);
      if (recovered) {
        return runWithRecovery(action, context, recoveryAction, attemptsRemaining - 1);
      }
    }

    if (recoveryAction && isMissingTableError(error)) {
      const shouldRecover = await context.confirm(
        'A required table does not exist. Initialize the database schema now?'
      );
      if (shouldRecover) {
        await recoveryAction();
        return runWithRecovery(action, context, recoveryAction, attemptsRemaining - 1);
      }
    }

    throw error;
  }
}

function printTables(tables) {
  if (!tables.length) {
    logPlain('(no tables found)');
    return;
  }

  tables.forEach((table, index) => {
    logPlain(`${String(index + 1).padStart(2, '0')}. ${table}`);
  });
}

function helpText() {
  return `
Database Toolkit

Usage:
  node db.js <command> [args] [--engine sqlite|postgres|mysql|mssql] [--yes]

Commands:
  create [schema.sql]     Create the database and optionally load a schema file
  init [schema.sql]       Initialize the database using the default schema
  update [schema.sql]     Apply an update SQL file
  reset [schema.sql]      Drop all tables and rebuild the schema
  drop <table>            Drop one table
  tables                  List tables in the current database
  backup [output]         Backup the database
  restore <file>          Restore from a backup file
  health                  Run a quick database health check
  seed [seed.sql]         Apply seed data
  migrate [dir]           Apply pending migration files in order
  scan                    Check CLI tools and active engine connectivity
  install [tool...]       Show or run installs for selected database clients
  set [engine] [--url]    Generate a project manifest for an engine
  create-env [engine]     Write .env.example for sqlite, postgres, mysql, or mssql
  help                    Show this help

Install flags:
  --install               Show install hints for missing tools during scan
  --manager=<apt|dnf|pacman|zypper|winget|choco>
                          Prefer a specific package manager for installs
  --dry-run               Show install commands without executing them
  --apply                 Actually run installer commands

Env flags:
  --database=<name>       Database name for generated env values
  --host=<host>           Database host, defaults to 127.0.0.1
  --port=<port>           Database port
  --user=<user>           Database user
  --password=<password>   Database password placeholder

Aliases:
  create_database, init_db, update_database, reset_db, drop_table,
  detect_tables, health_check, backup_db, restore_db, seed_db

Examples:
  node db.js init
  node db.js update schemas/update_schema.sql
  node db.js reset --yes
  node db.js drop subscriptions --yes
  node db.js tables
  node db.js backup
  node db.js scan
  node db.js scan --install
  node db.js install postgres mysql
  node db.js set postgres
  node db.js set postgres --url
  node db.js create-env postgres --database app_database --user postgres --password change_me
`;
}

export async function runCommand(context) {
  const { command, args, options, config, engine, cwd, confirm } = context;

  switch (command) {
    case 'help':
      logPlain(helpText().trim());
      return;

    case 'create': {
      await ensureClientReady(config, confirm, options);
      const schemaFile = resolveMaybePath(cwd, options.schema || args[0], config.defaults.schemaFile);
      const result = await runWithRecovery(() => engine.createDatabase(), context);
      logSuccess(`Database ready: ${result.database || config.databaseName}`);
      if (schemaFile) {
        await requireExistingFile(schemaFile, 'Schema file');
        await runWithRecovery(() => engine.runSqlFile(schemaFile), context);
        logSuccess(`Schema applied from ${schemaFile}`);
      }
      return;
    }

    case 'init': {
      await ensureClientReady(config, confirm, options);
      const schemaFile = resolveMaybePath(cwd, options.schema || args[0], config.defaults.schemaFile);
      const result = await runWithRecovery(() => engine.createDatabase(), context);
      logSuccess(`Database ready: ${result.database || config.databaseName}`);
      if (schemaFile) {
        await requireExistingFile(schemaFile, 'Schema file');
        await runWithRecovery(() => engine.runSqlFile(schemaFile), context);
        logSuccess(`Initialized from ${schemaFile}`);
      } else {
        logWarn('No schema file was provided, so the database was created without tables.');
      }
      return;
    }

    case 'update': {
      await ensureClientReady(config, confirm, options);
      const updateFile = resolveMaybePath(cwd, options.schema || args[0], config.defaults.updateFile);
      await requireExistingFile(updateFile, 'Update file');
      await runWithRecovery(
        () => engine.runSqlFile(updateFile),
        context,
        () => engine.runSqlFile(config.defaults.schemaFile)
      );
      logSuccess(`Applied update file: ${updateFile}`);
      return;
    }

    case 'reset': {
      await ensureClientReady(config, confirm, options);
      const schemaFile = resolveMaybePath(cwd, options.schema || args[0], config.defaults.schemaFile);
      if (!(await confirm('This will drop tables and rebuild the schema.'))) {
        logWarn('Reset cancelled.');
        return;
      }
      if (schemaFile) {
        await requireExistingFile(schemaFile, 'Schema file');
      }
      await engine.reset(schemaFile);
      logSuccess('Database reset completed.');
      return;
    }

    case 'drop': {
      await ensureClientReady(config, confirm, options);
      const tableName = args[0];
      if (!tableName) {
        throw new Error('Missing table name.');
      }
      if (!(await confirm(`This will drop table "${tableName}".`))) {
        logWarn('Drop cancelled.');
        return;
      }
      await engine.dropTable(tableName);
      logSuccess(`Dropped table: ${tableName}`);
      return;
    }

    case 'tables': {
      await ensureClientReady(config, confirm, options);
      const tables = await runWithRecovery(
        () => engine.listTables(),
        context,
        () => engine.runSqlFile(config.defaults.schemaFile)
      );
      logPlain(formatList(tables));
      return;
    }

    case 'scan': {
      const tools = scanDatabaseTools();
      const manager = chooseInstallManager(options.manager);
      let connectionStatus = null;
      if (config.engine === 'postgres' || config.engine === 'mysql') {
        try {
          await engine.health();
          connectionStatus = { ok: true };
        } catch (error) {
          connectionStatus = {
            ok: false,
            error: error?.code || error?.message || String(error),
          };
        }
      }
      const missing = printToolScanReport(tools, manager, config, connectionStatus);

      if (!missing.length) {
        logSuccess('All requested database clients are already installed.');
        return;
      }

      if (!manager) {
        logWarn('No supported package manager was found, so automatic installation is unavailable.');
        missing.forEach((tool) => {
          for (const managerKey of ['apt', 'dnf', 'pacman', 'zypper', 'winget', 'choco']) {
            logPlain(`  ${tool.key}: ${formatInstallHint(tool, managerKey)}`);
          }
        });
        return;
      }

      logInfo('Run `node db.js install <tool>` to generate install commands for missing clients.');
      missing.forEach((tool) => {
        if (tool.key === 'postgres' && config.engine === 'postgres' && connectionStatus?.ok) {
          logPlain(`  ${tool.key}: optional for this project because PostgreSQL is already reachable via the pg driver.`);
          return;
        }
        logPlain(`  ${tool.key}: ${formatInstallHint(tool, manager)}`);
      });
      return;
    }

    case 'backup': {
      await ensureClientReady(config, confirm, options);
      const outputPath = resolveMaybePath(
        cwd,
        options.output || args[0],
        path.join(config.defaults.backupDir, defaultBackupName(config))
      );
      await engine.backup(outputPath);
      logSuccess(`Backup written to ${outputPath}`);
      return;
    }

    case 'restore': {
      await ensureClientReady(config, confirm, options);
      const inputPath = resolveMaybePath(cwd, options.file || args[0], null);
      if (!inputPath) {
        throw new Error('Missing backup file path.');
      }
      await requireExistingFile(inputPath, 'Backup file');
      if (!(await confirm(`This will restore from "${inputPath}" and overwrite the target database.`))) {
        logWarn('Restore cancelled.');
        return;
      }
      await engine.restore(inputPath);
      logSuccess(`Restore completed from ${inputPath}`);
      return;
    }

    case 'health': {
      await ensureClientReady(config, confirm, options);
      const health = await runWithRecovery(
        () => engine.health(),
        context,
        () => engine.runSqlFile(config.defaults.schemaFile)
      );
      if (health.ok) {
        logSuccess(`Health check passed. Tables: ${health.tables}`);
      } else {
        logWarn(`Health check returned a warning: ${JSON.stringify(health)}`);
      }
      return;
    }

    case 'seed': {
      await ensureClientReady(config, confirm, options);
      const seedFile = resolveMaybePath(cwd, options.seed || args[0], config.defaults.seedFile);
      await requireExistingFile(seedFile, 'Seed file');
      await runWithRecovery(
        () => engine.runSqlFile(seedFile),
        context,
        () => engine.runSqlFile(config.defaults.schemaFile)
      );
      logSuccess(`Seed data applied from ${seedFile}`);
      return;
    }

    case 'migrate': {
      await ensureClientReady(config, confirm, options);
      const migrationDir = resolveMaybePath(cwd, options.dir || args[0], config.defaults.migrationsDir);
      const files = listSqlFiles(migrationDir);
      if (!files.length) {
        logWarn(`No migration files found in ${migrationDir}`);
        return;
      }
      await engine.ensureMigrationsTable?.();
      const applied = new Set((await engine.listAppliedMigrations?.()) ?? []);
      const pending = files.filter((file) => !applied.has(file));
      if (!pending.length) {
        logSuccess('No pending migrations found.');
        return;
      }
      for (const fileName of pending) {
        const filePath = path.join(migrationDir, fileName);
        await engine.runSqlFile(filePath);
        await engine.recordMigration?.(fileName);
        logSuccess(`Applied migration: ${fileName}`);
      }
      return;
    }

    case 'set': {
      const engineName = normalizeToolName(args[0]) || normalizeEngineName(args[0]);
      if (!engineName || !['sqlite', 'postgres', 'mysql', 'mssql'].includes(engineName)) {
        throw new Error('Missing or invalid engine. Use sqlite, postgres, mysql, or mssql.');
      }
      const manifest = buildProjectManifest({
        cwd,
        engine: engineName,
        databaseName: options.database || config.databaseName,
        config: null,
      });
      const filePath = writeProjectManifest(cwd, manifest);
      logSuccess(`Project manifest written to ${filePath}`);
      logInfo(`Active engine set to ${engineName}.`);
      if (typeof options.url === 'string' && options.url.trim()) {
        logPlain('Using connection URL provided via `--url`.');
      } else if (options.url) {
        logPlain(`Using the loaded ${manifest.connectionEnvName} value from your env file.`);
      } else {
        logPlain(`Use ${manifest.connectionEnvName} in your .env file.`);
      }
      return;
    }

    case 'create-env': {
      const engineName = normalizeToolName(args[0]) || normalizeEngineName(args[0]) || config.engine;
      if (!engineName || !['sqlite', 'postgres', 'mysql', 'mssql'].includes(engineName)) {
        throw new Error('Missing or invalid engine. Use sqlite, postgres, mysql, or mssql.');
      }
      const result = writeEnvExample({
        cwd,
        engine: engineName,
        databaseName: options.database || config.databaseName,
        options,
      });
      logSuccess(`Env example written to ${result.filePath}`);
      logSuccess('Project manifest updated for generated env defaults.');
      const hints = ubuntuServerHints(result.engine);
      if (hints.length) {
        logInfo('Ubuntu setup hints:');
        hints.forEach((hint) => logPlain(`  ${hint}`));
      }
      logInfo('Copy .env.example to .env on the server, edit the password, then run `node db.js init`.');
      return;
    }

    case 'rollback':
      throw new Error('Rollback is scaffolded but not implemented yet.');

    case 'install': {
      const requested = args.map((arg) => normalizeToolName(arg)).filter(Boolean);
      const targetNames = requested.length ? requested : ['missing'];
      const tools = scanDatabaseTools();
      const missing = tools.filter((tool) => !tool.installed);
      const selectedTools =
        targetNames.includes('all')
          ? tools
          : targetNames.includes('missing')
            ? missing
            : tools.filter((tool) => requested.includes(tool.key));

      if (!selectedTools.length) {
        logWarn('No matching database clients were selected for installation.');
        return;
      }

      const result = installDatabaseTools(
        selectedTools.map((tool) => tool.key),
        {
          manager: options.manager,
          dryRun: Boolean(options.dryRun),
          apply: Boolean(options.apply),
          force: Boolean(options.force),
        }
      );

      result.results.forEach((entry) => {
        if (entry.skipped) {
          logWarn(`${entry.tool.label}: ${entry.reason}`);
          return;
        }
        if (entry.manual) {
          logWarn(`${entry.tool.label}: automatic installation is disabled by default.`);
          entry.commands.forEach((command) => {
            logPlain(`  run: ${command}`);
          });
          return;
        }
        if (entry.dryRun) {
          logPlain(`Would install ${entry.tool.label}: ${entry.command}`);
          return;
        }
        logSuccess(`Installed ${entry.tool.label}`);
      });
      if (config.engine === 'mysql' && selectedTools.some((tool) => tool.key === 'mysql')) {
        logInfo('For local MySQL databases, the server package must also be installed and running.');
        logPlain('  Ubuntu: sudo apt-get update && sudo apt-get install -y mysql-server');
        logPlain('  Start: sudo systemctl enable --now mysql');
      }
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
