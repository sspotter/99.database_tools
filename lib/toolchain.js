import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logInfo, logPlain, logSuccess, logWarn } from './logger.js';

const TOOL_DEFINITIONS = [
  {
    key: 'sqlite',
    label: 'SQLite CLI',
    executable: 'sqlite3',
    install: {
      apt: 'sqlite3',
      dnf: 'sqlite',
      pacman: 'sqlite',
      zypper: 'sqlite3',
      winget: 'SQLite.SQLite',
      choco: 'sqlite',
    },
  },
  {
    key: 'postgres',
    label: 'PostgreSQL CLI',
    executable: 'psql',
    install: {
      apt: 'postgresql-client',
      dnf: 'postgresql',
      pacman: 'postgresql',
      zypper: 'postgresql',
      winget: 'PostgreSQL.PostgreSQL',
      choco: 'postgresql',
    },
  },
  {
    key: 'mysql',
    label: 'MySQL client',
    executable: 'mysql',
    install: {
      apt: 'default-mysql-client',
      dnf: 'mysql',
      pacman: 'mysql-clients',
      zypper: 'mysql-client',
      winget: 'Oracle.MySQL',
      choco: 'mysql',
    },
  },
];

const PACKAGE_MANAGERS = [
  {
    key: 'apt',
    executable: 'apt-get',
    installArgs: (toolId) => ['install', '-y', toolId],
    hintCommand: (toolId) => `sudo apt-get update && sudo apt-get install -y ${toolId}`,
  },
  {
    key: 'dnf',
    executable: 'dnf',
    installArgs: (toolId) => ['install', '-y', toolId],
    hintCommand: (toolId) => `sudo dnf install -y ${toolId}`,
  },
  {
    key: 'pacman',
    executable: 'pacman',
    installArgs: (toolId) => ['-S', '--needed', '--noconfirm', toolId],
    hintCommand: (toolId) => `sudo pacman -S --needed ${toolId}`,
  },
  {
    key: 'zypper',
    executable: 'zypper',
    installArgs: (toolId) => ['install', '-y', toolId],
    hintCommand: (toolId) => `sudo zypper install -y ${toolId}`,
  },
  {
    key: 'winget',
    executable: 'winget',
    installArgs: (toolId) => [
      'install',
      '--id',
      toolId,
      '-e',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
  },
  {
    key: 'choco',
    executable: 'choco',
    installArgs: (toolId) => ['install', toolId, '-y', '--no-progress'],
  },
];

function pathEntries() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function fileExists(candidatePath) {
  try {
    return Boolean(fs.lstatSync(candidatePath));
  } catch {
    return false;
  }
}

function findExecutableInPath(executable) {
  const candidates =
    process.platform === 'win32'
      ? [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
      : [executable];

  for (const directory of pathEntries()) {
    for (const candidate of candidates) {
      const resolved = path.join(directory, candidate);
      if (fileExists(resolved)) {
        return resolved;
      }
    }
  }

  return null;
}

function installedPackageManagers() {
  return PACKAGE_MANAGERS
    .map((manager) => {
      const path = detectExecutable(manager.executable);
      return path ? { ...manager, path } : null;
    })
    .filter(Boolean);
}

export function canLaunchExternalCommands() {
  const probe = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

export function normalizeToolName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'sqlite3' || value === 'sqlite') {
    return 'sqlite';
  }
  if (value === 'postgresql' || value === 'postgres' || value === 'psql') {
    return 'postgres';
  }
  if (value === 'mysql') {
    return 'mysql';
  }
  if (value === 'all' || value === 'missing') {
    return value;
  }
  return null;
}

export function engineToToolKey(engine) {
  const normalized = String(engine || '').toLowerCase();
  if (normalized === 'mysql') {
    return normalized;
  }
  return null;
}

export function detectExecutable(executable) {
  return findExecutableInPath(executable);
}

export function detectPackageManager(preferredManager) {
  const preferred = String(preferredManager || '').trim().toLowerCase();
  if (preferred) {
    const forced = PACKAGE_MANAGERS.find((manager) => manager.key === preferred);
    if (forced) {
      const path = detectExecutable(forced.executable);
      if (path) {
        return { ...forced, path };
      }
    }
    return null;
  }

  for (const manager of PACKAGE_MANAGERS) {
    const path = detectExecutable(manager.executable);
    if (path) {
      return { ...manager, path };
    }
  }

  return null;
}

export function detectPackageManagers(preferredManager) {
  const preferred = detectPackageManager(preferredManager);
  const installed = installedPackageManagers();
  if (!preferred) {
    return installed;
  }

  return [
    preferred,
    ...installed.filter((manager) => manager.key !== preferred.key),
  ];
}

export function scanDatabaseTools() {
  return TOOL_DEFINITIONS.map((tool) => {
    const path = detectExecutable(tool.executable);
    return {
      ...tool,
      installed: Boolean(path),
      path,
    };
  });
}

export function getInstalledTool(toolKey) {
  const normalized = normalizeToolName(toolKey);
  if (!normalized || normalized === 'all' || normalized === 'missing') {
    return null;
  }
  return scanDatabaseTools().find((tool) => tool.key === normalized) || null;
}

export function getToolByName(name) {
  const normalized = normalizeToolName(name);
  if (!normalized || normalized === 'all' || normalized === 'missing') {
    return null;
  }
  return TOOL_DEFINITIONS.find((tool) => tool.key === normalized) || null;
}

export function resolveInstallCommand(tool, managerKey) {
  const managerId = String(managerKey || '').trim().toLowerCase();
  if (!managerId) {
    return null;
  }
  const toolId = tool.install[managerId];
  if (!toolId) {
    return null;
  }
  const manager = PACKAGE_MANAGERS.find((entry) => entry.key === managerId);
  if (!manager) {
    return null;
  }
  const args = manager.installArgs(toolId);
  return {
    manager: manager.key,
    executable: manager.executable,
    args,
    hint: manager.hintCommand?.(toolId) || `${manager.executable} ${args.join(' ')}`,
    toolId,
  };
}

export function chooseInstallManager(preferredManager) {
  const resolved = detectPackageManager(preferredManager);
  return resolved ? resolved.key : null;
}

export function formatInstallHint(tool, managerKey) {
  const command = resolveInstallCommand(tool, managerKey);
  if (!command) {
    return `No install command available for ${tool.label}.`;
  }

  return command.hint;
}

export function formatManualInstallHints(tool) {
  return Object.entries(tool.install)
    .map(([managerKey]) => formatInstallHint(tool, managerKey))
    .filter(Boolean);
}

export function printToolScanReport(tools, managerKey, config = null, connectionStatus = null) {
  const missing = [];
  logPlain('Tool scan results:');
  if (config?.engine === 'postgres') {
    if (connectionStatus?.ok) {
      logSuccess(
        `- PostgreSQL engine: connected via pg driver (${config.postgres.host}:${config.postgres.port}/${config.postgres.database})`
      );
    } else if (connectionStatus?.error) {
      logWarn(`- PostgreSQL engine: connection failed (${connectionStatus.error})`);
    } else if (config.postgres?.connectionString) {
      logInfo(
        `- PostgreSQL engine: configured for pg driver (${config.postgres.host}:${config.postgres.port}/${config.postgres.database})`
      );
    } else {
      logWarn('- PostgreSQL engine: selected, but no LOCAL_DATABASE_URL or DATABASE_URL was found.');
    }
  }
  if (config?.engine === 'mysql') {
    if (connectionStatus?.ok) {
      logSuccess(
        `- MySQL engine: connected via mysql client (${config.mysql.host}:${config.mysql.port}/${config.mysql.database})`
      );
    } else if (connectionStatus?.error) {
      logWarn(`- MySQL engine: connection failed (${connectionStatus.error})`);
    } else {
      logInfo(
        `- MySQL engine: configured for mysql client (${config.mysql.host}:${config.mysql.port}/${config.mysql.database})`
      );
    }
  }
  for (const tool of tools) {
    if (tool.key === 'postgres' && config?.engine === 'postgres') {
      if (tool.installed) {
        logSuccess(`- ${tool.label}: found at ${tool.path}`);
      } else {
        logInfo(`- ${tool.label}: not installed (optional; this project uses the pg driver)`);
      }
      continue;
    }

    if (tool.installed) {
      logSuccess(`- ${tool.label}: found at ${tool.path}`);
      continue;
    }
    missing.push(tool);
    logWarn(`- ${tool.label}: missing`);
    if (managerKey) {
      logPlain(`  install: ${formatInstallHint(tool, managerKey)}`);
    }
  }
  return missing;
}

export function installDatabaseTools(targetNames, options = {}) {
  const normalizedTargets = (Array.isArray(targetNames) ? targetNames : [targetNames])
    .map((name) => normalizeToolName(name))
    .filter(Boolean);

  const selected =
    normalizedTargets.includes('all') || !normalizedTargets.length
      ? TOOL_DEFINITIONS
      : TOOL_DEFINITIONS.filter((tool) => normalizedTargets.includes(tool.key));

  const managers = detectPackageManagers(options.manager);
  if (!managers.length) {
    throw new Error('No supported package manager found. Install winget or Chocolatey first.');
  }

  if (!options.apply) {
    return {
      manager: managers[0].key,
      results: selected.map((tool) => ({
        tool,
        skipped: false,
        manual: true,
        commands: formatManualInstallHints(tool),
      })),
    };
  }

  const results = [];
  for (const tool of selected) {
    if (tool.installed && !options.force) {
      results.push({
        tool,
        skipped: true,
        reason: `Already installed at ${tool.path}`,
      });
      continue;
    }

    if (options.dryRun) {
      const installCommand = resolveInstallCommand(tool, managers[0].key);
      results.push({
        tool,
        skipped: false,
        dryRun: true,
        command: installCommand
          ? `${installCommand.executable} ${installCommand.args.join(' ')}`
          : `No install command available`,
      });
      continue;
    }

    let lastError = null;
    let installed = false;
    for (const manager of managers) {
      const installCommand = resolveInstallCommand(tool, manager.key);
      if (!installCommand) {
        continue;
      }

      const result = spawnSync(manager.path, installCommand.args, {
        encoding: 'utf8',
        stdio: 'inherit',
      });

      if (!result.error && result.status === 0) {
        results.push({
          tool,
          skipped: false,
          installed: true,
          manager: manager.key,
        });
        installed = true;
        break;
      }

      const message = result.error?.message || `Installer exited with code ${result.status}`;
      lastError = `${manager.key}: ${message}`;
    }

    if (!installed) {
      throw new Error(`${tool.label} install failed: ${lastError || 'no compatible installer was available'}`);
    }
  }

  return {
    manager: managers[0].key,
    results,
  };
}
