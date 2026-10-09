import test from 'node:test'
import assert from 'node:assert/strict'
import { dumpTables, rowCount } from '../src/db.js'
import { runSync } from '../src/sync.js'
import { buildPlan, planGroup, messageKey } from '../src/dupes/plan.js'
import { applyPlan, rollbackPlan } from '../src/dupes/apply.js'
import { startMock, memDb } from './helpers.js'

async function syncedDb(t) {
  const { client, close, mock } = await startMock()
  t.after(close)
  const db = memDb()
  await runSync({ db, client, pageSize: 10 })
  return { db, client, mock }
}

test('plan: finds the 3 seeded duplicate groups, read-only', async (t) => {
  const { db } = await syncedDb(t)
  const before = dumpTables(db)
  const plan = buildPlan(db)
  assert.deepEqual(dumpTables(db), before)

  assert.deepEqual(plan.groups.map((g) => [g.keepId, g.removeIds]), [[6, [58]], [12, [59]], [18, [60]]])
  assert.deepEqual(plan.summary, { groups: 3, ticketsToRemove: 3, messagesToMove: 1, messagesToDrop: 4 })
  const g6 = plan.groups[0]
  assert.equal(g6.moveMessageIds.length, 1)
  assert.equal(g6.dropMessageIds.length, 1)
  assert.match(plan.planId, /^[0-9a-f]{12}$/)
})

test('planGroup keeps the fuller copy; ties go to the lowest id', () => {
  const msg = (id, body) => ({ external_id: id, msg_date: 'd', author: 'a', body, src_hash: String(id) })
  const t = (id) => ({ external_id: id, src_hash: `t${id}` })
  const g = planGroup({
    key: 'k',
    copies: [
      { ticket: t(10), messages: [msg(1, 'x')] },
      { ticket: t(11), messages: [msg(2, 'x'), msg(3, 'y')] },
    ],
  })
  assert.equal(g.keepId, 11)
  assert.deepEqual(g.removeIds, [10])
  assert.deepEqual(g.dropMessageIds, [1])
  assert.equal(messageKey(msg(1, 'x')), messageKey(msg(2, 'x')))
})

test('plan -> apply -> rollback restores the original state exactly', async (t) => {
  const { db } = await syncedDb(t)
  const original = dumpTables(db)
  const plan = buildPlan(db)

  const results = applyPlan(db, plan)
  assert.ok(results.every((r) => r.status === 'applied'), JSON.stringify(results))
  assert.equal(rowCount(db, 'ticket'), 57)
  assert.equal(rowCount(db, 'message'), original.message.length - 4)
  assert.equal(rowCount(db, 'sync_suppress'), 3)
  // the unique message moved onto the survivor
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message WHERE ticket_external_id = 6').get().n, 3)
  assert.notDeepEqual(dumpTables(db), original)

  const rolled = rollbackPlan(db, plan)
  assert.ok(rolled.every((r) => r.status === 'rolled_back'))
  assert.deepEqual(dumpTables(db), original)

  // nothing left to roll back a second time
  assert.deepEqual(rollbackPlan(db, plan), [])
})

test('apply: dry-run changes nothing; second apply is skipped; stale plan is refused', async (t) => {
  const { db } = await syncedDb(t)
  const original = dumpTables(db)
  const plan = buildPlan(db)

  const dry = applyPlan(db, plan, { dryRun: true })
  assert.ok(dry.every((r) => r.status === 'dry-run-ok'))
  assert.deepEqual(dumpTables(db), original)
  assert.equal(rowCount(db, 'dupe_backup'), 0)

  // the data changes after the plan was reviewed -> that group is refused
  db.prepare("UPDATE ticket SET src_hash = 'changed' WHERE external_id = 58").run()
  const stale = applyPlan(db, plan)
  assert.equal(stale[0].status, 'skipped')
  assert.match(stale[0].reason, /changed since the plan/)
  assert.deepEqual(stale.slice(1).map((r) => r.status), ['applied', 'applied'])

  const second = applyPlan(db, plan)
  assert.deepEqual(second.map((r) => r.reason), ['data changed since the plan was made; re-run dupes:plan', 'already applied', 'already applied'])
})

test('a later sync does not resurrect removed duplicates or re-add dropped messages', async (t) => {
  const { db, client } = await syncedDb(t)
  const plan = buildPlan(db)
  applyPlan(db, plan)
  const afterApply = dumpTables(db)

  // re-read everything from the start of the data
  const res = await runSync({ db, client, pageSize: 10, since: '2026-01-01' })
  assert.equal(res[0].skipped, 3)
  assert.equal(rowCount(db, 'ticket'), 57)
  assert.equal(res[1].skipped, 4)
  assert.deepEqual(dumpTables(db), afterApply)

  // after rollback the suppression is gone and a re-read sees consistent data
  rollbackPlan(db, plan)
  const res2 = await runSync({ db, client, pageSize: 10, since: '2026-01-01' })
  assert.equal(res2[0].skipped, 0)
  assert.equal(res2[0].inserted + res2[0].updated, 0)
  assert.equal(rowCount(db, 'ticket'), 60)
})
