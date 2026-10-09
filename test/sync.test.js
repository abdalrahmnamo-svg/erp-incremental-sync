import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, dumpTables, totalChanges, rowCount } from '../src/db.js'
import { runSync, readCursor } from '../src/sync.js'
import { startMock, memDb } from './helpers.js'

const ticketMsgs = (mock) => mock.store['mail.message'].filter((m) => m.model === 'helpdesk.ticket')
const sum = (results, k) => results.reduce((n, r) => n + r[k], 0)

test('first sync copies every ticket and ticket-message exactly once', async (t) => {
  const { mock, client, close } = await startMock()
  t.after(close)
  const db = memDb()
  const res = await runSync({ db, client, pageSize: 10 })

  assert.equal(rowCount(db, 'ticket'), 60)
  assert.equal(rowCount(db, 'message'), ticketMsgs(mock).length) // res.partner notes are filtered out
  assert.equal(res[0].inserted, 60)
  assert.equal(res[0].pages, 6)
  // identity: tickets sharing an email share one contact row
  const distinctEmails = new Set(mock.store['helpdesk.ticket'].map((r) => r.partner_email)).size
  assert.equal(rowCount(db, 'contact'), distinctEmails)
  assert.deepEqual(readCursor(db, 'helpdesk.ticket'), { write_date: '2026-02-01 09:00:00', id: 60 })
})

test('re-sync with no ERP changes: 0 inserts, 0 updates, 0 writes (overlap rows are unchanged)', async (t) => {
  const { client, close } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })

  const before = dumpTables(db)
  const changesBefore = totalChanges(db)
  const res = await runSync({ db, client, pageSize: 10 })

  assert.equal(totalChanges(db) - changesBefore, 0, 'sqlite reports zero row changes')
  assert.deepEqual(dumpTables(db), before)
  assert.ok(sum(res, 'fetched') > 0, 'the overlap window is re-read')
  assert.equal(sum(res, 'fetched'), sum(res, 'unchanged'))
  assert.equal(sum(res, 'inserted'), 0)
  assert.equal(sum(res, 'updated'), 0)
})

test('incremental: only changed and new rows are picked up after the ERP is edited', async (t) => {
  const { client, post, close } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })

  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 3, values: { stage_id: [4, 'Solved'] }, now: '2026-03-01 10:00:00' })
  const created = await post('/__mutate', {
    action: 'create', model: 'helpdesk.ticket', now: '2026-03-01 10:00:05',
    values: { name: 'Brand new (#9001)', partner_name: 'Customer 0999', partner_email: 'customer0999@example.com', partner_phone: '+1-555-0199', stage_id: [1, 'New'], priority: '1', user_id: false, description: '<p>x</p>' },
  })
  await post('/__mutate', {
    action: 'create', model: 'mail.message', now: '2026-03-01 10:00:06',
    values: { model: 'helpdesk.ticket', res_id: created.id, body: '<p>hi</p>', author_id: [1999, 'Customer 0999'], date: '2026-03-01 10:00:05', message_type: 'comment' },
  })

  const before = totalChanges(db)
  const [tickets, messages] = await runSync({ db, client, pageSize: 10 })
  assert.equal(tickets.inserted, 1)
  assert.equal(tickets.updated, 1)
  assert.equal(tickets.fetched, tickets.inserted + tickets.updated + tickets.unchanged)
  assert.equal(messages.inserted, 1)
  assert.equal(messages.updated, 0)
  assert.equal(db.prepare('SELECT stage FROM ticket WHERE external_id = 3').get().stage, 'Solved')
  assert.ok(totalChanges(db) - before > 0)

  // and then it settles again
  const again = await runSync({ db, client, pageSize: 10 })
  assert.equal(sum(again, 'inserted') + sum(again, 'updated'), 0)
})

test('mid-run failure: cursor stays at the last committed page, next run resumes, no duplicates', async (t) => {
  const { mock, client, post, close } = await startMock()
  t.after(close)
  const db = memDb()

  await post('/__fail', { searchReads: 3 }) // pages 1-3 succeed, the 4th request returns HTTP 500
  await assert.rejects(runSync({ db, client, pageSize: 10 }), (e) => e.code === 'HTTP_500')

  assert.equal(rowCount(db, 'ticket'), 30)
  assert.deepEqual(readCursor(db, 'helpdesk.ticket'), { write_date: '2026-02-01 04:00:00', id: 30 })
  assert.equal(readCursor(db, 'mail.message'), null)

  await post('/__fail', { searchReads: null })
  const res = await runSync({ db, client, pageSize: 10 })

  // resumed from the committed cursor (+ the overlap window, re-read as unchanged), not from scratch
  assert.equal(res[0].inserted, 30)
  assert.equal(res[0].unchanged, 6)
  assert.equal(res[0].fetched, 36)
  assert.equal(rowCount(db, 'ticket'), 60)
  assert.equal(db.prepare('SELECT COUNT(DISTINCT external_id) AS n FROM ticket').get().n, 60)
  assert.equal(rowCount(db, 'message'), ticketMsgs(mock).length)
})

test('dry-run writes nothing: rows, cursor and file are untouched', async (t) => {
  const { client, close } = await startMock()
  t.after(close)

  // (1) writable in-memory DB with dryRun=true
  const db = memDb()
  const empty = dumpTables(db)
  const c0 = totalChanges(db)
  const plan = await runSync({ db, client, pageSize: 10, dryRun: true })
  assert.equal(plan[0].inserted, 60)
  assert.notEqual(plan[0].cursorAfter, null, 'the plan reports where the cursor would end')
  assert.equal(totalChanges(db) - c0, 0)
  assert.deepEqual(dumpTables(db), empty)
  assert.equal(readCursor(db, 'helpdesk.ticket'), null)

  // (2) populated DB: dry-run after a sync with pending changes does not move anything
  await runSync({ db, client, pageSize: 10 })
  const synced = dumpTables(db)
  const again = await runSync({ db, client, pageSize: 10, dryRun: true, since: '2026-02-01 00:00:00' })
  assert.equal(again[0].unchanged, 60)
  assert.deepEqual(dumpTables(db), synced)

  // (3) real file: dry-run against a missing file creates no file at all
  const dir = mkdtempSync(join(tmpdir(), 'erp-sync-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'never.db')
  const ro = openDb(file, { readOnly: true })
  await runSync({ db: ro, client, pageSize: 10, dryRun: true })
  ro.close()
  assert.equal(existsSync(file), false)
})

test('--since overrides the stored cursor', async (t) => {
  const { mock, client, close } = await startMock()
  t.after(close)
  const since = '2026-02-01 03:00:00'
  const expected = mock.store['helpdesk.ticket'].filter((r) => r.write_date >= since).length
  assert.equal(expected, 42)

  // empty DB, no cursor: only rows changed since the date are loaded
  const fresh = memDb()
  const res = await runSync({ db: fresh, client, pageSize: 10, since })
  assert.equal(res[0].inserted, expected)
  assert.equal(rowCount(fresh, 'ticket'), expected)

  // fully synced DB (cursor at the end): --since re-reads from the date, writes nothing new,
  // and never moves the cursor backwards
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })
  const cursor = readCursor(db, 'helpdesk.ticket')
  const reread = await runSync({ db, client, pageSize: 10, since })
  assert.equal(reread[0].fetched, expected)
  assert.equal(reread[0].unchanged, expected)
  assert.deepEqual(readCursor(db, 'helpdesk.ticket'), cursor)
})

test('identical write_date values are paged without loss or repeats (id tiebreak)', async (t) => {
  const { mock, client, close } = await startMock()
  t.after(close)
  const db = memDb()
  // groups of 6 tickets share a write_date; a page size of 4 puts page boundaries inside the ties
  const res = await runSync({ db, client, pageSize: 4 })
  assert.equal(res[0].pages, 15)
  assert.equal(res[0].inserted, 60)
  const ids = db.prepare('SELECT external_id FROM ticket ORDER BY external_id').all().map((r) => r.external_id)
  assert.deepEqual(ids, mock.store['helpdesk.ticket'].map((r) => r.id))
  assert.equal(rowCount(db, 'message'), ticketMsgs(mock).length)
})

test('overlap: a lower-id record edited in the same second as the cursor is picked up', async (t) => {
  const { client, post, close } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })
  const cursor = readCursor(db, 'helpdesk.ticket') // { '2026-02-01 09:00:00', id: 60 }

  // ticket 3 (id < 60) is edited with exactly the cursor's write_date
  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 3, values: { stage_id: [4, 'Solved'] }, now: cursor.write_date })
  const [tickets] = await runSync({ db, client, pageSize: 10 })
  assert.equal(tickets.updated, 1)
  assert.equal(db.prepare('SELECT stage FROM ticket WHERE external_id = 3').get().stage, 'Solved')
  assert.deepEqual(readCursor(db, 'helpdesk.ticket'), cursor)
})

test('overlap: a row that commits late with a write_date just before the cursor is picked up; cursor never moves back', async (t) => {
  const { client, post, close } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })
  const cursor = readCursor(db, 'helpdesk.ticket')

  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 5, values: { priority: '2' }, now: '2026-02-01 08:59:59' })
  const [tickets] = await runSync({ db, client, pageSize: 10 })
  assert.equal(tickets.updated, 1)
  assert.equal(db.prepare('SELECT priority FROM ticket WHERE external_id = 5').get().priority, '2')
  assert.deepEqual(readCursor(db, 'helpdesk.ticket'), cursor)

  // documented remaining limit: older than the overlap window is NOT seen by a normal run...
  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 7, values: { priority: '2' }, now: '2026-02-01 08:59:50' })
  const [miss] = await runSync({ db, client, pageSize: 10 })
  assert.equal(miss.updated, 0)
  // ...but a --since re-read recovers it
  const [fix] = await runSync({ db, client, pageSize: 10, since: '2026-02-01 08:00:00' })
  assert.equal(fix.updated, 1)
})

test('overlap window is configurable (0 disables the lookback)', async (t) => {
  const { client, post, close } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10, overlapSeconds: 0 })
  await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 5, values: { priority: '2' }, now: '2026-02-01 08:59:59' })
  const [tickets] = await runSync({ db, client, pageSize: 10, overlapSeconds: 0 })
  assert.equal(tickets.updated, 0)
})
