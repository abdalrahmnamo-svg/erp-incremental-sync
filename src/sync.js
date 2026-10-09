/**
 * Incremental sync core.
 *
 *   cursor (write_date, id) -> fetch one page (keyset, ordered) -> upsert by external id
 *   -> advance the cursor in the SAME transaction -> next page
 *
 * Each run starts from an inclusive lookback window (stored write_date minus an overlap) so
 * late-committing rows and same-second edits are re-read; upserts make the re-read free of
 * writes. Within a run, paging is keyset on (write_date, id).
 *
 * The cursor only moves when the page it describes has committed. A crash or error
 * mid-run therefore leaves the cursor at the last fully-committed page, and the next run
 * resumes from there; upserts make any re-delivery harmless.
 */

import { tx } from './db.js'
import { SPECS } from './ingest.js'
import { parseErpDate } from './identity.js'

export const DEFAULT_OVERLAP_SECONDS = 2

export const ORDER = 'write_date asc, id asc'

const after = (a, b) => a.write_date > b.write_date || (a.write_date === b.write_date && a.id > b.id)

/** Rows strictly after (write_date, id): the id breaks ties between identical write_dates. */
export function keysetDomain(pos) {
  return ['|', ['write_date', '>', pos.write_date], '&', ['write_date', '=', pos.write_date], ['id', '>', pos.id]]
}

export function readCursor(db, model) {
  const r = db.prepare('SELECT last_write_date, last_id FROM sync_cursor WHERE model = ?').get(model)
  return r ? { write_date: r.last_write_date, id: Number(r.last_id) } : null
}

/** Monotonic: a --since re-read of old data never moves the cursor backwards. */
function advanceCursor(db, model, pos) {
  const cur = readCursor(db, model)
  if (cur && !after(pos, cur)) return
  db.prepare(`
    INSERT INTO sync_cursor (model, last_write_date, last_id) VALUES (?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET last_write_date = excluded.last_write_date, last_id = excluded.last_id
  `).run(model, pos.write_date, pos.id)
}

/** ERP-format datetime minus N seconds. */
export function minusSeconds(erpDate, seconds) {
  const d = parseErpDate(erpDate)
  return new Date(d.getTime() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

export async function syncModel({
  db, client, spec, dryRun = false, since = null, pageSize = 50, overlapSeconds = DEFAULT_OVERLAP_SECONDS, onPage,
}) {
  const stored = readCursor(db, spec.model)
  let cursor = stored
  // --since replaces the stored cursor as the starting point. Otherwise start from the
  // inclusive window [cursor.write_date - overlap, ...); paging then continues by keyset.
  const startDomain = since
    ? [['write_date', '>=', since]]
    : stored ? [['write_date', '>=', minusSeconds(stored.write_date, overlapSeconds)]] : []
  let pos = null
  const totals = {
    model: spec.model, pages: 0, fetched: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0,
    cursorBefore: stored, cursorAfter: stored,
  }

  for (;;) {
    const domain = [...spec.domain, ...(pos ? keysetDomain(pos) : startDomain)]
    const page = await client.searchRead(spec.model, domain, spec.fields, { limit: pageSize, order: ORDER })
    if (!page.length) break
    const last = page[page.length - 1]
    const lastPos = { write_date: last.write_date, id: last.id }

    const classify = () => {
      for (const rec of page) totals[spec.apply(db, rec, { dryRun })] += 1
    }
    if (dryRun) classify()
    else tx(db, () => { classify(); advanceCursor(db, spec.model, lastPos) })

    totals.pages += 1
    totals.fetched += page.length
    pos = lastPos
    if (!cursor || after(lastPos, cursor)) cursor = lastPos
    totals.cursorAfter = cursor
    if (onPage) onPage({ model: spec.model, page: totals.pages, fetched: totals.fetched })
    if (page.length < pageSize) break
  }
  return totals
}

/** Sync every model in dependency order (tickets, then messages). */
export async function runSync({ db, client, dryRun = false, since = null, pageSize = 50, overlapSeconds = DEFAULT_OVERLAP_SECONDS, onPage }) {
  await client.authenticate()
  const results = []
  for (const spec of SPECS) results.push(await syncModel({ db, client, spec, dryRun, since, pageSize, overlapSeconds, onPage }))
  return results
}
