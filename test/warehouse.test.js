import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { openWarehouse, runLand, describeTable, LATEST_TICKETS_SQL, LATEST_MESSAGES_SQL } from '../src/warehouse/land.js'
import { ticketLandSpec, messageLandSpec } from '../src/warehouse/map.js'
import { startMock } from './helpers.js'

// Copied by hand from the warehouse's "Raw data contract" (types as DuckDB reports them for
// the tables its generator creates). Deliberately NOT imported from src/, so the test fails
// if the landing code drifts from the contract.
const CONTRACT = {
  tickets: [
    ['ticket_id', 'BIGINT'], ['external_ref', 'VARCHAR'], ['customer_id', 'VARCHAR'], ['channel', 'VARCHAR'],
    ['category', 'VARCHAR'], ['priority', 'VARCHAR'], ['stage', 'VARCHAR'], ['created_at', 'TIMESTAMP'],
    ['first_response_at', 'TIMESTAMP'], ['resolved_at', 'TIMESTAMP'], ['assigned_agent_id', 'BIGINT'],
    ['write_date', 'TIMESTAMP'], ['_loaded_at', 'TIMESTAMP'], ['_batch_id', 'VARCHAR'],
  ],
  messages: [
    ['message_id', 'BIGINT'], ['ticket_id', 'BIGINT'], ['author_type', 'VARCHAR'], ['sent_at', 'TIMESTAMP'],
    ['body_chars', 'BIGINT'], ['write_date', 'TIMESTAMP'], ['_loaded_at', 'TIMESTAMP'], ['_batch_id', 'VARCHAR'],
  ],
}

const rows = async (conn, sql, params) => (await conn.runAndReadAll(sql, params)).getRowObjectsJson()
const one = async (conn, sql) => Object.values((await rows(conn, sql))[0])[0]
const count = async (conn, table) => Number(await one(conn, `SELECT count(*) FROM raw.${table}`))
const fetchedSum = (results) => results.reduce((n, r) => n + r.fetched, 0)
const latestTickets = `SELECT * FROM (${LATEST_TICKETS_SQL})`
const latestMessages = `SELECT * FROM (${LATEST_MESSAGES_SQL})`
// The latest version per id, without the load metadata (which legitimately differs per run).
const fingerprint = async (conn) => JSON.stringify([
  await rows(conn, `${latestTickets} ORDER BY ticket_id`),
  await rows(conn, `${latestMessages} ORDER BY message_id`),
].map((rs) => rs.map(({ _loaded_at, _batch_id, ...rest }) => rest)))

async function setup(t, opts) {
  const mock = await startMock(opts)
  t.after(mock.close)
  const wh = await openWarehouse(':memory:')
  t.after(() => wh.close())
  const land = (extra = {}) => runLand({ conn: wh.conn, client: mock.client, pageSize: 10, ...extra })
  return { ...mock, wh, conn: wh.conn, land }
}

test('landing creates the contract schema exactly (column names and types)', async (t) => {
  const { conn } = await setup(t)
  for (const [table, cols] of Object.entries(CONTRACT)) {
    assert.deepEqual(await describeTable(conn, table), cols, `raw.${table}`)
  }
})

test('first run lands every ticket and ticket-message with load metadata', async (t) => {
  const { conn, land, mock } = await setup(t)
  const { batchId, results } = await land()
  const msgs = mock.store['mail.message'].filter((m) => m.model === 'helpdesk.ticket').length
  assert.equal(await count(conn, 'tickets'), 60)
  assert.equal(await count(conn, 'messages'), msgs)
  assert.deepEqual(results.map((r) => r.appended), [60, msgs])
  const meta = await rows(conn, 'SELECT DISTINCT _batch_id AS b FROM raw.tickets UNION SELECT DISTINCT _batch_id FROM raw.messages')
  assert.deepEqual(meta, [{ b: batchId }], 'one batch id per run, on every row')
  assert.equal(await one(conn, 'SELECT count(*) FROM raw.tickets WHERE _loaded_at IS NULL'), '0')
})

test('values follow the contract vocabulary and stay synthetic', async (t) => {
  const { conn, land } = await setup(t)
  await land()
  const t1 = (await rows(conn, 'SELECT * FROM raw.tickets WHERE ticket_id = 1'))[0]
  assert.match(t1.customer_id, /^CUST-\d{4}$/)
  assert.match(t1.external_ref, /^EXT-\d{8}$/)
  assert.ok(['chat', 'email', 'phone'].includes(t1.channel))
  assert.ok(['low', 'normal', 'high', 'urgent'].includes(t1.priority))
  assert.ok(['open', 'pending', 'solved', 'closed', 'abandoned'].includes(t1.stage))
  assert.match(t1.created_at, /^2026-01-01 /)
  const authors = (await rows(conn, 'SELECT DISTINCT author_type FROM raw.messages ORDER BY 1')).map((r) => r.author_type)
  assert.deepEqual(authors, ['agent', 'customer', 'system'])
  // every 9th ticket is unanswered: first_response_at stays NULL
  assert.equal(await one(conn, 'SELECT first_response_at FROM raw.tickets WHERE ticket_id = 9'), null)
  assert.ok(Number(await one(conn, 'SELECT min(body_chars) FROM raw.messages')) > 0)
})

test('two runs with no ERP changes: second run appends only the overlap re-reads; latest-per-id view is unchanged', async (t) => {
  const { conn, land } = await setup(t)
  await land()
  const before = await fingerprint(conn)
  const rawBefore = (await count(conn, 'tickets')) + (await count(conn, 'messages'))
  const second = await land()

  const appended = second.results.reduce((n, r) => n + r.appended, 0)
  assert.ok(appended > 0 && appended < 60, 'only the overlap window is re-read')
  assert.equal(appended, fetchedSum(second.results))
  assert.equal((await count(conn, 'tickets')) + (await count(conn, 'messages')) - rawBefore, appended)
  assert.equal(await fingerprint(conn), before, 'latest version per id is identical')
  assert.equal(await one(conn, `SELECT count(*) FROM (${LATEST_TICKETS_SQL})`), '60')
})

test('mutate then land: only changed and new rows are appended, and they win the latest-per-id view', async (t) => {
  const { conn, land, post } = await setup(t)
  await land()
  const stageBefore = (await rows(conn, `${latestTickets} WHERE ticket_id = 5`))[0].stage
  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 5, values: { stage_id: [3, 'Waiting'] }, now: '2026-03-01 10:00:00' })
  const created = await post('/__mutate', {
    action: 'create', model: 'helpdesk.ticket', now: '2026-03-01 10:00:05',
    values: {
      stage_id: [1, 'New'], priority: '1', user_id: false, x_customer_ref: 'CUST-0999', x_external_ref: 'EXT-00009001',
      x_channel: 'email', x_category: 'billing', x_first_response_at: false, x_resolved_at: false,
    },
  })
  const msg = await post('/__mutate', {
    action: 'create', model: 'mail.message', now: '2026-03-01 10:00:06',
    values: { model: 'helpdesk.ticket', res_id: created.id, body: '<p>hello</p>', author_id: [1999, 'Customer 0999'], date: '2026-03-01 10:00:05', message_type: 'comment' },
  })
  const { batchId } = await land()

  const landed = (await rows(conn, 'SELECT ticket_id FROM raw.tickets WHERE _batch_id = $1', [batchId])).map((r) => r.ticket_id)
  assert.ok(landed.includes('5'), 'edited ticket re-landed')
  assert.ok(landed.includes(String(created.id)), 'new ticket landed')
  assert.equal(await one(conn, 'SELECT count(*) FROM raw.tickets WHERE ticket_id = 5'), '2', 'append-only: both versions are kept')
  const latest = (await rows(conn, `${latestTickets} WHERE ticket_id = 5`))[0]
  assert.equal(stageBefore, 'open')
  assert.equal(latest.stage, 'pending')
  assert.equal(latest.write_date, '2026-03-01 10:00:00')
  assert.equal(await one(conn, `SELECT count(*) FROM (${LATEST_TICKETS_SQL})`), '61')
  assert.equal(await one(conn, `SELECT count(*) FROM raw.messages WHERE message_id = ${msg.id}`), '1')
})

test('raw._sync_runs records each run, one row per model', async (t) => {
  const { conn, land } = await setup(t)
  const a = await land()
  const b = await land()
  const log = await rows(conn, 'SELECT * FROM raw._sync_runs ORDER BY started_at, model')
  assert.equal(log.length, 4)
  assert.deepEqual([...new Set(log.map((r) => r.batch_id))].sort(), [a.batchId, b.batchId].sort())
  const first = log.find((r) => r.batch_id === a.batchId && r.model === 'helpdesk.ticket')
  assert.equal(first.status, 'success')
  assert.equal(first.fetched, '60')
  assert.equal(first.appended, '60')
  assert.equal(first.cursor_before, null)
  assert.equal(first.cursor_after, '2026-02-01 09:00:00#60')
  assert.ok(first.started_at && first.finished_at)
  const second = log.find((r) => r.batch_id === b.batchId && r.model === 'helpdesk.ticket')
  assert.equal(second.cursor_before, '2026-02-01 09:00:00#60')
  assert.equal(second.error, null)
})

test('a failing run is logged as failed, keeps committed pages, and the next run resumes', async (t) => {
  const { conn, land, post } = await setup(t)
  await post('/__fail', { searchReads: 2 }) // pages 1-2 succeed, page 3 returns HTTP 500
  await assert.rejects(() => land(), /HTTP 500/)
  const failed = (await rows(conn, "SELECT * FROM raw._sync_runs WHERE status = 'failed'"))[0]
  assert.equal(failed.model, 'helpdesk.ticket')
  assert.equal(failed.appended, '20')
  assert.match(failed.error, /HTTP 500/)
  assert.equal(await count(conn, 'tickets'), 20)

  await post('/__fail', { searchReads: null })
  await land()
  assert.equal(await one(conn, `SELECT count(*) FROM (${LATEST_TICKETS_SQL})`), '60')
  const dupes = await one(conn, 'SELECT count(*) FROM (SELECT ticket_id FROM raw.tickets GROUP BY 1 HAVING count(*) > 1)')
  assert.ok(Number(dupes) <= 6, 'only overlap rows are re-appended after resume')
})

test('dry-run writes nothing: no file, no rows, no cursor, no run log', async (t) => {
  const { client } = await startMock().then((m) => { t.after(m.close); return m })
  const dir = mkdtempSync(join(tmpdir(), 'erp-wh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'wh.duckdb')

  // 1) target file does not exist: a dry run plans against an empty in-memory warehouse and creates no file
  let wh = await openWarehouse(file, { readOnly: true })
  const plan = await runLand({ conn: wh.conn, client, dryRun: true, pageSize: 10 })
  wh.close()
  assert.equal(existsSync(file), false)
  assert.equal(plan.results[0].fetched, 60)
  assert.equal(plan.results[0].appended, 0)

  // 2) existing warehouse: row counts, cursor and run log are unchanged by a dry run
  wh = await openWarehouse(file)
  await runLand({ conn: wh.conn, client, pageSize: 10 })
  const snap = async (c) => JSON.stringify([
    await count(c, 'tickets'), await count(c, 'messages'),
    await rows(c, 'SELECT * FROM raw._sync_cursor ORDER BY 1'), await count(c, '_sync_runs'),
  ])
  const before = await snap(wh.conn)
  wh.close()
  wh = await openWarehouse(file, { readOnly: true })
  const dry = await runLand({ conn: wh.conn, client, dryRun: true, pageSize: 10, since: '2026-01-01 00:00:00' })
  assert.ok(fetchedSum(dry.results) > 0)
  wh.close()
  wh = await openWarehouse(file, { readOnly: true })
  assert.equal(await snap(wh.conn), before)
  wh.close()
})

test('id offset moves ERP ids into a separate namespace without touching the cursor', async (t) => {
  const { conn, land } = await setup(t)
  await land({ idOffset: 900000 })
  assert.equal(await one(conn, 'SELECT min(ticket_id) FROM raw.tickets'), '900001')
  assert.equal(await one(conn, 'SELECT count(*) FROM raw.messages m LEFT JOIN raw.tickets t USING (ticket_id) WHERE t.ticket_id IS NULL'), '0')
  assert.equal(await one(conn, "SELECT cursor_after FROM raw._sync_runs WHERE model = 'helpdesk.ticket'"), '2026-02-01 09:00:00#60')
})

test('refuses to append into an existing raw table that deviates from the contract', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-wh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'bad.duckdb')
  const inst = await DuckDBInstance.create(file)
  const c = await inst.connect()
  await c.run('CREATE SCHEMA raw')
  await c.run('CREATE TABLE raw.tickets (ticket_id VARCHAR)')
  c.closeSync()
  inst.closeSync()
  await assert.rejects(() => openWarehouse(file), /does not match the landing contract/)
})

test('mapping: label vocabulary, null handling, id offset', () => {
  const row = ticketLandSpec.toRow({
    id: 5, stage_id: [3, 'Waiting'], priority: '2', user_id: [2, 'Agent Beta'], create_date: '2026-01-01 00:00:00',
    write_date: '2026-02-01 00:00:00', x_external_ref: 'EXT-1', x_customer_ref: 'CUST-0001', x_channel: 'chat',
    x_category: 'billing', x_first_response_at: false, x_resolved_at: false,
  }, { idOffset: 100 })
  assert.deepEqual(row, [105, 'EXT-1', 'CUST-0001', 'chat', 'billing', 'high', 'pending', '2026-01-01 00:00:00', null, null, 2, '2026-02-01 00:00:00'])
  const m = messageLandSpec.toRow({ id: 1, res_id: 5, body: '<p>hello</p>', author_id: false, date: '2026-01-01 00:01:00', write_date: '2026-01-01 00:01:00' }, { idOffset: 100 })
  assert.deepEqual(m, [101, 105, 'system', '2026-01-01 00:01:00', 5, '2026-01-01 00:01:00'])
})
