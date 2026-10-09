import { join, resolve } from 'node:path'

/** Tiny flag parser: --flag, --key value, positional args in `_`. */
export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { args[a.slice(2)] = next; i++ } else args[a.slice(2)] = true
    } else args._.push(a)
  }
  return args
}

export const dbPath = (env = process.env) => resolve(env.SYNC_DB_PATH || join('output', 'sync.db'))
export const outputDir = () => resolve('output')
