#!/usr/bin/env node
// Read-only: finds duplicate tickets in the target DB and writes a JSON plan to output/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { openDb } from '../src/db.js'
import { buildPlan } from '../src/dupes/plan.js'
import { dbPath, outputDir } from '../src/cli.js'

const db = openDb(dbPath(), { readOnly: true })
const plan = buildPlan(db)
db.close()

mkdirSync(outputDir(), { recursive: true })
const file = join(outputDir(), `dupes-plan-${plan.planId}.json`)
writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`)

console.log(`Duplicate groups: ${plan.summary.groups}`)
for (const g of plan.groups) {
  console.log(`  keep #${g.keepId}, remove ${g.removeIds.map((i) => `#${i}`).join(', ')} | move ${g.moveMessageIds.length} message(s), drop ${g.dropMessageIds.length} duplicate message(s)`)
}
console.log(`Plan written to ${relative(process.cwd(), file)}`)
console.log('Review it, then: npm run dupes:apply -- <plan>   (add --dry-run to rehearse and roll back)')
