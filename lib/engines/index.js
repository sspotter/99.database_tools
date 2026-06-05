import { SqliteEngine } from './sqlite.js';
import { PostgresEngine } from './postgres.js';
import { ExternalCliEngine } from './external.js';

export function createEngine(config) {
  if (config.engine === 'sqlite') {
    return new SqliteEngine(config);
  }

  if (config.engine === 'postgres') {
    return new PostgresEngine(config);
  }

  if (['mysql', 'mssql'].includes(config.engine)) {
    return new ExternalCliEngine(config);
  }

  throw new Error(`Unsupported engine: ${config.engine}`);
}
