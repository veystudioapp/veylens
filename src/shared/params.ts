/**
 * Dashboard filters as SQL parameters.
 *
 * A tile's SQL names a filter as `{{name}}`, and wraps a clause that only
 * applies while the filter has a value in `[[ … ]]`:
 *
 *     SELECT status, count(*) FROM orders
 *      WHERE true
 *      [[AND ordered_at >= {{date_start}}]]
 *      [[AND ordered_at <  {{date_end}}]]
 *      [[AND country = {{country}}]]
 *      GROUP BY 1
 *
 * With "All" chosen the country clause is dropped; with a country chosen it
 * stays, and the value travels as a bound parameter — `$1`, `?` — never as
 * text spliced into the statement. Only a query opened for the user to read
 * and edit (a drill-down, "Open as query") has its values written in, as
 * quoted literals.
 */
import type { Cell, DashboardFilter, DatePreset, ParamValues, TextMatch } from "./api"

/** DuckDB binds and quotes as Postgres does. */
export type ParamDialect = "postgres" | "mysql" | "duckdb"

const PARAM = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g
const BLOCK = /\[\[([\s\S]*?)\]\]/g

type ParamValue = ParamValues[string]

const present = (value: ParamValue | undefined): value is string | string[] =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== ""

export function paramNames(sql: string): string[] {
  return [...new Set([...sql.matchAll(PARAM)].map((match) => match[1]!))]
}

export const hasParameters = (sql: string) =>
  paramNames(sql).length > 0 || /\[\[[\s\S]*?\]\]/.test(sql)

/** The statement with every `[[ … ]]` kept or dropped by its parameters. */
function resolveBlocks(sql: string, values: ParamValues): string {
  return sql.replace(BLOCK, (_, inner: string) =>
    paramNames(inner).every((name) => present(values[name])) ? inner : ""
  )
}

function missing(name: string, values: ParamValues): Error {
  return new Error(
    name in values
      ? `{{${name}}} has no value. Put the clause that uses it in [[ … ]] so that it is left out when nothing is chosen.`
      : `There is no filter for {{${name}}}. Known: ${Object.keys(values).map((key) => `{{${key}}}`).join(", ") || "none"}.`
  )
}

/** The statement with placeholders for the driver, and their values. */
export function bindParameters(
  sql: string,
  values: ParamValues,
  dialect: ParamDialect
): { text: string; values: Cell[] } {
  const bound: Cell[] = []
  // Postgres numbers its placeholders, so a name used twice is bound once.
  const placed = new Map<string, string>()
  const text = resolveBlocks(sql, values).replace(PARAM, (_, name: string) => {
    const value = values[name]
    if (!present(value)) throw missing(name, values)
    const list = Array.isArray(value) ? value : [value]
    if (dialect === "mysql") {
      bound.push(...list)
      return list.map(() => "?").join(", ")
    }
    let placeholders = placed.get(name)
    if (placeholders === undefined) {
      placeholders = list
        .map((item) => {
          bound.push(item)
          return `$${bound.length}`
        })
        .join(", ")
      placed.set(name, placeholders)
    }
    return placeholders
  })
  return { text, values: bound }
}

/** A value as a SQL string literal in the engine's own quoting. */
export function quoteLiteral(value: string, dialect: ParamDialect): string {
  const escaped =
    dialect === "mysql"
      ? value.replaceAll("\\", "\\\\").replaceAll("'", "''")
      : value.replaceAll("'", "''")
  return `'${escaped}'`
}

/** The statement with its values written in: for a person to read and edit. */
export function inlineParameters(
  sql: string,
  values: ParamValues,
  dialect: ParamDialect
): string {
  return resolveBlocks(sql, values).replace(PARAM, (_, name: string) => {
    const value = values[name]
    if (!present(value)) throw missing(name, values)
    return (Array.isArray(value) ? value : [value])
      .map((item) => quoteLiteral(item, dialect))
      .join(", ")
  })
}

// ── Dates ──────────────────────────────────────────────────────────────────

const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  all: "All time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
  mtd: "Month to date",
  qtd: "Quarter to date",
  ytd: "Year to date",
  custom: "Custom range",
}

/**
 * A preset as the first day in and the first day out, in local time. "Last
 * 7 days" is today and the six before it; "last 12 months" starts on the
 * first of the month eleven months back, so each month is whole.
 */
export function dateRange(
  preset: DatePreset,
  from: string | null,
  to: string | null,
  today = new Date()
): { start: string | null; end: string | null } {
  const tomorrow = day(addDays(today, 1))
  const year = today.getFullYear()
  const month = today.getMonth()
  switch (preset) {
    case "all":
      return { start: null, end: null }
    case "7d":
      return { start: day(addDays(today, -6)), end: tomorrow }
    case "30d":
      return { start: day(addDays(today, -29)), end: tomorrow }
    case "90d":
      return { start: day(addDays(today, -89)), end: tomorrow }
    case "12m":
      return { start: day(new Date(year, month - 11, 1)), end: tomorrow }
    case "mtd":
      return { start: day(new Date(year, month, 1)), end: tomorrow }
    case "qtd":
      return { start: day(new Date(year, month - (month % 3), 1)), end: tomorrow }
    case "ytd":
      return { start: day(new Date(year, 0, 1)), end: tomorrow }
    case "custom": {
      const valid = (text: string | null) =>
        text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null
      const last = valid(to)
      const [y, m, d] = (last ?? "").split("-").map(Number)
      return {
        start: valid(from),
        end: last ? day(addDays(new Date(y!, m! - 1, d!), 1)) : null,
      }
    }
  }
}

// ── Other filters ──────────────────────────────────────────────────────────

/** Words typed into a text filter as a LIKE pattern: `%` and `_` in them
 * match themselves, escaped with `\`, which LIKE takes by default on
 * Postgres and MySQL; DuckDB needs `ESCAPE '\'` after the pattern. */
export function likePattern(words: string, match: TextMatch): string {
  if (match === "exact") return words
  const escaped = words.replace(/[\\%_]/g, (char) => `\\${char}`)
  return match === "starts" ? `${escaped}%` : `%${escaped}%`
}

/** A number as typed — `1200`, `-3.5`, `1e3` — or null for anything else,
 * so a stray letter leaves the bound open rather than failing every tile. */
export function numberOrNull(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim().replace(/,/g, "")
  return /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(trimmed) ? trimmed : null
}

/** What the dashboard's filters set, as the parameters its tiles read. */
export function filterValues(
  filters: DashboardFilter[],
  today = new Date()
): ParamValues {
  const values: ParamValues = {}
  for (const filter of filters) {
    switch (filter.kind) {
      case "date_range": {
        const range = dateRange(filter.preset, filter.from, filter.to, today)
        values[`${filter.name}_start`] = range.start
        values[`${filter.name}_end`] = range.end
        break
      }
      case "select":
        values[filter.name] = filter.value
        break
      case "multi_select":
        values[filter.name] = filter.values
        break
      case "text":
        values[filter.name] = filter.value?.trim() ? likePattern(filter.value.trim(), filter.match) : null
        break
      case "number_range":
        values[`${filter.name}_min`] = numberOrNull(filter.min)
        values[`${filter.name}_max`] = numberOrNull(filter.max)
        break
      case "toggle":
        values[filter.name] = filter.value === null ? null : filter.value ? "1" : "0"
        break
    }
  }
  return values
}

/** The names a filter gives its tiles, as they would be written. */
export function filterParams(filter: Pick<DashboardFilter, "kind" | "name">): string[] {
  return filter.kind === "date_range"
    ? [`${filter.name}_start`, `${filter.name}_end`]
    : filter.kind === "number_range"
      ? [`${filter.name}_min`, `${filter.name}_max`]
      : [filter.name]
}

/** What a filter is set to, in words: "Last 30 days", "3 chosen", "All". */
export function filterValueLabel(filter: DashboardFilter): string {
  switch (filter.kind) {
    case "date_range":
      return filter.preset === "custom"
        ? `${filter.from ?? "…"} to ${filter.to ?? "…"}`
        : DATE_PRESET_LABELS[filter.preset]
    case "select":
      return filter.value ?? "All"
    case "multi_select":
      return filter.values.length === 0 ? "All" : filter.values.join(", ")
    case "text":
      return filter.value?.trim() ? `${filter.match} "${filter.value.trim()}"` : "All"
    case "number_range": {
      const min = numberOrNull(filter.min)
      const max = numberOrNull(filter.max)
      return min && max ? `${min} to ${max}` : min ? `at least ${min}` : max ? `at most ${max}` : "All"
    }
    case "toggle":
      return filter.value === null ? "All" : filter.value ? "Yes" : "No"
  }
}

/** A filter name is a parameter name: letters, digits, underscores. */
export const validParamName = (name: string) => /^[A-Za-z_]\w*$/.test(name)
