import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDirSync, exists, readTextFile, quoteIdentifier } from '../utils.js';
import { rejectSameFile, snapshotDatabase, restoreDatabase } from '../sqlite-files.js';

export class SqliteEngine {
  constructor(config) {
    this.config = config;
    this.databasePath = config.sqlite.file;
    this.db = null;
  }

  open() {
    if (!this.db) {
      ensureDirSync(path.dirname(this.databasePath));
      this.db = new DatabaseSync(this.databasePath);
      this.db.exec(`
        PRAGMA busy_timeout = 30000;
        PRAGMA synchronous = FULL;
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
    if (!exists(this.databasePath)) {
      throw new Error(`SQLite database file does not exist: ${this.databasePath}`);
    }
    rejectSameFile(this.databasePath, outputPath);
    ensureDirSync(path.dirname(outputPath));
    const directory = fs.mkdtempSync(path.join(path.dirname(outputPath), '.dbtk-backup-'));
    try {
      const stage = path.join(directory, 'snapshot.db');
      snapshotDatabase(this.databasePath, stage);
      // Hardlink publication is atomic and fails if any destination already exists.
      fs.linkSync(stage, outputPath);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    return outputPath;
  }

  restore(inputPath) {
    return restoreDatabase(this, inputPath);
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
