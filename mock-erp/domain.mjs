// Minimal Odoo domain evaluator: leaf triples, prefix operators '&', '|', '!'.
// Top-level terms are AND-ed (Odoo's implicit '&').

const OPS = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  in: (a, b) => b.includes(a),
  'not in': (a, b) => !b.includes(a),
}

export function compileDomain(domain = []) {
  let i = 0
  const term = () => {
    if (i >= domain.length) throw new Error('malformed domain: operator without operand')
    const t = domain[i++]
    if (t === '&') { const a = term(); const b = term(); return (r) => a(r) && b(r) }
    if (t === '|') { const a = term(); const b = term(); return (r) => a(r) || b(r) }
    if (t === '!') { const a = term(); return (r) => !a(r) }
    if (!Array.isArray(t) || t.length !== 3) throw new Error(`malformed domain leaf: ${JSON.stringify(t)}`)
    const [field, op, value] = t
    const fn = OPS[op]
    if (!fn) throw new Error(`unsupported operator: ${op}`)
    return (r) => fn(r[field], value)
  }
  const terms = []
  while (i < domain.length) terms.push(term())
  return (r) => terms.every((f) => f(r))
}

/** "write_date asc, id asc" -> comparator. */
export function compileOrder(order) {
  if (!order) return () => 0
  const keys = String(order).split(',').map((p) => {
    const [field, dir = 'asc'] = p.trim().split(/\s+/)
    return { field, sign: dir.toLowerCase() === 'desc' ? -1 : 1 }
  })
  return (a, b) => {
    for (const { field, sign } of keys) {
      if (a[field] < b[field]) return -sign
      if (a[field] > b[field]) return sign
    }
    return 0
  }
}
