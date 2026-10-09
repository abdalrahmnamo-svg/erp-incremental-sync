import { createMockErp } from '../mock-erp/server.mjs'
import { createErpClient } from '../src/erpClient.js'
import { openDb } from '../src/db.js'

/** Start the mock ERP in-process on a random port and return a client for it. */
export async function startMock({ ticketCount = 60, pageSize = 10 } = {}) {
  const mock = await createMockErp({ port: 0, ticketCount })
  const client = createErpClient({ url: mock.url, ...mock.credentials, pageSize, timeoutMs: 5000 })
  const post = async (path, body) => {
    const res = await fetch(`${mock.url}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return res.json()
  }
  return { mock, client, post, close: () => mock.close() }
}

export const memDb = () => openDb(':memory:')
