/**
 * A connection's permissions, applied to SQL: what kind of statement it is,
 * which schemas and tables it reads and writes, and whether it passes the
 * guards. Shared: the main process refuses on it, the renderer asks before
 * it and explains.
 *
 * The SQL is read, not run, so this is best effort. When something is hidden,
 * what is known to reach a table without naming it is refused (SQL run from
 * text, DO blocks, file reads, a moved search path, value catalogs), and the
 * guard hides views over hidden tables from the server's catalog. A function
 * the database already has can still read anything its body does. The
 * database user's own grants are the boundary that cannot be talked around;
 * these are the app's, on top.
 */

import {
  OBJECT_ACCESS,
  RULES,
  STATEMENT_KINDS,
  type AccessMode,
  type ChangeSet,
  type Engine,
  type Guards,
  type ObjectAccess,
  type ObjectRule,
  type Permissions,
  type Rule,
  type StatementKind,
  type TableRef,
  type TreeSchema,
} from "./api"

export const STATEMENT_LABEL: Record<StatementKind, string> = {
  insert: "Insert rows",
  update: "Update rows",
  delete: "Delete rows",
  ddl: "Change the schema",
}

export const STATEMENT_HINT: Record<StatementKind, string> = {
  insert: "INSERT, REPLACE, COPY … FROM, LOAD DATA",
  update: "UPDATE, MERGE",
  delete: "DELETE",
  ddl: "CREATE, ALTER, DROP, TRUNCATE, GRANT, and calls that may do anything",
}

export const RULE_LABEL: Record<Rule, string> = { allow: "Allow", ask: "Ask", block: "Block" }

export const OBJECT_LABEL: Record<ObjectAccess, string> = {
  hidden: "Hidden",
  read: "Read only",
  write: "Writable",
  schema: "Structure only",
}

export const OBJECT_DETAIL: Record<ObjectAccess, string> = {
  hidden: "Not listed, not described, and refused in any statement that names it — the assistant does not see it either.",
  read: "Read as usual; a statement or an edit that writes to it is refused.",
  write: "As the connection allows — for a table inside a schema set otherwise.",
  schema: "Listed and described; its data refused in any statement that names it.",
}

export const AI_SCHEMA_ONLY_LABEL = "AI: structure only"
export const AI_SCHEMA_ONLY_DETAIL =
  "The assistant sees its columns, types and keys, but cannot read its rows — nor a view built on it. You still can."

export const DEFAULT_GUARDS: Guards = {
  requireWhere: false,
  maxAffected: null,
  timeoutSeconds: null,
  maxRows: null,
}

export const DEFAULT_PERMISSIONS: Permissions = {
  statements: { insert: "allow", update: "allow", delete: "allow", ddl: "allow" },
  objects: [],
  guards: DEFAULT_GUARDS,
}

const positive = (value: unknown, most: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), most)
    : null

/** Whatever was stored or sent, as permissions: unknown parts dropped,
 * missing ones the defaults. */
export function checkPermissions(raw: unknown): Permissions {
  const given = (raw && typeof raw === "object" ? raw : {}) as Partial<Permissions>
  const statements = { ...DEFAULT_PERMISSIONS.statements }
  for (const kind of STATEMENT_KINDS) {
    const rule = given.statements?.[kind]
    if (RULES.includes(rule as Rule)) statements[kind] = rule as Rule
  }
  const seen = new Set<string>()
  const objects: ObjectRule[] = []
  for (const item of Array.isArray(given.objects) ? given.objects : []) {
    if (!item || typeof item.schema !== "string" || !item.schema.trim()) continue
    if (!(OBJECT_ACCESS as readonly string[]).includes(item.access)) continue
    const table = typeof item.table === "string" && item.table.trim() ? item.table.trim() : null
    const key = `${item.schema.trim().toLowerCase()}.${table?.toLowerCase() ?? "*"}`
    if (seen.has(key)) continue
    seen.add(key)
    objects.push({
      schema: item.schema.trim(),
      table,
      access: item.access,
      ...(item.aiSchemaOnly === true ? { aiSchemaOnly: true } : {}),
    })
  }
  const guards = (given.guards ?? {}) as Partial<Guards>
  return {
    statements,
    objects,
    guards: {
      requireWhere: guards.requireWhere === true,
      maxAffected: positive(guards.maxAffected, 1_000_000_000),
      timeoutSeconds: positive(guards.timeoutSeconds, 24 * 3600),
      maxRows: positive(guards.maxRows, 1_000_000),
    },
  }
}

// ── Reading SQL ────────────────────────────────────────────────────────────

type Token = { kind: "word" | "name" | "punct"; text: string }

/**
 * A script cut into statements, each as tokens: strings and comments gone,
 * quoted names kept as names. Dollar quotes (`$$ … $$`) are strings.
 */
export function tokenize(sql: string, engine: Engine): Token[][] {
  const statements: Token[][] = []
  let current: Token[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (/\s/.test(c)) {
      i++
    } else if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++
    } else if (c === "#" && engine === "mysql") {
      while (i < n && sql[i] !== "\n") i++
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === "'" || (c === '"' && engine === "mysql")) {
      // A string: '' (and \' on MySQL) inside it.
      i++
      while (i < n) {
        if (sql[i] === "\\" && engine === "mysql") i += 2
        else if (sql[i] === c && sql[i + 1] === c) i += 2
        else if (sql[i] === c) break
        else i++
      }
      i++
      current.push({ kind: "punct", text: "''" })
    } else if (c === "$" && engine === "postgres" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end < 0 ? n : end + tag.length
      current.push({ kind: "punct", text: "''" })
    } else if (c === '"' || c === "`") {
      let name = ""
      i++
      while (i < n) {
        if (sql[i] === c && sql[i + 1] === c) {
          name += c
          i += 2
        } else if (sql[i] === c) break
        else name += sql[i++]
      }
      i++
      current.push({ kind: "name", text: name })
    } else if (c === ";") {
      if (current.length) statements.push(current)
      current = []
      i++
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let word = ""
      while (i < n && /[\w$\u0080-￿]/.test(sql[i]!)) word += sql[i++]
      current.push({ kind: "word", text: word })
    } else {
      current.push({ kind: "punct", text: c })
      i++
    }
  }
  if (current.length) statements.push(current)
  return statements
}

const lower = (token: Token | undefined) => (token?.kind === "word" ? token.text.toLowerCase() : null)

export type StatementClass = StatementKind | "read" | "session" | "other"

const DDL = new Set([
  "create", "alter", "drop", "truncate", "rename", "grant", "revoke", "comment",
  "reindex", "cluster", "refresh", "vacuum", "import", "security",
])
const SESSION = new Set([
  "begin", "start", "commit", "rollback", "end", "savepoint", "release", "set",
  "reset", "use", "discard", "listen", "unlisten", "notify", "lock", "analyze",
  "checkpoint", "show", "deallocate", "abort",
])
const READ = new Set(["select", "show", "describe", "desc", "table", "values", "help"])

/** The first data-changing keyword in a statement's top level and its CTEs. */
function writeIn(tokens: Token[]): StatementKind | null {
  for (let index = 0; index < tokens.length; index++) {
    const word = lower(tokens[index])
    if (word === "insert") return "insert"
    if (word === "delete") return "delete"
    if (word === "merge") return "update"
    // FOR UPDATE / ON CONFLICT DO UPDATE / ON DUPLICATE KEY UPDATE are not one.
    if (word === "update" && !["for", "do", "key"].includes(lower(tokens[index - 1]) ?? "")) {
      return "update"
    }
  }
  return null
}

/** What one statement does, by its keywords. */
export function classify(tokens: Token[]): StatementClass {
  const start = tokens.findIndex((token) => token.text !== "(")
  const word = lower(tokens[start])
  if (!word) return "other"
  if (word === "explain") {
    // EXPLAIN ANALYZE runs what it explains.
    const analyze = tokens.some((token) => lower(token) === "analyze" || lower(token) === "analyse")
    const inner = classify(
      tokens.slice(start + 1).filter((token) => !["analyze", "analyse", "verbose", "format"].includes(lower(token) ?? ""))
    )
    return analyze && inner !== "read" ? inner : "read"
  }
  if (word === "with") return writeIn(tokens) ?? "read"
  if (word === "select") {
    // SELECT … INTO a new table (Postgres), or INTO OUTFILE (MySQL).
    const into = tokens.findIndex((token) => lower(token) === "into")
    return into >= 0 ? "ddl" : "read"
  }
  if (READ.has(word)) return "read"
  if (word === "insert" || word === "replace" || word === "load") return "insert"
  if (word === "copy") {
    // COPY t FROM … loads; COPY t TO / COPY (query) TO only reads.
    let depth = 0
    for (const token of tokens) {
      if (token.text === "(") depth++
      else if (token.text === ")") depth--
      else if (depth === 0 && lower(token) === "from") return "insert"
    }
    return "read"
  }
  if (word === "update" || word === "merge") return "update"
  if (word === "delete") return "delete"
  if (DDL.has(word)) return "ddl"
  if (SESSION.has(word)) return "session"
  return "other"
}

const NOT_NAMES = new Set([
  "select", "lateral", "only", "if", "not", "exists", "where", "set", "values",
  "on", "using", "join", "inner", "left", "right", "full", "cross", "natural",
  "outer", "group", "order", "limit", "having", "window", "union", "returning",
  "default", "as", "with", "unnest", "generate_series", "json_table", "dual",
  "temporary", "temp", "unlogged", "materialized", "recursive", "ignore",
  "low_priority", "quick", "delayed", "high_priority", "table", "view",
])

/** A schema-qualified name at `index`, and where it ends. */
function nameAt(tokens: Token[], index: number): { parts: string[]; end: number } | null {
  const first = tokens[index]
  if (!first || first.kind === "punct") return null
  if (first.kind === "word" && NOT_NAMES.has(first.text.toLowerCase())) return null
  // A function call is not a table: name( … ).
  const parts = [first.kind === "word" ? first.text.toLowerCase() : first.text]
  let end = index + 1
  while (tokens[end]?.text === "." && tokens[end + 1] && tokens[end + 1]!.kind !== "punct") {
    const part = tokens[end + 1]!
    parts.push(part.kind === "word" ? part.text.toLowerCase() : part.text)
    end += 2
  }
  if (tokens[end]?.text === "(" && first.kind === "word" && parts.length === 1) {
    const previous = lower(tokens[index - 1])
    // INSERT INTO t (a, b) and CREATE TABLE t ( … ) are tables; FROM f(x) is not.
    if (previous !== "into" && previous !== "table" && previous !== "exists") return null
  }
  return { parts: parts.slice(-3), end }
}

/** Words that close a FROM clause. */
const FROM_ENDS = new Set([
  "where", "group", "order", "having", "limit", "union", "intersect", "except",
  "window", "returning", "set", "values", "select", "offset", "fetch", "for",
])

const FROM_IN_CALL = new Set(["extract", "substring", "trim", "position", "overlay", "substr"])

export type Reference = { schema: string; table: string; written: boolean }

/**
 * The tables a statement names — after FROM, JOIN, INTO, UPDATE, TABLE,
 * TRUNCATE, VIEW, COPY — and whether each is written to. Unqualified names
 * are in `defaultSchema`. CTE names are not tables.
 */
export function referencesIn(tokens: Token[], defaultSchema: string): Reference[] {
  const found: Reference[] = []
  const ctes = new Set<string>()
  const cls = classify(tokens)
  const writes = cls !== "read" && cls !== "session"
  // WITH name AS ( … ): a name, not a table.
  for (let index = 0; index < tokens.length - 2; index++) {
    if (
      tokens[index + 1] &&
      lower(tokens[index + 1]) === "as" &&
      tokens[index + 2]?.text === "(" &&
      (lower(tokens[index - 1]) === "with" || tokens[index - 1]?.text === "," || lower(tokens[index - 1]) === "recursive")
    ) {
      ctes.add(tokens[index]!.text.toLowerCase())
    }
  }
  const add = (parts: string[], written: boolean) => {
    const table = parts.at(-1)!
    if (parts.length === 1 && ctes.has(table.toLowerCase())) return
    const schema = parts.length >= 2 ? parts.at(-2)! : defaultSchema
    found.push({ schema, table, written })
  }
  // The functions whose arguments say FROM without naming a table:
  // EXTRACT(year FROM d), SUBSTRING(s FROM 2), TRIM(x FROM s)…
  const calls: (string | null)[] = []
  const copy = lower(tokens[0]) === "copy"
  // Whether a FROM clause is open at each depth of parentheses: a comma in
  // it starts another table — FROM a x JOIN b ON …, c.
  const inFrom: boolean[] = [false]
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.text === "(") {
      calls.push(lower(tokens[index - 1]))
      inFrom.push(false)
    } else if (token.text === ")") {
      calls.pop()
      inFrom.pop()
    } else if (token.text === "," && inFrom.at(-1)) {
      const name = nameAt(tokens, index + 1)
      if (name) add(name.parts, false)
      continue
    }
    const word = lower(token)
    if (!word) continue
    if (FROM_ENDS.has(word)) inFrom[inFrom.length - 1] = false
    const previous = lower(tokens[index - 1])
    let written = false
    let list = false
    if (word === "from") {
      if ((copy && calls.length === 0) || FROM_IN_CALL.has(calls.at(-1) ?? "")) continue
      // DELETE FROM t writes t; COPY t FROM is caught at COPY.
      // DELETE [LOW_PRIORITY] [QUICK] FROM t writes t.
      written = previous === "delete" || lower(tokens[index - 2]) === "delete"
      if (!written) inFrom[inFrom.length - 1] = true
    } else if (word === "join") {
      written = false
    } else if (word === "into") {
      written = true
    } else if (word === "update") {
      if (["for", "do", "key"].includes(previous ?? "")) continue
      written = true
    } else if (word === "table" || word === "view") {
      // CREATE/ALTER/DROP TABLE t, TRUNCATE TABLE t, LOCK TABLE t; but not
      // TABLE t on its own (a read), nor RETURNS TABLE.
      if (index === 0) {
        written = false
      } else if (previous === "returns") {
        continue
      } else {
        written = writes
        list = word === "table" && (previous === "drop" || previous === "truncate")
      }
    } else if (word === "truncate") {
      if (lower(tokens[index + 1]) === "table") continue
      written = true
      list = true
    } else if (word === "copy" && index === 0) {
      written = cls === "insert"
    } else if (word === "handler" && index === 0) {
      // MySQL's HANDLER t OPEN / READ: reads a table with no FROM.
      written = false
    } else if (word === "using" && cls === "delete") {
      written = false
      list = true
    } else {
      continue
    }
    let at = index + 1
    // IF [NOT] EXISTS, ONLY
    while (["if", "not", "exists", "only", "lateral", "ignore", "low_priority", "quick"].includes(lower(tokens[at]) ?? "")) at++
    for (;;) {
      const name = nameAt(tokens, at)
      if (!name) break
      add(name.parts, written)
      if (!list) break
      // FROM a x, b y — past the alias to the comma.
      let next = name.end
      if (lower(tokens[next]) === "as") next++
      if (tokens[next] && tokens[next]!.kind !== "punct" && !NOT_NAMES.has(lower(tokens[next]) ?? "") && lower(tokens[next]) !== "where") next++
      if (tokens[next]?.text !== ",") break
      at = next + 1
    }
  }
  return found
}

// ── Reaching a table without naming it ─────────────────────────────────────

/** Functions that run SQL handed to them as text, dump whole tables or
 * schemas, read the server's files or another database, or decode the WAL:
 * what they read is not in the statement's names. */
const OPAQUE_FUNCTIONS = new Set([
  // Postgres: SQL or a table given as text.
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
  "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
  "schema_to_xml", "schema_to_xmlschema", "schema_to_xml_and_xmlschema",
  "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
  "cursor_to_xml", "ts_stat",
  // Postgres: another database.
  "dblink", "dblink_exec", "dblink_open", "dblink_fetch", "dblink_send_query", "dblink_get_result",
  // Postgres: the server's files, large objects and the WAL.
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
  "lo_import", "lo_export", "lo_get", "lo_open", "loread",
  "pg_logical_slot_get_changes", "pg_logical_slot_peek_changes",
  "pg_logical_slot_get_binary_changes", "pg_logical_slot_peek_binary_changes",
  // Postgres: a setting such as search_path, which moves where a bare name is looked for.
  "set_config",
  // MySQL: the server's files.
  "load_file",
])

/** Catalogs that hold sample values from every table's columns. */
const VALUE_CATALOGS = new Set([
  "pg_stats", "pg_statistic", "pg_stats_ext", "pg_stats_ext_exprs", "pg_statistic_ext_data",
  "column_statistics",
])

/**
 * Why a statement could read a table it does not name: SQL run from text,
 * a code block, a file, a moved search path, a catalog of sample values.
 * Only asked when something is hidden — otherwise there is nothing to reach.
 */
function opaqueIn(tokens: Token[], engine: Engine, defaultSchema: string): string[] {
  const reasons: string[] = []
  const first = lower(tokens.find((token) => token.text !== "("))
  const second = lower(tokens[tokens.findIndex((token) => token.text !== "(") + 1])
  if (first === "do") {
    reasons.push("A DO block runs code this app cannot read.")
  }
  if (engine === "mysql" && first === "prepare") {
    reasons.push("PREPARE … FROM runs SQL given as text, so the tables it reads cannot be checked.")
  }
  if (engine === "mysql" && first === "use") {
    reasons.push("USE changes which database a bare table name is looked for in.")
  }
  if (first === "set" || first === "reset") {
    const words = tokens.slice(1, 4).map(lower)
    if (words.includes("search_path") || words.includes("schema")) {
      reasons.push("Changing search_path moves where a bare table name is looked for.")
    }
  }
  if (engine === "postgres" && first === "create") {
    // CREATE [OR REPLACE] FUNCTION|PROCEDURE: a body in a string, read by no one here.
    const kind = second === "or" ? lower(tokens[tokens.findIndex((token) => token.text !== "(") + 3]) : second
    if (kind === "function" || kind === "procedure") {
      reasons.push("A function's body is text this app cannot read, so the tables it reads cannot be checked.")
    }
  }
  for (let index = 0; index < tokens.length - 1; index++) {
    const name = lower(tokens[index])
    if (name && tokens[index + 1]!.text === "(" && OPAQUE_FUNCTIONS.has(name)) {
      reasons.push(`${name}(…) reads data without naming the table, so it cannot be checked.`)
    }
  }
  for (const ref of referencesIn(tokens, defaultSchema)) {
    if (VALUE_CATALOGS.has(ref.table.toLowerCase())) {
      reasons.push(`${ref.table} holds sample values from every table's columns, hidden ones too.`)
    }
  }
  return reasons
}

/** How far an object's data is kept from whoever asks: 2 hidden, 1 only its
 * structure shown, 0 readable. */
const RESTRICTION: Record<ObjectAccess, number> = { write: 0, read: 0, schema: 1, hidden: 2 }
const RESTRICTED: ObjectAccess[] = ["write", "schema", "hidden"]

/** Whether some data is kept from whoever asks: what is hidden, or shown as
 * structure only. */
const hidesSomething = (permissions: Permissions) =>
  permissions.objects.some((rule) => RESTRICTION[rule.access] > 0)

/** Whether a statement may read this object's rows. */
export const dataReadable = (access: ObjectAccess) => RESTRICTION[access] === 0

/**
 * The permissions as the assistant meets them: every rule marked
 * `aiSchemaOnly` — or inside a schema so marked — shows structure only. What
 * is hidden stays hidden. The stricter wins: a table's own rule cannot give
 * the assistant data its schema keeps from it.
 */
export function forAssistant(permissions: Permissions): Permissions {
  if (!permissions.objects.some((rule) => rule.aiSchemaOnly)) return permissions
  const schemaMarked = new Set(
    permissions.objects
      .filter((rule) => rule.table === null && rule.aiSchemaOnly)
      .map((rule) => rule.schema.toLowerCase())
  )
  return {
    ...permissions,
    objects: permissions.objects.map(({ aiSchemaOnly, ...rule }) =>
      rule.access !== "hidden" && (aiSchemaOnly || schemaMarked.has(rule.schema.toLowerCase()))
        ? { ...rule, access: "schema" as const }
        : rule
    ),
  }
}

/**
 * The permissions with every view that reads a hidden table — directly, or
 * through another such view — hidden too, and every view over one shown as
 * structure only shown so too. `sources` is each view and a table or view it
 * reads, from the server's catalog.
 */
export function hideDependentViews(
  permissions: Permissions,
  sources: { view: TableRef; source: TableRef }[]
): Permissions {
  if (!hidesSomething(permissions) || sources.length === 0) return permissions
  const key = (ref: TableRef) => `${ref.schema.toLowerCase()}.${ref.table.toLowerCase()}`
  const raised = new Map<string, { view: TableRef; level: number }>()
  const level = (ref: TableRef) =>
    Math.max(raised.get(key(ref))?.level ?? 0, RESTRICTION[objectAccess(permissions, ref)])
  for (let changed = true; changed; ) {
    changed = false
    for (const { view, source } of sources) {
      const from = level(source)
      if (from > level(view)) {
        raised.set(key(view), { view, level: from })
        changed = true
      }
    }
  }
  if (raised.size === 0) return permissions
  return {
    ...permissions,
    objects: [
      ...[...raised.values()].map(({ view, level }) => ({
        schema: view.schema,
        table: view.table,
        access: RESTRICTED[level]!,
      })),
      ...permissions.objects.filter((rule) => rule.table === null || !raised.has(key({ schema: rule.schema, table: rule.table }))),
    ],
  }
}

/** Whether an UPDATE or DELETE has a WHERE anywhere in it. */
const hasWhere = (tokens: Token[]) => tokens.some((token) => lower(token) === "where")

// ── Judging ────────────────────────────────────────────────────────────────

const ORDER: Record<Rule, number> = { allow: 0, ask: 1, block: 2 }
const stricter = (a: Rule, b: Rule): Rule => (ORDER[a] >= ORDER[b] ? a : b)

/** The access mode as a floor under every write's rule. */
const FLOOR: Record<AccessMode, Rule> = { read_write: "allow", confirm: "ask", read_only: "block" }

/** A kind of write's rule on this connection, the access mode applied. */
export function ruleFor(permissions: Permissions, access: AccessMode, kind: StatementKind): Rule {
  return stricter(permissions.statements[kind], FLOOR[access])
}

/** How a schema or table may be used: its own rule, else its schema's. */
export function objectAccess(permissions: Permissions, ref: TableRef): ObjectAccess {
  const schema = ref.schema.toLowerCase()
  const table = ref.table.toLowerCase()
  const own = permissions.objects.find(
    (rule) => rule.schema.toLowerCase() === schema && rule.table?.toLowerCase() === table
  )
  if (own) return own.access
  return (
    permissions.objects.find((rule) => rule.schema.toLowerCase() === schema && rule.table === null)
      ?.access ?? "write"
  )
}

/** The tree with what is hidden taken out. */
export function visibleTree(permissions: Permissions, tree: TreeSchema[]): TreeSchema[] {
  if (permissions.objects.length === 0) return tree
  return tree
    .map((schema) => ({
      ...schema,
      tables: schema.tables.filter(
        (table) => objectAccess(permissions, { schema: schema.name, table: table.name }) !== "hidden"
      ),
    }))
    .filter(
      (schema) =>
        schema.tables.length > 0 ||
        !permissions.objects.some(
          (rule) => rule.schema.toLowerCase() === schema.name.toLowerCase() && rule.table === null && rule.access === "hidden"
        )
    )
}

export type Verdict = {
  /** The strictest any statement in it met. */
  rule: Rule
  /** Why, a line each: what is blocked, or what is asked about. */
  reasons: string[]
  /** The writes in it, by kind. */
  kinds: StatementKind[]
}

export type Context = {
  permissions: Permissions
  access: AccessMode
  engine: Engine
  /** Where an unqualified name is looked for: `public`, or the database. */
  defaultSchema: string
}

const quoteRef = (ref: { schema: string; table: string }) => `${ref.schema}.${ref.table}`

const structureOnly = (ref: { schema: string; table: string }) =>
  `${quoteRef(ref)} shows the assistant its structure only: its data cannot be read. Work from its columns, or ask the user to look at the rows themselves.`

/**
 * What the permissions say of some SQL, statement by statement: allowed,
 * to be asked about, or blocked — and why.
 */
export function judge(sql: string, context: Context): Verdict {
  const { permissions, access } = context
  const reasons: string[] = []
  const kinds = new Set<StatementKind>()
  let rule: Rule = "allow"
  const raise = (to: Rule, reason: string) => {
    rule = stricter(rule, to)
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  const hiding = hidesSomething(permissions)
  for (const tokens of tokenize(sql, context.engine)) {
    const cls = classify(tokens)
    for (const ref of referencesIn(tokens, context.defaultSchema)) {
      const allowed = objectAccess(permissions, ref)
      if (allowed === "hidden") raise("block", `${quoteRef(ref)} is hidden on this connection.`)
      else if (allowed === "schema") raise("block", structureOnly(ref))
      else if (ref.written && allowed === "read") raise("block", `${quoteRef(ref)} is read-only on this connection.`)
    }
    if (hiding) {
      for (const reason of opaqueIn(tokens, context.engine, context.defaultSchema)) {
        raise("block", `${reason} This connection hides tables, so it is refused.`)
      }
    }
    if (cls === "read" || cls === "session") continue
    const writeKinds: StatementKind[] = cls === "other" ? [...STATEMENT_KINDS] : [cls]
    for (const kind of writeKinds) kinds.add(kind)
    const statementRule = writeKinds
      .map((kind) => ruleFor(permissions, access, kind))
      .reduce(stricter, "allow" as Rule)
    if (statementRule !== "allow") {
      const what =
        cls === "other"
          ? `A statement this app cannot read the effect of (${tokens[0]?.text.toUpperCase()})`
          : STATEMENT_LABEL[cls]
      raise(
        statementRule,
        access === "read_only"
          ? "This connection is read-only."
          : statementRule === "block"
            ? `${what} is blocked on this connection.`
            : `${what}: this connection asks first.`
      )
    }
    if (
      permissions.guards.requireWhere &&
      (cls === "update" || cls === "delete") &&
      !hasWhere(tokens)
    ) {
      raise("block", `An ${cls.toUpperCase()} without WHERE would change every row; this connection refuses it.`)
    }
  }
  return { rule, reasons, kinds: [...kinds] }
}

/** The same, for rows edited in a table tab. */
export function judgeChanges(changes: ChangeSet, context: Omit<Context, "engine" | "defaultSchema">): Verdict {
  const { permissions, access } = context
  const reasons: string[] = []
  const kinds: StatementKind[] = []
  let rule: Rule = "allow"
  const raise = (to: Rule, reason: string) => {
    rule = stricter(rule, to)
    reasons.push(reason)
  }
  const ref = { schema: changes.schema, table: changes.table }
  const allowed = objectAccess(permissions, ref)
  if (allowed === "schema") raise("block", structureOnly(ref))
  else if (allowed !== "write") raise("block", `${quoteRef(ref)} is ${allowed === "hidden" ? "hidden" : "read-only"} on this connection.`)
  const counts: [StatementKind, number][] = [
    ["update", changes.updates.length],
    ["insert", changes.inserts.length],
    ["delete", changes.deletes.length],
  ]
  for (const [kind, count] of counts) {
    if (!count) continue
    kinds.push(kind)
    const kindRule = ruleFor(permissions, access, kind)
    if (kindRule !== "allow") {
      raise(
        kindRule,
        access === "read_only"
          ? "This connection is read-only."
          : kindRule === "block"
            ? `${STATEMENT_LABEL[kind]} is blocked on this connection.`
            : `${STATEMENT_LABEL[kind]}: this connection asks first.`
      )
    }
  }
  const total = counts.reduce((sum, [, count]) => sum + count, 0)
  const most = permissions.guards.maxAffected
  if (most !== null && total > most) {
    raise("block", `${total} rows would change, more than the ${most} this connection allows at once.`)
  }
  return { rule, reasons, kinds }
}

/** Where an unqualified table name is looked for. */
export const defaultSchemaOf = (connection: { engine: Engine; database: string }) =>
  connection.engine === "postgres" ? "public" : connection.database

/** The hidden and structure-only tables some SQL names, and what reaches a
 * table without naming it, as reasons to refuse it — for a read, or a dry
 * run, which changes nothing but may still show what is in them. */
export function hiddenIn(sql: string, context: Context): string[] {
  const reasons: string[] = []
  if (!hidesSomething(context.permissions)) return reasons
  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  for (const tokens of tokenize(sql, context.engine)) {
    for (const ref of referencesIn(tokens, context.defaultSchema)) {
      const access = objectAccess(context.permissions, ref)
      if (access === "hidden") add(`${quoteRef(ref)} is hidden on this connection.`)
      else if (access === "schema") add(structureOnly(ref))
    }
    for (const reason of opaqueIn(tokens, context.engine, context.defaultSchema)) {
      add(`${reason} This connection hides tables, so it is refused.`)
    }
  }
  return reasons
}

/** The permissions in a line or two for the assistant: what it will be refused. */
export function describePermissions(permissions: Permissions, access: AccessMode): string[] {
  const lines: string[] = []
  if (access === "read_only") lines.push("read-only: every write is refused")
  else {
    const blocked = STATEMENT_KINDS.filter((kind) => permissions.statements[kind] === "block")
    if (blocked.length) lines.push(`blocked: ${blocked.map((kind) => STATEMENT_LABEL[kind].toLowerCase()).join(", ")}`)
  }
  const read = permissions.objects.filter((rule) => rule.access === "read")
  if (read.length && access !== "read_only") {
    lines.push(`read-only: ${read.map((rule) => `${rule.schema}.${rule.table ?? "*"}`).join(", ")}`)
  }
  const structure = permissions.objects.filter(
    (rule) => rule.access !== "hidden" && (rule.aiSchemaOnly || rule.access === "schema")
  )
  if (structure.length) {
    lines.push(
      `structure only for the assistant (columns can be described, rows cannot be read — not even through a view or an aggregate): ${structure.map((rule) => `${rule.schema}.${rule.table ?? "*"}`).join(", ")}`
    )
  }
  const { guards } = permissions
  if (guards.requireWhere) lines.push("UPDATE and DELETE need a WHERE")
  if (guards.maxAffected !== null) lines.push(`a write may change at most ${guards.maxAffected} rows`)
  if (guards.timeoutSeconds !== null) lines.push(`statements stop after ${guards.timeoutSeconds}s`)
  if (guards.maxRows !== null) lines.push(`queries return at most ${guards.maxRows} rows`)
  return lines
}
