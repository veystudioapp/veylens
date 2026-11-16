/**
 * What the SQL editor suggests at the caret: the tables of the connection, and
 * the columns of the tables the statement names — read off the words around
 * the caret, not parsed, so it keeps working on SQL that is half written.
 */

import type { Column, Engine, TableRef, TreeSchema } from "@shared/api"

// Relative: the tests load this under bun, which knows no `@shared` alias.
import { tokenize } from "../../shared/permissions"
import { sqlTokens } from "./sql-tokens"

type Token = ReturnType<typeof tokenize>[number][number]

/** A table the statement names, as written, and what it calls it. */
export type TableUse = { parts: string[]; alias: string | null }

export type CompletionSpot = {
  /** The range a suggestion replaces: the word at the caret. */
  from: number
  to: number
  /** The part of that word before the caret. */
  prefix: string
  /** What is before `.` when the word follows one: a schema, a table, an alias. */
  qualifier: string | null
  /** Right after FROM, JOIN, INTO, UPDATE…: only a table makes sense. */
  wantsTable: boolean
  uses: TableUse[]
}

export type Completion = {
  kind: "table" | "view" | "column"
  label: string
  insert: string
  /** A column's type; a table's schema, when it is not the default one. */
  detail: string | null
  /** A column's table, as the statement calls it. */
  source: string | null
}

const lower = (token: Token | undefined) => (token?.kind === "word" ? token.text.toLowerCase() : null)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Where the caret's statement starts and ends, and whether the caret is in a
 * string, a comment or a quoted name — where nothing is suggested. */
function statementAround(text: string, caret: number) {
  let start = 0
  let end = text.length
  let quoted = false
  let at = 0
  for (const token of sqlTokens(text)) {
    const next = at + token.text.length
    if (token.kind === "text") {
      for (let index = token.text.indexOf(";"); index !== -1; index = token.text.indexOf(";", index + 1)) {
        const position = at + index
        if (position < caret) start = position + 1
        else if (end === text.length) end = position
      }
    } else if (
      (token.kind === "string" || token.kind === "comment" || token.kind === "identifier") &&
      at < caret &&
      (caret < next || (caret === next && unclosed(token.text)))
    ) {
      quoted = true
    }
    at = next
  }
  return { start, end, quoted }
}

function unclosed(text: string): boolean {
  if (text.startsWith("--")) return true
  if (text.startsWith("/*")) return !text.endsWith("*/") || text.length < 4
  const quote = text.match(/['"`]/)?.[0]
  if (!quote) return false
  return text.length < 2 || !text.endsWith(quote) || text.indexOf(quote) === text.length - 1
}

const TABLE_AFTER = new Set(["from", "join", "update", "into", "table", "truncate"])
/** Words that end a FROM list, or start a clause after it. */
const CLAUSES = new Set([
  "select", "where", "group", "order", "having", "limit", "offset", "set",
  "values", "on", "using", "returning", "union", "intersect", "except",
  "window", "fetch", "for",
])

/** Whether a table's name is what comes after these tokens. */
function wantsTableAfter(tokens: Token[]): boolean {
  const last = tokens.at(-1)
  if (!last) return false
  if (TABLE_AFTER.has(lower(last) ?? "")) return true
  if (last.text !== ",") return false
  // FROM a, | — a comma in a FROM list at the caret's depth.
  let depth = 0
  for (let index = tokens.length - 2; index >= 0; index--) {
    const token = tokens[index]!
    if (token.text === ")") depth++
    else if (token.text === "(") {
      if (depth === 0) return false
      depth--
    } else if (depth === 0) {
      const word = lower(token)
      if (word === "from") return true
      if (word && CLAUSES.has(word)) return false
    }
  }
  return false
}

const NOT_ALIAS = new Set([
  ...CLAUSES, "join", "inner", "left", "right", "full", "cross", "natural",
  "outer", "lateral", "as", "straight_join", "where",
])

/** The tables a statement names after FROM, JOIN, UPDATE and INTO, each with
 * its alias. */
export function tableUses(tokens: Token[]): TableUse[] {
  const uses: TableUse[] = []
  const inFrom: boolean[] = [false]
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const word = lower(token)
    let starts = false
    if (token.text === "(") inFrom.push(false)
    else if (token.text === ")") inFrom.length > 1 && inFrom.pop()
    else if (token.text === ",") starts = inFrom.at(-1)!
    else if (word === "from") {
      inFrom[inFrom.length - 1] = true
      starts = true
    } else if (word === "join" || word === "update" || word === "into") starts = true
    else if (word && CLAUSES.has(word)) inFrom[inFrom.length - 1] = false
    if (!starts) continue

    let at = index + 1
    while (["only", "lateral", "ignore", "low_priority"].includes(lower(tokens[at]) ?? "")) at++
    const first = tokens[at]
    if (!first || first.kind === "punct" || NOT_ALIAS.has(lower(first) ?? "")) continue
    const parts = [first.text]
    let end = at + 1
    while (tokens[end]?.text === "." && tokens[end + 1] && tokens[end + 1]!.kind !== "punct") {
      parts.push(tokens[end + 1]!.text)
      end += 2
    }
    // FROM generate_series(…) is a call; INSERT INTO t (a, b) is a table.
    if (tokens[end]?.text === "(" && parts.length === 1 && word !== "into") continue
    if (lower(tokens[end]) === "as") end++
    const alias = tokens[end]
    uses.push({
      parts,
      alias: alias && alias.kind !== "punct" && !NOT_ALIAS.has(lower(alias) ?? "") ? alias.text : null,
    })
  }
  return uses
}

/** What is being typed at the caret, or null where nothing should be
 * suggested. */
export function completionSpot(text: string, caret: number, engine: Engine): CompletionSpot | null {
  const { start, end, quoted } = statementAround(text, caret)
  if (quoted) return null
  const before = text.slice(start, caret)
  const prefix = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*$/.exec(before)?.[0] ?? ""
  const from = caret - prefix.length
  // A word that only ends in letters, like the `e10` of `1e10`.
  if (prefix && /[\d$]$/.test(before.slice(0, -prefix.length))) return null
  const after = /^[\w$\u0080-￿]*/.exec(text.slice(caret, end))![0]
  const head = text.slice(start, from)
  const dotted = /(?:([A-Za-z_\u0080-￿][\w$\u0080-￿]*)|"((?:[^"]|"")+)"|`((?:[^`]|``)+)`)\.$/.exec(head)
  const qualifier = dotted
    ? (dotted[1] ?? dotted[2]?.replaceAll('""', '"') ?? dotted[3]!.replaceAll("``", "`"))
    : null
  const lead = dotted ? head.slice(0, head.length - dotted[0].length) : head
  return {
    from,
    to: caret + after.length,
    prefix,
    qualifier,
    wantsTable: !dotted && wantsTableAfter(tokenize(lead, engine).at(-1) ?? []),
    uses: tableUses(tokenize(text.slice(start, end), engine)[0] ?? []),
  }
}

/** A table by its name as written: in the schema it is qualified with, or
 * else the default schema first. */
export function findTable(
  schemas: TreeSchema[],
  parts: string[],
  defaultSchema: string
): TableRef | null {
  const table = parts.at(-1)!
  const schemaName = parts.length >= 2 ? parts.at(-2)! : null
  const candidates = schemaName
    ? schemas.filter((schema) => same(schema.name, schemaName))
    : [...schemas].sort((a, b) => Number(same(b.name, defaultSchema)) - Number(same(a.name, defaultSchema)))
  for (const schema of candidates) {
    const found =
      schema.tables.find((item) => item.name === table) ??
      schema.tables.find((item) => same(item.name, table))
    if (found) return { schema: schema.name, table: found.name }
  }
  return null
}

const RESERVED = new Set(
  `all and any as asc between by case check column constraint create cross
  default delete desc distinct drop else end except exists false fetch for
  foreign from full grant group having in index inner insert intersect into is
  join key left like limit natural not null offset on or order outer primary
  references right select set table then to true union unique update user
  using values when where window with`.split(/\s+/)
)

/** A name as it has to be written: quoted when it would not read as itself. */
export function quoteName(name: string, engine: Engine): string {
  const plain = engine === "mysql" ? /^[A-Za-z_][\w$]*$/ : /^[a-z_][a-z0-9_$]*$/
  if (plain.test(name) && !RESERVED.has(name.toLowerCase())) return name
  return engine === "mysql" ? `\`${name.replaceAll("`", "``")}\`` : `"${name.replaceAll('"', '""')}"`
}

export const COMPLETION_LIMIT = 200

/**
 * The suggestions for a spot, best first. A table whose columns are not known
 * yet is returned in `pending`, for the caller to fetch and ask again.
 */
export function completions(
  spot: CompletionSpot,
  context: {
    schemas: TreeSchema[]
    defaultSchema: string
    engine: Engine
    columnsOf: (ref: TableRef) => Column[] | undefined
  }
): { items: Completion[]; pending: TableRef[] } {
  const { schemas, defaultSchema, engine, columnsOf } = context
  const quote = (name: string) => quoteName(name, engine)
  const items: Completion[] = []
  const pending: TableRef[] = []
  const seen = new Set<string>()

  const columns = (ref: TableRef, source: string | null) => {
    const key = `${ref.schema}.${ref.table}`
    if (seen.has(key)) return
    seen.add(key)
    const found = columnsOf(ref)
    if (!found) {
      pending.push(ref)
      return
    }
    for (const column of found) {
      items.push({ kind: "column", label: column.name, insert: quote(column.name), detail: column.type, source })
    }
  }
  const tables = (only: TreeSchema | null) => {
    for (const schema of only ? [only] : schemas) {
      const home = only !== null || same(schema.name, defaultSchema)
      for (const table of schema.tables) {
        items.push({
          kind: table.kind,
          label: table.name,
          insert: home ? quote(table.name) : `${quote(schema.name)}.${quote(table.name)}`,
          detail: home ? null : schema.name,
          source: null,
        })
      }
    }
  }

  if (spot.qualifier !== null) {
    const name = spot.qualifier
    const use =
      spot.uses.find((item) => item.alias !== null && same(item.alias, name)) ??
      spot.uses.find((item) => same(item.parts.at(-1)!, name))
    const ref = use ? findTable(schemas, use.parts, defaultSchema) : null
    const schema = schemas.find((item) => same(item.name, name))
    if (ref) columns(ref, null)
    else if (schema) tables(schema)
    else {
      const loose = findTable(schemas, [name], defaultSchema)
      if (loose) columns(loose, null)
    }
  } else {
    if (!spot.wantsTable) {
      for (const use of spot.uses) {
        const ref = findTable(schemas, use.parts, defaultSchema)
        if (ref) columns(ref, use.alias ?? ref.table)
      }
    }
    tables(null)
  }

  const wanted = spot.prefix.toLowerCase()
  const starting: Completion[] = []
  const containing: Completion[] = []
  for (const item of items) {
    const label = item.label.toLowerCase()
    if (label.startsWith(wanted)) starting.push(item)
    // From two letters: one letter is in most names.
    else if (wanted.length >= 2 && label.includes(wanted)) containing.push(item)
  }
  const ranked = [...starting, ...containing].slice(0, COMPLETION_LIMIT)
  // Nothing to offer but what is already typed.
  if (ranked.length === 1 && ranked[0]!.label === spot.prefix) return { items: [], pending }
  return { items: ranked, pending }
}
