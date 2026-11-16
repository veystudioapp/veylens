/**
 * What can be said about a chart from a result alone: which columns can be
 * plotted, what a sensible first chart is, and whether a spec fits the data.
 * Shared, so the agent's `show_chart` refuses exactly what the viewer could
 * not draw.
 */
import {
  MAX_SERIES,
  type Cell,
  type ChartSpec,
  type Column,
  type QueryResult,
} from "./api"

/** A value as a number, or null where it is not one. */
export function toNumber(value: Cell | undefined): number | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (text === "") return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

/**
 * Whether a column holds numbers: by its type, or — for a driver that says
 * `text` about a `SUM` — by every value it has reading as one.
 */
export function isNumeric(
  result: Pick<QueryResult, "columns" | "rows">,
  index: number
): boolean {
  const column = result.columns[index]
  if (!column) return false
  if (column.kind === "number") return true
  if (column.kind !== "text") return false
  let seen = 0
  for (const row of result.rows) {
    const value = row[index]
    if (value === null || value === undefined) continue
    if (toNumber(value) === null) return false
    seen++
  }
  return seen > 0
}

const isTime = (column: Column) =>
  column.kind === "datetime" || /date|time|month|year|day|week/i.test(column.name)

/** Types that draw several numeric columns side by side or stacked. */
export const STACKABLE = new Set<ChartSpec["type"]>(["bar", "hbar", "area"])

/** A first chart for a result, or null when nothing in it can be plotted. */
export function inferChart(
  result: Pick<QueryResult, "columns" | "rows">
): ChartSpec | null {
  const numeric = result.columns
    .map((column, index) => ({ column, index }))
    .filter(({ index }) => isNumeric(result, index))
  if (numeric.length === 0) return null

  // One row of numbers is a figure, not a chart.
  if (result.rows.length === 1 && numeric.length === result.columns.length) {
    return { type: "stat", x: null, y: [numeric[0]!.column.name] }
  }

  // Two dimensions and a measure — `GROUP BY month, channel` — is one series
  // per value of the second, along the first.
  const dimensions = result.columns.filter(
    (_, index) => !isNumeric(result, index)
  )
  if (dimensions.length === 2 && numeric.length === 1) {
    const [first, second] = dimensions as [Column, Column]
    const along = isTime(second) && !isTime(first) ? second : first
    const across = along === first ? second : first
    return {
      type: isTime(along) ? "line" : "bar",
      x: along.name,
      y: [numeric[0]!.column.name],
      series: across.name,
    }
  }

  const x =
    result.columns.find((column, index) => !isNumeric(result, index)) ??
    // Every column numeric (year, total): the first is the axis.
    (numeric.length > 1 ? numeric[0]!.column : undefined)
  if (!x) return null
  const y = numeric
    .map(({ column }) => column.name)
    .filter((name) => name !== x.name)
    .slice(0, MAX_SERIES)
  if (y.length === 0) return null

  const type = isTime(x) ? "line" : result.rows.length > 12 ? "hbar" : "bar"
  return { type, x: x.name, y }
}

/** Why a spec cannot be drawn from these columns, or null when it can. */
export function chartProblem(
  spec: ChartSpec,
  result: Pick<QueryResult, "columns" | "rows">
): string | null {
  const names = result.columns.map((column) => column.name)
  const missing = [
    spec.x,
    spec.series ?? null,
    spec.compare ?? null,
    spec.target ?? null,
    ...spec.y,
  ].filter(
    (name): name is string => name !== null && !names.includes(name)
  )
  if (missing.length) {
    return `No column named ${missing.map((name) => `"${name}"`).join(", ")}. The result has: ${names.join(", ")}.`
  }
  if (spec.y.length === 0 && spec.type !== "table") {
    return "Name at least one column in y."
  }
  if (spec.y.length > MAX_SERIES) {
    return `At most ${MAX_SERIES} series; fold the rest into "Other" in the SQL.`
  }
  const notNumbers = [
    ...spec.y,
    ...(spec.compare ? [spec.compare] : []),
    ...(spec.target ? [spec.target] : []),
  ].filter(
    (name) => !isNumeric(result, names.indexOf(name))
  )
  if (notNumbers.length) {
    return `${notNumbers.map((name) => `"${name}"`).join(", ")} ${notNumbers.length === 1 ? "is" : "are"} not numeric, so cannot be plotted.`
  }
  if (spec.series && spec.y.length !== 1) {
    return "With series, y names the one value plotted for each series."
  }
  if (spec.series && spec.series === spec.x) {
    return "series and x must be different columns."
  }
  if (spec.stacked && !STACKABLE.has(spec.type)) {
    return `A ${spec.type} chart cannot be stacked; only bar, hbar and area can.`
  }
  switch (spec.type) {
    case "stat":
    case "table":
      return spec.type === "stat" && result.rows.length === 0
        ? "The query returned no rows."
        : null
    case "kpi":
      if (result.rows.length === 0) return "The query returned no rows."
      if (!spec.x && result.rows.length > 1) {
        return "A KPI without x reads one row; with x (a period), its trend is the rows in order and the last row is the current value."
      }
      return null
    case "pivot":
      if (!spec.x || !spec.series) {
        return "A pivot needs x (its rows) and series (its columns)."
      }
      return null
    case "progress":
      if (!spec.target) return "A progress needs target: the column holding the goal."
      if (spec.y.length !== 1) return "A progress measures one value, y[0], against its target."
      if (result.rows.length === 0) return "The query returned no rows."
      if (!spec.x && result.rows.length > 1) {
        return "A progress without x reads one row; with x, each row is a bar against its own target."
      }
      return null
    case "scatter":
      if (!spec.x) return "A scatter needs x: the measure along the bottom."
      if (!isNumeric(result, names.indexOf(spec.x))) {
        return `A scatter plots one measure against another; "${spec.x}" is not numeric.`
      }
      if (spec.y.length !== 1) return "A scatter plots one measure, y[0], against x."
      return null
    case "funnel":
    case "waterfall":
      if (!spec.x) return `A ${spec.type} needs x: the column naming its steps.`
      if (spec.series) return `A ${spec.type} has no series; one row per step.`
      if (spec.y.length !== 1) return `A ${spec.type} draws one value, y[0], per step.`
      return null
    default:
      return spec.x ? null : `A ${spec.type} chart needs x.`
  }
}

/** One bar of a waterfall: where it starts and ends on the value axis. */
export type BridgeStep = {
  from: number
  to: number
  kind: "start" | "up" | "down" | "total"
}

/**
 * A waterfall's bars: the first value is where it starts, from zero; each
 * after it moves the running figure up or down from where the last left it;
 * the total is where it ends, from zero again. A missing change moves nothing.
 */
export function bridge(values: (number | null)[]): BridgeStep[] {
  if (values.length === 0) return []
  const start = values[0] ?? 0
  const steps: BridgeStep[] = [{ from: 0, to: start, kind: "start" }]
  let running = start
  for (const value of values.slice(1)) {
    const change = value ?? 0
    steps.push({ from: running, to: running + change, kind: change < 0 ? "down" : "up" })
    running += change
  }
  steps.push({ from: 0, to: running, kind: "total" })
  return steps
}

/** What a long result becomes when one column's values are its series. */
export type Wide = {
  labels: Cell[]
  names: string[]
  /** [series][row] */
  values: (number | null)[][]
}

/**
 * A result in long form — one row per (x, series) — turned wide: one row per
 * x, one series per value of the series column, in the order the values
 * sort, so that a series keeps its colour when a filter removes another.
 * Past `MAX_SERIES` the smallest are summed into "Other".
 */
export function widen(
  result: Pick<QueryResult, "columns" | "rows">,
  x: string,
  series: string,
  value: string
): Wide {
  const names = result.columns.map((column) => column.name)
  const xi = names.indexOf(x)
  const si = names.indexOf(series)
  const vi = names.indexOf(value)
  const labels: Cell[] = []
  const rowOf = new Map<string, number>()
  const cells = new Map<string, Map<number, number>>()
  const totals = new Map<string, number>()
  for (const row of result.rows) {
    const label = row[xi] ?? null
    const key = label ?? "\u0000null"
    let index = rowOf.get(key)
    if (index === undefined) {
      index = labels.length
      labels.push(label)
      rowOf.set(key, index)
    }
    const name = row[si] ?? "NULL"
    const number = toNumber(row[vi])
    if (!cells.has(name)) cells.set(name, new Map())
    if (number !== null) {
      const column = cells.get(name)!
      column.set(index, (column.get(index) ?? 0) + number)
      totals.set(name, (totals.get(name) ?? 0) + Math.abs(number))
    }
  }
  let ordered = [...cells.keys()].sort((a, b) => a.localeCompare(b))
  if (ordered.length > MAX_SERIES) {
    const keep = new Set(
      [...ordered]
        .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
        .slice(0, MAX_SERIES - 1)
    )
    const other = new Map<number, number>()
    for (const name of ordered) {
      if (keep.has(name)) continue
      for (const [index, number] of cells.get(name)!) {
        other.set(index, (other.get(index) ?? 0) + number)
      }
    }
    ordered = ordered.filter((name) => keep.has(name))
    cells.set("Other", other)
    ordered.push("Other")
  }
  return {
    labels,
    names: ordered,
    values: ordered.map((name) =>
      labels.map((_, index) => cells.get(name)!.get(index) ?? null)
    ),
  }
}
