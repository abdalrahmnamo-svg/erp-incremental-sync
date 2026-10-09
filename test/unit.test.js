import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEmail, normalizePhone, normalizeName, parseErpDate, normalizeSince,
} from '../src/identity.js'
import { stripHtml, mval, classifyAuthor, recordHash } from '../src/ingest.js'
import { maskEmail, maskPhone, projectTicket } from '../src/projection.js'
import { compileDomain, compileOrder } from '../mock-erp/domain.mjs'
import { keysetDomain } from '../src/sync.js'

test('identity: email, phone and name normalization', () => {
  assert.equal(normalizeEmail('  Customer0042@Example.COM '), 'customer0042@example.com')
  assert.equal(normalizeEmail('not-an-email'), null)
  assert.equal(normalizePhone('+1-555-0142'), '15550142')
  assert.equal(normalizePhone('+1 (415) 555-0142'), '4155550142')
  assert.equal(normalizePhone('415.555.0142'), '4155550142')
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizeName('  Café   Ünïcode, Ltd. '), 'cafe unicode ltd')
})

test('identity: dates and --since parsing', () => {
  assert.equal(parseErpDate('2026-01-02 03:04:05').toISOString(), '2026-01-02T03:04:05.000Z')
  assert.equal(parseErpDate('nope'), null)
  assert.equal(normalizeSince('2026-01-01'), '2026-01-01 00:00:00')
  assert.equal(normalizeSince('2026-01-01 08:30:00'), '2026-01-01 08:30:00')
  assert.throws(() => normalizeSince('yesterday-ish'))
})

test('ingest: html stripping, many2one unwrap, author classification, hashing', () => {
  assert.equal(stripHtml('<p>Hello &amp; welcome</p><p>Line two</p>'), 'Hello & welcome\nLine two')
  assert.equal(stripHtml(false), null)
  assert.equal(mval([5, 'Agent Alpha']), 'Agent Alpha')
  assert.equal(mval(false), null)
  assert.equal(classifyAuthor([101, 'Agent Alpha']), 'agent')
  assert.equal(classifyAuthor([1001, 'Customer 0001']), 'customer')
  assert.equal(classifyAuthor(false), 'system')
  assert.equal(recordHash({ a: 1, b: 2 }), recordHash({ b: 2, a: 1 }))
  assert.notEqual(recordHash({ a: 1 }), recordHash({ a: 2 }))
})

test('projection: masked by default, plain when revealed', () => {
  const row = { external_id: 1, subject: 's', stage: 'Solved', partner_name: 'Customer 0001', partner_email: 'customer0001@example.com', partner_phone: '+1-555-0101' }
  const masked = projectTicket(row, [{ direction: 'customer' }, { direction: 'agent' }, { direction: 'agent' }])
  assert.equal(masked.masked, true)
  assert.notEqual(masked.email, row.partner_email)
  assert.match(masked.email, /^cu•+@example\.com$/)
  assert.equal(masked.phone.slice(-4), '0101')
  assert.equal(masked.agentMessageCount, 2)
  assert.equal(masked.isClosed, true)
  assert.equal(projectTicket(row, [], { reveal: true }).email, row.partner_email)
  assert.equal(maskEmail(null), null)
  assert.equal(maskPhone('12'), '••••')
})

test('mock domain engine: operators, prefix | and &, order', () => {
  const rows = [{ id: 1, w: 'a' }, { id: 2, w: 'a' }, { id: 3, w: 'b' }]
  const f = compileDomain(['|', ['w', '>', 'a'], '&', ['w', '=', 'a'], ['id', '>', 1]])
  assert.deepEqual(rows.filter(f).map((r) => r.id), [2, 3])
  assert.deepEqual(rows.filter(compileDomain([['id', 'in', [1, 3]]])).map((r) => r.id), [1, 3])
  assert.deepEqual([...rows].sort(compileOrder('w desc, id desc')).map((r) => r.id), [3, 2, 1])
  assert.throws(() => compileDomain([['id', 'like', 1]]))
})

test('keyset domain is strictly after (write_date, id)', () => {
  const rows = [{ id: 1, write_date: 'a' }, { id: 2, write_date: 'a' }, { id: 3, write_date: 'b' }]
  const f = compileDomain(keysetDomain({ write_date: 'a', id: 1 }))
  assert.deepEqual(rows.filter(f).map((r) => r.id), [2, 3])
})
