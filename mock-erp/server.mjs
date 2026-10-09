// Mock Odoo-style JSON-RPC server (POST /jsonrpc) plus dev-only helper endpoints.
//   common.authenticate            -> uid | false
//   object.execute_kw              -> search_read | search_count | read
//   POST /__mutate                 -> edit / create a record (bumps write_date)
//   POST /__fail                   -> make search_read return HTTP 500 after N more calls
//   GET  /__stats                  -> request counters
// Start standalone with `npm run mock-erp`.

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { compileDomain, compileOrder } from './domain.mjs'
import { seedStore, fmt, TICKET_MODEL, MESSAGE_MODEL } from './seed.mjs'

const rpcError = (name, message) => ({
  code: 200,
  message: 'Odoo Server Error',
  data: { name, message },
})

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export function createMockErp({
  port = 0,
  db = 'demo',
  user = 'demo',
  apiKey = 'change-me',
  ticketCount = 60,
} = {}) {
  const store = seedStore({ ticketCount })
  const stats = { requests: 0, searchReads: 0 }
  let failBudget = null // null = never fail; n = allow n more search_reads then HTTP 500
  const UID = 1

  const maxWriteDate = () =>
    Object.values(store).flat().reduce((m, r) => (r.write_date > m ? r.write_date : m), '')

  const project = (rec, fields) => {
    if (!fields || !fields.length) return { ...rec }
    const out = { id: rec.id }
    for (const f of fields) if (f in rec) out[f] = rec[f]
    return out
  }

  function executeKw(model, method, args, kwargs = {}) {
    const rows = store[model]
    if (!rows) throw Object.assign(new Error(`Object ${model} does not exist`), { rpcName: 'KeyError' })
    switch (method) {
      case 'search_read': {
        stats.searchReads += 1
        const matched = rows.filter(compileDomain(args[0] || [])).sort(compileOrder(kwargs.order || 'id asc'))
        const start = kwargs.offset || 0
        const end = kwargs.limit != null ? start + kwargs.limit : undefined
        return matched.slice(start, end).map((r) => project(r, kwargs.fields))
      }
      case 'search_count':
        return rows.filter(compileDomain(args[0] || [])).length
      case 'read': {
        const ids = new Set(args[0] || [])
        return rows.filter((r) => ids.has(r.id)).map((r) => project(r, kwargs.fields))
      }
      default:
        throw Object.assign(new Error(`Unsupported method ${method}`), { rpcName: 'AttributeError' })
    }
  }

  function mutate(body) {
    const model = body.model || TICKET_MODEL
    const rows = store[model]
    if (!rows) throw new Error(`unknown model ${model}`)
    // New write_date never goes backwards, even if the host clock is behind the seed data.
    const writeDate = body.now || fmt(new Date(Math.max(Date.now(), Date.parse(`${maxWriteDate().replace(' ', 'T')}Z`))))
    if (body.action === 'create') {
      const id = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1
      const rec = { id, create_date: writeDate, ...body.values, write_date: writeDate }
      rows.push(rec)
      return rec
    }
    if (body.action === 'update') {
      const rec = rows.find((r) => r.id === body.id)
      if (!rec) throw new Error(`no ${model} with id ${body.id}`)
      Object.assign(rec, body.values, { write_date: writeDate })
      return rec
    }
    throw new Error(`unknown action ${body.action}`)
  }

  const send = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  const server = http.createServer(async (req, res) => {
    stats.requests += 1
    try {
      if (req.method === 'GET' && req.url === '/__stats') return send(res, 200, { ...stats })
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
      const body = await readJson(req)

      if (req.url === '/__mutate') return send(res, 200, mutate(body))
      if (req.url === '/__fail') {
        failBudget = body.searchReads ?? null
        return send(res, 200, { failBudget })
      }
      if (req.url !== '/jsonrpc') return send(res, 404, { error: 'not found' })

      const { service, method, args = [] } = body.params || {}
      const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: body.id, result })
      const fail = (name, message) => send(res, 200, { jsonrpc: '2.0', id: body.id, error: rpcError(name, message) })

      if (service === 'common' && method === 'authenticate') {
        const [d, u, key] = args
        return reply(d === db && u === user && key === apiKey ? UID : false)
      }
      if (service === 'object' && method === 'execute_kw') {
        const [d, uid, key, model, m, a, kw] = args
        if (d !== db || uid !== UID || key !== apiKey) return fail('odoo.exceptions.AccessDenied', 'Access Denied')
        if (m === 'search_read' && failBudget !== null) {
          if (failBudget <= 0) return send(res, 500, { error: 'injected failure' })
          failBudget -= 1
        }
        try {
          return reply(executeKw(model, m, a, kw))
        } catch (e) {
          return fail(e.rpcName || 'ValueError', e.message)
        }
      }
      return fail('odoo.exceptions.UserError', `Unknown service ${service}.${method}`)
    } catch (e) {
      send(res, 400, { error: e.message })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address()
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        store,
        stats,
        credentials: { db, username: user, apiKey },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
      })
    })
  })
}

// Standalone: node mock-erp/server.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_ERP_PORT) || 8069
  const mock = await createMockErp({
    port,
    db: process.env.ERP_DB || 'demo',
    user: process.env.ERP_USER || 'demo',
    apiKey: process.env.ERP_API_KEY || 'change-me',
  })
  console.log(`mock ERP listening on ${mock.url}/jsonrpc  (${mock.store[TICKET_MODEL].length} tickets, ${mock.store[MESSAGE_MODEL].length} messages)`)
  console.log('dev endpoints: POST /__mutate, POST /__fail, GET /__stats   (Ctrl+C to stop)')
}
