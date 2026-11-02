-- Migration 003: add an audit_log table.
-- Portable DDL: runs on SQLite, PostgreSQL, and MySQL.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor VARCHAR(255),
  action VARCHAR(255) NOT NULL,
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
