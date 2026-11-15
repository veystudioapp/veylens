import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import type { Cell, ChartSpec, QueryResult } from "@shared/api"
import { toNumber, widen } from "@shared/chart"

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
}

function prepare(spec: ChartSpec, data: Data): Prepared {
  const names = data.columns.map((column) => column.name)
  let raw: Cell[]
  let series: string[]
  let values: (number | null)[][]
  if (spec.series && spec.x && spec.y[0]) {
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
  }
  let labels = raw.map(categoryLabel)
  // Months, as a `date_trunc('month', …)` gives them: the day says nothing.
  if (labels.length > 1 && labels.every((label) => /^\d{4}-\d{2}-01$/.test(label))) {
    labels = labels.map((label) => label.slice(0, 7))
  }
  return { raw, labels, names: series, values }
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

function Legend({ names, line }: { names: string[]; line: boolean }) {
  if (names.length < 2) return null
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {names.map((name, index) => (
        <span key={name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={line ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[3px]"}
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
  hint,
}: {
  left: number
  top: number
  flip: boolean
  label: string
  rows: { name: string; value: number | null; index: number }[]
  hint?: string
}) {
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
            style={{ background: color(row.index) }}
          />
          <span className="font-semibold text-popover-foreground tabular-nums">
            {row.value === null ? "—" : formatNumber(row.value)}
          </span>
          {rows.length > 1 && (
            <span className="text-muted-foreground">{row.name}</span>
          )}
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
  /** A category clicked: the x value as the data has it. */
  onSelect?: (value: Cell) => void
  /** The category the dashboard is filtered to; the others are dimmed. */
  selected?: Cell | undefined
}

const SELECT_HINT = "Click to filter the dashboard"

// ── Columns, lines and areas ───────────────────────────────────────────────

function Cartesian({
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
  const { labels, names, values, raw } = prepared
  const count = labels.length
  const pick = onSelect ? (index: number) => onSelect(raw[index] ?? null) : undefined
  const { active, setActive, onKeyDown } = useActive(count, pick)
  const isBar = spec.type === "bar"
  const isArea = spec.type === "area"
  const k = names.length
  const stacked = !!spec.stacked && k > 1 && (isBar || isArea)
  const bySeries = useMemo(() => spans(values, stacked), [values, stacked])
  const ends = useMemo(() => stackEnds(bySeries), [bySeries])
  const selectedIndex =
    selected === undefined ? -1 : raw.findIndex((value) => value === selected)

  const [low, high] = extent(bySeries.map((series) =>
    series.map((span) => (span ? ([span[1], span[1]] as [number, number]) : null))
  ))
  // Bars and areas grow from zero; a line far from zero may start near its
  // data instead of flattening against the top.
  const nearZero = low <= 0 || (high - low) / Math.abs(high) > 0.3
  const domainLow = isBar || isArea || nearZero ? Math.min(0, low) : low
  const ticks = niceTicks(domainLow, Math.max(high, isBar || isArea ? 0 : high))
  const yMin = ticks[0]!
  const yMax = ticks.at(-1)!
  const format = tickFormat(Math.max(Math.abs(yMin), Math.abs(yMax)))

  const endLabels = !isBar && !stacked && k <= 4 && count > 1
  const margin = {
    top: 8,
    right: endLabels ? 52 : 12,
    bottom: 22,
    left: Math.max(...ticks.map((tick) => format(tick).length)) * CHAR + 10,
  }
  const plotW = Math.max(40, width - margin.left - margin.right)
  const plotH = Math.max(40, height - margin.top - margin.bottom)
  const y = (value: number) =>
    margin.top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH
  const baseline = y(Math.max(yMin, Math.min(0, yMax)))

  const band = plotW / Math.max(1, count)
  const xCenter = (index: number) =>
    isBar
      ? margin.left + band * (index + 0.5)
      : margin.left + (count === 1 ? plotW / 2 : (index * plotW) / (count - 1))

  // Labels left to right, each only where it clears the one before it —
  // measured as it is anchored, so the first and last, which hug the plot's
  // edges, are measured as they actually sit.
  const anchorOf = (index: number): "start" | "middle" | "end" =>
    isBar || count === 1
      ? "middle"
      : index === 0
        ? "start"
        : index === count - 1
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
    const lastSpan = count > 1 ? span(count - 1) : null
    let edge = -Infinity
    for (let index = 0; index < count; index++) {
      const [from, to] = span(index)
      const clearsLast = index === count - 1 || !lastSpan || to + 8 <= lastSpan[0]
      if (from >= edge + 8 && clearsLast) {
        shown.add(index)
        edge = to
      }
    }
    return shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, width, count, isBar, margin.left, plotW])

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
      : count === 1
        ? 0
        : Math.round((position / plotW) * (count - 1))
    return Math.max(0, Math.min(count - 1, index))
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

        {peak !== null && values[0]![peak] !== null && (
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

      {active !== null && (
        <Tooltip
          left={tooltipX}
          top={margin.top}
          flip={tooltipX > width * 0.6}
          label={labels[active] ?? ""}
          rows={names.map((name, index) => ({
            name,
            index,
            value: values[index]![active] ?? null,
          }))}
          hint={pick ? SELECT_HINT : undefined}
        />
      )}
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
  const stacked = !!spec.stacked && k > 1
  const bySeries = spans(values, stacked)
  const ends = stackEnds(bySeries)
  const selectedIndex =
    selected === undefined ? -1 : raw.findIndex((value) => value === selected)

  const thickness = stacked || k === 1 ? 16 : Math.max(4, Math.min(12, (22 - (k - 1) * GAP) / k))
  const row = stacked ? 28 : Math.max(28, k * (thickness + GAP) + 10)
  const [low, high] = extent(bySeries)
  const ticks = niceTicks(Math.min(0, low), Math.max(0, high), 4)
  const xMin = ticks[0]!
  const xMax = ticks.at(-1)!
  const format = tickFormat(Math.max(Math.abs(xMin), Math.abs(xMax)))
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
          rows={names.map((name, index) => ({
            name,
            index,
            value: values[index]![active] ?? null,
          }))}
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
                    style={shade(value, low, high)}
                  >
                    {value === null ? "" : formatNumber(value)}
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

export function Chart({
  spec,
  data,
  height = 240,
  limit = 20,
  large = false,
  onSelect,
  selected,
  titled = false,
  fill = false,
}: {
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
} & Selection) {
  const prepared = useMemo(() => prepare(spec, data), [spec, data])
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
      case "table":
        body = (
          <ResultTable
            data={data}
            shaded={spec.y}
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
  const legend = ["bar", "hbar", "line", "area"].includes(spec.type)
  return (
    <div className={cn("w-full", fill && "flex h-full min-h-0 flex-1 flex-col")}>
      {legend && <Legend names={prepared.names} line={spec.type === "line"} />}
      {body}
    </div>
  )
}

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
  bare = false,
}: {
  data: Data
  maxRows?: number
  className?: string
  shaded?: string[]
  bare?: boolean
}) {
  const rows = data.rows.slice(0, maxRows)
  const ranges = useMemo(() => {
    const result = new Map<number, [number, number]>()
    data.columns.forEach((column, index) => {
      if (!shaded.includes(column.name)) return
      const numbers = data.rows
        .map((row) => toNumber(row[index]))
        .filter((value): value is number => value !== null)
      if (numbers.length) result.set(index, [Math.min(...numbers), Math.max(...numbers)])
    })
    return result
  }, [data, shaded])
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
                    style={range ? shade(toNumber(value), range[0], range[1]) : undefined}
                  >
                    {text === null ? (
                      <span className="text-[11px] text-muted-foreground/60">null</span>
                    ) : (
                      text
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
