#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadDatabaseConfig } from './config/database.js';
import { createEngine } from './lib/engines/index.js';
import { runCommand } from './lib/commands.js';
import { logError } from './lib/logger.js';

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(cwd) {
  const candidates = ['.env', '.env.local', '.ENV'];
  for (const candidate of candidates) {
    const envPath = path.join(cwd, candidate);
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const fileValues = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(fileValues)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    if (token === '--yes' || token === '-y') {
      options.yes = true;
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    if (token === '--install' || token === '-i') {
      options.install = true;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--apply') {
      options.apply = true;
      continue;
    }
    if (token === '--url') {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || nextValue.startsWith('-')) {
        options.url = true;
      } else {
        options.url = nextValue;
        index += 1;
      }
      continue;
    }

    const [flag, inlineValue] = token.split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    const readValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      if (nextValue === undefined || nextValue.startsWith('-')) {
        throw new Error(`Missing value for ${flag}`);
      }
      index += 1;
      return nextValue;
    };

    switch (flag) {
      case '--engine':
      case '--schema':
      case '--output':
      case '--dir':
      case '--database':
      case '--file':
      case '--seed':
      case '--manager':
      case '--host':
      case '--port':
      case '--user':
      case '--password':
      case '--url':
        options[flag.slice(2)] = readValue();
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { options, positionals };
}

function resolveCommand(name = 'help') {
  const aliases = {
    create_database: 'create',
    init_db: 'init',
    update_database: 'update',
    reset_db: 'reset',
    drop_table: 'drop',
    detect_tables: 'tables',
    scan: 'scan',
    health_check: 'health',
    backup_db: 'backup',
    restore_db: 'restore',
    install_db_tools: 'install',
    seed_db: 'seed',
    set_db: 'set',
    create_env: 'create-env',
    env: 'create-env',
    migrate: 'migrate',
  };
  return aliases[name] ?? name;
}

async function confirmDestructiveAction(message, force) {
  if (force || process.env.DB_TOOLKIT_ASSUME_YES === 'true') {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(cwd);

  const { options, positionals } = parseArgs(process.argv.slice(2));
  const command = resolveCommand(positionals[0] ?? 'help');
  const commandArgs = positionals.slice(1);

  const effectiveEnv = { ...process.env };
  if (typeof options.url === 'string' && options.url.trim()) {
    effectiveEnv.LOCAL_DATABASE_URL = options.url.trim();
  }

  const config = loadDatabaseConfig(effectiveEnv, cwd, options.engine);
  const engine = createEngine(config);

  const context = {
    cwd,
    command,
    args: commandArgs,
    options,
    config,
    engine,
    confirm: (message) => confirmDestructiveAction(message, Boolean(options.yes)),
  };

  await runCommand(context);
}

main().catch((error) => {
  logError(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
