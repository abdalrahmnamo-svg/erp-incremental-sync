#!/usr/bin/env node
// Dev helper for the demo: edits two tickets and creates one ticket + message in the
// running mock ERP, so the next `npm run sync` has exactly 3 tickets + 1 message to pick up.
import { erpConfigFromEnv } from '../src/erpClient.js'

const { url } = erpConfigFromEnv()

async function post(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

try {
  const a = await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 3, values: { stage_id: [4, 'Solved'] } })
  const b = await post('/__mutate', { action: 'update', model: 'helpdesk.ticket', id: 9, values: { priority: '2' } })
  const c = await post('/__mutate', {
    action: 'create', model: 'helpdesk.ticket',
    values: {
      name: 'New request from the demo (#9001)', partner_id: [1999, 'Customer 0999'], partner_name: 'Customer 0999',
      partner_email: 'customer0999@example.com', partner_phone: '+1-555-0199', stage_id: [1, 'New'],
      priority: '1', user_id: false, description: '<p>Created by mutate.mjs.</p>',
    },
  })
  const m = await post('/__mutate', {
    action: 'create', model: 'mail.message',
    values: {
      model: 'helpdesk.ticket', res_id: c.id, body: '<p>First message of the new ticket.</p>',
      author_id: [1999, 'Customer 0999'], date: c.write_date, message_type: 'comment',
    },
  })
  console.log(`mutated: ticket #${a.id} (stage), ticket #${b.id} (priority), new ticket #${c.id}, new message #${m.id}`)
} catch (e) {
  console.error(`mutate failed: ${e.message} (is the mock ERP running? npm run mock-erp)`)
  process.exit(1)
}
