/**
 * The one sanctioned way ticket rows leave the app for display.
 * Default is masked (email/phone partially hidden); { reveal: true } returns plain values.
 * The contact fields are plain text in this demo (see README, "PII").
 */

export function maskEmail(email) {
  if (!email) return null
  const [local, domain] = String(email).split('@')
  if (!domain) return '••••'
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`
}

export function maskPhone(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  return digits.length <= 4 ? '••••' : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

export function projectTicket(row, messages = [], { reveal = false } = {}) {
  const by = (d) => messages.filter((m) => m.direction === d).length
  return {
    id: row.external_id,
    subject: row.subject,
    stage: row.stage,
    priority: row.priority,
    assignee: row.assignee,
    createdAt: row.created_at,
    isClosed: /solved|closed|done/i.test(String(row.stage ?? '')),
    customer: row.partner_name,
    email: reveal ? row.partner_email : maskEmail(row.partner_email),
    phone: reveal ? row.partner_phone : maskPhone(row.partner_phone),
    messageCount: messages.length,
    customerMessageCount: by('customer'),
    agentMessageCount: by('agent'),
    masked: !reveal,
  }
}
