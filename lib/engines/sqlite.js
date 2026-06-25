import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDirSync, exists, readTextFile, quoteIdentifier } from '../utils.js';

function removeSidecarFiles(databasePath) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecarPath)) {
      try {
        fs.rmSync(sidecarPath, { force: true });
      } catch {
        // Best-effort cleanup only. Some filesystem combinations lock sidecar files.
      }
    }
  }
}

export class SqliteEngine {
  constructor(config) {
    this.config = config;
    this.databasePath = config.sqlite.file;
    this.db = null;
  }

  open() {
    if (!this.db) {
      ensureDirSync(path.dirname(this.databasePath));
      removeSidecarFiles(this.databasePath);
      this.db = new DatabaseSync(this.databasePath);
      this.db.exec(`
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA temp_store = MEMORY;
        PRAGMA foreign_keys = ON;
      `);
    }
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  ensureDatabaseFile() {
    const didExist = exists(this.databasePath);
    this.open();
    return { database: this.databasePath, created: !didExist };
  }

  createDatabase() {
    return this.ensureDatabaseFile();
  }

  runSql(sqlText) {
    const db = this.open();
    const trimmed = sqlText.trim();
    if (!trimmed) {
      return;
    }
    db.exec(trimmed);
  }

  runSqlFile(filePath) {
    this.runSql(readTextFile(filePath));
  }

  listTables() {
    const db = this.open();
    const rows = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all();
    return rows.map((row) => row.name);
  }

  dropTable(tableName) {
    const db = this.open();
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)};`);
  }

  previewRows(tableName, limit = 100) {
    const db = this.open();
    // Validate against the real table list so the interpolated identifier below
    // can never be attacker-controlled SQL.
    if (!this.listTables().includes(tableName)) {
      throw new Error(`Unknown table: ${tableName}`);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const quoted = quoteIdentifier(tableName);
    const rows = db.prepare(`SELECT * FROM ${quoted} LIMIT ${safeLimit}`).all();
    const columns = rows.length
      ? Object.keys(rows[0])
      : db.prepare(`PRAGMA table_info(${quoted})`).all().map((col) => col.name);
    return { columns, rows };
  }

  reset(schemaFile) {
    const db = this.open();
    const tables = this.listTables();
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      for (const tableName of tables) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)};`);
      }
      db.exec('DROP TABLE IF EXISTS schema_migrations;');
      if (schemaFile) {
        this.runSqlFile(schemaFile);
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  health() {
    const db = this.open();
    const integrity = db.prepare('PRAGMA integrity_check;').get();
    return {
      ok: integrity?.integrity_check === 'ok',
      integrity: integrity?.integrity_check ?? 'unknown',
      tables: this.listTables().length,
    };
  }

  backup(outputPath) {
    this.close();
    ensureDirSync(path.dirname(outputPath));
    if (!exists(this.databasePath)) {
      throw new Error(`SQLite database file does not exist: ${this.databasePath}`);
    }
    fs.copyFileSync(this.databasePath, outputPath);
    this.open();
    return outputPath;
  }

  restore(inputPath) {
    this.close();
    ensureDirSync(path.dirname(this.databasePath));
    fs.copyFileSync(inputPath, this.databasePath);
    this.open();
    return this.databasePath;
  }

  ensureMigrationsTable() {
    this.runSql(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  listAppliedMigrations() {
    this.ensureMigrationsTable();
    const db = this.open();
    const rows = db
      .prepare('SELECT filename FROM schema_migrations ORDER BY filename')
      .all();
    return rows.map((row) => row.filename);
  }

  recordMigration(filename) {
    this.ensureMigrationsTable();
    const db = this.open();
    db.prepare(
      'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, CURRENT_TIMESTAMP)'
    ).run(filename);
  }

  clearMigrationLedger() {
    const db = this.open();
    db.exec('DROP TABLE IF EXISTS schema_migrations;');
  }

}
