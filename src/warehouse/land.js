/**
 * Land ERP changes into a DuckDB `raw` schema (the warehouse's landing contract).
 *
 * Same incremental logic as the SQLite target: cursor (write_date, id), an inclusive overlap
 * window on every run, keyset paging inside a run, and the cursor advanced in the SAME
 * transaction as the page it describes. What differs is the write: raw is append-only, so
 * every fetched row is appended with `_loaded_at` and `_batch_id`; deduplication ("latest
 * write_date wins") is the warehouse staging layer's job. Every run is logged to
 * `raw._sync_runs`, one row per model.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { keysetDomain, minusSeconds, after, ORDER, DEFAULT_OVERLAP_SECONDS } from '../sync.js'
import { ALL_TABLES, RAW_CONTRACT, SCHEMA_SQL } from './contract.js'
import { LAND_SPECS } from './map.js'

const ts = (d) => d.toISOString().slice(0, 23).replace('T', ' ') // 'YYYY-MM-DD HH:MM:SS.mmm' (UTC)
const curStr = (c) => (c ? `${c.write_date}#${c.id}` : null)

/** One id per run, e.g. erp_20261011T101500Z_k3f9. */
export function newBatchId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  return `erp_${stamp}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Open the warehouse file.
 * readOnly (dry-run): never creates or writes; a missing file yields an empty in-memory
 * database with the same schema, so a dry run can plan against "nothing landed yet".
 */
export async function openWarehouse(path, { readOnly = false } = {}) {
  if (path === ':memory:' || (readOnly && !existsSync(path))) {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    for (const sql of SCHEMA_SQL) await conn.run(sql)
    return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
  }
  if (!readOnly) mkdirSync(dirname(path), { recursive: true })
  const instance = await DuckDBInstance.create(path, readOnly ? { access_mode: 'READ_ONLY' } : {})
  const conn = await instance.connect()
  if (!readOnly) {
    for (const sql of SCHEMA_SQL) await conn.run(sql)
    await assertContract(conn)
  }
  return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
}

export async function describeTable(conn, table) {
  const r = await conn.runAndReadAll(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'raw' AND table_name = $1 ORDER BY ordinal_position`, [table])
  return r.getRowObjects().map((o) => [o.column_name, o.data_type])
}

/** Refuse to append into a pre-existing table whose shape is not the contract. */
async function assertContract(conn) {
  for (const [table, cols] of Object.entries(RAW_CONTRACT)) {
    const actual = await describeTable(conn, table)
    if (JSON.stringify(actual) !== JSON.stringify(cols)) {
      throw new Error(`raw.${table} does not match the landing contract; refusing to append.\n  expected ${JSON.stringify(cols)}\n  found    ${JSON.stringify(actual)}`)
    }
  }
}

async function tableExists(conn, table) {
  const r = await conn.runAndReadAll(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'raw' AND table_name = $1`, [table])
  return r.getRows().length > 0
}

export async function readCursor(conn, model) {
  if (!(await tableExists(conn, '_sync_cursor'))) return null
  const r = await conn.runAndReadAll('SELECT last_write_date, last_id FROM raw._sync_cursor WHERE model = $1', [model])
  const row = r.getRowObjects()[0]
  return row ? { write_date: row.last_write_date, id: Number(row.last_id) } : null
}

async function advanceCursor(conn, model, pos) {
  const cur = await readCursor(conn, model)
  if (cur && !after(pos, cur)) return // monotonic: --since never moves it backwards
  await conn.run(
    `INSERT INTO raw._sync_cursor (model, last_write_date, last_id) VALUES ($1, $2, $3)
     ON CONFLICT (model) DO UPDATE SET last_write_date = excluded.last_write_date, last_id = excluded.last_id`,
    [model, pos.write_date, pos.id])
}

async function inTx(conn, fn) {
  await conn.run('BEGIN TRANSACTION')
  try {
    const out = await fn()
    await conn.run('COMMIT')
    return out
  } catch (err) {
    await conn.run('ROLLBACK')
    throw err
  }
}

async function appendRows(conn, spec, rows, loadedAt, batchId) {
  const cols = ALL_TABLES[spec.table] // contract columns including _loaded_at and _batch_id
  const placeholders = cols.map(([, t], i) => (t === 'TIMESTAMP' ? `CAST($${i + 1} AS TIMESTAMP)` : `$${i + 1}`)).join(', ')
  const sql = `INSERT INTO raw.${spec.table} VALUES (${placeholders})`
  for (const row of rows) await conn.run(sql, [...row, loadedAt, batchId])
}

async function landModel({ conn, client, spec, dryRun, since, pageSize, overlapSeconds, idOffset, batchId, now, onPage }) {
  const stored = await readCursor(conn, spec.model)
  let cursor = stored
  const startDomain = since
    ? [['write_date', '>=', since]]
    : stored ? [['write_date', '>=', minusSeconds(stored.write_date, overlapSeconds)]] : []
  const startedAt = ts(now())
  const loadedAt = startedAt // one load timestamp per model per run
  const totals = {
    model: spec.model, table: spec.table, pages: 0, fetched: 0, appended: 0,
    cursorBefore: stored, cursorAfter: stored, status: 'success', error: null,
  }

  if (!dryRun) {
    await conn.run(
      `INSERT INTO raw._sync_runs (batch_id, started_at, model, fetched, appended, cursor_before, status)
       VALUES ($1, CAST($2 AS TIMESTAMP), $3, 0, 0, $4, 'running')`,
      [batchId, startedAt, spec.model, curStr(stored)])
  }

  let failure = null
  try {
    let pos = null
    for (;;) {
      const domain = [...spec.domain, ...(pos ? keysetDomain(pos) : startDomain)]
      const page = await client.searchRead(spec.model, domain, spec.fields, { limit: pageSize, order: ORDER })
      if (!page.length) break
      const last = page[page.length - 1]
      const lastPos = { write_date: last.write_date, id: last.id }
      if (!dryRun) {
        const rows = page.map((rec) => spec.toRow(rec, { idOffset }))
        await inTx(conn, async () => {
          await appendRows(conn, spec, rows, loadedAt, batchId)
          await advanceCursor(conn, spec.model, lastPos)
        })
        totals.appended += page.length
      }
      totals.pages += 1
      totals.fetched += page.length
      pos = lastPos
      if (!cursor || after(lastPos, cursor)) cursor = lastPos
      totals.cursorAfter = cursor
      if (onPage) onPage({ model: spec.model, page: totals.pages, fetched: totals.fetched })
      if (page.length < pageSize) break
    }
  } catch (err) {
    failure = err
    totals.status = 'failed'
    totals.error = String(err?.message || err).slice(0, 500)
  }

  if (!dryRun) {
    await conn.run(
      `UPDATE raw._sync_runs SET finished_at = CAST($1 AS TIMESTAMP), fetched = $2, appended = $3,
         cursor_after = $4, status = $5, error = $6
       WHERE batch_id = $7 AND model = $8`,
      [ts(now()), totals.fetched, totals.appended, curStr(totals.cursorAfter), totals.status, totals.error, batchId, spec.model])
  }
  if (failure) throw failure
  return totals
}

/**
 * Land every model in dependency order (tickets, then messages).
 * dryRun: the real fetch + cursor logic against a read-only connection; "appended" stays 0
 * and nothing (rows, cursor, run log) is written.
 */
export async function runLand({
  conn, client, dryRun = false, since = null, pageSize = 50, overlapSeconds = DEFAULT_OVERLAP_SECONDS,
  idOffset = 0, batchId = newBatchId(), now = () => new Date(), onPage,
}) {
  await client.authenticate()
  const results = []
  for (const spec of LAND_SPECS) {
    results.push(await landModel({ conn, client, spec, dryRun, since, pageSize, overlapSeconds, idOffset, batchId, now, onPage }))
  }
  return { batchId, results }
}

/** The warehouse-style "latest version per id" views (what staging does), for checks and docs. */
export const LATEST_TICKETS_SQL = `
  SELECT * FROM raw.tickets
  QUALIFY row_number() OVER (PARTITION BY ticket_id ORDER BY write_date DESC, _loaded_at DESC) = 1`
export const LATEST_MESSAGES_SQL = `
  SELECT * FROM raw.messages
  QUALIFY row_number() OVER (PARTITION BY message_id ORDER BY write_date DESC, _loaded_at DESC) = 1`
