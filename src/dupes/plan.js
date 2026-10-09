/**
 * Duplicate-ticket cleanup: planning (read-only).
 *
 * Some ERPs end up with the same support request twice under different ids (double submit,
 * import retry). Two tickets are "the same request" when they share the customer identity
 * (normalized email, else phone), the normalized subject and the creation timestamp.
 *
 * Per group: keep the copy with the most messages (ties: lowest id), move the messages the
 * keeper lacks onto it, drop messages the keeper already has, delete the other copies.
 * Nothing here writes; the plan is a JSON file a human reviews before `dupes:apply`.
 */

import { createHash } from 'node:crypto'
import { normalizeName } from '../identity.js'

export const PLAN_VERSION = 1

/** Identity of a message across copies. */
export const messageKey = (m) => `${m.msg_date}|${m.author}|${m.body}`

/** Load every ticket that has a usable identity, grouped by duplicate key. */
export function loadGroups(db) {
  const tickets = db.prepare(`
    SELECT t.*, c.email_norm, c.phone_norm
    FROM ticket t LEFT JOIN contact c ON c.id = t.contact_id
    ORDER BY t.external_id
  `).all()
  const messagesOf = db.prepare('SELECT * FROM message WHERE ticket_external_id = ? ORDER BY msg_date, external_id')
  const groups = new Map()
  for (const t of tickets) {
    const who = t.email_norm || t.phone_norm
    const subject = normalizeName(t.subject)
    if (!who || !subject || !t.created_at) continue
    const key = `${who}|${subject}|${t.created_at}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ticket: { ...t }, messages: messagesOf.all(t.external_id).map((m) => ({ ...m })) })
  }
  return [...groups].filter(([, copies]) => copies.length > 1).map(([key, copies]) => ({ key, copies }))
}

/** Detects whether a group changed after it was planned (apply refuses a stale plan). */
export function fingerprint(copies) {
  const sorted = [...copies].sort((a, b) => a.ticket.external_id - b.ticket.external_id)
  const material = sorted.map((c) => [
    c.ticket.external_id, c.ticket.src_hash,
    c.messages.map((m) => [m.external_id, m.src_hash, m.ticket_external_id]),
  ])
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export function planGroup({ key, copies }) {
  const ranked = [...copies].sort(
    (a, b) => b.messages.length - a.messages.length || a.ticket.external_id - b.ticket.external_id,
  )
  const [keep, ...others] = ranked
  const have = new Set(keep.messages.map(messageKey))
  const move = []
  const drop = []
  for (const copy of others) {
    for (const m of copy.messages) {
      const k = messageKey(m)
      if (have.has(k)) drop.push(m.external_id)
      else { have.add(k); move.push(m.external_id) }
    }
  }
  return {
    key,
    keepId: keep.ticket.external_id,
    removeIds: others.map((c) => c.ticket.external_id).sort((a, b) => a - b),
    moveMessageIds: move,
    dropMessageIds: drop,
    fingerprint: fingerprint(copies),
  }
}

export function buildPlan(db) {
  const groups = loadGroups(db).map(planGroup).sort((a, b) => a.keepId - b.keepId)
  const body = { version: PLAN_VERSION, groups }
  const planId = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)
  return {
    version: PLAN_VERSION,
    planId,
    createdAt: new Date().toISOString(),
    summary: {
      groups: groups.length,
      ticketsToRemove: groups.reduce((n, g) => n + g.removeIds.length, 0),
      messagesToMove: groups.reduce((n, g) => n + g.moveMessageIds.length, 0),
      messagesToDrop: groups.reduce((n, g) => n + g.dropMessageIds.length, 0),
    },
    groups,
  }
}
