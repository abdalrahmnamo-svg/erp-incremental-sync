/**
 * The raw landing contract of the support-analytics-warehouse (schema `raw`).
 * Column order, names and DuckDB types match what that repo's generator creates, so this
 * repo can append to the same tables. Every table also carries `_loaded_at` and `_batch_id`.
 */
export const RAW_CONTRACT = {
  tickets: [
    ['ticket_id', 'BIGINT'],
    ['external_ref', 'VARCHAR'],
    ['customer_id', 'VARCHAR'],
    ['channel', 'VARCHAR'],
    ['category', 'VARCHAR'],
    ['priority', 'VARCHAR'],
    ['stage', 'VARCHAR'],
    ['created_at', 'TIMESTAMP'],
    ['first_response_at', 'TIMESTAMP'],
    ['resolved_at', 'TIMESTAMP'],
    ['assigned_agent_id', 'BIGINT'],
    ['write_date', 'TIMESTAMP'],
    ['_loaded_at', 'TIMESTAMP'],
    ['_batch_id', 'VARCHAR'],
  ],
  messages: [
    ['message_id', 'BIGINT'],
    ['ticket_id', 'BIGINT'],
    ['author_type', 'VARCHAR'],
    ['sent_at', 'TIMESTAMP'],
    ['body_chars', 'BIGINT'],
    ['write_date', 'TIMESTAMP'],
    ['_loaded_at', 'TIMESTAMP'],
    ['_batch_id', 'VARCHAR'],
  ],
}

/** Pipeline bookkeeping tables, owned by this repo (not part of the warehouse contract). */
export const OPS_TABLES = {
  _sync_runs: [
    ['batch_id', 'VARCHAR'],
    ['started_at', 'TIMESTAMP'],
    ['finished_at', 'TIMESTAMP'],
    ['model', 'VARCHAR'],
    ['fetched', 'BIGINT'],
    ['appended', 'BIGINT'],
    ['cursor_before', 'VARCHAR'],
    ['cursor_after', 'VARCHAR'],
    ['status', 'VARCHAR'],
    ['error', 'VARCHAR'],
  ],
  _sync_cursor: [
    ['model', 'VARCHAR'],
    ['last_write_date', 'VARCHAR'],
    ['last_id', 'BIGINT'],
  ],
}

const KEYS = { _sync_cursor: ', PRIMARY KEY (model)' } // the cursor upsert needs a conflict target
const ddl = (name, cols) => `CREATE TABLE IF NOT EXISTS raw.${name} (${cols.map(([c, t]) => `${c} ${t}`).join(', ')}${KEYS[name] ?? ''})`

export const SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS raw',
  ...Object.entries(RAW_CONTRACT).map(([n, c]) => ddl(n, c)),
  ...Object.entries(OPS_TABLES).map(([n, c]) => ddl(n, c)),
]

export const ALL_TABLES = { ...RAW_CONTRACT, ...OPS_TABLES }
