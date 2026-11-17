/**
 * What the statements an app ran through a gateway add up to: the same
 * statement with different values counted as one, the bursts of one
 * statement that an ORM's lazy loading makes (N+1), and the slow ones. Pure,
 * so the inspector shows what the tests check.
 */
import type { GatewayQuery } from "./api"

/**
 * A statement with its values taken out: strings, numbers and placeholders
 * become `?`, lists of them one `?…`, comments and spacing go. Two calls that
 * differ only in an id read the same.
 */
export function fingerprint(sql: string): string {
  const known = fingerprints.get(sql)
  if (known !== undefined) return known
  if (fingerprints.size >= FINGERPRINTS_KEPT) fingerprints.clear()
  const made = normalise(sql)
  fingerprints.set(sql, made)
  return made
}

/** An app runs the same few hundred statements over and over: each is
 * normalised once. */
const fingerprints = new Map<string, string>()
const FINGERPRINTS_KEPT = 10_000

function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "?")
    .replace(/[EeBbXxNn]?'(?:[^'\\]|''|\\.)*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/(?<![\w."`])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![\w"`])/gi, "?")
    .replace(/\b(true|false|null)\b/gi, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?…)")
    .replace(/(\((?:\s*\?…?\s*,?)+\))(?:\s*,\s*\((?:\s*\?…?\s*,?)+\))+/g, "$1, …")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase()
}

/** What frames the real work: transactions, settings, a health check. */
export function isNoise(sql: string): boolean {
  const text = sql.trim().toLowerCase()
  return (
    /^(begin|start transaction|commit|rollback|end|savepoint|release|set|reset|discard|deallocate|show|use)\b/.test(text) ||
    /^select\s+1\s*;?$/.test(text)
  )
}

const isRead = (query: GatewayQuery) =>
  (query.command ?? "").toUpperCase() === "SELECT" || /^\s*(select|with)\b/i.test(query.sql)

export type QueryGroup = {
  fingerprint: string
  /** The latest of them, as it ran. */
  sample: GatewayQuery
  count: number
  totalMs: number
  avgMs: number
  maxMs: number
  /** The 95th percentile of their times. */
  p95Ms: number
  errors: number
  rows: number
  sessions: number
}

/** One group per statement, the most time spent first. */
export function groupQueries(queries: GatewayQuery[]): QueryGroup[] {
  const groups = new Map<string, { list: GatewayQuery[]; sessions: Set<number> }>()
  for (const query of queries) {
    const key = fingerprint(query.sql)
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { list: [], sessions: new Set() }))
    group.list.push(query)
    group.sessions.add(query.session)
  }
  return [...groups.entries()]
    .map(([key, { list, sessions }]) => {
      const times = list.map((query) => query.ms).sort((a, b) => a - b)
      const totalMs = times.reduce((sum, ms) => sum + ms, 0)
      return {
        fingerprint: key,
        sample: list.at(-1)!,
        count: list.length,
        totalMs,
        avgMs: totalMs / list.length,
        maxMs: times.at(-1) ?? 0,
        p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0,
        errors: list.filter((query) => query.error).length,
        rows: list.reduce((sum, query) => sum + (query.rows ?? 0), 0),
        sessions: sessions.size,
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
}

export type NPlusOne = {
  fingerprint: string
  session: number
  /** The repeated statements, in order. */
  queries: GatewayQuery[]
  /** The statement just before them on the same connection: usually the
   * "1" that fetched the list they were run for. */
  trigger: GatewayQuery | null
  /** Every one with the same values: a cache would do, not a join. */
  identical: boolean
  /** From the first sent to the last done. */
  spanMs: number
  totalMs: number
}

export type NPlusOneOptions = {
  /** Fewer than this in a burst is not counted. */
  minRepeats?: number
  /** Two of one statement further apart than this are separate bursts. */
  gapMs?: number
}

/**
 * Reads run again and again on one connection in quick succession — what an
 * ORM loading a relation per row looks like from the database. Each burst is
 * the same statement, on the same connection, every one within `gapMs` of the
 * one before; other statements may come between (two relations loaded per
 * row interleave).
 */
export function findNPlusOne(queries: GatewayQuery[], options: NPlusOneOptions = {}): NPlusOne[] {
  const minRepeats = options.minRepeats ?? 5
  const gapMs = options.gapMs ?? 1000
  const bySession = new Map<number, GatewayQuery[]>()
  for (const query of queries) {
    const list = bySession.get(query.session) ?? []
    list.push(query)
    bySession.set(query.session, list)
  }

  const found: NPlusOne[] = []
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.at - b.at || a.id - b.id)
    const open = new Map<string, GatewayQuery[]>()
    const close = (key: string) => {
      const burst = open.get(key)
      open.delete(key)
      if (!burst || burst.length < minRepeats) return
      const first = burst[0]!
      const last = burst.at(-1)!
      const before = list.slice(0, list.indexOf(first)).reverse()
      const trigger = before.find((query) => !isNoise(query.sql) && fingerprint(query.sql) !== key) ?? null
      const values = new Set(burst.map((query) => `${query.sql}\u0000${JSON.stringify(query.params)}`))
      found.push({
        fingerprint: key,
        session,
        queries: burst,
        trigger,
        identical: values.size === 1,
        spanMs: last.at + last.ms - first.at,
        totalMs: burst.reduce((sum, query) => sum + query.ms, 0),
      })
    }
    for (const query of list) {
      if (isNoise(query.sql) || !isRead(query)) continue
      const key = fingerprint(query.sql)
      const burst = open.get(key)
      if (burst && query.at - (burst.at(-1)!.at + burst.at(-1)!.ms) > gapMs) close(key)
      const current = open.get(key) ?? []
      current.push(query)
      open.set(key, current)
    }
    for (const key of [...open.keys()]) close(key)
  }
  return found.sort((a, b) => b.queries.length - a.queries.length || b.totalMs - a.totalMs)
}

/** The slowest, past a threshold, slowest first. */
export function slowQueries(queries: GatewayQuery[], thresholdMs = 100): GatewayQuery[] {
  return queries.filter((query) => query.ms >= thresholdMs).sort((a, b) => b.ms - a.ms)
}

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * A Postgres statement with its `$1`, `$2`… written in as literals, for
 * running it again — EXPLAIN, the SQL editor. Null when a value could not be
 * read (sent in binary) or was not kept. Placeholders in strings, comments
 * and quoted names are left alone.
 */
export function inlinePostgresParams(sql: string, params: string[] | null): string | null {
  if (!/\$\d/.test(sql)) return sql
  if (!params) return null
  let failed = false
  const out = sql.replace(
    /('(?:[^']|'')*')|("(?:[^"]|"")*")|(--[^\n]*)|(\/\*[\s\S]*?\*\/)|\$(\d+)/g,
    (match, single, double, line, block, index) => {
      if (single || double || line || block) return match
      const value = params[Number(index) - 1]
      if (value === undefined || value === "<binary>" || value.endsWith("…")) {
        failed = true
        return match
      }
      return value === "NULL" ? "NULL" : quoted(value)
    }
  )
  return failed ? null : out
}
