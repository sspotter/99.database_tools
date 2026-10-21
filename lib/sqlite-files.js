import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function rejectSameFile(source, target) {
  if (!fs.existsSync(target)) return;
  const from = fs.statSync(source, { bigint: true });
  const to = fs.statSync(target, { bigint: true });
  if (fs.realpathSync(source) === fs.realpathSync(target) || (from.dev === to.dev && from.ino === to.ino)) {
    throw new Error('SQLite source and destination refer to the same file or alias');
  }
}

function validateDatabase(db) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
}

function validateHeader(source) {
  // Empty files are accepted by SQLite as new databases, but are invalid restore inputs.
  const descriptor = fs.openSync(source, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(descriptor, header, 0, 16, 0) !== 16 || header.toString() !== 'SQLite format 3\0') {
      throw new Error('Invalid SQLite database header');
    }
  } finally { fs.closeSync(descriptor); }
}

export function snapshotDatabase(source, stage) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    validateDatabase(db);
    db.prepare('VACUUM INTO ?').run(stage);
  } finally { db.close(); }
  const staged = new DatabaseSync(stage, { readOnly: true });
  try { validateDatabase(staged); } finally { staged.close(); }
  const stagedFile = fs.openSync(stage, 'r+');
  try { fs.fsyncSync(stagedFile); } finally { fs.closeSync(stagedFile); }
}

function prepareReplacement(db) {
  // SQLite must reconcile recovery state itself; never unlink a WAL or journal.
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (checkpoint.busy) throw new Error('SQLite target is busy; stop external applications for maintenance');
  const journal = db.prepare('PRAGMA journal_mode=DELETE').get();
  if (journal.journal_mode !== 'delete') throw new Error('SQLite target journal is busy; stop external applications');
  db.exec('BEGIN EXCLUSIVE');
  db.exec('ROLLBACK');
}

function rejectRecoveryFiles(target) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(target + suffix)) {
      throw new Error('SQLite recovery sidecars remain; stop external applications and recover the target before maintenance');
    }
  }
}

function replaceDatabase(engine, stage, recovery) {
  const target = engine.databasePath;
  const existed = fs.existsSync(target);
  if (existed) {
    prepareReplacement(engine.open());
    engine.close();
    rejectRecoveryFiles(target);
    fs.linkSync(target, recovery);
  } else rejectRecoveryFiles(target);
  let published = false;
  let retainRecovery = false;
  try {
    fs.renameSync(stage, target);
    published = true;
    engine.open();
  } catch (failure) {
    engine.close();
    if (published) {
      try {
        if (existed) fs.renameSync(recovery, target);
        else fs.unlinkSync(target);
      } catch (rollbackFailure) {
        retainRecovery = true;
        throw new AggregateError([failure, rollbackFailure], `SQLite restore failed; original retained at ${recovery}`);
      }
    }
    throw failure;
  } finally {
    if (!retainRecovery && fs.existsSync(recovery)) fs.unlinkSync(recovery);
  }
}

export function restoreDatabase(engine, inputPath) {
  const target = engine.databasePath;
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('SQLite restore target must not be a symlink alias');
  }
  rejectSameFile(inputPath, target);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(fs.realpathSync(parent), `${path.basename(target)}.dbtk-restore.lock`);
  const lockFile = fs.openSync(lock, 'wx');
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(parent, '.dbtk-restore-'));
    const stage = path.join(directory, 'snapshot.db');
    const recovery = path.join(directory, 'original.db');
    validateHeader(inputPath);
    snapshotDatabase(inputPath, stage);
    replaceDatabase(engine, stage, recovery);
  } finally {
    // A retained recovery file is never removed after rollback itself failed.
    try {
      if (directory && !fs.existsSync(path.join(directory, 'original.db'))) fs.rmSync(directory, { recursive: true, force: true });
    } finally {
      fs.closeSync(lockFile);
      fs.unlinkSync(lock);
    }
  }
  return target;
}
