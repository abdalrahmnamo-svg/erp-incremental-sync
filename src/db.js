import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS contact (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_norm  TEXT UNIQUE,
  phone_norm  TEXT,
  name        TEXT,
  email       TEXT,
  phone       TEXT
);
CREATE TABLE IF NOT EXISTS ticket (
  external_id INTEGER PRIMARY KEY,
  subject     TEXT,
  contact_id  INTEGER,
  partner_name  TEXT,
  partner_email TEXT,
  partner_phone TEXT,
  stage       TEXT,
  priority    TEXT,
  assignee    TEXT,
  description TEXT,
  created_at  TEXT,
  write_date  TEXT NOT NULL,
  src_hash    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  external_id        INTEGER PRIMARY KEY,
  ticket_external_id INTEGER NOT NULL,
  body        TEXT,
  author      TEXT,
  direction   TEXT,
  msg_date    TEXT,
  write_date  TEXT NOT NULL,
  src_hash    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_ticket ON message(ticket_external_id);
CREATE TABLE IF NOT EXISTS sync_cursor (
  model           TEXT PRIMARY KEY,
  last_write_date TEXT NOT NULL,
  last_id         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_suppress (
  external_id INTEGER PRIMARY KEY,
  merged_into INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dupe_backup (
  plan_id    TEXT NOT NULL,
  group_key  TEXT NOT NULL,
  status     TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (plan_id, group_key)
);
`

/** Tables compared by tests / dry-run checks (everything except the dupe backup). */
export const DATA_TABLES = ['contact', 'ticket', 'message', 'sync_cursor', 'sync_suppress']

/**
 * Open the target database.
 * readOnly: never creates or writes a file; a missing file yields an empty in-memory DB
 * with the same schema, so dry-run can plan against "nothing synced yet".
 */
export function openDb(path, { readOnly = false } = {}) {
  if (path === ':memory:') {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    return db
  }
  if (readOnly) {
    if (!existsSync(path)) {
      const db = new DatabaseSync(':memory:')
      db.exec(SCHEMA)
      return db
    }
    return new DatabaseSync(path, { readOnly: true })
  }
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}

/** Run fn inside a transaction; roll back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const totalChanges = (db) => Number(db.prepare('SELECT total_changes() AS n').get().n)

/** Deterministic dump of the data tables (used to prove "nothing changed"). */
export function dumpTables(db, tables = DATA_TABLES) {
  const out = {}
  for (const t of tables) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...r }))
  return out
}

export const rowCount = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
