// Deterministic synthetic data for the mock ERP. No randomness: the same call always
// yields the same records, so tests and the README demo are reproducible.

const STAGES = [[1, 'New'], [2, 'In Progress'], [3, 'Waiting'], [4, 'Solved']]
const AGENTS = [[1, 'Agent Alpha'], [2, 'Agent Beta'], [3, 'Agent Gamma']]
const CHANNELS = ['chat', 'email', 'phone']
const CATEGORIES = ['billing', 'technical_issue', 'delivery', 'general_inquiry', 'account_access', 'returns_refunds']
const SUBJECTS = [
  'Cannot log in', 'Invoice question', 'Export is slow',
  'Update billing address', 'Feature request: dark mode', 'Password reset loop',
]
const pad = (n, w) => String(n).padStart(w, '0')

export const TICKET_MODEL = 'helpdesk.ticket'
export const MESSAGE_MODEL = 'mail.message'

/** Date -> Odoo-style UTC "YYYY-MM-DD HH:MM:SS". */
export function fmt(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}
// Accepts both ISO ('...T...Z') and Odoo-style ('YYYY-MM-DD HH:MM:SS', UTC) strings; the latter must
// not be parsed as local time or the data would shift with the machine's timezone.
const at = (iso, plusMinutes) => fmt(new Date(Date.parse(/[TZ]/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`) + plusMinutes * 60_000))

function customer(c) {
  return {
    partner_id: [1000 + c, `Customer ${pad(c, 4)}`],
    partner_name: `Customer ${pad(c, 4)}`,
    partner_email: `customer${pad(c, 4)}@example.com`,
    partner_phone: `+1-555-01${pad(c % 100, 2)}`,
  }
}

/**
 * Builds { 'helpdesk.ticket': [...], 'mail.message': [...] }.
 * - write_date is shared by groups of 6 tickets (deliberate ties for the id tiebreak).
 * - the last 3 tickets are ERP-side duplicates of tickets 6, 12 and 18.
 */
export function seedStore({ ticketCount = 60 } = {}) {
  const tickets = []
  const messages = []
  let msgId = 0
  const addMsg = (ticketId, k, date, writeDate, ticketCustomer, body, system = false, agentReplies = true) => {
    const agentSide = agentReplies && k % 2 === 1
    messages.push({
      id: ++msgId,
      model: TICKET_MODEL,
      res_id: ticketId,
      body,
      author_id: system ? false : agentSide ? AGENTS[ticketId % 3] : ticketCustomer.partner_id,
      date,
      message_type: system ? 'notification' : 'comment',
      write_date: writeDate,
    })
  }

  const dupOf = ticketCount >= 23 ? [6, 12, 18] : []
  const regular = ticketCount - dupOf.length

  for (let i = 1; i <= regular; i++) {
    const c = ((i * 7) % 40) + 1
    const cust = customer(c)
    const createDate = at('2026-01-01T00:00:00Z', i * 180)
    const writeDate = at('2026-02-01T00:00:00Z', Math.floor((i - 1) / 6) * 60)
    const stage = STAGES[i % 4]
    const answered = i % 9 !== 0 // every 9th ticket has no first response yet
    tickets.push({
      id: i,
      name: `${SUBJECTS[i % 6]} (#${pad(i, 4)})`,
      ...cust,
      stage_id: stage,
      priority: String(i % 3),
      user_id: i % 4 === 0 ? false : AGENTS[i % 3],
      description: `<p>Synthetic description for ticket ${i}.</p>`,
      // x_* are custom fields (the Odoo naming convention) feeding the warehouse landing contract.
      x_customer_ref: `CUST-${pad(c, 4)}`,
      x_external_ref: `EXT-${pad(i * 7919, 8)}`,
      x_channel: CHANNELS[i % 3],
      x_category: CATEGORIES[i % 6],
      x_first_response_at: answered ? at(createDate, 20) : false, // = the first agent message (k=1)
      x_resolved_at: stage[0] === 4 ? at(createDate, 300 + i) : false,
      create_date: createDate,
      write_date: writeDate,
    })
    const n = 2 + (i % 3)
    for (let k = 0; k < n; k++) {
      addMsg(i, k, at(createDate, (k + 1) * 10), writeDate, cust, `<p>Message ${k + 1} for ticket ${i}.</p>`, false, answered)
    }
    if (stage[0] === 4) addMsg(i, 9, at(createDate, 200), writeDate, cust, '<p>Ticket closed.</p>', true)
  }

  dupOf.forEach((orig, j) => {
    const o = tickets.find((t) => t.id === orig)
    const id = regular + j + 1
    const writeDate = at('2026-02-01T00:00:00Z', Math.floor((id - 1) / 6) * 60)
    tickets.push({ ...o, id, write_date: writeDate })
    const origMsgs = messages.filter((m) => m.res_id === orig)
    // The first duplicate carries one shared message plus one unique message, the second
    // only a shared message, the third the same two messages as its original.
    const copy = j === 2 ? origMsgs.slice(0, 2) : origMsgs.slice(0, 1)
    for (const m of copy) {
      messages.push({ ...m, id: ++msgId, res_id: id, write_date: writeDate })
    }
    if (j === 0) {
      messages.push({
        ...origMsgs[0], id: ++msgId, res_id: id, write_date: writeDate,
        date: at(o.create_date, 55), author_id: AGENTS[2], body: '<p>Extra note only on the duplicate.</p>',
      })
    }
  })

  // A duplicate that carries no agent message is not "answered" (keeps first_response_at consistent with its thread).
  for (const t of tickets.slice(regular)) {
    const hasAgent = messages.some((m) => m.res_id === t.id && Array.isArray(m.author_id) && /^Agent/.test(m.author_id[1]))
    if (!hasAgent) t.x_first_response_at = false
  }

  // Noise on another model: the sync must filter these out by model.
  for (let i = 1; i <= 3; i++) {
    messages.push({
      id: ++msgId, model: 'res.partner', res_id: 1000 + i, body: '<p>Partner note.</p>',
      author_id: AGENTS[0], date: '2026-01-02 00:00:00', message_type: 'comment',
      write_date: '2026-01-02 00:00:00',
    })
  }
  return { [TICKET_MODEL]: tickets, [MESSAGE_MODEL]: messages }
}
