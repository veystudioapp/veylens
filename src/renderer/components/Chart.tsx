import { ArrowDownRight, ArrowUp, ArrowUpRight, ChevronRight, Minus } from "lucide-react"
import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import {
  MAX_SERIES,
  type Cell,
  type CellRule,
  type ChartAnalytics,
  type ChartSpec,
  type QueryResult,
} from "@shared/api"
import {
  anomalies,
  bridge,
  DRILLABLE,
  FACETABLE,
  fitLine,
  fitSeries,
  forecast,
  isNumeric,
  mean,
  median,
  nextLabels,
  parts,
  rollUp,
  squarify,
  toNumber,
  widen,
  type Part,
} from "@shared/chart"

import { groupDigits } from "@/lib/cell-format"
import { cn } from "@/lib/utils"

/*
 * Charts drawn as SVG, to the dataviz method's specs rather than a library's
 * defaults: series colours in a fixed order (`--series-n`, validated against
 * this app's surfaces), bars at most 24px with a 4px rounded data end and
 * square at the baseline, a 2px surface gap between stacked segments, 2px
 * lines, markers ringed in the surface colour, hairline solid grid, one axis
 * only, a legend for two or more series, labels on few marks, and every value
 * reachable by hover, by keyboard, and in the table view the callers put
 * beside each chart. Magnitude in a matrix or a table is one hue, light to
 * dark.
 */

type Data = Pick<QueryResult, "columns" | "rows">

const color = (index: number) => `var(--series-${index + 1})`
/** The folded tail of a pie or a treemap: no hue of its own, so none is spent. */
const OTHER = "color-mix(in oklab, var(--muted-foreground) 45%, var(--card))"

const CHAR = 6.2
const FONT = 11
const BAR = 24
const GAP = 2

const fullFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
})
const percentFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
})
/** A part of something: no sign, as a share is never a change. */
const shareFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
})
/** A change written on its bar: compact, and always signed. */
const changeFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
})

export const formatNumber = (value: number) => fullFormat.format(value)

/** Ticks in full under 10,000 and compact on an axis that reaches it. */
const tickFormat = (extent: number) =>
  extent >= 10_000
    ? (value: number) => compactFormat.format(value)
    : (value: number) => fullFormat.format(value)

/** A big figure: in full below a million, compact above. */
const figure = (value: number) =>
  Math.abs(value) >= 1_000_000 ? compactFormat.format(value) : fullFormat.format(value)

/** A category as it reads on an axis: midnight dropped from a date. */
export function categoryLabel(value: Cell | undefined): string {
  if (value === null || value === undefined) return "NULL"
  return value.replace(/[ T]00:00:00(\.0+)?([+-]\d\d(:?\d\d)?|Z)?$/, "")
}

function niceTicks(low: number, high: number, count = 5): number[] {
  if (low === high) {
    high = low === 0 ? 1 : low + Math.abs(low) * 0.5
    low = Math.min(0, low)
  }
  const raw = (high - low) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const error = raw / magnitude
  const step =
    (error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1) * magnitude
  const start = Math.floor(low / step) * step
  const end = Math.ceil(high / step) * step
  const ticks: number[] = []
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)))
  }
  return ticks
}

type Prepared = {
  /** The x values as the data has them: what a click selects. */
  raw: Cell[]
  labels: string[]
  names: string[]
  /** [series][row] */
  values: (number | null)[][]
  /** A combo's line, per row. */
  line: (number | null)[] | null
}

function prepare(spec: ChartSpec, data: Data): Prepared {
  const names = data.columns.map((column) => column.name)
  let raw: Cell[]
  let series: string[]
  let values: (number | null)[][]
  let line: (number | null)[] | null = null
  // A scatter's series colours its dots; its rows stay rows.
  if (spec.series && spec.x && spec.y[0] && spec.type !== "scatter") {
    const wide = widen(data, spec.x, spec.series, spec.y[0])
    raw = wide.labels
    series = wide.names
    values = wide.values
  } else {
    const xIndex = spec.x === null ? -1 : names.indexOf(spec.x)
    raw = data.rows.map((row) => (xIndex >= 0 ? (row[xIndex] ?? null) : null))
    series = spec.y
    values = spec.y.map((name) => {
      const index = names.indexOf(name)
      return data.rows.map((row) => toNumber(row[index]))
    })
    if (spec.type === "combo" && spec.line) {
      const index = names.indexOf(spec.line)
      line = data.rows.map((row) => toNumber(row[index]))
    }
  }
  let labels = raw.map(categoryLabel)
  // Months, as a `date_trunc('month', …)` gives them: the day says nothing.
  if (labels.length > 1 && labels.every((label) => /^\d{4}-\d{2}-01$/.test(label))) {
    labels = labels.map((label) => label.slice(0, 7))
  }
  return { raw, labels, names: series, values, line }
}

/** Each value as its share of its row's total across the series. */
function shares(values: (number | null)[][]): (number | null)[][] {
  const count = values[0]?.length ?? 0
  const totals = Array.from({ length: count }, (_, row) =>
    values.reduce((sum, series) => sum + Math.abs(series[row] ?? 0), 0)
  )
  return values.map((series) =>
    series.map((value, row) => (value === null ? null : totals[row] ? value / totals[row]! : 0))
  )
}

/**
 * A second axis's ticks at the first's gridlines: as many, with zero on the
 * same line, each a round step apart. Null when the second axis's values
 * fall where the first has no room for them — below a first that starts at
 * zero.
 */
function alignedTicks(low: number, high: number, left: number[]): number[] | null {
  const n = left.length - 1
  const zero = left.indexOf(0)
  if (n < 1 || zero < 0) return null
  if ((low < 0 && zero === 0) || (high > 0 && zero === n)) return null
  const raw = Math.max(zero > 0 ? -low / zero : 0, zero < n ? high / (n - zero) : 0)
  if (raw <= 0) return null
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10]
    .map((multiple) => multiple * magnitude)
    .find((candidate) => candidate >= raw * (1 - 1e-9))!
  return left.map((_, index) => Number(((index - zero) * step).toPrecision(12)))
}

/** For each row, each series' [from, to]: side by side from zero, or stacked. */
function spans(values: (number | null)[][], stacked: boolean) {
  const count = values[0]?.length ?? 0
  const result = values.map(() => new Array<[number, number] | null>(count).fill(null))
  for (let row = 0; row < count; row++) {
    let up = 0
    let down = 0
    values.forEach((series, index) => {
      const value = series[row]
      if (value === null || value === undefined) return
      if (!stacked) {
        result[index]![row] = [0, value]
      } else if (value >= 0) {
        result[index]![row] = [up, up + value]
        up += value
      } else {
        result[index]![row] = [down, down + value]
        down += value
      }
    })
  }
  return result
}

function extent(spansBySeries: ([number, number] | null)[][]): [number, number] {
  let low = Infinity
  let high = -Infinity
  for (const series of spansBySeries) {
    for (const span of series) {
      if (!span) continue
      low = Math.min(low, span[0], span[1])
      high = Math.max(high, span[0], span[1])
    }
  }
  return low === Infinity ? [0, 1] : [low, high]
}

/** Which segment of a stack ends it, in each direction, per row. */
function stackEnds(spansBySeries: ([number, number] | null)[][]) {
  const count = spansBySeries[0]?.length ?? 0
  const ends = new Array(count).fill(null).map(() => ({ up: -1, down: -1 }))
  spansBySeries.forEach((series, index) => {
    series.forEach((span, row) => {
      if (!span) return
      if (span[1] >= span[0]) ends[row]!.up = index
      else ends[row]!.down = index
    })
  })
  return ends
}

/** The container's width, followed as it changes. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (element.clientWidth > 0) setWidth(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/**
 * The room left in a box whose height its parent sets — a dashboard tile —
 * given to a plot. The plot is laid over the box, so drawing it at that
 * height cannot grow the box and measure larger again.
 */
function FillHeight({ least, children }: { least: number; children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(least)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const fit = (next: number) => setHeight(Math.max(least, Math.floor(next)))
    if (element.clientHeight > 0) fit(element.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height
      if (next && next > 0) fit(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [least])
  return (
    <div ref={ref} className="relative min-h-0 flex-1" style={{ minHeight: least }}>
      <div className="absolute inset-x-0 top-0">{children(height)}</div>
    </div>
  )
}

/**
 * A bar from `base` to `end` along its length, `thickness` across from
 * `across`; its value end rounded when `round`, square otherwise.
 */
function barPath(
  orientation: "vertical" | "horizontal",
  base: number,
  end: number,
  across: number,
  thickness: number,
  round = true
): string {
  const length = Math.abs(end - base)
  const r = round ? Math.min(4, thickness / 2, length) : 0
  // Which way the bar grows on screen; its corners start `r` short of the end.
  const sign = end >= base ? 1 : -1
  if (orientation === "vertical") {
    const left = across
    const right = across + thickness
    return [
      `M${left},${base}`,
      `L${left},${end - sign * r}`,
      `Q${left},${end} ${left + r},${end}`,
      `L${right - r},${end}`,
      `Q${right},${end} ${right},${end - sign * r}`,
      `L${right},${base}`,
      "Z",
    ].join(" ")
  }
  const top = across
  const bottom = across + thickness
  return [
    `M${base},${top}`,
    `L${end - sign * r},${top}`,
    `Q${end},${top} ${end},${top + r}`,
    `L${end},${bottom - r}`,
    `Q${end},${bottom} ${end - sign * r},${bottom}`,
    `L${base},${bottom}`,
    "Z",
  ].join(" ")
}

/** A segment's two ends in pixels, pulled apart from its neighbours by the
 * surface gap — except where it meets the baseline. */
function segmentEnds(
  span: [number, number],
  scale: (value: number) => number,
  stacked: boolean
): [number, number] {
  let from = scale(span[0])
  let to = scale(span[1])
  if (!stacked) return [from, to]
  const direction = Math.sign(to - from) || 1
  if (span[0] !== 0) from += (direction * GAP) / 2
  to -= (direction * GAP) / 2
  if (Math.sign(to - from) !== direction) to = from
  return [from, to]
}

function Legend({
  names,
  line,
  dot = false,
  lines = [],
}: {
  names: string[]
  line: boolean
  dot?: boolean
  /** Drawn as lines after `names`, in the colours that follow theirs. */
  lines?: string[]
}) {
  if (names.length + lines.length < 2) return null
  const entries = [
    ...names.map((name) => ({ name, isLine: line })),
    ...lines.map((name) => ({ name, isLine: true })),
  ]
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {entries.map(({ name, isLine }, index) => (
        <span key={name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={
              isLine
                ? "h-0.5 w-3 rounded-full"
                : dot
                  ? "size-2.5 rounded-full"
                  : "size-2.5 rounded-[3px]"
            }
            style={{ background: color(index) }}
          />
          {name}
        </span>
      ))}
    </div>
  )
}

/** The readout for one category: values first, every series. */
function Tooltip({
  left,
  top,
  flip,
  label,
  rows,
  notes = [],
  hint,
}: {
  left: number
  top: number
  flip: boolean
  label: string
  /** `detail` follows the value, quieter: a share, for one. */
  rows: { name: string; value: number | null; index: number; color?: string; detail?: string }[]
  /** Lines under the values: what they come to, what they are a share of. */
  notes?: string[]
  hint?: string
}) {
  const selectHint = useContext(SelectHint)
  if (hint === SELECT_HINT) hint = selectHint
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-28 rounded-md border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
      style={{
        left,
        top,
        transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
      }}
    >
      <div className="mb-1 text-muted-foreground">{label}</div>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2 whitespace-nowrap">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: row.color ?? color(row.index) }}
          />
          <span className="font-semibold text-popover-foreground tabular-nums">
            {row.value === null ? "—" : formatNumber(row.value)}
          </span>
          {row.detail && (
            <span className="text-muted-foreground tabular-nums">{row.detail}</span>
          )}
          {rows.length > 1 && (
            <span className="text-muted-foreground">{row.name}</span>
          )}
        </div>
      ))}
      {notes.map((note) => (
        <div key={note} className="whitespace-nowrap text-muted-foreground tabular-nums">
          {note}
        </div>
      ))}
      {hint && <div className="mt-1 text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** Arrow keys walk the categories, as the pointer does; Enter selects. */
function useActive(count: number, onPick?: (index: number) => void) {
  const [active, setActive] = useState<number | null>(null)
  const onKeyDown = (event: KeyboardEvent) => {
    if (count === 0) return
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      setActive((current) => (current === null ? 0 : Math.min(count - 1, current + 1)))
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault()
      setActive((current) => (current === null ? count - 1 : Math.max(0, current - 1)))
    } else if (event.key === "Enter" && active !== null && onPick) {
      event.preventDefault()
      onPick(active)
    } else if (event.key === "Escape") {
      setActive(null)
    }
  }
  return { active, setActive, onKeyDown }
}

type Selection = {
  /** A category clicked: the x value as the data has it — and, drilled down,
   * the column it is a value of. */
  onSelect?: (value: Cell, column?: string) => void
  /** The category the dashboard is filtered to; the others are dimmed. */
  selected?: Cell | undefined
}

const SELECT_HINT = "Click to filter the dashboard"

/** What a click on a category does here: filters, unless it drills in. */
const SelectHint = createContext(SELECT_HINT)

// ── Columns, lines and areas ───────────────────────────────────────────────

/** The values a set of small multiples share an axis over. */
type Domain = { low: number; high: number; lineLow: number; lineHigh: number }

/** What the plotted values reach, stacked as drawn; and a combo's line's. */
function reach(spec: ChartSpec, prepared: Prepared): Domain {
  const k = prepared.names.length
  const stackable = spec.type === "bar" || spec.type === "combo" || spec.type === "area"
  const percent = !!spec.percent && k > 1 && stackable
  const stacked = (!!spec.stacked || percent) && k > 1 && stackable
  const bySeries = spans(percent ? shares(prepared.values) : prepared.values, stacked)
  const [low, high] = extent(bySeries.map((series) =>
    series.map((span) => (span ? ([span[1], span[1]] as [number, number]) : null))
  ))
  const line = (prepared.line ?? []).filter((value): value is number => value !== null)
  return { low, high, lineLow: Math.min(0, ...line), lineHigh: Math.max(0, ...line) }
}

function Cartesian({
  spec,
  prepared,
  height,
  domain,
  quiet = false,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  prepared: Prepared
  height: number
  /** One scale for every chart of a small multiple. */
  domain?: Domain
  /** Without the key to its analytics marks: whoever shows it gives it once. */
  quiet?: boolean
} & Selection) {
  const [ref, width] = useWidth(520)
  const { names, values, raw } = prepared
  const count = prepared.labels.length
  const isCombo = spec.type === "combo"
  const isBar = spec.type === "bar" || isCombo
  const isArea = spec.type === "area"
  const k = names.length
  const percent = !!spec.percent && k > 1 && (isBar || isArea)
  const stacked = (!!spec.stacked || percent) && k > 1 && (isBar || isArea)
  const plotted = useMemo(() => (percent ? shares(values) : values), [values, percent])
  const bySeries = useMemo(() => spans(plotted, stacked), [plotted, stacked])
  const ends = useMemo(() => stackEnds(bySeries), [bySeries])
  const selectedIndex =
    selected === undefined ? -1 : raw.findIndex((value) => value === selected)

  // The analytics pane: per series, so none over a stack.
  const analytics: ChartAnalytics = stacked
    ? { constant: spec.analytics?.constant }
    : (spec.analytics ?? {})
  const ahead = !isBar && analytics.forecast ? analytics.forecast : 0
  const slots = count + ahead
  const labels = useMemo(
    () => (ahead ? [...prepared.labels, ...nextLabels(prepared.labels, ahead)] : prepared.labels),
    [prepared.labels, ahead]
  )
  const fits = useMemo(() => values.map(fitSeries), [values])
  const averages = useMemo(() => values.map(mean), [values])
  const medians = useMemo(() => values.map(median), [values])
  const forecasts = useMemo(
    () => (ahead ? values.map((series) => forecast(series, ahead)) : []),
    [values, ahead]
  )
  const unusual = useMemo(
    () => (analytics.anomalies ? values.map(anomalies) : []),
    [values, analytics.anomalies]
  )
  const pick = onSelect
    ? (index: number) => {
        if (index < count) onSelect(raw[index] ?? null)
      }
    : undefined
  const { active, setActive, onKeyDown } = useActive(slots, pick)

  const drawn = domain ?? reach(spec, prepared)
  // What the analytics reach, so that none is drawn off the plot.
  const extras: number[] = []
  if (analytics.constant != null) extras.push(analytics.constant)
  values.forEach((_, index) => {
    if (analytics.average && averages[index] != null) extras.push(averages[index]!)
    if (analytics.median && medians[index] != null) extras.push(medians[index]!)
    const fit = fits[index]
    if (analytics.trend && fit) extras.push(fit.intercept, fit.intercept + fit.slope * (count - 1))
    for (const step of forecasts[index] ?? []) extras.push(step.low, step.high)
  })
  const low = Math.min(drawn.low, ...extras)
  const high = Math.max(drawn.high, ...extras)
  // Bars and areas grow from zero; a line far from zero may start near its
  // data instead of flattening against the top.
  const nearZero = low <= 0 || (high - low) / Math.abs(high) > 0.3
  const domainLow = isBar || isArea || nearZero ? Math.min(0, low) : low
  const ticks = niceTicks(domainLow, Math.max(high, isBar || isArea ? 0 : high))
  const yMin = ticks[0]!
  const yMax = ticks.at(-1)!
  const format = percent
    ? (value: number) => shareFormat.format(value)
    : tickFormat(Math.max(Math.abs(yMin), Math.abs(yMax)))

  // A combo's line on its own axis, on the right, from zero like the columns
  // — on the columns' gridlines where it can be, so one grid serves both.
  const line = isCombo ? prepared.line : null
  const rightTicks = line
    ? (alignedTicks(drawn.lineLow, drawn.lineHigh, ticks) ?? niceTicks(drawn.lineLow, drawn.lineHigh))
    : []
  const rMin = rightTicks[0] ?? 0
  const rMax = rightTicks.at(-1) ?? 1
  const rightFormat = tickFormat(Math.max(Math.abs(rMin), Math.abs(rMax)))

  const endLabels = !isBar && !stacked && k <= 4 && count > 1 && !ahead
  const margin = {
    top: line ? 18 : 8,
    right: line
      ? Math.max(...rightTicks.map((tick) => rightFormat(tick).length)) * CHAR + 10
      : endLabels
        ? 52
        : 12,
    bottom: 22,
    left: Math.max(...ticks.map((tick) => format(tick).length)) * CHAR + 10,
  }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const plotH = Math.max(40, height - margin.top - margin.bottom)
  const y = (value: number) =>
    margin.top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH
  const yRight = (value: number) =>
    margin.top + plotH - ((value - rMin) / (rMax - rMin || 1)) * plotH
  const baseline = y(Math.max(yMin, Math.min(0, yMax)))

  const band = plotW / Math.max(1, slots)
  const xCenter = (index: number) =>
    isBar
      ? margin.left + band * (index + 0.5)
      : margin.left + (slots === 1 ? plotW / 2 : (index * plotW) / (slots - 1))

  // Labels left to right, each only where it clears the one before it —
  // measured as it is anchored, so the first and last, which hug the plot's
  // edges, are measured as they actually sit.
  const anchorOf = (index: number): "start" | "middle" | "end" =>
    isBar || slots === 1
      ? "middle"
      : index === 0
        ? "start"
        : index === slots - 1
          ? "end"
          : "middle"
  const shownLabels = useMemo(() => {
    const shown = new Set<number>()
    const span = (index: number): [number, number] => {
      const textWidth = labels[index]!.length * CHAR
      const at = xCenter(index)
      const anchor = anchorOf(index)
      return anchor === "start"
        ? [at, at + textWidth]
        : anchor === "end"
          ? [at - textWidth, at]
          : [at - textWidth / 2, at + textWidth / 2]
    }
    // The last label is placed first, so the axis always says where it ends.
    const lastSpan = slots > 1 ? span(slots - 1) : null
    let edge = -Infinity
    for (let index = 0; index < slots; index++) {
      const [from, to] = span(index)
      const clearsLast = index === slots - 1 || !lastSpan || to + 8 <= lastSpan[0]
      if (from >= edge + 8 && clearsLast) {
        shown.add(index)
        edge = to
      }
    }
    return shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, width, slots, isBar, margin.left, plotW])

  const thickness = stacked
    ? Math.max(1, Math.min(BAR, band * 0.8))
    : Math.max(1, Math.min(BAR, (band * 0.8 - (k - 1) * GAP) / k))
  const groupWidth = stacked ? thickness : thickness * k + GAP * (k - 1)

  // The one label a lone series of columns gets: on its tallest.
  const peak =
    isBar && k === 1 && count <= 16
      ? values[0]!.reduce<number | null>(
          (best, value, index) =>
            value !== null && (best === null || value > (values[0]![best] ?? -Infinity))
              ? index
              : best,
          null
        )
      : null

  const placeEndLabels = () => {
    if (!endLabels) return []
    const last = count - 1
    const placed: { index: number; y: number; value: number }[] = []
    const candidates = values
      .map((series, index) => ({ index, value: series[last] }))
      .filter((item): item is { index: number; value: number } => item.value !== null && item.value !== undefined)
      .map((item) => ({ ...item, y: y(item.value) }))
      .sort((a, b) => a.y - b.y)
    for (const candidate of candidates) {
      // Labels that would collide are left to the legend and the tooltip,
      // not nudged off their lines.
      if (placed.some((item) => Math.abs(item.y - candidate.y) < FONT + 1)) continue
      placed.push(candidate)
    }
    return placed
  }

  const indexAt = (clientX: number, element: Element) => {
    const box = element.getBoundingClientRect()
    const position = clientX - box.left - margin.left
    const index = isBar
      ? Math.floor(position / band)
      : slots === 1
        ? 0
        : Math.round((position / plotW) * (slots - 1))
    return Math.max(0, Math.min(slots - 1, index))
  }

  const dim = (index: number) =>
    selectedIndex >= 0
      ? index === selectedIndex
        ? 1
        : 0.3
      : active === null || active === index
        ? 1
        : 0.55

  const tooltipX = active === null ? 0 : xCenter(active)

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`${spec.type} chart of ${names.join(", ")}${spec.x ? ` by ${spec.x}` : ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerMove={(event) => setActive(indexAt(event.clientX, event.currentTarget))}
        onPointerLeave={() => setActive(null)}
        onClick={
          pick ? (event) => pick(indexAt(event.clientX, event.currentTarget)) : undefined
        }
        className={cn(
          "block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={margin.left - 6}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              fontSize={FONT}
              className="fill-muted-foreground tabular-nums"
            >
              {format(tick)}
            </text>
          </g>
        ))}

        {line && (
          <g>
            {rightTicks.map((tick) => (
              <text
                key={tick}
                x={margin.left + plotW + 6}
                y={yRight(tick)}
                dy="0.32em"
                fontSize={FONT}
                className="fill-muted-foreground tabular-nums"
              >
                {rightFormat(tick)}
              </text>
            ))}
            {/* Two axes: each says what it measures, so neither is read for the other. */}
            {k === 1 && (
              <text x={margin.left} y={margin.top - 8} fontSize={FONT} className="fill-muted-foreground">
                {names[0]}
              </text>
            )}
            <text
              x={width}
              y={margin.top - 8}
              textAnchor="end"
              fontSize={FONT}
              className="fill-muted-foreground"
            >
              {spec.line}
            </text>
          </g>
        )}

        {labels.map((label, index) =>
          shownLabels.has(index) ? (
            <text
              key={index}
              x={xCenter(index)}
              y={margin.top + plotH + 15}
              textAnchor={anchorOf(index)}
              fontSize={FONT}
              className={cn(
                index === selectedIndex ? "fill-foreground font-semibold" : "fill-muted-foreground"
              )}
            >
              {label}
            </text>
          ) : null
        )}

        {(active !== null || selectedIndex >= 0) && !isBar && (
          <line
            x1={xCenter(active ?? selectedIndex)}
            x2={xCenter(active ?? selectedIndex)}
            y1={margin.top}
            y2={margin.top + plotH}
            stroke="var(--chart-axis)"
            strokeWidth={1}
          />
        )}

        {isBar
          ? bySeries.map((series, seriesIndex) =>
              series.map((span, index) => {
                if (!span) return null
                const [from, to] = segmentEnds(span, y, stacked)
                const outermost =
                  !stacked ||
                  (span[1] >= span[0] ? ends[index]!.up : ends[index]!.down) === seriesIndex
                const left = stacked
                  ? xCenter(index) - thickness / 2
                  : xCenter(index) - groupWidth / 2 + seriesIndex * (thickness + GAP)
                return (
                  <path
                    key={`${seriesIndex}-${index}`}
                    d={barPath("vertical", from, to, left, thickness, outermost)}
                    fill={color(seriesIndex)}
                    opacity={dim(index)}
                  />
                )
              })
            )
          : bySeries.map((series, seriesIndex) => {
              const points = series.map((span, index) =>
                span ? ([xCenter(index), y(span[1])] as const) : null
              )
              const lower = series.map((span, index) =>
                span ? ([xCenter(index), stacked ? y(span[0]) : baseline] as const) : null
              )
              // A gap in the data is a gap in the line.
              const segments: number[][] = [[]]
              points.forEach((point, index) => {
                if (point) segments.at(-1)!.push(index)
                else if (segments.at(-1)!.length) segments.push([])
              })
              const showDots = count <= 24
              return (
                <g key={seriesIndex}>
                  {segments.map((segment, part) =>
                    segment.length === 0 ? null : (
                      <g key={part}>
                        {isArea && segment.length > 1 && (
                          <path
                            d={[
                              ...segment.map((index, i) => `${i ? "L" : "M"}${points[index]![0]},${points[index]![1]}`),
                              ...[...segment].reverse().map((index) => `L${lower[index]![0]},${lower[index]![1]}`),
                              "Z",
                            ].join(" ")}
                            fill={color(seriesIndex)}
                            fillOpacity={stacked ? 0.22 : 0.1}
                          />
                        )}
                        <path
                          d={segment
                            .map((index, i) => `${i ? "L" : "M"}${points[index]![0]},${points[index]![1]}`)
                            .join(" ")}
                          fill="none"
                          stroke={color(seriesIndex)}
                          strokeWidth={2}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </g>
                    )
                  )}
                  {points.map((point, index) =>
                    point &&
                    (showDots || index === count - 1 || index === active || index === selectedIndex) ? (
                      <circle
                        key={index}
                        cx={point[0]}
                        cy={point[1]}
                        r={index === active || index === selectedIndex ? 5 : 4}
                        fill={color(seriesIndex)}
                        stroke="var(--card)"
                        strokeWidth={2}
                      />
                    ) : null
                  )}
                </g>
              )
            })}

        {line && (
          <g>
            <path
              d={line
                .map((value, index) => (value === null ? null : ([xCenter(index), yRight(value)] as const)))
                .reduce<string[]>((path, point, index, points) => {
                  // A gap in the data is a gap in the line.
                  if (point) path.push(`${points[index - 1] ? "L" : "M"}${point[0]},${point[1]}`)
                  return path
                }, [])
                .join(" ")}
              fill="none"
              stroke={color(k)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {line.map((value, index) =>
              value === null || (count > 24 && index !== active && index !== count - 1) ? null : (
                <circle
                  key={index}
                  cx={xCenter(index)}
                  cy={yRight(value)}
                  r={index === active || index === selectedIndex ? 5 : 4}
                  fill={color(k)}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              )
            )}
          </g>
        )}

        {names.map((_, seriesIndex) => {
          const stroke = color(seriesIndex)
          const fit = fits[seriesIndex]
          const steps = forecasts[seriesIndex]
          const series = values[seriesIndex]!
          let lastIndex = series.length - 1
          while (lastIndex >= 0 && series[lastIndex] === null) lastIndex--
          const across = (at: number, dash: string, key: string) => (
            <line
              key={key}
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(at)}
              y2={y(at)}
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray={dash}
              opacity={0.85}
            />
          )
          return (
            <g key={`analytics-${seriesIndex}`} className="pointer-events-none">
              {analytics.average && averages[seriesIndex] != null && across(averages[seriesIndex]!, "6 4", "average")}
              {analytics.median && medians[seriesIndex] != null && across(medians[seriesIndex]!, "2 3", "median")}
              {analytics.trend && fit && count > 1 && (
                <line
                  x1={xCenter(0)}
                  x2={xCenter(count - 1)}
                  y1={y(fit.intercept)}
                  y2={y(fit.intercept + fit.slope * (count - 1))}
                  stroke={stroke}
                  strokeWidth={1.5}
                  strokeDasharray="10 4"
                  opacity={0.85}
                />
              )}
              {steps && lastIndex >= 0 && (
                <g>
                  <path
                    d={[
                      `M${xCenter(lastIndex)},${y(series[lastIndex]!)}`,
                      ...steps.map((step, index) => `L${xCenter(count + index)},${y(step.high)}`),
                      ...[...steps].reverse().map((step, index) => `L${xCenter(count + steps.length - 1 - index)},${y(step.low)}`),
                      "Z",
                    ].join(" ")}
                    fill={stroke}
                    fillOpacity={0.12}
                  />
                  <path
                    d={[
                      `M${xCenter(lastIndex)},${y(series[lastIndex]!)}`,
                      ...steps.map((step, index) => `L${xCenter(count + index)},${y(step.value)}`),
                    ].join(" ")}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    strokeLinejoin="round"
                  />
                </g>
              )}
              {(unusual[seriesIndex] ?? []).map((odd, index) => {
                const span = bySeries[seriesIndex]![index]
                if (!odd || !span) return null
                const at = isBar
                  ? xCenter(index) - groupWidth / 2 + seriesIndex * (thickness + GAP) + thickness / 2
                  : xCenter(index)
                return (
                  <circle
                    key={index}
                    cx={at}
                    cy={y(span[1])}
                    r={8}
                    fill="none"
                    stroke="var(--foreground)"
                    strokeWidth={1.5}
                  />
                )
              })}
            </g>
          )
        })}

        {analytics.constant != null && (
          <g className="pointer-events-none">
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(analytics.constant)}
              y2={y(analytics.constant)}
              stroke="var(--foreground)"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.6}
            />
            <text
              x={margin.left + plotW - 2}
              y={y(analytics.constant) - 4}
              textAnchor="end"
              fontSize={FONT}
              className="fill-foreground tabular-nums"
            >
              {spec.analytics?.constantLabel || format(analytics.constant)}
            </text>
          </g>
        )}

        {ahead > 0 && (
          <line
            x1={xCenter(count - 1)}
            x2={xCenter(count - 1)}
            y1={margin.top}
            y2={margin.top + plotH}
            stroke="var(--chart-axis)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}

        {peak !== null && !line && values[0]![peak] !== null && (
          <text
            x={xCenter(peak)}
            y={y(values[0]![peak]!) - 6}
            textAnchor="middle"
            fontSize={FONT}
            className="fill-foreground font-medium tabular-nums"
          >
            {formatNumber(values[0]![peak]!)}
          </text>
        )}

        {placeEndLabels().map((label) => (
          <text
            key={label.index}
            x={xCenter(count - 1) + 8}
            y={label.y}
            dy="0.32em"
            fontSize={FONT}
            className="fill-foreground font-medium tabular-nums"
          >
            {compactFormat.format(label.value)}
          </text>
        ))}
      </svg>

      {active !== null && active >= count && (
        <Tooltip
          left={tooltipX}
          top={margin.top}
          flip={tooltipX > width * 0.6}
          label={`${labels[active] ?? ""} · forecast`}
          rows={names.map((name, index) => {
            const step = forecasts[index]?.[active - count]
            return {
              name,
              index,
              value: step?.value ?? null,
              detail: step ? `${compactFormat.format(step.low)}–${compactFormat.format(step.high)}` : undefined,
            }
          })}
          notes={["Likely range: 95%, if the trend holds."]}
        />
      )}
      {active !== null && active < count && (
        <Tooltip
          left={tooltipX}
          top={margin.top}
          flip={tooltipX > width * 0.6}
          label={labels[active] ?? ""}
          rows={[
            ...names.map((name, index) => {
              const share = plotted[index]![active] ?? null
              return {
                name,
                index,
                value: values[index]![active] ?? null,
                detail: percent && share !== null ? shareFormat.format(share) : undefined,
              }
            }),
            ...(line ? [{ name: spec.line ?? "", index: k, value: line[active] ?? null }] : []),
          ]}
          notes={
            unusual.some((series) => series[active])
              ? [`Unusual: far from the trend of ${names.filter((_, index) => unusual[index]?.[active]).join(", ")}`]
              : []
          }
          hint={pick ? SELECT_HINT : undefined}
        />
      )}
      {!quiet && <AnalyticsKey analytics={analytics} forecastShown={ahead > 0} />}
    </div>
  )
}

// ── Small multiples ────────────────────────────────────────────────────────

/** Past this many charts the rest are left to the table. */
const PANELS = 12

/**
 * One small chart per value of the facet column, in the order the rows give
 * them, every one on the same scale so that their heights compare.
 */
function Facets({
  spec,
  data,
  height,
  fit,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  data: Data
  height: number
  /** Share `height` between the rows of charts, rather than each taking it. */
  fit: boolean
} & Selection) {
  const [ref, width] = useWidth(520)
  const inner = useMemo(() => ({ ...spec, facet: null }), [spec])
  const { panels, total } = useMemo(() => {
    const index = data.columns.findIndex((column) => column.name === spec.facet)
    const groups = new Map<string, { value: Cell; rows: Cell[][] }>()
    for (const row of data.rows) {
      const value = row[index] ?? null
      const key = value ?? "\u0000null"
      let group = groups.get(key)
      if (!group) {
        group = { value, rows: [] }
        groups.set(key, group)
      }
      group.rows.push(row)
    }
    return {
      total: groups.size,
      panels: [...groups.values()].slice(0, PANELS).map((group) => ({
        value: group.value,
        prepared: prepare(inner, { columns: data.columns, rows: group.rows }),
      })),
    }
  }, [data, spec.facet, inner])
  const domain = useMemo(
    () =>
      panels.reduce<Domain>(
        (shared, panel) => {
          const own = reach(inner, panel.prepared)
          return {
            low: Math.min(shared.low, own.low),
            high: Math.max(shared.high, own.high),
            lineLow: Math.min(shared.lineLow, own.lineLow),
            lineHigh: Math.max(shared.lineHigh, own.lineHigh),
          }
        },
        { low: Infinity, high: -Infinity, lineLow: 0, lineHigh: 0 }
      ),
    [panels, inner]
  )
  const columns = Math.min(panels.length, width >= 900 ? 3 : width >= 480 ? 2 : 1)
  const rows = Math.ceil(panels.length / Math.max(1, columns))
  const title = 20
  const between = 12
  const panelHeight = fit
    ? Math.max(100, Math.floor((height - rows * title - (rows - 1) * between) / rows))
    : Math.max(140, Math.round(height * 0.7))
  const stacked = !!(spec.stacked || spec.percent)
  return (
    <div ref={ref} className="w-full">
      <div
        className="grid gap-x-4"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`, rowGap: between }}
      >
        {panels.map((panel, index) => (
          <div key={index} className="min-w-0">
            <div className="truncate text-[11px] font-medium text-foreground" style={{ height: title }}>
              {categoryLabel(panel.value)}
            </div>
            <Cartesian
              spec={inner}
              prepared={panel.prepared}
              height={panelHeight}
              domain={domain}
              quiet
              onSelect={onSelect}
              selected={selected}
            />
          </div>
        ))}
      </div>
      <AnalyticsKey
        analytics={stacked ? {} : (spec.analytics ?? {})}
        forecastShown={!stacked && !!spec.analytics?.forecast && (spec.type === "line" || spec.type === "area")}
      />
      {total > panels.length && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          The first {panels.length} of {total} {spec.facet} values; the table has them all.
        </p>
      )}
    </div>
  )
}

/** What each analytics mark is: they are told apart by dash, not colour. */
function AnalyticsKey({
  analytics,
  forecastShown,
}: {
  analytics: ChartAnalytics
  forecastShown: boolean
}) {
  const items = [
    analytics.average && { dash: "6 4", name: "Average" },
    analytics.median && { dash: "2 3", name: "Median" },
    analytics.trend && { dash: "10 4", name: "Trend" },
    forecastShown && { dash: "5 4", name: "Forecast, shaded: likely range" },
    analytics.anomalies && { dash: null, name: "Ringed: unusual" },
  ].filter((item): item is { dash: string | null; name: string } => !!item)
  if (!items.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <span key={item.name} className="flex items-center gap-1.5">
          <svg width={18} height={10} aria-hidden>
            {item.dash === null ? (
              <circle cx={9} cy={5} r={4} fill="none" stroke="currentColor" strokeWidth={1.5} />
            ) : (
              <line x1={0} x2={18} y1={5} y2={5} stroke="currentColor" strokeWidth={1.5} strokeDasharray={item.dash} />
            )}
          </svg>
          {item.name}
        </span>
      ))}
    </div>
  )
}

// ── Ranked horizontal bars ─────────────────────────────────────────────────

function Horizontal({
  spec,
  prepared,
  limit,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  prepared: Prepared
  limit: number
} & Selection) {
  const [ref, width] = useWidth(520)
  const shown = Math.min(prepared.labels.length, limit)
  const labels = prepared.labels.slice(0, shown)
  const raw = prepared.raw.slice(0, shown)
  const values = prepared.values.map((series) => series.slice(0, shown))
  const names = prepared.names
  const pick = onSelect ? (index: number) => onSelect(raw[index] ?? null) : undefined
  const { active, setActive, onKeyDown } = useActive(shown, pick)
  const k = names.length
  const percent = !!spec.percent && k > 1
  const stacked = (!!spec.stacked || percent) && k > 1
  const plotted = percent ? shares(values) : values
  const bySeries = spans(plotted, stacked)
  const ends = stackEnds(bySeries)
  const selectedIndex =
    selected === undefined ? -1 : raw.findIndex((value) => value === selected)

  const thickness = stacked || k === 1 ? 16 : Math.max(4, Math.min(12, (22 - (k - 1) * GAP) / k))
  const row = stacked ? 28 : Math.max(28, k * (thickness + GAP) + 10)
  const [low, high] = extent(bySeries)
  const ticks = niceTicks(Math.min(0, low), Math.max(0, high), 4)
  const xMin = ticks[0]!
  const xMax = ticks.at(-1)!
  const format = percent
    ? (value: number) => shareFormat.format(value)
    : tickFormat(Math.max(Math.abs(xMin), Math.abs(xMax)))
  const tipLabels = k === 1

  const labelChars = Math.min(
    Math.max(...labels.map((label) => label.length), 1),
    Math.floor((width * 0.35) / CHAR)
  )
  const margin = {
    top: 4,
    right: tipLabels ? 64 : 16,
    bottom: 20,
    left: labelChars * CHAR + 12,
  }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const height = margin.top + row * shown + margin.bottom
  const x = (value: number) =>
    margin.left + ((value - xMin) / (xMax - xMin || 1)) * plotW
  const clip = (label: string) =>
    label.length > labelChars ? `${label.slice(0, Math.max(1, labelChars - 1))}…` : label

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`Bar chart of ${names.join(", ")}${spec.x ? ` by ${spec.x}` : ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className={cn(
          "block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={x(tick)}
              x2={x(tick)}
              y1={margin.top}
              y2={margin.top + row * shown}
              stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={x(tick)}
              y={margin.top + row * shown + 14}
              textAnchor="middle"
              fontSize={FONT}
              className="fill-muted-foreground tabular-nums"
            >
              {format(tick)}
            </text>
          </g>
        ))}

        {labels.map((label, index) => {
          const top = margin.top + row * index
          const groupHeight = stacked ? thickness : k * thickness + (k - 1) * GAP
          const groupTop = top + (row - groupHeight) / 2
          const opacity =
            selectedIndex >= 0
              ? index === selectedIndex
                ? 1
                : 0.3
              : active === null || active === index
                ? 1
                : 0.55
          return (
            <g
              key={index}
              onPointerEnter={() => setActive(index)}
              onClick={pick ? () => pick(index) : undefined}
              opacity={opacity}
            >
              {/* The whole row is the target, not only the painted bar. */}
              <rect x={0} y={top} width={width} height={row} fill="transparent" />
              <text
                x={margin.left - 8}
                y={top + row / 2}
                dy="0.32em"
                textAnchor="end"
                fontSize={FONT}
                className={index === selectedIndex ? "fill-foreground font-semibold" : "fill-foreground"}
              >
                {clip(label)}
              </text>
              {bySeries.map((series, seriesIndex) => {
                const span = series[index]
                if (!span) return null
                const [from, to] = segmentEnds(span, x, stacked)
                const across = stacked ? groupTop : groupTop + seriesIndex * (thickness + GAP)
                const outermost =
                  !stacked ||
                  (span[1] >= span[0] ? ends[index]!.up : ends[index]!.down) === seriesIndex
                const value = values[seriesIndex]![index]!
                return (
                  <g key={seriesIndex}>
                    <path
                      d={barPath("horizontal", from, to, across, thickness, outermost)}
                      fill={color(seriesIndex)}
                    />
                    {tipLabels && (
                      <text
                        x={x(value) + (value >= 0 ? 6 : -6)}
                        y={across + thickness / 2}
                        dy="0.32em"
                        textAnchor={value >= 0 ? "start" : "end"}
                        fontSize={FONT}
                        className="fill-foreground tabular-nums"
                      >
                        {formatNumber(value)}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      {active !== null && (
        <Tooltip
          left={Math.min(width - 20, margin.left + plotW / 2)}
          top={margin.top + row * active + row}
          flip={false}
          label={labels[active] ?? ""}
          rows={names.map((name, index) => {
            const share = plotted[index]![active] ?? null
            return {
              name,
              index,
              value: values[index]![active] ?? null,
              detail: percent && share !== null ? shareFormat.format(share) : undefined,
            }
          })}
          hint={pick ? SELECT_HINT : undefined}
        />
      )}
      {prepared.labels.length > shown && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          The top {shown} of {prepared.labels.length}; the table has them all.
        </p>
      )}
    </div>
  )
}

// ── Figures ────────────────────────────────────────────────────────────────

function Stats({
  prepared,
  large,
  titled,
}: {
  prepared: Prepared
  large: boolean
  titled: boolean
}) {
  // A lone figure under a title is named by it; several still need theirs.
  const labelled = !titled || prepared.names.length > 1
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {prepared.names.slice(0, 4).map((name, index) => {
        const value = prepared.values[index]![0] ?? null
        return (
          <div key={name} className="min-w-0">
            {labelled && <div className="text-xs text-muted-foreground">{name}</div>}
            <div
              className={cn(
                "font-semibold tracking-tight text-foreground",
                large ? "text-5xl" : "text-3xl"
              )}
              title={value === null ? undefined : formatNumber(value)}
            >
              {value === null ? "—" : figure(value)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Twelve-ish points of trend, quiet, with the current one in the accent. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const [ref, width] = useWidth(160)
  const height = 32
  const points = values
    .map((value, index) => (value === null ? null : { index, value }))
    .filter((point): point is { index: number; value: number } => point !== null)
  if (points.length < 2) return <div ref={ref} />
  const low = Math.min(...points.map((point) => point.value))
  const high = Math.max(...points.map((point) => point.value))
  const x = (index: number) => 4 + (index / (values.length - 1)) * (width - 8)
  const y = (value: number) => 4 + (1 - (value - low) / (high - low || 1)) * (height - 8)
  const last = points.at(-1)!
  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} aria-hidden className="block overflow-visible">
        <path
          d={points.map((point, i) => `${i ? "L" : "M"}${x(point.index)},${y(point.value)}`).join(" ")}
          fill="none"
          stroke="var(--chart-axis)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(last.index)}
          cy={y(last.value)}
          r={4}
          fill={color(0)}
          stroke="var(--card)"
          strokeWidth={2}
        />
      </svg>
    </div>
  )
}

/**
 * The stat tile contract: label, value, the signed change against a named
 * period — coloured by whether that direction is good, and always with an
 * arrow and words — and the trend it came from.
 */
function Kpi({
  spec,
  data,
  prepared,
  titled,
}: {
  spec: ChartSpec
  data: Data
  prepared: Prepared
  titled: boolean
}) {
  const series = prepared.values[0] ?? []
  let current: number | null
  let previous: number | null = null
  let against = "the previous period"
  if (spec.x) {
    current = series.at(-1) ?? null
    previous = series.length > 1 ? (series.at(-2) ?? null) : null
    if (series.length > 1) against = prepared.labels.at(-2) ?? against
  } else {
    current = series[0] ?? null
    if (spec.compare) {
      const index = data.columns.findIndex((column) => column.name === spec.compare)
      previous = toNumber(data.rows[0]?.[index])
    }
  }
  const change =
    current !== null && previous !== null && previous !== 0
      ? (current - previous) / Math.abs(previous)
      : null
  const direction = change === null || change === 0 ? 0 : change > 0 ? 1 : -1
  const good = direction === 0 ? null : (direction > 0) === (spec.upIsGood ?? true)
  const Arrow = direction > 0 ? ArrowUpRight : direction < 0 ? ArrowDownRight : Minus

  return (
    <div className="flex h-full flex-col gap-1">
      {!titled && <div className="text-xs text-muted-foreground">{spec.y[0]}</div>}
      <div
        className="text-3xl font-semibold tracking-tight text-foreground"
        title={current === null ? undefined : formatNumber(current)}
      >
        {current === null ? "—" : figure(current)}
      </div>
      {change !== null && (
        <div
          className="flex items-center gap-1 text-xs font-medium"
          style={{
            color:
              good === null ? "var(--muted-foreground)" : good ? "var(--delta-good)" : "var(--delta-bad)",
          }}
        >
          <Arrow className="size-3.5" aria-hidden />
          <span>
            {percentFormat.format(change)}{" "}
            <span className="font-normal text-muted-foreground">vs {against}</span>
          </span>
        </div>
      )}
      {spec.x && series.length > 2 && (
        <div className="mt-auto pt-1">
          <Sparkline values={series.slice(-24)} />
        </div>
      )}
    </div>
  )
}

/** A shade of the sequential hue for a value's place between low and high. */
function shade(value: number | null, low: number, high: number) {
  if (value === null || high === low) return undefined
  const share = (value - low) / (high - low)
  const percent = Math.round(8 + share * 62)
  return {
    background: `color-mix(in oklab, var(--series-1) ${percent}%, transparent)`,
    color: percent > 50 ? "#ffffff" : undefined,
  }
}

/**
 * A cell's marks under its column's rules: a bar of its size behind it, an
 * arrow by its sign, its figure in a status colour past a threshold — with
 * the arrow or the weight beside the colour, never the colour alone.
 */
function RuledValue({
  rules,
  value,
  range,
  children,
}: {
  rules: CellRule[]
  value: number | null
  range: [number, number] | undefined
  children: ReactNode
}) {
  if (!rules.length || value === null) return <>{children}</>
  const bars = rules.some((rule) => rule.kind === "bars")
  const icons = rules.find((rule) => rule.kind === "icons")
  const hit = rules.find(
    (rule) =>
      (rule.kind === "above" && value > rule.value) || (rule.kind === "below" && value < rule.value)
  )
  const reach = range ? Math.max(Math.abs(range[0]), Math.abs(range[1])) : 0
  const tone =
    hit && hit.kind !== "bars" && hit.kind !== "icons"
      ? hit.tone === "good"
        ? "var(--delta-good)"
        : "var(--delta-bad)"
      : undefined
  const sign = value > 0 ? 1 : value < 0 ? -1 : 0
  const Arrow = sign > 0 ? ArrowUpRight : sign < 0 ? ArrowDownRight : Minus
  const arrowTone =
    icons && icons.kind === "icons" && sign !== 0
      ? (sign > 0) === (icons.upIsGood ?? true)
        ? "var(--delta-good)"
        : "var(--delta-bad)"
      : "var(--muted-foreground)"
  return (
    <span className="relative flex items-center justify-end gap-1">
      {bars && reach > 0 && (
        <span
          aria-hidden
          className="absolute inset-y-[-3px] left-0 rounded-[3px]"
          style={{
            width: `${(Math.abs(value) / reach) * 100}%`,
            background: `color-mix(in oklab, ${value < 0 ? "var(--delta-bad)" : "var(--series-1)"} 22%, transparent)`,
          }}
        />
      )}
      {icons && <Arrow aria-hidden className="relative size-3.5 shrink-0" style={{ color: arrowTone }} />}
      <span
        className={cn("relative", hit && "font-semibold")}
        style={{ color: tone }}
        title={hit && hit.kind !== "bars" && hit.kind !== "icons" ? `${hit.kind} ${formatNumber(hit.value)}` : undefined}
      >
        {children}
      </span>
    </span>
  )
}

/** One value by two dimensions: x down the side, series across the top. */
function Pivot({
  spec,
  data,
  onSelect,
  selected,
}: { spec: ChartSpec; data: Data } & Selection) {
  const wide = useMemo(
    () => widen(data, spec.x!, spec.series!, spec.y[0]!),
    [data, spec.x, spec.series, spec.y]
  )
  const all = wide.values.flat().filter((value): value is number => value !== null)
  const low = Math.min(...all, 0)
  const high = Math.max(...all, 0)
  const rules = (spec.rules ?? []).filter((rule) => rule.column === spec.y[0])
  // A bar in the cell says its size already; shading it too says it twice.
  const shaded = !rules.some((rule) => rule.kind === "bars")
  const rowTotal = (index: number) =>
    wide.values.reduce((sum, series) => sum + (series[index] ?? 0), 0)
  return (
    <div className="selectable overflow-auto rounded-md border">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th className="border-b px-2 py-1 text-left font-medium">{spec.x}</th>
            {wide.names.map((name) => (
              <th key={name} className="border-b px-2 py-1 text-right font-medium whitespace-nowrap">
                {name}
              </th>
            ))}
            <th className="border-b border-l px-2 py-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {wide.labels.map((label, index) => (
            <tr
              key={index}
              onClick={onSelect ? () => onSelect(label) : undefined}
              className={cn(
                onSelect && "cursor-pointer hover:bg-accent/40",
                selected !== undefined && selected !== label && "opacity-40"
              )}
            >
              <td className="border-b px-2 py-1 whitespace-nowrap">{categoryLabel(label)}</td>
              {wide.values.map((series, seriesIndex) => {
                const value = series[index] ?? null
                return (
                  <td
                    key={seriesIndex}
                    className="border-b px-2 py-1 text-right tabular-nums"
                    style={shaded ? shade(value, low, high) : undefined}
                  >
                    <RuledValue rules={rules} value={value} range={[low, high]}>
                      {value === null ? "" : formatNumber(value)}
                    </RuledValue>
                  </td>
                )
              })}
              <td className="border-b border-l px-2 py-1 text-right font-medium tabular-nums">
                {formatNumber(rowTotal(index))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Labels for a row's categories: as many characters as a third of the width
 * allows, the rest cut with an ellipsis. */
function rowLabels(labels: string[], width: number) {
  const chars = Math.min(
    Math.max(...labels.map((label) => label.length), 1),
    Math.floor((width * 0.35) / CHAR)
  )
  const clip = (label: string) =>
    label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label
  return { chars, clip }
}

const dimmed = (index: number, active: number | null, selectedIndex: number) =>
  selectedIndex >= 0
    ? index === selectedIndex
      ? 1
      : 0.3
    : active === null || active === index
      ? 1
      : 0.55

// ── Funnel ─────────────────────────────────────────────────────────────────

/**
 * Steps in the order the rows give them, each a bar of how many are left,
 * over a faint one of how many reached the step before: the drop is the
 * difference. Each says its count and its share of the first step.
 */
function Funnel({
  spec,
  prepared,
  limit,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  prepared: Prepared
  limit: number
} & Selection) {
  const [ref, width] = useWidth(520)
  const shown = Math.min(prepared.labels.length, limit)
  const labels = prepared.labels.slice(0, shown)
  const raw = prepared.raw.slice(0, shown)
  const values = (prepared.values[0] ?? []).slice(0, shown)
  const pick = onSelect ? (index: number) => onSelect(raw[index] ?? null) : undefined
  const { active, setActive, onKeyDown } = useActive(shown, pick)
  const selectedIndex =
    selected === undefined ? -1 : raw.findIndex((value) => value === selected)

  const first = values[0] ?? null
  const high = Math.max(0, ...values.map((value) => value ?? 0))
  const share = (value: number | null, of: number | null) =>
    value === null || of === null || of === 0 ? null : value / of

  const row = 30
  const thickness = 16
  const { chars, clip } = rowLabels(labels, width)
  const margin = { top: 4, right: 112, bottom: 4, left: chars * CHAR + 12 }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const height = margin.top + row * shown + margin.bottom
  const x = (value: number) => margin.left + (high ? Math.max(0, value) / high : 0) * plotW

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`Funnel of ${spec.y[0] ?? ""} by ${spec.x ?? ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className={cn(
          "block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {labels.map((label, index) => {
          const top = margin.top + row * index
          const across = top + (row - thickness) / 2
          const value = values[index] ?? null
          const before = index > 0 ? (values[index - 1] ?? null) : null
          const ofFirst = index > 0 ? share(value, first) : null
          return (
            <g
              key={index}
              onPointerEnter={() => setActive(index)}
              onClick={pick ? () => pick(index) : undefined}
              opacity={dimmed(index, active, selectedIndex)}
            >
              <rect x={0} y={top} width={width} height={row} fill="transparent" />
              <text
                x={margin.left - 8}
                y={top + row / 2}
                dy="0.32em"
                textAnchor="end"
                fontSize={FONT}
                className={index === selectedIndex ? "fill-foreground font-semibold" : "fill-foreground"}
              >
                {clip(label)}
              </text>
              {before !== null && before > 0 && (
                <path
                  d={barPath("horizontal", margin.left, x(before), across, thickness)}
                  fill={color(0)}
                  fillOpacity={0.14}
                />
              )}
              {value !== null && value > 0 && (
                <path
                  d={barPath("horizontal", margin.left, x(value), across, thickness)}
                  fill={color(0)}
                />
              )}
              <text
                x={width - 4}
                y={top + row / 2}
                dy="0.32em"
                textAnchor="end"
                fontSize={FONT}
                className="tabular-nums"
              >
                <tspan className="fill-foreground font-medium">
                  {value === null ? "—" : figure(value)}
                </tspan>
                {ofFirst !== null && (
                  <tspan className="fill-muted-foreground"> · {shareFormat.format(ofFirst)}</tspan>
                )}
              </text>
            </g>
          )
        })}
      </svg>

      {active !== null && (
        <Tooltip
          left={Math.min(width - 20, margin.left + plotW / 2)}
          top={margin.top + row * active + row}
          flip={false}
          label={labels[active] ?? ""}
          rows={[{ name: spec.y[0] ?? "", value: values[active] ?? null, index: 0 }]}
          notes={
            active === 0
              ? []
              : [
                  share(values[active] ?? null, values[active - 1] ?? null),
                  share(values[active] ?? null, first),
                ].flatMap((part, which) =>
                  part === null
                    ? []
                    : [
                        `${shareFormat.format(part)} of ${which === 0 ? labels[active - 1] : labels[0]}`,
                      ]
                )
          }
          hint={pick ? SELECT_HINT : undefined}
        />
      )}
      {prepared.labels.length > shown && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          The first {shown} of {prepared.labels.length} steps; the table has them all.
        </p>
      )}
    </div>
  )
}

// ── Waterfall ──────────────────────────────────────────────────────────────

/**
 * Where a figure starts, each change that moves it — a rise and a fall in
 * the status colours, by whether that direction is good — and where it ends.
 */
function Waterfall({
  spec,
  prepared,
  height,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  prepared: Prepared
  height: number
} & Selection) {
  const [ref, width] = useWidth(520)
  const values = prepared.values[0] ?? []
  const steps = useMemo(() => bridge(values), [values])
  const labels = [...prepared.labels, "Total"]
  const count = steps.length
  const last = count - 1
  // The total is not a category of the data, so there is nothing to select.
  const pick = onSelect
    ? (index: number) => {
        if (index < last) onSelect(prepared.raw[index] ?? null)
      }
    : undefined
  const { active, setActive, onKeyDown } = useActive(count, pick)
  const selectedIndex =
    selected === undefined ? -1 : prepared.raw.findIndex((value) => value === selected)

  const ends = steps.flatMap((step) => [step.from, step.to])
  const ticks = niceTicks(Math.min(0, ...ends), Math.max(0, ...ends))
  const yMin = ticks[0]!
  const yMax = ticks.at(-1)!
  const format = tickFormat(Math.max(Math.abs(yMin), Math.abs(yMax)))
  const margin = {
    top: 16,
    right: 12,
    bottom: 22,
    left: Math.max(...ticks.map((tick) => format(tick).length)) * CHAR + 10,
  }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const plotH = Math.max(40, height - margin.top - margin.bottom)
  const y = (value: number) =>
    margin.top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH
  const band = plotW / Math.max(1, count)
  const xCenter = (index: number) => margin.left + band * (index + 0.5)
  const thickness = Math.max(1, Math.min(BAR, band * 0.7))
  const labelChars = Math.floor((band - 4) / CHAR)
  const upIsGood = spec.upIsGood ?? true
  const fillOf = (kind: (typeof steps)[number]["kind"]) =>
    kind === "start" || kind === "total"
      ? color(0)
      : (kind === "up") === upIsGood
        ? "var(--delta-good)"
        : "var(--delta-bad)"
  const textOf = (index: number) => {
    const step = steps[index]!
    return step.kind === "up" || step.kind === "down"
      ? changeFormat.format(step.to - step.from)
      : compactFormat.format(step.to)
  }

  const indexAt = (clientX: number, element: Element) => {
    const position = clientX - element.getBoundingClientRect().left - margin.left
    return Math.max(0, Math.min(last, Math.floor(position / band)))
  }

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`Waterfall of ${spec.y[0] ?? ""} by ${spec.x ?? ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerMove={(event) => setActive(indexAt(event.clientX, event.currentTarget))}
        onPointerLeave={() => setActive(null)}
        onClick={pick ? (event) => pick(indexAt(event.clientX, event.currentTarget)) : undefined}
        className={cn(
          "block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={margin.left}
              x2={margin.left + plotW}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={margin.left - 6}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              fontSize={FONT}
              className="fill-muted-foreground tabular-nums"
            >
              {format(tick)}
            </text>
          </g>
        ))}

        {labelChars >= 2 &&
          labels.map((label, index) => (
            <text
              key={index}
              x={xCenter(index)}
              y={margin.top + plotH + 15}
              textAnchor="middle"
              fontSize={FONT}
              className={cn(
                index === selectedIndex || index === last
                  ? "fill-foreground font-semibold"
                  : "fill-muted-foreground"
              )}
            >
              {label.length > labelChars ? `${label.slice(0, labelChars - 1)}…` : label}
            </text>
          ))}

        {/* Where each bar leaves the running figure, the next picks it up. */}
        {steps.slice(0, -1).map((step, index) => (
          <line
            key={`link-${index}`}
            x1={xCenter(index) + thickness / 2}
            x2={xCenter(index + 1) - thickness / 2}
            y1={y(step.to)}
            y2={y(step.to)}
            stroke="var(--chart-axis)"
            strokeWidth={1}
            strokeDasharray="2 2"
            shapeRendering="crispEdges"
          />
        ))}

        {steps.map((step, index) => {
          const opacity = index === last ? (active === null || active === last ? 1 : 0.55) : dimmed(index, active, selectedIndex)
          const top = Math.max(step.from, step.to)
          const bottom = Math.min(step.from, step.to)
          const text = textOf(index)
          const fits = text.length * CHAR <= band - 2
          const below = step.kind === "down" || (step.kind !== "up" && step.to < 0)
          return (
            <g key={index} opacity={opacity}>
              {step.to !== step.from && (
                <path
                  d={barPath("vertical", y(step.from), y(step.to), xCenter(index) - thickness / 2, thickness)}
                  fill={fillOf(step.kind)}
                />
              )}
              {fits && count <= 16 && (
                <text
                  x={xCenter(index)}
                  y={below ? y(bottom) + 12 : y(top) - 5}
                  textAnchor="middle"
                  fontSize={FONT}
                  className="fill-foreground font-medium tabular-nums"
                >
                  {text}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {active !== null && (
        <Tooltip
          left={xCenter(active)}
          top={margin.top}
          flip={xCenter(active) > width * 0.6}
          label={labels[active] ?? ""}
          rows={[
            {
              name: spec.y[0] ?? "",
              value:
                steps[active]!.kind === "up" || steps[active]!.kind === "down"
                  ? steps[active]!.to - steps[active]!.from
                  : steps[active]!.to,
              index: 0,
              color: fillOf(steps[active]!.kind),
            },
          ]}
          notes={
            steps[active]!.kind === "up" || steps[active]!.kind === "down"
              ? [`${formatNumber(steps[active]!.to)} after`]
              : []
          }
          hint={pick && active < last ? SELECT_HINT : undefined}
        />
      )}
    </div>
  )
}

// ── Scatter ────────────────────────────────────────────────────────────────

type Dot = { x: number; y: number; group: number; label: string | null; size: number | null }

/** Rows as dots, coloured by `series`: the most frequent groups keep a colour
 * of their own, the rest share "Other" — no ninth colour is invented. */
function dots(spec: ChartSpec, data: Data): { dots: Dot[]; groups: string[] } {
  const names = data.columns.map((column) => column.name)
  const xi = names.indexOf(spec.x ?? "")
  const yi = names.indexOf(spec.y[0] ?? "")
  const si = spec.series ? names.indexOf(spec.series) : -1
  const zi = spec.size ? names.indexOf(spec.size) : -1
  // What a dot is: the first column that names rather than measures.
  const li = data.columns.findIndex(
    (_, index) => index !== si && index !== xi && index !== yi && !isNumeric(data, index)
  )
  const counts = new Map<string, number>()
  if (si >= 0) {
    for (const row of data.rows) {
      const group = row[si] ?? "NULL"
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
  }
  let groups = [...counts.keys()].sort((a, b) => a.localeCompare(b))
  if (groups.length > MAX_SERIES) {
    const keep = new Set(
      [...groups]
        .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
        .slice(0, MAX_SERIES - 1)
    )
    groups = [...groups.filter((group) => keep.has(group)), "Other"]
  }
  const indexOf = new Map(groups.map((group, index) => [group, index]))
  const other = groups.length - 1
  const list: Dot[] = []
  for (const row of data.rows) {
    const x = toNumber(row[xi])
    const y = toNumber(row[yi])
    if (x === null || y === null) continue
    const group = si >= 0 ? (indexOf.get(row[si] ?? "NULL") ?? other) : 0
    const label = li >= 0 ? (row[li] ?? null) : si >= 0 ? (row[si] ?? null) : null
    list.push({ x, y, group, label, size: zi >= 0 ? toNumber(row[zi]) : null })
  }
  return { dots: list, groups }
}

/** One measure against another: a dot per row, both axes from the data. */
function Scatter({
  spec,
  scattered: { dots: list, groups },
  height,
}: {
  spec: ChartSpec
  scattered: ReturnType<typeof dots>
  height: number
}) {
  const [ref, width] = useWidth(520)
  const { active, setActive, onKeyDown } = useActive(list.length)
  if (list.length === 0) {
    return (
      <p ref={ref} className="text-xs text-muted-foreground">
        No row has both {spec.x} and {spec.y[0]}.
      </p>
    )
  }

  const xs = list.map((dot) => dot.x)
  const constant = spec.analytics?.constant ?? null
  const ys = [...list.map((dot) => dot.y), ...(constant === null ? [] : [constant])]
  const trend = spec.analytics?.trend ? fitLine(list) : null
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 5)
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 5)
  const xMin = xTicks[0]!
  const xMax = xTicks.at(-1)!
  const yMin = yTicks[0]!
  const yMax = yTicks.at(-1)!
  const xFormat = tickFormat(Math.max(Math.abs(xMin), Math.abs(xMax)))
  const yFormat = tickFormat(Math.max(Math.abs(yMin), Math.abs(yMax)))
  // Both axes are measures, so both are named: y above its ticks, x under its.
  const margin = {
    top: 18,
    right: 12,
    bottom: 34,
    left: Math.max(...yTicks.map((tick) => yFormat(tick).length)) * CHAR + 10,
  }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const plotH = Math.max(40, height - margin.top - margin.bottom)
  const x = (value: number) => margin.left + ((value - xMin) / (xMax - xMin || 1)) * plotW
  const y = (value: number) => margin.top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH
  const radius = list.length > 500 ? 2.5 : list.length > 150 ? 3 : 4
  // A bubble's area, not its radius, is its size; the largest 24px across.
  const largest = Math.max(0, ...list.map((dot) => dot.size ?? 0))
  const radiusOf = (dot: Dot) =>
    spec.size && largest > 0 ? 3 + Math.sqrt(Math.max(0, dot.size ?? 0) / largest) * 21 : radius
  // Big bubbles under small ones, so none is hidden.
  const order = spec.size
    ? list.map((_, index) => index).sort((a, b) => (list[b]!.size ?? 0) - (list[a]!.size ?? 0))
    : list.map((_, index) => index)

  // Tick labels along the bottom only where they clear the one before.
  const shownX = (() => {
    const shown = new Set<number>()
    let edge = -Infinity
    xTicks.forEach((tick, index) => {
      const half = (xFormat(tick).length * CHAR) / 2
      if (x(tick) - half >= edge + 8) {
        shown.add(index)
        edge = x(tick) + half
      }
    })
    return shown
  })()

  const nearest = (clientX: number, clientY: number, element: Element) => {
    const box = element.getBoundingClientRect()
    const px = clientX - box.left
    const py = clientY - box.top
    let best = -1
    let distance = 12
    // Of the dots under the pointer the smallest, drawn on top; else the nearest edge.
    list.forEach((dot, index) => {
      const r = radiusOf(dot)
      const d = Math.max(0, Math.hypot(x(dot.x) - px, y(dot.y) - py) - r)
      if (d < distance || (d === 0 && best >= 0 && r < radiusOf(list[best]!))) {
        distance = d
        best = index
      }
    })
    return best < 0 ? null : best
  }

  const hovered = active === null ? null : list[active]
  return (
      <div ref={ref} className="relative w-full">
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label={`Scatter of ${spec.y[0] ?? ""} against ${spec.x ?? ""}`}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerMove={(event) =>
            setActive(nearest(event.clientX, event.clientY, event.currentTarget))
          }
          onPointerLeave={() => setActive(null)}
          className="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {yTicks.map((tick) => (
            <g key={`y${tick}`}>
              <line
                x1={margin.left}
                x2={margin.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={margin.left - 6}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                fontSize={FONT}
                className="fill-muted-foreground tabular-nums"
              >
                {yFormat(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((tick, index) => (
            <g key={`x${tick}`}>
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={margin.top}
                y2={margin.top + plotH}
                stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {shownX.has(index) && (
                <text
                  x={x(tick)}
                  y={margin.top + plotH + 15}
                  textAnchor="middle"
                  fontSize={FONT}
                  className="fill-muted-foreground tabular-nums"
                >
                  {xFormat(tick)}
                </text>
              )}
            </g>
          ))}
          <text x={margin.left} y={margin.top - 8} fontSize={FONT} className="fill-muted-foreground">
            {spec.y[0]}
          </text>
          <text
            x={margin.left + plotW}
            y={margin.top + plotH + 30}
            textAnchor="end"
            fontSize={FONT}
            className="fill-muted-foreground"
          >
            {spec.x}
          </text>

          {spec.size && (
            <text
              x={margin.left + plotW}
              y={margin.top - 8}
              textAnchor="end"
              fontSize={FONT}
              className="fill-muted-foreground"
            >
              Area: {spec.size}
            </text>
          )}

          {order.map((index) => {
            const dot = list[index]!
            return (
              <circle
                key={index}
                cx={x(dot.x)}
                cy={y(dot.y)}
                r={radiusOf(dot)}
                fill={color(dot.group)}
                fillOpacity={active === null || active === index ? (spec.size ? 0.6 : 0.75) : 0.4}
                stroke="var(--card)"
                strokeWidth={spec.size ? 2 : 1}
              />
            )
          })}
          {trend && (
            <line
              x1={x(Math.min(...xs))}
              x2={x(Math.max(...xs))}
              y1={y(trend.intercept + trend.slope * Math.min(...xs))}
              y2={y(trend.intercept + trend.slope * Math.max(...xs))}
              stroke="var(--foreground)"
              strokeWidth={1.5}
              strokeDasharray="10 4"
              opacity={0.7}
              className="pointer-events-none"
            />
          )}
          {constant !== null && (
            <g className="pointer-events-none">
              <line
                x1={margin.left}
                x2={margin.left + plotW}
                y1={y(constant)}
                y2={y(constant)}
                stroke="var(--foreground)"
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.6}
              />
              <text
                x={margin.left + plotW - 2}
                y={y(constant) - 4}
                textAnchor="end"
                fontSize={FONT}
                className="fill-foreground tabular-nums"
              >
                {spec.analytics?.constantLabel || yFormat(constant)}
              </text>
            </g>
          )}
          {hovered && (
            <circle
              cx={x(hovered.x)}
              cy={y(hovered.y)}
              r={spec.size ? radiusOf(hovered) : 6}
              fill={color(hovered.group)}
              stroke="var(--card)"
              strokeWidth={2}
            />
          )}
        </svg>

        {hovered && (
          <Tooltip
            left={x(hovered.x)}
            top={y(hovered.y)}
            flip={x(hovered.x) > width * 0.6}
            label={hovered.label ?? `Row ${active! + 1}`}
            rows={[
              { name: spec.x ?? "", value: hovered.x, index: hovered.group },
              { name: spec.y[0] ?? "", value: hovered.y, index: hovered.group },
              ...(spec.size ? [{ name: spec.size, value: hovered.size, index: hovered.group }] : []),
            ]}
            notes={
              groups.length > 1 && hovered.label !== groups[hovered.group]
                ? [groups[hovered.group]!]
                : []
            }
          />
        )}
        <AnalyticsKey analytics={{ trend: !!trend }} forecastShown={false} />
      </div>
  )
}

// ── Pie and donut ──────────────────────────────────────────────────────────

/** Past this many slices the smallest fold into "Other": a pie of more is
 * not read, and ranked bars are the form for comparing them. */
const SLICES = 6

/** An annular sector — a wedge from the centre when `inner` is 0 — clockwise
 * from angle `from` to `to`, in radians from 3 o'clock. */
function arcPath(cx: number, cy: number, inner: number, outer: number, from: number, to: number): string {
  if (to - from >= Math.PI * 2 - 1e-9) {
    // One arc cannot end where it starts: a whole ring is two halves.
    const middle = from + Math.PI
    return `${arcPath(cx, cy, inner, outer, from, middle)} ${arcPath(cx, cy, inner, outer, middle, to)}`
  }
  const large = to - from > Math.PI ? 1 : 0
  const at = (r: number, angle: number) => `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
  if (inner <= 0) {
    return `M${cx},${cy} L${at(outer, from)} A${outer},${outer} 0 ${large} 1 ${at(outer, to)} Z`
  }
  return [
    `M${at(outer, from)}`,
    `A${outer},${outer} 0 ${large} 1 ${at(outer, to)}`,
    `L${at(inner, to)}`,
    `A${inner},${inner} 0 ${large} 0 ${at(inner, from)}`,
    "Z",
  ].join(" ")
}

/**
 * A part keeps its colour by its name, not its size: the kept parts take the
 * series colours in the order their names sort, so a filter that reorders
 * them repaints none. The folded tail is grey.
 */
function partColours(list: Part[]) {
  const names = list
    .filter((part) => !part.other)
    .map((part) => categoryLabel(part.raw))
    .sort((a, b) => a.localeCompare(b))
  return list.map((part) => (part.other ? OTHER : color(names.indexOf(categoryLabel(part.raw)))))
}

/**
 * The parts of one whole, largest first from 12 o'clock, each slice parted
 * from the next by the surface. Beside it, every part's name, share and
 * figure — the labels a slice is too small to carry. A donut says the whole
 * in its middle.
 */
function Pie({
  spec,
  data,
  height,
  hole,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  data: Data
  height: number
  hole: boolean
} & Selection) {
  const [ref, width] = useWidth(520)
  const list = useMemo(() => parts(data, spec.x!, spec.y[0]!, SLICES), [data, spec.x, spec.y])
  const fills = useMemo(() => partColours(list), [list])
  const total = list.reduce((sum, part) => sum + part.value, 0)
  const pick = onSelect
    ? (index: number) => {
        if (!list[index]!.other) onSelect(list[index]!.raw)
      }
    : undefined
  const { active, setActive, onKeyDown } = useActive(list.length, pick)
  const selectedIndex =
    selected === undefined ? -1 : list.findIndex((part) => !part.other && part.raw === selected)

  if (list.length === 0) {
    return (
      <p ref={ref} className="text-xs text-muted-foreground">
        No row has a {spec.y[0]} above zero.
      </p>
    )
  }

  // The list beside the pie where there is room for both, under it where not.
  const side = width >= 360
  const size = Math.max(96, Math.min(height, side ? width * 0.5 : width, 320))
  const center = size / 2
  const outer = center - 4
  const inner = hole ? outer * 0.62 : 0
  const angles: [number, number][] = []
  let running = -Math.PI / 2
  for (const part of list) {
    const sweep = (part.value / (total || 1)) * Math.PI * 2
    angles.push([running, running + sweep])
    running += sweep
  }
  const share = (value: number) => shareFormat.format(total ? value / total : 0)
  const hovered = active === null ? null : list[active]!
  const tipAt = (() => {
    if (active === null) return null
    const [from, to] = angles[active]!
    const middle = (from + to) / 2
    const r = hole ? (inner + outer) / 2 : outer * 0.6
    return { left: center + r * Math.cos(middle), top: center + r * Math.sin(middle) }
  })()

  return (
    <div ref={ref} className={cn("relative flex w-full gap-x-6 gap-y-3", side ? "items-start" : "flex-col")}>
      <svg
        width={size}
        height={size}
        role="img"
        tabIndex={0}
        aria-label={`${hole ? "Donut" : "Pie"} of ${spec.y[0] ?? ""} by ${spec.x ?? ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className={cn(
          "block shrink-0 overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {list.map((part, index) => {
          const [from, to] = angles[index]!
          const lifted = index === active || index === selectedIndex
          return (
            <path
              key={index}
              d={arcPath(center, center, inner, lifted ? outer + 3 : outer, from, to)}
              fill={fills[index]}
              stroke={list.length > 1 ? "var(--card)" : "none"}
              strokeWidth={GAP}
              strokeLinejoin="round"
              opacity={dimmed(index, active, selectedIndex)}
              onPointerEnter={() => setActive(index)}
              onClick={pick ? () => pick(index) : undefined}
            />
          )
        })}
        {hole && (
          <g className="pointer-events-none">
            <text
              x={center}
              y={center}
              dy="-0.1em"
              textAnchor="middle"
              fontSize={Math.max(14, Math.min(24, inner / 3))}
              className="fill-foreground font-semibold tabular-nums"
            >
              {figure(hovered ? hovered.value : total)}
            </text>
            <text
              x={center}
              y={center}
              dy="1.5em"
              textAnchor="middle"
              fontSize={FONT}
              className="fill-muted-foreground"
            >
              {hovered ? share(hovered.value) : "Total"}
            </text>
          </g>
        )}
      </svg>

      <ul className="flex min-w-0 flex-1 flex-col gap-1 self-center text-xs">
        {list.map((part, index) => (
          <li
            key={index}
            onPointerEnter={() => setActive(index)}
            onPointerLeave={() => setActive(null)}
            onClick={pick ? () => pick(index) : undefined}
            className={cn(
              "flex items-center gap-2 rounded-sm px-1 py-0.5",
              pick && !part.other && "cursor-pointer",
              index === active && "bg-muted/60"
            )}
            style={{ opacity: dimmed(index, active, selectedIndex) }}
          >
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: fills[index] }} />
            <span className={cn("min-w-0 flex-1 truncate", index === selectedIndex ? "font-semibold" : "")}>
              {categoryLabel(part.raw)}
            </span>
            <span className="shrink-0 font-medium tabular-nums">{share(part.value)}</span>
            <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
              {figure(part.value)}
            </span>
          </li>
        ))}
      </ul>

      {hovered && tipAt && !hole && (
        <Tooltip
          left={tipAt.left}
          top={tipAt.top}
          flip={false}
          label={categoryLabel(hovered.raw)}
          rows={[{ name: spec.y[0] ?? "", value: hovered.value, index: 0, color: fills[active!] }]}
          notes={[`${share(hovered.value)} of ${figure(total)}`]}
          hint={pick && !hovered.other ? SELECT_HINT : undefined}
        />
      )}
    </div>
  )
}

// ── Treemap ────────────────────────────────────────────────────────────────

/** Past this many rectangles the smallest fold into "Other". */
const TILES = 40

/**
 * Many parts of one whole as rectangles with the area of their value, the
 * largest at the top left, in one hue that deepens with size; each named on
 * itself where it has room, and every one by hover.
 */
function Treemap({
  spec,
  data,
  height,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  data: Data
  height: number
} & Selection) {
  const [ref, width] = useWidth(520)
  const list = useMemo(() => parts(data, spec.x!, spec.y[0]!, TILES), [data, spec.x, spec.y])
  const boxes = useMemo(
    () => squarify(list.map((part) => part.value), { x: 0, y: 0, w: width, h: height }),
    [list, width, height]
  )
  const total = list.reduce((sum, part) => sum + part.value, 0)
  const high = Math.max(0, ...list.filter((part) => !part.other).map((part) => part.value))
  const pick = onSelect
    ? (index: number) => {
        if (!list[index]!.other) onSelect(list[index]!.raw)
      }
    : undefined
  const { active, setActive, onKeyDown } = useActive(list.length, pick)
  const selectedIndex =
    selected === undefined ? -1 : list.findIndex((part) => !part.other && part.raw === selected)

  if (list.length === 0) {
    return (
      <p ref={ref} className="text-xs text-muted-foreground">
        No row has a {spec.y[0]} above zero.
      </p>
    )
  }

  const depth = (part: Part) => (part.other || !high ? 0 : Math.round(30 + (part.value / high) * 70))
  const hovered = active === null ? null : list[active]!
  const box = active === null ? null : boxes[active]!

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`Treemap of ${spec.y[0] ?? ""} by ${spec.x ?? ""}`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className={cn(
          "block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          pick && "cursor-pointer"
        )}
      >
        {list.map((part, index) => {
          const { x, y, w, h } = boxes[index]!
          // The surface between neighbours: half the gap off each side.
          const inset = { x: x + GAP / 2, y: y + GAP / 2, w: Math.max(0, w - GAP), h: Math.max(0, h - GAP) }
          const percent = depth(part)
          const dark = percent > 60
          const label = categoryLabel(part.raw)
          const chars = Math.floor((inset.w - 12) / CHAR)
          const named = chars >= 3 && inset.h >= 24
          const figured = named && inset.h >= 40
          return (
            <g
              key={index}
              opacity={dimmed(index, active, selectedIndex)}
              onPointerEnter={() => setActive(index)}
              onClick={pick ? () => pick(index) : undefined}
            >
              <rect
                x={inset.x}
                y={inset.y}
                width={inset.w}
                height={inset.h}
                rx={Math.min(4, inset.w / 2, inset.h / 2)}
                fill={
                  part.other ? OTHER : `color-mix(in oklab, var(--series-1) ${percent}%, var(--card))`
                }
              />
              {named && (
                <text
                  x={inset.x + 6}
                  y={inset.y + 15}
                  fontSize={FONT}
                  className={cn("pointer-events-none font-medium", dark ? "fill-white" : "fill-foreground")}
                >
                  {label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label}
                </text>
              )}
              {figured && (
                <text
                  x={inset.x + 6}
                  y={inset.y + 29}
                  fontSize={FONT}
                  className={cn("pointer-events-none tabular-nums", dark ? "fill-white/80" : "fill-muted-foreground")}
                >
                  {figure(part.value)}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {hovered && box && (
        <Tooltip
          left={box.x + box.w / 2}
          top={box.y + box.h / 2}
          flip={box.x + box.w / 2 > width * 0.6}
          label={categoryLabel(hovered.raw)}
          rows={[{ name: spec.y[0] ?? "", value: hovered.value, index: 0 }]}
          notes={[`${shareFormat.format(total ? hovered.value / total : 0)} of ${figure(total)}`]}
          hint={pick && !hovered.other ? SELECT_HINT : undefined}
        />
      )}
    </div>
  )
}

// ── Progress ───────────────────────────────────────────────────────────────

/** A value against its target: a filled track, and a tick where the target is. */
function Meter({ value, target, label }: { value: number | null; target: number | null; label: string }) {
  const scale = Math.max(value ?? 0, target ?? 0) || 1
  const filled = Math.max(0, Math.min(1, (value ?? 0) / scale))
  const mark = target === null ? null : Math.max(0, Math.min(1, target / scale))
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={target ?? undefined}
      aria-valuenow={value ?? undefined}
      className="relative h-2 w-full rounded-full bg-muted"
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${filled * 100}%`, background: color(0) }}
      />
      {mark !== null && (
        <div
          aria-hidden
          className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground/70"
          style={{ left: `calc(${mark * 100}% - 1px)` }}
        />
      )}
    </div>
  )
}

/** A share of a target, in the status colour only once the target is passed. */
function TargetShare({
  value,
  target,
  upIsGood,
}: {
  value: number | null
  target: number | null
  upIsGood: boolean
}) {
  if (value === null || target === null || target === 0) return null
  const part = value / target
  // Reaching a goal is good news; going over a budget is bad.
  const tone = upIsGood
    ? value >= target
      ? "var(--delta-good)"
      : undefined
    : value > target
      ? "var(--delta-bad)"
      : undefined
  return (
    <span className="font-medium tabular-nums" style={{ color: tone }}>
      {shareFormat.format(part)}
    </span>
  )
}

/**
 * A figure against its target. One row is a headline: the figure, its
 * target, the track between. With x, a row each, every one against its own.
 */
function Progress({
  spec,
  data,
  prepared,
  limit,
  titled,
  onSelect,
  selected,
}: {
  spec: ChartSpec
  data: Data
  prepared: Prepared
  limit: number
  titled: boolean
} & Selection) {
  const targetIndex = data.columns.findIndex((column) => column.name === spec.target)
  const targets = data.rows.map((row) => toNumber(row[targetIndex]))
  const values = prepared.values[0] ?? []
  const upIsGood = spec.upIsGood ?? true

  if (!spec.x) {
    const value = values[0] ?? null
    const target = targets[0] ?? null
    return (
      <div className="flex h-full flex-col gap-1.5">
        {!titled && <div className="text-xs text-muted-foreground">{spec.y[0]}</div>}
        <div className="flex items-baseline gap-2">
          <div
            className="text-3xl font-semibold tracking-tight text-foreground"
            title={value === null ? undefined : formatNumber(value)}
          >
            {value === null ? "—" : figure(value)}
          </div>
          {target !== null && (
            <div className="text-xs text-muted-foreground tabular-nums">of {figure(target)}</div>
          )}
        </div>
        <div className="mt-auto flex flex-col gap-1.5 pt-1">
          <Meter value={value} target={target} label={spec.y[0] ?? ""} />
          <div className="text-xs text-muted-foreground">
            <TargetShare value={value} target={target} upIsGood={upIsGood} /> of target
          </div>
        </div>
      </div>
    )
  }

  const shown = Math.min(values.length, limit)
  return (
    <div className="flex flex-col gap-2.5">
      {values.slice(0, shown).map((value, index) => {
        const raw = prepared.raw[index] ?? null
        const target = targets[index] ?? null
        return (
          <div
            key={index}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onClick={onSelect ? () => onSelect(raw) : undefined}
            onKeyDown={
              onSelect
                ? (event) => {
                    if (event.key === "Enter") onSelect(raw)
                  }
                : undefined
            }
            title={onSelect ? SELECT_HINT : undefined}
            className={cn(
              "flex flex-col gap-1 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              onSelect && "cursor-pointer",
              selected !== undefined && selected !== raw && "opacity-40"
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-foreground">
                {prepared.labels[index]}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">
                  {value === null ? "—" : figure(value)}
                </span>
                {target !== null && <> / {figure(target)}</>}
                {target !== null && value !== null && target !== 0 && " · "}
                <TargetShare value={value} target={target} upIsGood={upIsGood} />
              </span>
            </div>
            <Meter value={value} target={target} label={prepared.labels[index] ?? ""} />
          </div>
        )
      })}
      {values.length > shown && (
        <p className="text-[11px] text-muted-foreground">
          The first {shown} of {values.length}; the table has them all.
        </p>
      )}
    </div>
  )
}

type ChartProps = {
  spec: ChartSpec
  data: Data
  /** Whoever shows the chart names it: a lone figure need not say its column. */
  titled?: boolean
  /** Columns and lines take the height of the box they are in, `height` at
   * the least: the box's height must come from elsewhere. */
  fill?: boolean
  /** Of the plot and its axis, for columns and lines; ranked bars grow. */
  height?: number
  /** Ranked bars shown before the rest is left to the table. */
  limit?: number
  large?: boolean
} & Selection

/**
 * A chart, and — where it has drill levels — the path drilled down so far:
 * its categories summed at the level reached, a click on one going a level
 * deeper, and only at the deepest selecting it for whoever shows the chart.
 */
export function Chart(props: ChartProps) {
  const { spec, data, onSelect, selected } = props
  const levels = useMemo(
    () =>
      spec.x && spec.levels?.length && DRILLABLE.has(spec.type) ? [spec.x, ...spec.levels] : null,
    [spec.x, spec.levels, spec.type]
  )
  const key = levels?.join("\u0000") ?? ""
  const [drill, setDrill] = useState<{ key: string; path: Cell[] }>({ key, path: [] })
  // A new hierarchy starts again from the top.
  const path = drill.key === key ? drill.path : NO_PATH
  const depth = levels ? Math.min(path.length, levels.length - 1) : 0
  const view = useMemo(() => {
    if (!levels) return null
    const at = levels[depth]!
    const sum = [...spec.y, spec.line, spec.size].filter((name): name is string => !!name)
    return {
      spec: { ...spec, x: at, levels: undefined },
      data: rollUp(
        data,
        levels.slice(0, depth).map((name, index) => [name, path[index] ?? null] as [string, Cell]),
        [at, ...(spec.series ? [spec.series] : [])],
        sum
      ),
    }
  }, [levels, depth, path, spec, data])
  if (!levels || !view) return <ChartBody {...props} />

  const deepest = depth === levels.length - 1
  const go = (next: Cell[]) => setDrill({ key, path: next })
  return (
    <div className={cn("w-full", props.fill && "flex h-full min-h-0 flex-1 flex-col")}>
      <nav
        aria-label="Drill path"
        className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
      >
        <button
          type="button"
          disabled={depth === 0}
          onClick={() => go(path.slice(0, depth - 1))}
          title="Up a level"
          aria-label="Up a level"
          className="flex size-5 items-center justify-center rounded hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => go([])}
          className={depth === 0 ? "font-medium text-foreground" : "hover:text-foreground"}
        >
          All {levels[0]}
        </button>
        {path.slice(0, depth).map((value, index) => (
          <Fragment key={index}>
            <ChevronRight aria-hidden className="size-3" />
            <button
              type="button"
              onClick={() => go(path.slice(0, index + 1))}
              className={index === depth - 1 ? "font-medium text-foreground" : "hover:text-foreground"}
            >
              {categoryLabel(value)}
            </button>
          </Fragment>
        ))}
        {!deepest && (
          <span className="ml-1">
            · click a {levels[depth]} to see its {levels[depth + 1]}
          </span>
        )}
      </nav>
      <SelectHint.Provider value={deepest ? SELECT_HINT : "Click to drill in"}>
        <ChartBody
          {...props}
          spec={view.spec}
          data={view.data}
          onSelect={
            deepest
              ? onSelect && ((value: Cell) => onSelect(value, levels[depth]))
              : (value: Cell) => go([...path.slice(0, depth), value])
          }
          selected={deepest ? selected : undefined}
        />
      </SelectHint.Provider>
    </div>
  )
}

const NO_PATH: Cell[] = []

function ChartBody({
  spec,
  data,
  height = 240,
  limit = 20,
  large = false,
  onSelect,
  selected,
  titled = false,
  fill = false,
}: ChartProps) {
  const prepared = useMemo(() => prepare(spec, data), [spec, data])
  const scattered = useMemo(
    () => (spec.type === "scatter" ? dots(spec, data) : null),
    [spec, data]
  )
  let body: ReactNode
  if (data.rows.length === 0) {
    body = <p className="text-xs text-muted-foreground">No rows to draw.</p>
  } else {
    switch (spec.type) {
      case "stat":
        body = <Stats prepared={prepared} large={large} titled={titled} />
        break
      case "kpi":
        body = <Kpi spec={spec} data={data} prepared={prepared} titled={titled} />
        break
      case "pivot":
        body = <Pivot spec={spec} data={data} onSelect={onSelect} selected={selected} />
        break
      case "progress":
        body = (
          <Progress
            spec={spec}
            data={data}
            prepared={prepared}
            limit={limit}
            titled={titled}
            onSelect={onSelect}
            selected={selected}
          />
        )
        break
      case "funnel":
        body = (
          <Funnel
            spec={spec}
            prepared={prepared}
            limit={limit}
            onSelect={onSelect}
            selected={selected}
          />
        )
        break
      case "waterfall":
      case "scatter":
      case "pie":
      case "donut":
      case "treemap": {
        const plot = (at: number) =>
          spec.type === "scatter" ? (
            <Scatter spec={spec} scattered={scattered!} height={at} />
          ) : spec.type === "pie" || spec.type === "donut" ? (
            <Pie
              spec={spec}
              data={data}
              height={at}
              hole={spec.type === "donut"}
              onSelect={onSelect}
              selected={selected}
            />
          ) : spec.type === "treemap" ? (
            <Treemap spec={spec} data={data} height={at} onSelect={onSelect} selected={selected} />
          ) : (
            <Waterfall
              spec={spec}
              prepared={prepared}
              height={at}
              onSelect={onSelect}
              selected={selected}
            />
          )
        body = fill ? <FillHeight least={height}>{plot}</FillHeight> : plot(height)
        break
      }
      case "table":
        body = (
          <ResultTable
            data={data}
            shaded={spec.y}
            rules={spec.rules}
            bare={fill}
            className={fill ? "min-h-0 flex-1" : undefined}
          />
        )
        break
      case "hbar":
        body = (
          <Horizontal
            spec={spec}
            prepared={prepared}
            limit={limit}
            onSelect={onSelect}
            selected={selected}
          />
        )
        break
      default: {
        if (spec.facet && FACETABLE.has(spec.type)) {
          const plot = (at: number) => (
            <Facets
              spec={spec}
              data={data}
              height={at}
              fit={fill}
              onSelect={onSelect}
              selected={selected}
            />
          )
          body = fill ? <FillHeight least={height}>{plot}</FillHeight> : plot(height)
          break
        }
        const plot = (at: number) => (
          <Cartesian
            spec={spec}
            prepared={prepared}
            height={at}
            onSelect={onSelect}
            selected={selected}
          />
        )
        body = fill ? <FillHeight least={height}>{plot}</FillHeight> : plot(height)
      }
    }
  }
  const legend = ["bar", "hbar", "line", "area", "combo"].includes(spec.type)
  return (
    <div className={cn("w-full", fill && "flex h-full min-h-0 flex-1 flex-col")}>
      {legend && (
        <Legend
          names={prepared.names}
          line={spec.type === "line"}
          lines={spec.type === "combo" && spec.line ? [spec.line] : []}
        />
      )}
      {scattered && data.rows.length > 0 && (
        <Legend names={scattered.groups} line={false} dot />
      )}
      {body}
    </div>
  )
}

const NO_RULES: CellRule[] = []

/** A cell as a reader wants it: numbers grouped, nothing else changed. */
function cellText(value: string, kind: string | undefined) {
  return kind === "number" ? groupDigits(value) : value
}

/** A result as a plain table: every chart's twin, and a tile without one.
 * `shaded` columns carry their magnitude in one hue, light to dark. `bare`
 * drops its own frame, for a card that is the frame already. */
export function ResultTable({
  data,
  maxRows = 200,
  className,
  shaded = [],
  rules = NO_RULES,
  bare = false,
}: {
  data: Data
  maxRows?: number
  className?: string
  shaded?: string[]
  /** Marks on cells by their value, column by column. */
  rules?: CellRule[]
  bare?: boolean
}) {
  const rows = data.rows.slice(0, maxRows)
  const ruled = useMemo(() => new Set(rules.map((rule) => rule.column)), [rules])
  const ranges = useMemo(() => {
    const result = new Map<number, [number, number]>()
    data.columns.forEach((column, index) => {
      if (!shaded.includes(column.name) && !ruled.has(column.name)) return
      const numbers = data.rows
        .map((row) => toNumber(row[index]))
        .filter((value): value is number => value !== null)
      if (numbers.length) result.set(index, [Math.min(...numbers), Math.max(...numbers)])
    })
    return result
  }, [data, shaded, ruled])
  const right = (index: number) => data.columns[index]?.kind === "number" || ranges.has(index)
  if (data.rows.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No rows.</p>
  }
  return (
    <div
      className={cn(
        "result-table selectable overflow-auto",
        bare
          ? "-mx-4 -mb-4 rounded-b-lg [&_tbody_tr:last-child>td]:border-b-0"
          : "rounded-md border [&_tbody_tr:last-child>td]:border-b-0",
        className
      )}
    >
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-[1]">
          <tr>
            {data.columns.map((column, index) => (
              <th
                key={index}
                title={column.type}
                className={cn(
                  "h-8 border-b bg-card px-3 text-left text-[11px] font-medium whitespace-nowrap text-muted-foreground",
                  bare && "border-t",
                  right(index) && "text-right"
                )}
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="hover:[&>td]:bg-muted/50">
              {row.map((value, cell) => {
                const range = ranges.get(cell)
                const kind = data.columns[cell]?.kind
                const text = value === null ? null : cellText(value, kind)
                const name = data.columns[cell]?.name ?? ""
                const cellRules = ruled.has(name) ? rules.filter((rule) => rule.column === name) : []
                const barred = cellRules.some((rule) => rule.kind === "bars")
                return (
                  <td
                    key={cell}
                    title={text !== null && text.length > 32 ? text : undefined}
                    className={cn(
                      "h-8 max-w-64 truncate border-b border-border/60 px-3 whitespace-nowrap",
                      right(cell) && "text-right tabular-nums",
                      kind === "json" && "font-mono text-[11px]",
                      kind === "boolean" && "text-muted-foreground"
                    )}
                    style={
                      range && shaded.includes(name) && !barred
                        ? shade(toNumber(value), range[0], range[1])
                        : undefined
                    }
                  >
                    {text === null ? (
                      <span className="text-[11px] text-muted-foreground/60">null</span>
                    ) : (
                      <RuledValue rules={cellRules} value={toNumber(value)} range={range}>
                        {text}
                      </RuledValue>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > rows.length && (
        <div className="px-3 py-2 text-[11px] text-muted-foreground">
          Showing the first {rows.length.toLocaleString()} of{" "}
          {data.rows.length.toLocaleString()} rows.
        </div>
      )}
    </div>
  )
}
