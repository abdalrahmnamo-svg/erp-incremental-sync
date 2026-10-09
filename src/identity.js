/**
 * Normalization rules for the identifiers that join tickets to contacts.
 *
 * PII choice (a): contact fields are stored as plain text. The normalized forms below
 * are what identity matching and duplicate detection compare, on both the write path and
 * the lookup path, so "Customer0042@Example.com " and "customer0042@example.com" agree.
 */

export function normalizeEmail(email) {
  const s = String(email ?? '').trim().toLowerCase()
  if (!s || !s.includes('@')) return null
  return s
}

/** Digits only; an 11-digit number with a leading country code 1 collapses to 10 digits. */
export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(name) {
  const s = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s || null
}

/** Parse an ERP UTC datetime ("YYYY-MM-DD HH:MM:SS") into a Date, or null. */
export function parseErpDate(value) {
  if (!value || typeof value !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value.trim())
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : NaN)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Accepts "2026-01-01", "2026-01-01 08:30:00" or ISO; returns the ERP format (UTC) or throws. */
export function normalizeSince(input) {
  const d = parseErpDate(String(input)) ?? new Date(String(input))
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid --since value "${input}" (use e.g. 2026-01-01 or 2026-01-01 08:30:00).`)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
