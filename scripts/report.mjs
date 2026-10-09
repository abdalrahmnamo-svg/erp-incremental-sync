#!/usr/bin/env node
// Prints a masked summary of the synced data (uses the projection layer).
import { openDb, rowCount } from '../src/db.js'
import { projectTicket } from '../src/projection.js'
import { parseArgs, dbPath } from '../src/cli.js'

const args = parseArgs(process.argv.slice(2))
const db = openDb(dbPath(), { readOnly: true })
const reveal = args.reveal === true
const limit = Number(args.limit) || 5

console.log(`tickets ${rowCount(db, 'ticket')} | messages ${rowCount(db, 'message')} | contacts ${rowCount(db, 'contact')}`)
const rows = db.prepare('SELECT * FROM ticket ORDER BY external_id LIMIT ?').all(limit)
for (const t of rows) {
  const msgs = db.prepare('SELECT * FROM message WHERE ticket_external_id = ?').all(t.external_id)
  console.log(JSON.stringify(projectTicket(t, msgs, { reveal })))
}
db.close()
