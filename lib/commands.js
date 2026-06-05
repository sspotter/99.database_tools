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
  help                    Show this help

Install flags:
  --install               Show install hints for missing tools during scan
  --manager=<winget|choco>
                          Prefer a specific package manager for installs
  --dry-run               Show install commands without executing them
  --apply                 Actually run installer commands

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
      const result = await engine.createDatabase();
      logSuccess(`Database ready: ${result.database || config.databaseName}`);
      if (schemaFile) {
        await requireExistingFile(schemaFile, 'Schema file');
        await engine.runSqlFile(schemaFile);
        logSuccess(`Schema applied from ${schemaFile}`);
      }
      return;
    }

    case 'init': {
      await ensureClientReady(config, confirm, options);
      const schemaFile = resolveMaybePath(cwd, options.schema || args[0], config.defaults.schemaFile);
      const result = await engine.createDatabase();
      logSuccess(`Database ready: ${result.database || config.databaseName}`);
      if (schemaFile) {
        await requireExistingFile(schemaFile, 'Schema file');
        await engine.runSqlFile(schemaFile);
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
      await engine.runSqlFile(updateFile);
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
      const tables = await engine.listTables();
      logPlain(formatList(tables));
      return;
    }

    case 'scan': {
      const tools = scanDatabaseTools();
      const manager = chooseInstallManager(options.manager);
      const missing = printToolScanReport(tools, manager, config);

      if (!missing.length) {
        logSuccess('All requested database clients are already installed.');
        return;
      }

      if (!manager) {
        logWarn('No supported package manager was found, so automatic installation is unavailable.');
        missing.forEach((tool) => {
          logPlain(`  ${tool.key}: ${formatInstallHint(tool, 'winget')}`);
          logPlain(`  ${tool.key}: ${formatInstallHint(tool, 'choco')}`);
        });
        return;
      }

      logInfo('Run `node db.js install <tool>` to generate install commands for missing clients.');
      missing.forEach((tool) => {
        if (tool.key === 'postgres' && config.engine === 'postgres') {
          logPlain(`  ${tool.key}: optional for this project because PostgreSQL is already reachable via the pg driver.`);
          return;
        }
        logPlain(`  ${tool.key}: ${formatInstallHint(tool, 'winget')}`);
        logPlain(`  ${tool.key}: ${formatInstallHint(tool, 'choco')}`);
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
      const health = await engine.health();
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
      await engine.runSqlFile(seedFile);
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
        databaseName: config.databaseName,
        config: {
          ...config,
          engine: engineName,
        },
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
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
