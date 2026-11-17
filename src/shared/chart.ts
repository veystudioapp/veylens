/**
 * What can be said about a chart from a result alone: which columns can be
 * plotted, what a sensible first chart is, and whether a spec fits the data.
 * Shared, so the agent's `show_chart` refuses exactly what the viewer could
 * not draw.
 */
import {
  ANALYTIC_TYPES,
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
export const STACKABLE = new Set<ChartSpec["type"]>(["bar", "hbar", "area", "combo"])

/** Types that draw the parts of one whole, one row per part. */
export const PARTS = new Set<ChartSpec["type"]>(["pie", "donut", "treemap"])

/** Types whose categories can be drilled into, level by level. */
export const DRILLABLE = new Set<ChartSpec["type"]>([
  "bar",
  "hbar",
  "line",
  "area",
  "combo",
  "pie",
  "donut",
  "treemap",
])

/** Types that can be split into small multiples on one scale. */
export const FACETABLE = new Set<ChartSpec["type"]>(["bar", "line", "area", "combo"])

/** The longest a forecast may run, in periods. */
export const MAX_FORECAST = 24

/** Why a spec's analytics, drill levels, facet or cell rules cannot be drawn. */
function extrasProblem(
  spec: ChartSpec,
  result: Pick<QueryResult, "columns" | "rows">
): string | null {
  const names = result.columns.map((column) => column.name)
  const levels = spec.levels ?? []
  if (levels.length) {
    if (!DRILLABLE.has(spec.type)) return `A ${spec.type} cannot be drilled into.`
    if (!spec.x) return "Drill levels go under x: name x, the top level."
    const all = [spec.x, ...levels]
    if (new Set(all).size !== all.length) return "x and each drill level must be different columns."
    const taken = [spec.series, spec.line, spec.size, ...spec.y].filter(Boolean)
    const clash = levels.find((level) => taken.includes(level))
    if (clash) return `"${clash}" is plotted, so it cannot also be a drill level.`
    if (spec.facet) return "A chart is drilled into or split into small multiples, not both."
  }
  if (spec.facet) {
    if (!FACETABLE.has(spec.type)) return `A ${spec.type} cannot be split into small multiples.`
    if (spec.series) return "Split into small multiples or into series, not both: name the columns in y."
    if (spec.facet === spec.x) return "facet and x must be different columns."
  }
  const analytics = spec.analytics
  if (analytics) {
    const fitted = analytics.average || analytics.median || analytics.trend || analytics.forecast || analytics.anomalies
    const any = fitted || analytics.constant != null
    if (any && !ANALYTIC_TYPES.has(spec.type)) {
      return `A ${spec.type} has no analytics lines; bar, line, area, combo and scatter do.`
    }
    if (spec.type === "scatter" && (analytics.average || analytics.median || analytics.forecast || analytics.anomalies)) {
      return "A scatter takes a trend line and a constant line only."
    }
    if (analytics.forecast) {
      if (spec.type !== "line" && spec.type !== "area") return "Only a line or an area is forecast."
      if (!Number.isInteger(analytics.forecast) || analytics.forecast < 1 || analytics.forecast > MAX_FORECAST) {
        return `A forecast runs 1 to ${MAX_FORECAST} periods.`
      }
    }
    if (fitted && (spec.stacked || spec.percent)) {
      return "Averages, trends, forecasts and anomalies are per series: unstack the chart."
    }
  }
  for (const rule of spec.rules ?? []) {
    if (spec.type !== "table" && spec.type !== "pivot") return "Only a table or a pivot formats its cells."
    if (!names.includes(rule.column)) return `No column named "${rule.column}" to format.`
    if (!isNumeric(result, names.indexOf(rule.column))) return `"${rule.column}" is not numeric, so cannot be formatted by value.`
    if (spec.type === "pivot" && rule.column !== spec.y[0]) return `A pivot's cells are ${spec.y[0]}; format that column.`
  }
  return null
}

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
    spec.line ?? null,
    spec.size ?? null,
    spec.facet ?? null,
    ...(spec.levels ?? []),
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
    ...(spec.line ? [spec.line] : []),
    ...(spec.size ? [spec.size] : []),
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
  if ((spec.stacked || spec.percent) && !STACKABLE.has(spec.type)) {
    return `A ${spec.type} chart cannot be stacked; only bar, hbar, area and combo can.`
  }
  if (spec.percent && !spec.series && spec.y.length < 2) {
    return "A 100% stack splits each category between several series: name two or more y, or a series."
  }
  if (spec.line && spec.type !== "combo") return "Only a combo draws a line column."
  if (spec.size && spec.type !== "scatter") return "Only a scatter sizes its dots."
  const extras = extrasProblem(spec, result)
  if (extras) return extras
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
    case "pie":
    case "donut":
    case "treemap": {
      if (!spec.x) return `A ${spec.type} needs x: the column naming its parts.`
      if (spec.series) return `A ${spec.type} has no series; one row per part.`
      if (spec.y.length !== 1) return `A ${spec.type} sizes its parts by one value, y[0].`
      const index = names.indexOf(spec.y[0]!)
      if (result.rows.some((row) => (toNumber(row[index]) ?? 0) < 0)) {
        return `A ${spec.type} shows the parts of a whole, and "${spec.y[0]}" has negative values; use hbar.`
      }
      return null
    }
    case "combo":
      if (!spec.x) return "A combo needs x."
      if (!spec.line) return "A combo needs line: the column drawn as a line on the right axis."
      if (spec.y.includes(spec.line)) return "A combo's line must not also be one of its columns (y)."
      if (spec.series) return "A combo has no series; name its columns in y."
      if (spec.y.length + 1 > MAX_SERIES) return `At most ${MAX_SERIES} series, the line included.`
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

// ── Analytics ──────────────────────────────────────────────────────────────

/** A straight line through points, and how far they scatter about it. */
export type Fit = { slope: number; intercept: number; sigma: number }

/** The least-squares line through the points; null for fewer than two. */
export function fitLine(points: { x: number; y: number }[]): Fit | null {
  const n = points.length
  if (n < 2) return null
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n
  let across = 0
  let spread = 0
  for (const point of points) {
    across += (point.x - meanX) * (point.y - meanY)
    spread += (point.x - meanX) ** 2
  }
  const slope = spread === 0 ? 0 : across / spread
  const intercept = meanY - slope * meanX
  const squares = points.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0)
  return { slope, intercept, sigma: n > 2 ? Math.sqrt(squares / (n - 2)) : 0 }
}

/** A series' fit along its rows, the row's index its x; gaps left out. */
export function fitSeries(values: (number | null)[]): Fit | null {
  return fitLine(
    values.flatMap((value, index) => (value === null ? [] : [{ x: index, y: value }]))
  )
}

export function mean(values: (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null)
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
}

export function median(values: (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (!numbers.length) return null
  const middle = Math.floor(numbers.length / 2)
  return numbers.length % 2 ? numbers[middle]! : (numbers[middle - 1]! + numbers[middle]!) / 2
}

/**
 * Which values lie more than two standard deviations off their series' fit.
 * Below six points there is too little to call anything unusual.
 */
export function anomalies(values: (number | null)[]): boolean[] {
  const fit = fitSeries(values)
  const count = values.filter((value) => value !== null).length
  if (!fit || count < 6 || fit.sigma === 0) return values.map(() => false)
  return values.map(
    (value, index) =>
      value !== null && Math.abs(value - (fit.intercept + fit.slope * index)) > 2 * fit.sigma
  )
}

/** One period of a forecast: where the trend puts it, and its likely range. */
export type ForecastStep = { value: number; low: number; high: number }

/**
 * The periods after a series, carried on from its last value at its fitted
 * slope; the range, 95% if the scatter about the fit holds, widening with
 * the square root of the distance ahead. Null with fewer than three points.
 */
export function forecast(values: (number | null)[], ahead: number): ForecastStep[] | null {
  const fit = fitSeries(values)
  let lastIndex = values.length - 1
  while (lastIndex >= 0 && values[lastIndex] === null) lastIndex--
  if (!fit || lastIndex < 0 || values.filter((value) => value !== null).length < 3) return null
  const last = values[lastIndex]!
  return Array.from({ length: ahead }, (_, index) => {
    const distance = values.length - lastIndex + index
    const value = last + fit.slope * distance
    const spread = 1.96 * fit.sigma * Math.sqrt(distance)
    return { value, low: value - spread, high: value + spread }
  })
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

/**
 * The labels of the periods after the last: the next months, quarters,
 * days at the same step, or numbers at the same step — and "+1", "+2"…
 * where the labels say nothing of what comes next.
 */
export function nextLabels(labels: string[], count: number): string[] {
  const last = labels.at(-1) ?? ""
  const before = labels.at(-2)
  const ahead = Array.from({ length: count }, (_, index) => index + 1)
  let match = /^(\d{4})-(\d{2})$/.exec(last)
  if (match) {
    const start = Number(match[1]) * 12 + Number(match[2]) - 1
    return ahead.map((step) => `${Math.floor((start + step) / 12)}-${pad(((start + step) % 12) + 1)}`)
  }
  match = /^(\d{4})-Q([1-4])$/.exec(last)
  if (match) {
    const start = Number(match[1]) * 4 + Number(match[2]) - 1
    return ahead.map((step) => `${Math.floor((start + step) / 4)}-Q${((start + step) % 4) + 1}`)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
    const day = 86_400_000
    const at = Date.parse(`${last}T00:00:00Z`)
    const previous = before && /^\d{4}-\d{2}-\d{2}$/.test(before) ? Date.parse(`${before}T00:00:00Z`) : NaN
    const step = Number.isFinite(previous) && at > previous ? at - previous : day
    return ahead.map((index) => new Date(at + step * index).toISOString().slice(0, 10))
  }
  if (/^-?\d+$/.test(last)) {
    const step = before !== undefined && /^-?\d+$/.test(before) ? Number(last) - Number(before) || 1 : 1
    return ahead.map((index) => String(Number(last) + step * index))
  }
  return ahead.map((index) => `+${index}`)
}

/**
 * The rows under a path of drilled categories, summed by the next level:
 * one row per value of `by` (and of `series`), in the order they first
 * appear, with `sum` the totals of their numbers.
 */
export function rollUp(
  result: Pick<QueryResult, "columns" | "rows">,
  where: [string, Cell][],
  by: string[],
  sum: string[]
): Pick<QueryResult, "columns" | "rows"> {
  const names = result.columns.map((column) => column.name)
  const filters = where.map(([name, value]) => [names.indexOf(name), value] as const)
  const keys = by.map((name) => names.indexOf(name))
  const totals = sum.map((name) => names.indexOf(name))
  const groups = new Map<string, { key: Cell[]; sums: (number | null)[] }>()
  for (const row of result.rows) {
    if (!filters.every(([index, value]) => (row[index] ?? null) === value)) continue
    const key = keys.map((index) => row[index] ?? null)
    const id = JSON.stringify(key)
    let group = groups.get(id)
    if (!group) {
      group = { key, sums: totals.map(() => null) }
      groups.set(id, group)
    }
    totals.forEach((index, at) => {
      const number = toNumber(row[index])
      if (number !== null) group!.sums[at] = (group!.sums[at] ?? 0) + number
    })
  }
  return {
    columns: [...keys, ...totals].map((index) => result.columns[index]!),
    rows: [...groups.values()].map((group) => [
      ...group.key,
      ...group.sums.map((value) => (value === null ? null : String(Number(value.toPrecision(15))))),
    ]),
  }
}

/** One part of a whole: a category of x, or the tail folded together. */
export type Part = { raw: Cell; value: number; other: boolean }

/**
 * The parts a pie or a treemap draws: rows of the same category summed,
 * largest first, the empty dropped, and past `keep` the smallest folded into
 * one "Other" — last, whatever its size.
 */
export function parts(
  result: Pick<QueryResult, "columns" | "rows">,
  x: string,
  value: string,
  keep: number
): Part[] {
  const names = result.columns.map((column) => column.name)
  const xi = names.indexOf(x)
  const vi = names.indexOf(value)
  const sums = new Map<string, { raw: Cell; value: number }>()
  for (const row of result.rows) {
    const number = toNumber(row[vi])
    if (number === null) continue
    const raw = row[xi] ?? null
    const key = raw ?? "\u0000null"
    const entry = sums.get(key)
    if (entry) entry.value += number
    else sums.set(key, { raw, value: number })
  }
  const sorted = [...sums.values()]
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
  if (sorted.length <= keep) return sorted.map((entry) => ({ ...entry, other: false }))
  const rest = sorted.slice(keep - 1).reduce((sum, entry) => sum + entry.value, 0)
  return [
    ...sorted.slice(0, keep - 1).map((entry) => ({ ...entry, other: false })),
    { raw: "Other", value: rest, other: true },
  ]
}

export type Box = { x: number; y: number; w: number; h: number }

/**
 * A box cut into one rectangle per value, each with the area its value is
 * of the total, as near square as rows laid along the shorter side allow
 * (Bruls, Huizing and van Wijk's squarified treemap). Values largest first.
 */
export function squarify(values: number[], box: Box): Box[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || box.w <= 0 || box.h <= 0) return values.map(() => ({ ...box, w: 0, h: 0 }))
  const areas = values.map((value) => (value / total) * box.w * box.h)
  const worst = (sum: number, least: number, most: number, side: number) =>
    Math.max((side * side * most) / (sum * sum), (sum * sum) / (side * side * least))
  const out: Box[] = new Array(values.length)
  let { x, y, w, h } = box
  let start = 0
  while (start < areas.length) {
    const side = Math.min(w, h)
    let end = start + 1
    let sum = areas[start]!
    let least = sum
    let most = sum
    let ratio = worst(sum, least, most, side)
    while (end < areas.length) {
      const next = areas[end]!
      const nextRatio = worst(sum + next, Math.min(least, next), Math.max(most, next), side)
      if (nextRatio > ratio) break
      sum += next
      least = Math.min(least, next)
      most = Math.max(most, next)
      ratio = nextRatio
      end++
    }
    const thickness = sum / side
    let offset = 0
    for (let index = start; index < end; index++) {
      const length = areas[index]! / thickness
      out[index] =
        w >= h
          ? { x, y: y + offset, w: thickness, h: length }
          : { x: x + offset, y, w: length, h: thickness }
      offset += length
    }
    if (w >= h) {
      x += thickness
      w -= thickness
    } else {
      y += thickness
      h -= thickness
    }
    start = end
  }
  return out
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
