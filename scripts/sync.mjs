#!/usr/bin/env node
/**
 * ERP -> SQLite incremental sync.
 *
 *   npm run sync -- --dry-run            plan only; writes nothing (not even the cursor)
 *   npm run sync                         fetch changed rows since the stored cursor and commit
 *   npm run sync -- --since 2026-01-01   ignore the cursor and re-read everything changed since a date
 */
import { createErpClient, erpConfigFromEnv, ErpError } from '../src/erpClient.js'
import { openDb, rowCount } from '../src/db.js'
import { runSync } from '../src/sync.js'
import { normalizeSince } from '../src/identity.js'
import { relative } from 'node:path'
import { parseArgs, dbPath } from '../src/cli.js'

const fmtCursor = (c) => (c ? `${c.write_date} #${c.id}` : '(none)')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dryRun = args['dry-run'] === true
  const config = erpConfigFromEnv()
  const pageSize = args['page-size'] ? Math.max(1, Number(args['page-size'])) : config.pageSize
  const since = args.since && args.since !== true ? normalizeSince(args.since) : null
  const path = dbPath()

  const client = createErpClient(config)
  const uid = await client.authenticate()
  console.log(`ERP sync${dryRun ? ' (DRY RUN: nothing will be written)' : ''}`)
  console.log(`Connected as uid ${uid} (${config.url}, db ${config.db}); target ${dryRun ? '(read-only) ' : ''}${relative(process.cwd(), path) || path}`)
  console.log(`Start: ${since ? `--since ${since} (stored cursor ignored)` : 'stored cursor minus overlap'} | page size ${pageSize} | overlap ${config.overlapSeconds}s\n`)

  const db = openDb(path, { readOnly: dryRun })
  try {
    const results = await runSync({ db, client, dryRun, since, pageSize, overlapSeconds: config.overlapSeconds })
    const verb = dryRun ? 'would ' : ''
    for (const r of results) {
      console.log(r.model)
      console.log(`  cursor  ${fmtCursor(r.cursorBefore)}  ->  ${fmtCursor(r.cursorAfter)}${dryRun ? '  (not saved)' : ''}`)
      console.log(`  pages ${r.pages} | fetched ${r.fetched} | ${verb}insert ${r.inserted} | ${verb}update ${r.updated} | unchanged ${r.unchanged} | skipped ${r.skipped}`)
    }
    const changes = results.reduce((n, r) => n + r.inserted + r.updated, 0)
    console.log(`\n${changes === 0 ? 'Nothing to do: target is up to date.' : `${dryRun ? 'Plan' : 'Done'}: ${changes} row(s) ${dryRun ? 'would change' : 'written'}.`}`)
    if (!dryRun) console.log(`Target now holds ${rowCount(db, 'ticket')} tickets, ${rowCount(db, 'message')} messages.`)
    else console.log('Re-run without --dry-run to apply.')
  } finally {
    db.close()
  }
}

main().catch((e) => {
  console.error(e instanceof ErpError ? `Sync failed [${e.code}]: ${e.message}` : `Sync failed: ${e.message}`)
  process.exit(1)
})
