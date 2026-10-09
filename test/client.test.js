import test from 'node:test'
import assert from 'node:assert/strict'
import { createErpClient, ErpError } from '../src/erpClient.js'
import { startMock } from './helpers.js'

test('mock ERP: authenticate, search_read filters, limit/offset/order', async (t) => {
  const { mock, client, close } = await startMock()
  t.after(close)

  assert.equal(await client.authenticate(), 1)

  const all = await client.searchRead('helpdesk.ticket', [], ['name'], { order: 'id asc' })
  assert.equal(all.length, 60)

  const gt = await client.searchRead('helpdesk.ticket', [['id', '>', 55]], ['name'], { order: 'id asc' })
  assert.deepEqual(gt.map((r) => r.id), [56, 57, 58, 59, 60])

  const page = await client.searchRead('helpdesk.ticket', [], ['name'], { order: 'id desc', limit: 3, offset: 2 })
  assert.deepEqual(page.map((r) => r.id), [58, 57, 56])

  const first = mock.store['helpdesk.ticket'][0].write_date
  const ge = await client.searchRead('helpdesk.ticket', [['write_date', '>=', first]], ['write_date'])
  const g = await client.searchRead('helpdesk.ticket', [['write_date', '>', first]], ['write_date'])
  assert.equal(ge.length, 60)
  assert.equal(g.length, 54) // the first write_date is shared by 6 tickets

  assert.equal(await client.searchCount('helpdesk.ticket', [['write_date', '=', first]]), 6)
  const fields = await client.searchRead('helpdesk.ticket', [['id', '=', 1]], ['name'])
  assert.deepEqual(Object.keys(fields[0]).sort(), ['id', 'name'])
})

test('mock ERP: wrong API key is rejected', async (t) => {
  const { mock, close } = await startMock()
  t.after(close)
  const bad = createErpClient({ url: mock.url, db: 'demo', username: 'demo', apiKey: 'wrong', pageSize: 10, timeoutMs: 2000 })
  await assert.rejects(bad.authenticate(), (e) => e instanceof ErpError && e.code === 'ERP_AUTH_FAILED')
})

test('client: unreachable host surfaces a clear error', async () => {
  const c = createErpClient({ url: 'http://127.0.0.1:1', db: 'd', username: 'u', apiKey: 'k', pageSize: 10, timeoutMs: 2000 })
  await assert.rejects(c.authenticate(), (e) => e instanceof ErpError && e.code === 'ERP_UNREACHABLE')
})
