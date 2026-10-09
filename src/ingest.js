/**
 * Per-model ingest specs: how one ERP record becomes one row, keyed by external id.
 *
 * Each spec.apply(db, rec, { dryRun }) returns 'inserted' | 'updated' | 'unchanged' | 'skipped'.
 * Change detection compares a hash of the source record, so a re-delivered record that did
 * not actually change costs a SELECT and zero writes. In dry-run mode nothing is written.
 */

import { createHash } from 'node:crypto'
import { normalizeEmail, normalizePhone } from './identity.js'

export const TICKET_MODEL = 'helpdesk.ticket'
export const MESSAGE_MODEL = 'mail.message'

/** Unwrap many2one `[id, "Label"]` tuples; map false/undefined to null. */
export function mval(v) {
  if (Array.isArray(v)) return v.length === 2 ? v[1] : v[0] ?? null
  if (v === false || v === undefined) return null
  return v
}

export function stripHtml(html) {
  if (html == null || html === false) return null
  const text = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return text || null
}

/** Stable hash of a record: key order does not matter. */
export function recordHash(rec) {
  const sorted = Object.keys(rec).sort().map((k) => [k, rec[k]])
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

/** Message direction from the author: no author = system, "Agent ..." = agent, else customer. */
export function classifyAuthor(authorField) {
  const name = mval(authorField)
  if (!name) return 'system'
  return /^agent\b/i.test(String(name)) ? 'agent' : 'customer'
}

function resolveContact(db, { name, email, phone }) {
  const emailNorm = normalizeEmail(email)
  const phoneNorm = normalizePhone(phone)
  let row = null
  if (emailNorm) row = db.prepare('SELECT id, name, phone FROM contact WHERE email_norm = ?').get(emailNorm)
  if (!row && phoneNorm) row = db.prepare('SELECT id, name, phone FROM contact WHERE phone_norm = ? AND email_norm IS NULL').get(phoneNorm)
  if (row) {
    if ((name && row.name !== name) || (phone && row.phone !== phone)) {
      db.prepare('UPDATE contact SET name = ?, phone = ? WHERE id = ?').run(name ?? row.name, phone ?? row.phone, row.id)
    }
    return Number(row.id)
  }
  if (!emailNorm && !phoneNorm) return null
  const info = db
    .prepare('INSERT INTO contact (email_norm, phone_norm, name, email, phone) VALUES (?, ?, ?, ?, ?)')
    .run(emailNorm, phoneNorm, name ?? null, email || null, phone || null)
  return Number(info.lastInsertRowid)
}

export const ticketSpec = {
  model: TICKET_MODEL,
  domain: [],
  fields: [
    'name', 'partner_id', 'partner_name', 'partner_email', 'partner_phone', 'stage_id',
    'priority', 'user_id', 'description', 'create_date', 'write_date',
  ],
  apply(db, rec, { dryRun = false } = {}) {
    if (db.prepare('SELECT 1 FROM sync_suppress WHERE external_id = ?').get(rec.id)) return 'skipped'
    const hash = recordHash(rec)
    const existing = db.prepare('SELECT src_hash FROM ticket WHERE external_id = ?').get(rec.id)
    if (existing && existing.src_hash === hash) return 'unchanged'
    if (dryRun) return existing ? 'updated' : 'inserted'

    const partnerName = rec.partner_name || mval(rec.partner_id) || null
    const contactId = resolveContact(db, {
      name: partnerName, email: rec.partner_email || null, phone: rec.partner_phone || null,
    })
    db.prepare(`
      INSERT INTO ticket (external_id, subject, contact_id, partner_name, partner_email, partner_phone,
                          stage, priority, assignee, description, created_at, write_date, src_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        subject = excluded.subject, contact_id = excluded.contact_id,
        partner_name = excluded.partner_name, partner_email = excluded.partner_email,
        partner_phone = excluded.partner_phone, stage = excluded.stage, priority = excluded.priority,
        assignee = excluded.assignee, description = excluded.description,
        created_at = excluded.created_at, write_date = excluded.write_date, src_hash = excluded.src_hash
    `).run(
      rec.id, mval(rec.name), contactId, partnerName, rec.partner_email || null, rec.partner_phone || null,
      mval(rec.stage_id), mval(rec.priority), mval(rec.user_id), stripHtml(rec.description),
      rec.create_date || null, rec.write_date, hash,
    )
    return existing ? 'updated' : 'inserted'
  },
}

export const messageSpec = {
  model: MESSAGE_MODEL,
  domain: [['model', '=', TICKET_MODEL]],
  fields: ['res_id', 'model', 'body', 'author_id', 'date', 'message_type', 'write_date'],
  apply(db, rec, { dryRun = false } = {}) {
    const hash = recordHash(rec)
    const existing = db.prepare('SELECT src_hash FROM message WHERE external_id = ?').get(rec.id)
    if (existing && existing.src_hash === hash) return 'unchanged'

    // A ticket merged away by the duplicate cleanup keeps its messages on the survivor, and a
    // message the cleanup dropped as a duplicate must not be re-inserted by a later re-read.
    const merged = db.prepare('SELECT merged_into FROM sync_suppress WHERE external_id = ?').get(rec.res_id)
    const ticketId = merged ? Number(merged.merged_into) : rec.res_id
    if (merged && !existing) {
      const twin = db.prepare(
        'SELECT 1 FROM message WHERE ticket_external_id = ? AND msg_date IS ? AND author IS ? AND body IS ?',
      ).get(ticketId, rec.date || null, mval(rec.author_id), stripHtml(rec.body))
      if (twin) return 'skipped'
    }
    if (dryRun) return existing ? 'updated' : 'inserted'

    db.prepare(`
      INSERT INTO message (external_id, ticket_external_id, body, author, direction, msg_date, write_date, src_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        ticket_external_id = excluded.ticket_external_id, body = excluded.body, author = excluded.author,
        direction = excluded.direction, msg_date = excluded.msg_date, write_date = excluded.write_date,
        src_hash = excluded.src_hash
    `).run(
      rec.id, ticketId, stripHtml(rec.body), mval(rec.author_id), classifyAuthor(rec.author_id),
      rec.date || null, rec.write_date, hash,
    )
    return existing ? 'updated' : 'inserted'
  },
}

export const SPECS = [ticketSpec, messageSpec]
