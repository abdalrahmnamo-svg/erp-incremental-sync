#!/usr/bin/env node
// Restores the exact pre-apply rows for a plan from dupe_backup.
import { readFileSync } from 'node:fs'
import { openDb } from '../src/db.js'
import { rollbackPlan } from '../src/dupes/apply.js'
import { parseArgs, dbPath } from '../src/cli.js'

const args = parseArgs(process.argv.slice(2))
const file = args._[0]
if (!file) { console.error('usage: npm run dupes:rollback -- <plan.json>'); process.exit(2) }
const plan = JSON.parse(readFileSync(file, 'utf8'))

const db = openDb(dbPath())
const results = rollbackPlan(db, plan)
db.close()

for (const r of results) console.log(`${r.status.padEnd(12)} ${r.key}${r.reason ? ` (${r.reason})` : ''}`)
console.log(results.length ? `Rolled back plan ${plan.planId}.` : `Nothing to roll back for plan ${plan.planId}.`)
if (results.some((r) => r.status === 'failed')) process.exitCode = 1
