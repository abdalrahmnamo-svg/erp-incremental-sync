/**
 * ERP record -> raw-contract row. Pure functions, no I/O.
 * Conversion is value-level only (labels, nulls, id namespace); nothing is cleaned or
 * deduplicated here: the warehouse's staging layer owns that.
 */
import { mval, stripHtml, classifyAuthor, TICKET_MODEL, MESSAGE_MODEL } from '../ingest.js'

const PRIORITY = { 0: 'low', 1: 'normal', 2: 'high', 3: 'urgent' }
const STAGE = { New: 'open', 'In Progress': 'open', Waiting: 'pending', Solved: 'solved' }

const orNull = (v) => (v === false || v === undefined || v === '' ? null : v)
const idOf = (v) => (Array.isArray(v) ? v[0] : orNull(v))

export const ticketLandSpec = {
  model: TICKET_MODEL,
  table: 'tickets',
  domain: [],
  fields: [
    'stage_id', 'priority', 'user_id', 'create_date', 'write_date',
    'x_external_ref', 'x_customer_ref', 'x_channel', 'x_category', 'x_first_response_at', 'x_resolved_at',
  ],
  /** Values in contract order, without _loaded_at / _batch_id. */
  toRow(rec, { idOffset = 0 } = {}) {
    const stage = mval(rec.stage_id)
    const agent = idOf(rec.user_id)
    return [
      rec.id + idOffset,
      orNull(rec.x_external_ref),
      orNull(rec.x_customer_ref),
      orNull(rec.x_channel),
      orNull(rec.x_category),
      PRIORITY[rec.priority] ?? null,
      STAGE[stage] ?? (stage ? String(stage).toLowerCase() : null),
      orNull(rec.create_date),
      orNull(rec.x_first_response_at),
      orNull(rec.x_resolved_at),
      agent == null ? null : Number(agent),
      rec.write_date,
    ]
  },
}

export const messageLandSpec = {
  model: MESSAGE_MODEL,
  table: 'messages',
  domain: [['model', '=', TICKET_MODEL]],
  fields: ['res_id', 'model', 'body', 'author_id', 'date', 'message_type', 'write_date'],
  toRow(rec, { idOffset = 0 } = {}) {
    return [
      rec.id + idOffset,
      rec.res_id + idOffset,
      classifyAuthor(rec.author_id),
      orNull(rec.date),
      (stripHtml(rec.body) ?? '').length,
      rec.write_date,
    ]
  },
}

export const LAND_SPECS = [ticketLandSpec, messageLandSpec]
