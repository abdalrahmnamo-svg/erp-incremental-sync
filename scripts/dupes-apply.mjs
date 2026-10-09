#!/usr/bin/env node
// Applies a reviewed plan group by group (one transaction each). --dry-run rolls every group back.
import { readFileSync } from 'node:fs'
import { openDb } from '../src/db.js'
import { applyPlan } from '../src/dupes/apply.js'
import { parseArgs, dbPath } from '../src/cli.js'

const args = parseArgs(process.argv.slice(2))
const file = args._[0]
if (!file) { console.error('usage: npm run dupes:apply -- <plan.json> [--dry-run]'); process.exit(2) }
const plan = JSON.parse(readFileSync(file, 'utf8'))
const dryRun = args['dry-run'] === true

const db = openDb(dbPath())
const results = applyPlan(db, plan, { dryRun })
db.close()

for (const r of results) {
  console.log(`${r.status.padEnd(10)} keep #${r.keepId} remove ${r.removed.map((i) => `#${i}`).join(', ')}${r.reason ? ` (${r.reason})` : ''}`)
}
console.log(dryRun ? 'Dry run: everything rolled back.' : `Applied plan ${plan.planId}. Undo with: npm run dupes:rollback -- ${file}`)
if (results.some((r) => r.status === 'failed')) process.exitCode = 1
