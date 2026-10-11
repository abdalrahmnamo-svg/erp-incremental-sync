#!/usr/bin/env node
/**
 * One-shot demo: start the mock ERP in-process, land it into a warehouse's `raw` schema,
 * edit a few ERP records, land again, then print the run log.
 *
 *   node scripts/land-to-warehouse.mjs --warehouse ../support-analytics-warehouse/warehouse/support.duckdb
 *
 * Options: --id-offset N (default 900000; keeps ERP ids clear of ids already in the
 * warehouse's raw tables), --no-mutate (land once only).
 *
 * Afterwards, rebuild the warehouse: cd ../support-analytics-warehouse/dbt && dbt build
 */
import { createMockErp } from '../mock-erp/server.mjs'
import { createErpClient } from '../src/erpClient.js'
import { openWarehouse, runLand } from '../src/warehouse/land.js'
import { parseArgs, warehousePath } from '../src/cli.js'

const args = parseArgs(process.argv.slice(2))
const path = warehousePath(args)
const idOffset = Number(args['id-offset'] ?? 900000) || 0

const mock = await createMockErp({ port: 0 })
const client = createErpClient({ url: mock.url, ...mock.credentials, pageSize: 50, timeoutMs: 10_000 })
const post = (body) => fetch(`${mock.url}/__mutate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

const wh = await openWarehouse(path)
try {
  const summarize = (label, { batchId, results }) => {
    const n = results.reduce((a, r) => a + r.appended, 0)
    console.log(`${label}: batch ${batchId}, ${results.map((r) => `${r.table} +${r.appended}`).join(', ')} (${n} rows)`)
  }
  summarize('first load ', await runLand({ conn: wh.conn, client, idOffset }))
  if (args['no-mutate'] !== true) {
    await post({ action: 'update', model: 'helpdesk.ticket', id: 5, values: { stage_id: [3, 'Waiting'] } })
    const created = await post({
      action: 'create', model: 'helpdesk.ticket',
      values: {
        stage_id: [1, 'New'], priority: '1', user_id: false, x_customer_ref: 'CUST-0999', x_external_ref: 'EXT-00009001',
        x_channel: 'email', x_category: 'billing', x_first_response_at: false, x_resolved_at: false,
      },
    })
    await post({
      action: 'create', model: 'mail.message',
      values: { model: 'helpdesk.ticket', res_id: created.id, body: '<p>First message.</p>', author_id: [1999, 'Customer 0999'], date: created.write_date, message_type: 'comment' },
    })
    summarize('second load', await runLand({ conn: wh.conn, client, idOffset }))
  }
  const log = (await wh.conn.runAndReadAll(
    'SELECT batch_id, model, fetched, appended, cursor_after, status FROM raw._sync_runs ORDER BY started_at, model')).getRowObjectsJson()
  console.log('\nraw._sync_runs')
  console.table(log)
  console.log(`Warehouse: ${path}\nNext: cd <warehouse repo>/dbt && dbt build`)
} finally {
  wh.close()
  await mock.close()
}
