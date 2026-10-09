/**
 * Minimal Odoo-style External API client (JSON-RPC over Node's built-in fetch).
 *
 * Credentials come only from the environment (see .env.example) and are never logged.
 * The defaults match the mock server so the demo works without a .env file.
 */

export class ErpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'ErpError'
    this.code = code
    this.data = data
  }
}

export function erpConfigFromEnv(env = process.env) {
  const url = String(env.ERP_URL || 'http://localhost:8069').trim().replace(/\/+$/, '')
  const db = String(env.ERP_DB || 'demo').trim()
  const username = String(env.ERP_USER || 'demo').trim()
  const apiKey = String(env.ERP_API_KEY || 'change-me').trim()
  const pageSize = Math.max(1, Math.floor(Number(env.SYNC_PAGE_SIZE) || 50))
  const overlapSeconds = Math.max(0, Number(env.SYNC_OVERLAP_SECONDS ?? 2) || 0)
  const timeoutMs = Math.max(1_000, Number(env.ERP_TIMEOUT_MS) || 30_000)
  return { url, db, username, apiKey, pageSize, overlapSeconds, timeoutMs }
}

export function createErpClient(config = erpConfigFromEnv()) {
  const { url, db, username, apiKey, timeoutMs } = config
  let uid = null

  async function jsonRpc(service, method, args) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetch(`${url}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
        signal: controller.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ErpError(`ERP request timed out after ${timeoutMs}ms (${service}.${method}).`, { code: 'ERP_TIMEOUT' })
      }
      throw new ErpError(`Could not reach the ERP at ${url}. (${err?.message || err})`, { code: 'ERP_UNREACHABLE' })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw new ErpError(`ERP HTTP ${res.status} on ${service}.${method}.`, { code: `HTTP_${res.status}` })
    const body = await res.json().catch(() => ({}))
    if (body.error) {
      const data = body.error.data || {}
      const msg = data.message || body.error.message || 'ERP RPC error'
      const isAccess = /AccessError|AccessDenied/i.test(data.name || '')
      throw new ErpError(msg, { code: isAccess ? 'ERP_AUTH_FAILED' : 'ERP_RPC_ERROR', data })
    }
    return body.result
  }

  async function authenticate() {
    if (uid) return uid
    const result = await jsonRpc('common', 'authenticate', [db, username, apiKey, {}])
    if (!result) {
      throw new ErpError(`Authentication failed for user "${username}" on db "${db}".`, { code: 'ERP_AUTH_FAILED' })
    }
    uid = result
    return uid
  }

  async function executeKw(model, method, args = [], kwargs = {}) {
    const id = await authenticate()
    return jsonRpc('object', 'execute_kw', [db, id, apiKey, model, method, args, kwargs])
  }

  /** One page of search_read. Keyset pagination is done by the caller via the domain. */
  async function searchRead(model, domain = [], fields = [], { limit, offset = 0, order } = {}) {
    const kwargs = { fields }
    if (limit != null) kwargs.limit = limit
    if (offset) kwargs.offset = offset
    if (order) kwargs.order = order
    return executeKw(model, 'search_read', [domain], kwargs)
  }

  const searchCount = (model, domain = []) => executeKw(model, 'search_count', [domain])

  return {
    config: { url, db, username, pageSize: config.pageSize, timeoutMs }, // apiKey intentionally omitted
    authenticate,
    executeKw,
    searchRead,
    searchCount,
  }
}
