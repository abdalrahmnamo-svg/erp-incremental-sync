/**
 * Duplicate-ticket cleanup: apply and rollback.
 *
 * Each group is applied in its own transaction:
 *   reload copies -> require the SAME fingerprint as the reviewed plan -> back up everything
 *   that will change into dupe_backup -> move/drop messages -> delete the extra tickets
 *   -> record them in sync_suppress so the next sync does not resurrect them.
 * Rollback replays the backup in reverse and restores the original rows exactly.
 */

import { tx } from '../db.js'
import { fingerprint } from './plan.js'

class DryRunRollback extends Error {}

const insertRow = (db, table, row) => {
  const cols = Object.keys(row)
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]))
}

function loadCopies(db, ids) {
  const copies = []
  for (const id of ids) {
    const ticket = db.prepare('SELECT * FROM ticket WHERE external_id = ?').get(id)
    if (!ticket) return null
    const messages = db.prepare('SELECT * FROM message WHERE ticket_external_id = ? ORDER BY msg_date, external_id').all(id)
    copies.push({ ticket: { ...ticket }, messages: messages.map((m) => ({ ...m })) })
  }
  return copies
}

export function applyGroup(db, planId, group, { dryRun = false } = {}) {
  const base = { key: group.key, keepId: group.keepId, removed: group.removeIds }
  const ids = [group.keepId, ...group.removeIds]
  try {
    return tx(db, () => {
      if (db.prepare('SELECT 1 FROM dupe_backup WHERE plan_id = ? AND group_key = ? AND status = ?').get(planId, group.key, 'applied')) {
        return { ...base, status: 'skipped', reason: 'already applied' }
      }
      const copies = loadCopies(db, ids)
      if (!copies) return { ...base, status: 'skipped', reason: 'a copy no longer exists' }
      if (fingerprint(copies) !== group.fingerprint) {
        return { ...base, status: 'skipped', reason: 'data changed since the plan was made; re-run dupes:plan' }
      }

      const removed = copies.filter((c) => group.removeIds.includes(c.ticket.external_id))
      const backup = {
        keepId: group.keepId,
        tickets: removed.map((c) => c.ticket),
        // every message currently attached to a removed ticket, as it was
        messages: removed.flatMap((c) => c.messages),
        moved: removed.flatMap((c) => c.messages)
          .filter((m) => group.moveMessageIds.includes(m.external_id))
          .map((m) => ({ id: m.external_id, from: m.ticket_external_id })),
      }
      db.prepare('INSERT INTO dupe_backup (plan_id, group_key, status, applied_at, payload) VALUES (?, ?, ?, ?, ?)')
        .run(planId, group.key, 'applied', new Date().toISOString(), JSON.stringify(backup))

      for (const id of group.moveMessageIds) {
        db.prepare('UPDATE message SET ticket_external_id = ? WHERE external_id = ?').run(group.keepId, id)
      }
      for (const rid of group.removeIds) {
        db.prepare('DELETE FROM message WHERE ticket_external_id = ?').run(rid)
        db.prepare('DELETE FROM ticket WHERE external_id = ?').run(rid)
        db.prepare('INSERT OR REPLACE INTO sync_suppress (external_id, merged_into) VALUES (?, ?)').run(rid, group.keepId)
      }

      const summary = { ...base, status: 'applied', moved: group.moveMessageIds.length, dropped: group.dropMessageIds.length }
      if (dryRun) throw Object.assign(new DryRunRollback('dry run'), { summary: { ...summary, status: 'dry-run-ok' } })
      return summary
    })
  } catch (e) {
    if (e instanceof DryRunRollback) return e.summary
    return { ...base, status: 'failed', reason: e.message }
  }
}

export function applyPlan(db, plan, opts = {}) {
  return plan.groups.map((g) => applyGroup(db, plan.planId, g, opts))
}

export function rollbackPlan(db, plan) {
  const rows = db
    .prepare("SELECT group_key, payload FROM dupe_backup WHERE plan_id = ? AND status = 'applied' ORDER BY applied_at DESC, rowid DESC")
    .all(plan.planId)
  const results = []
  for (const row of rows) {
    const backup = JSON.parse(row.payload)
    try {
      tx(db, () => {
        for (const t of backup.tickets) insertRow(db, 'ticket', t)
        for (const m of backup.moved) {
          db.prepare('UPDATE message SET ticket_external_id = ? WHERE external_id = ?').run(m.from, m.id)
        }
        for (const m of backup.messages) insertRow(db, 'message', m)
        for (const t of backup.tickets) db.prepare('DELETE FROM sync_suppress WHERE external_id = ?').run(t.external_id)
        db.prepare("UPDATE dupe_backup SET status = 'rolled_back' WHERE plan_id = ? AND group_key = ?").run(plan.planId, row.group_key)
      })
      results.push({ key: row.group_key, status: 'rolled_back' })
    } catch (e) {
      results.push({ key: row.group_key, status: 'failed', reason: e.message })
    }
  }
  return results
}
