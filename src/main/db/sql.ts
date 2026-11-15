import {
  combineFilters,
  type Cell,
  type ChangeSet,
  type Filter,
  type FilterMatch,
  type FilterNode,
  type RowKey,
  type Sort,
  type TableRef,
} from "../../shared/api"
import { startsLikeRead } from "../../shared/statements"

/** What differs between the engines when a statement is put together. */
export type Dialect = {
  quote(identifier: string): string
  /** The nth placeholder, counted from 1. */
  param(n: number): string
  /** A column rendered as text, for LIKE against any type. */
  asText(expression: string): string
  like: string
}

export const POSTGRES: Dialect = {
  quote: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
  param: (n) => `$${n}`,
  asText: (expression) => `${expression}::text`,
  like: "ILIKE",
}

export const MYSQL: Dialect = {
  quote: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
  param: () => "?",
  asText: (expression) => `CAST(${expression} AS CHAR)`,
  like: "LIKE",
}

export type Statement = { text: string; values: Cell[] }

/** Collects values and hands back the placeholder each one is bound to. */
class Params {
  readonly values: Cell[] = []
  constructor(private readonly dialect: Dialect) {}
  add(value: Cell): string {
    this.values.push(value)
    return this.dialect.param(this.values.length)
  }
}

export function tableName(dialect: Dialect, ref: TableRef): string {
  return `${dialect.quote(ref.schema)}.${dialect.quote(ref.table)}`
}

/** `%`, `_` and the escape character itself, taken literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

const COMPARISONS: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
}

function condition(dialect: Dialect, filter: Filter, params: Params): string {
  const column = dialect.quote(filter.column)
  const pattern = (text: string) =>
    `${dialect.asText(column)} ${dialect.like} ${params.add(text)}`

  switch (filter.op) {
    case "is_null":
      return `${column} IS NULL`
    case "is_not_null":
      return `${column} IS NOT NULL`
    case "contains":
      return pattern(`%${likeLiteral(filter.value)}%`)
    case "not_contains":
      return `NOT (${pattern(`%${likeLiteral(filter.value)}%`)})`
    case "starts_with":
      return pattern(`${likeLiteral(filter.value)}%`)
    case "ends_with":
      return pattern(`%${likeLiteral(filter.value)}`)
    default: {
      const operator = COMPARISONS[filter.op]
      if (!operator) throw new Error(`Unknown filter operator: ${filter.op}`)
      return `${column} ${operator} ${params.add(filter.value)}`
    }
  }
}

function where(
  dialect: Dialect,
  filters: FilterNode[],
  params: Params,
  match: FilterMatch = "all"
): string {
  // Each part in brackets, so or never binds into a neighbour's words.
  const joined = combineFilters(
    filters,
    match,
    (filter) => condition(dialect, filter, params),
    (parts, word) => parts.map((part) => `(${part})`).join(word === "or" ? " OR " : " AND ")
  )
  return joined === null ? "" : ` WHERE ${joined}`
}

/**
 * The row a change is about, as a WHERE clause.
 *
 * An empty key throws rather than producing no clause at all: an UPDATE or a
 * DELETE without a WHERE is every row in the table.
 */
function whereKey(dialect: Dialect, key: RowKey, params: Params): string {
  const columns = Object.keys(key)
  if (columns.length === 0) {
    throw new Error("A row can only be changed through its primary key.")
  }
  const parts = columns.map((column) => {
    const value = key[column] ?? null
    return value === null
      ? `${dialect.quote(column)} IS NULL`
      : `${dialect.quote(column)} = ${params.add(value)}`
  })
  return ` WHERE ${parts.join(" AND ")}`
}

function wholeNumber(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number.`)
  }
  return value
}

export function selectRows(
  dialect: Dialect,
  ref: TableRef,
  columns: string[],
  filters: FilterNode[],
  order: Sort[],
  limit: number,
  offset: number,
  match: FilterMatch = "all"
): Statement {
  const params = new Params(dialect)
  const list = columns.length
    ? columns.map((column) => dialect.quote(column)).join(", ")
    : "*"
  const orderBy = order.length
    ? ` ORDER BY ${order
        .map(
          (sort) =>
            `${dialect.quote(sort.column)} ${sort.direction === "desc" ? "DESC" : "ASC"}`
        )
        .join(", ")}`
    : ""
  return {
    text:
      `SELECT ${list} FROM ${tableName(dialect, ref)}` +
      where(dialect, filters, params, match) +
      orderBy +
      ` LIMIT ${wholeNumber(limit, "limit")} OFFSET ${wholeNumber(offset, "offset")}`,
    values: params.values,
  }
}

export function countRows(
  dialect: Dialect,
  ref: TableRef,
  filters: FilterNode[],
  match: FilterMatch = "all"
): Statement {
  const params = new Params(dialect)
  return {
    text:
      `SELECT count(*) FROM ${tableName(dialect, ref)}` +
      where(dialect, filters, params, match),
    values: params.values,
  }
}

/**
 * A change set as statements, in the order they are run: deletes, updates,
 * inserts. `single` marks the ones that must touch exactly one row.
 */
export function changeStatements(
  dialect: Dialect,
  changes: ChangeSet
): (Statement & { single: boolean })[] {
  const table = tableName(dialect, changes)
  const statements: (Statement & { single: boolean })[] = []

  for (const key of changes.deletes) {
    const params = new Params(dialect)
    statements.push({
      text: `DELETE FROM ${table}${whereKey(dialect, key, params)}`,
      values: params.values,
      single: true,
    })
  }

  for (const update of changes.updates) {
    const columns = Object.keys(update.values)
    if (columns.length === 0) continue
    const params = new Params(dialect)
    const assignments = columns
      .map(
        (column) =>
          `${dialect.quote(column)} = ${params.add(update.values[column] ?? null)}`
      )
      .join(", ")
    statements.push({
      text: `UPDATE ${table} SET ${assignments}${whereKey(dialect, update.key, params)}`,
      values: params.values,
      single: true,
    })
  }

  for (const insert of changes.inserts) {
    const columns = Object.keys(insert)
    const params = new Params(dialect)
    const text = columns.length
      ? `INSERT INTO ${table} (${columns.map((column) => dialect.quote(column)).join(", ")}) VALUES (${columns.map((column) => params.add(insert[column] ?? null)).join(", ")})`
      : dialect === MYSQL
        ? `INSERT INTO ${table} () VALUES ()`
        : `INSERT INTO ${table} DEFAULT VALUES`
    statements.push({ text, values: params.values, single: false })
  }

  return statements
}

/**
 * Refuses a statement that does not start like a read.
 *
 * The first of two locks on a read, and the weaker one: the statement is also
 * run inside a READ ONLY transaction, which is what actually stops a write
 * hidden in a CTE. This one is for what such a transaction lets through —
 * COPY … TO, SET, CALL, SELECT … INTO OUTFILE.
 */
export function assertReadOnly(sql: string): void {
  if (/\binto\s+(outfile|dumpfile)\b/i.test(sql)) {
    throw new Error("run_query cannot write to a file on the server.")
  }
  if (!startsLikeRead(sql)) {
    throw new Error(
      "run_query only runs read-only statements (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE). Use execute_sql for anything that changes data or schema."
    )
  }
}
