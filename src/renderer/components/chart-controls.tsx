import {
  ChartSpline,
  ChevronDown,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListTree,
  Paintbrush,
  Pin,
  Plus,
} from "lucide-react"

import {
  ANALYTIC_TYPES,
  CHART_TYPES,
  MAX_SERIES,
  type CellRule,
  type ChartAnalytics,
  type ChartSpec,
  type ChartType,
  type DashboardTile,
  type QueryResult,
} from "@shared/api"
import { DRILLABLE, FACETABLE, isNumeric, STACKABLE } from "@shared/chart"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { errorMessage, useStore } from "@/lib/store"

import { promptText } from "./prompt"
import { SimpleSelect } from "./simple-select"

export const CHART_LABELS: Record<ChartType, string> = {
  bar: "Columns",
  hbar: "Ranked bars",
  line: "Line",
  area: "Area",
  combo: "Columns + line",
  scatter: "Scatter",
  pie: "Pie",
  donut: "Donut",
  treemap: "Treemap",
  funnel: "Funnel",
  waterfall: "Waterfall",
  stat: "Figure",
  kpi: "KPI",
  progress: "Progress",
  pivot: "Matrix",
  table: "Table",
}

const NONE = "\u0000none"

/** Types that take each choice. */
const TAKES_X = new Set<ChartType>([
  "bar",
  "hbar",
  "line",
  "area",
  "combo",
  "scatter",
  "pie",
  "donut",
  "treemap",
  "funnel",
  "waterfall",
  "kpi",
  "progress",
  "pivot",
])
const TAKES_SERIES = new Set<ChartType>(["bar", "hbar", "line", "area", "scatter", "pivot"])
/** Types that draw one value. */
const SINGLE = new Set<ChartType>([
  "kpi",
  "pivot",
  "scatter",
  "pie",
  "donut",
  "treemap",
  "funnel",
  "waterfall",
  "progress",
])
const STACK_MODES = { side: "Side by side", stacked: "Stacked", percent: "100% stacked" }
/** Types with a good and a bad direction. */
const TAKES_DIRECTION = new Set<ChartType>(["kpi", "progress", "waterfall"])
/** Types whose x may be left out: a one-row figure. */
const OPTIONAL_X = new Set<ChartType>(["kpi", "progress"])

/**
 * Which form, along what, which numbers, split by what: the choices a chart
 * is. Each is offered only for the forms that use it.
 */
export function ChartControls({
  spec,
  data,
  onChange,
}: {
  spec: ChartSpec
  data: Pick<QueryResult, "columns" | "rows">
  onChange: (spec: ChartSpec) => void
}) {
  const numeric = data.columns
    .map((column, index) => ({ name: column.name, index }))
    .filter(({ index }) => isNumeric(data, index))
    .map(({ name }) => name)
  const dimensions = data.columns
    .map((column) => column.name)
    .filter((name) => !numeric.includes(name))
  const types = Object.fromEntries(
    CHART_TYPES.map((type) => [type, CHART_LABELS[type]])
  ) as Record<ChartType, string>
  const options = (names: string[], none: string | null) => {
    const items: Record<string, string> = {}
    if (none) items[NONE] = none
    for (const name of names) items[name] = name
    return items
  }
  const single = !!spec.series || SINGLE.has(spec.type)
  const seriesCount = spec.series ? 2 : spec.y.length

  const setType = (type: ChartType) => {
    const next: ChartSpec = { ...spec, type }
    if (!TAKES_X.has(type)) next.x = null
    else if (type === "scatter") {
      // Two measures: x is one the plotted value is not.
      if (!next.x || !numeric.includes(next.x)) {
        next.x = numeric.find((name) => name !== next.y[0]) ?? null
      }
      if (next.y[0] === next.x) {
        next.y = numeric.filter((name) => name !== next.x).slice(0, 1)
      }
    } else if (!next.x && !OPTIONAL_X.has(type)) {
      next.x = dimensions[0] ?? data.columns[0]?.name ?? null
    }
    if (!TAKES_SERIES.has(type)) next.series = null
    if (type === "pivot" && !next.series) {
      next.series = dimensions.find((name) => name !== next.x) ?? null
    }
    if ((SINGLE.has(type) || next.series) && next.y.length > 1) next.y = next.y.slice(0, 1)
    if (type === "combo") {
      // The line is a measure the columns are not; with none spare, the last column.
      if (!next.line || next.y.includes(next.line)) {
        next.line =
          numeric.find((name) => !next.y.includes(name)) ??
          (next.y.length > 1 ? next.y.at(-1)! : null)
        next.y = next.y.filter((name) => name !== next.line)
      }
    } else {
      next.line = null
    }
    if (type !== "scatter") next.size = null
    if (!ANALYTIC_TYPES.has(type)) delete next.analytics
    else if (type === "scatter" && next.analytics) {
      next.analytics = { trend: next.analytics.trend, constant: next.analytics.constant, constantLabel: next.analytics.constantLabel }
    } else if (type !== "line" && type !== "area" && next.analytics?.forecast) {
      next.analytics = { ...next.analytics, forecast: undefined }
    }
    if (!DRILLABLE.has(type)) delete next.levels
    if (!FACETABLE.has(type)) next.facet = null
    if (type !== "table" && type !== "pivot") delete next.rules
    if (!STACKABLE.has(type)) {
      next.stacked = false
      next.percent = false
    }
    if (type !== "kpi") next.compare = null
    if (type === "progress") {
      if (!next.target) next.target = numeric.find((name) => !next.y.includes(name)) ?? null
    } else {
      next.target = null
    }
    if (!TAKES_DIRECTION.has(type)) delete next.upIsGood
    onChange(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SimpleSelect
        label="Chart type"
        heading="Chart type"
        value={spec.type}
        items={types}
        onChange={setType}
        className="h-7"
      />
      {TAKES_X.has(spec.type) && (
        <SimpleSelect
          label="Along"
          heading={
            spec.type === "kpi"
              ? "Trend along"
              : spec.type === "pivot"
                ? "Rows"
                : spec.type === "hbar" ||
                    spec.type === "progress" ||
                    spec.type === "pie" ||
                    spec.type === "donut" ||
                    spec.type === "treemap"
                  ? "Categories"
                  : spec.type === "funnel" || spec.type === "waterfall"
                    ? "Steps"
                    : "X axis"
          }
          value={spec.x ?? NONE}
          items={options(
            spec.type === "scatter"
              ? numeric.filter((name) => name !== spec.y[0])
              : data.columns.map((column) => column.name),
            spec.type === "kpi" ? "No trend" : spec.type === "progress" ? "One figure" : null
          )}
          onChange={(x) => onChange({ ...spec, x: x === NONE ? null : x })}
          className="h-7 max-w-40"
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="h-7 text-xs">
              {spec.y.length === 0
                ? spec.type === "table"
                  ? "Shade…"
                  : "Values…"
                : spec.y.length === 1
                  ? spec.y[0]
                  : `${spec.y.length} series`}
              <ChevronDown />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuGroup>
          <DropdownMenuLabel>
            {spec.type === "table" ? "Shaded columns" : single ? "Value" : "Plotted columns"}
          </DropdownMenuLabel>
          {numeric.length === 0 ? (
            <DropdownMenuLabel className="font-normal">
              No numeric columns.
            </DropdownMenuLabel>
          ) : (
            numeric.filter((name) => name !== spec.line).map((name) => {
              const checked = spec.y.includes(name)
              return (
                <DropdownMenuCheckboxItem
                  key={name}
                  checked={checked}
                  disabled={
                    (checked && spec.y.length === 1 && spec.type !== "table") ||
                    (!checked && !single && spec.y.length >= MAX_SERIES)
                  }
                  onCheckedChange={(next) =>
                    onChange({
                      ...spec,
                      // One value where the form takes one; otherwise kept in
                      // the result's column order, so that a column keeps its
                      // colour whichever were ticked first.
                      y: single
                        ? [name]
                        : numeric.filter((item) =>
                            item === name ? next : spec.y.includes(item)
                          ),
                    })
                  }
                >
                  {name}
                </DropdownMenuCheckboxItem>
              )
            })
          )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {TAKES_SERIES.has(spec.type) && !spec.facet && dimensions.length > 0 && (
        <SimpleSelect
          label={spec.type === "scatter" ? "Colour by" : "Split by"}
          heading={spec.type === "scatter" ? "Colour by" : "Split by"}
          value={spec.series ?? NONE}
          items={options(
            dimensions.filter((name) => name !== spec.x),
            spec.type === "pivot" ? null : spec.type === "scatter" ? "One colour" : "No split"
          )}
          onChange={(series) =>
            onChange({
              ...spec,
              series: series === NONE ? null : series,
              y: series === NONE ? spec.y : spec.y.slice(0, 1),
            })
          }
          className="h-7 max-w-40"
        />
      )}
      {STACKABLE.has(spec.type) && seriesCount > 1 && (
        <SimpleSelect
          label="Stacking"
          heading="Series"
          value={spec.percent ? "percent" : spec.stacked ? "stacked" : "side"}
          items={STACK_MODES}
          onChange={(mode) =>
            onChange({ ...spec, stacked: mode !== "side", percent: mode === "percent" })
          }
          leading={<Layers />}
          className="h-7"
        />
      )}
      {spec.type === "combo" && (
        <SimpleSelect
          label="Line"
          heading="Line, on the right axis"
          value={spec.line ?? NONE}
          items={options(
            numeric.filter((name) => !spec.y.includes(name)),
            spec.line ? null : "Choose a column"
          )}
          onChange={(line) => onChange({ ...spec, line: line === NONE ? null : line })}
          className="h-7 max-w-44"
        />
      )}
      {spec.type === "scatter" && (
        <SimpleSelect
          label="Size by"
          heading="Size by"
          value={spec.size ?? NONE}
          items={options(
            numeric.filter((name) => name !== spec.x && !spec.y.includes(name)),
            "One size"
          )}
          onChange={(size) => onChange({ ...spec, size: size === NONE ? null : size })}
          className="h-7 max-w-40"
        />
      )}
      {spec.type === "kpi" && !spec.x && (
        <SimpleSelect
          label="Compare with"
          heading="Compare with"
          value={spec.compare ?? NONE}
          items={options(
            numeric.filter((name) => !spec.y.includes(name)),
            "No comparison"
          )}
          onChange={(compare) =>
            onChange({ ...spec, compare: compare === NONE ? null : compare })
          }
          className="h-7 max-w-44"
        />
      )}
      {spec.type === "progress" && (
        <SimpleSelect
          label="Target"
          heading="Target"
          value={spec.target ?? NONE}
          items={options(
            numeric.filter((name) => !spec.y.includes(name)),
            null
          )}
          onChange={(target) => onChange({ ...spec, target })}
          className="h-7 max-w-44"
        />
      )}
      {FACETABLE.has(spec.type) && !spec.series && !spec.levels?.length && dimensions.length > 0 && (
        <SimpleSelect
          label="Small multiples"
          heading="One small chart per"
          value={spec.facet ?? NONE}
          items={options(
            dimensions.filter((name) => name !== spec.x),
            "One chart"
          )}
          onChange={(facet) => onChange({ ...spec, facet: facet === NONE ? null : facet })}
          leading={<LayoutGrid />}
          className="h-7 max-w-44"
        />
      )}
      {DRILLABLE.has(spec.type) && spec.x && !spec.facet && (
        <DrillMenu
          spec={spec}
          candidates={dimensions.filter((name) => name !== spec.x && name !== spec.series)}
          onChange={onChange}
        />
      )}
      {ANALYTIC_TYPES.has(spec.type) && <AnalyticsMenu spec={spec} onChange={onChange} />}
      {(spec.type === "table" || spec.type === "pivot") && (
        <FormatMenu
          spec={spec}
          columns={spec.type === "pivot" ? spec.y.slice(0, 1) : numeric}
          onChange={onChange}
        />
      )}
      {TAKES_DIRECTION.has(spec.type) && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          title="Whether a rise is shown as good news"
          onClick={() => onChange({ ...spec, upIsGood: !(spec.upIsGood ?? true) })}
        >
          {spec.upIsGood ?? true ? "Up is good" : "Down is good"}
        </Button>
      )}
    </div>
  )
}

/** The columns under x a click drills into, coarse to fine as the result
 * orders them. */
function DrillMenu({
  spec,
  candidates,
  onChange,
}: {
  spec: ChartSpec
  candidates: string[]
  onChange: (spec: ChartSpec) => void
}) {
  const levels = spec.levels ?? []
  if (candidates.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant={levels.length ? "secondary" : "outline"} size="sm" className="h-7 text-xs">
            <ListTree />
            {levels.length ? `Drill: ${[spec.x, ...levels].join(" › ")}` : "Drill down…"}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Levels under {spec.x}</DropdownMenuLabel>
          {candidates.map((name) => (
            <DropdownMenuCheckboxItem
              key={name}
              checked={levels.includes(name)}
              onCheckedChange={(next) => {
                const chosen = candidates.filter((item) =>
                  item === name ? next : levels.includes(item)
                )
                const updated = { ...spec }
                if (chosen.length) updated.levels = chosen
                else delete updated.levels
                onChange(updated)
              }}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Values are summed at each level.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const FORECASTS = [0, 3, 6, 12]

/** Power BI's analytics pane: lines and marks worked out from the values. */
function AnalyticsMenu({
  spec,
  onChange,
}: {
  spec: ChartSpec
  onChange: (spec: ChartSpec) => void
}) {
  const analytics = spec.analytics ?? {}
  const scatter = spec.type === "scatter"
  const forecastable = spec.type === "line" || spec.type === "area"
  const stacked = !!(spec.stacked || spec.percent)
  const set = (patch: ChartAnalytics) => {
    const next: ChartAnalytics = { ...analytics, ...patch }
    for (const key of Object.keys(next) as (keyof ChartAnalytics)[]) {
      if (next[key] === undefined || next[key] === null || next[key] === false || next[key] === 0) {
        delete next[key]
      }
    }
    const updated = { ...spec }
    if (Object.keys(next).length) updated.analytics = next
    else delete updated.analytics
    onChange(updated)
  }
  const count = Object.values(analytics).filter(
    (value) => value !== undefined && value !== null && value !== false && value !== 0 && typeof value !== "string"
  ).length
  const setConstant = async () => {
    const value = await promptText({
      title: "Constant line",
      label: "Value — a goal or a limit",
      initial: analytics.constant == null ? "" : String(analytics.constant),
      action: "Draw",
    })
    if (value === null) return
    const number = Number(value.trim())
    if (value.trim() === "" || !Number.isFinite(number)) return set({ constant: null, constantLabel: null })
    const label = await promptText({
      title: "Constant line",
      label: "Label (optional)",
      initial: analytics.constantLabel ?? "",
      action: "Done",
    })
    set({ constant: number, constantLabel: label?.trim() || null })
  }
  const toggle = (key: "average" | "median" | "trend" | "anomalies", label: string, disabled = false) => (
    <DropdownMenuCheckboxItem
      checked={!!analytics[key]}
      disabled={disabled}
      onCheckedChange={(next) => set({ [key]: next })}
    >
      {label}
    </DropdownMenuCheckboxItem>
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant={count ? "secondary" : "outline"} size="sm" className="h-7 text-xs">
            <ChartSpline />
            {count ? `Analytics · ${count}` : "Analytics"}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {stacked && !scatter ? "Per series — unstack to use these" : "Lines from the data"}
          </DropdownMenuLabel>
          {!scatter && toggle("average", "Average", stacked)}
          {!scatter && toggle("median", "Median", stacked)}
          {toggle("trend", "Trend line", stacked && !scatter)}
          {!scatter && toggle("anomalies", "Mark unusual points", stacked)}
        </DropdownMenuGroup>
        {forecastable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Forecast</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(analytics.forecast ?? 0)}
                onValueChange={(value) => set({ forecast: Number(value) })}
              >
                {FORECASTS.map((periods) => (
                  <DropdownMenuRadioItem key={periods} value={String(periods)} disabled={stacked && periods > 0}>
                    {periods ? `${periods} periods ahead` : "None"}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void setConstant()}>
          {analytics.constant == null
            ? "Constant line…"
            : `Constant line: ${analytics.constantLabel || analytics.constant}`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Conditional formatting: a table's or a pivot's cells marked by value. */
function FormatMenu({
  spec,
  columns,
  onChange,
}: {
  spec: ChartSpec
  columns: string[]
  onChange: (spec: ChartSpec) => void
}) {
  const rules = spec.rules ?? []
  if (columns.length === 0) return null
  const save = (next: CellRule[]) => {
    const updated = { ...spec }
    if (next.length) updated.rules = next
    else delete updated.rules
    onChange(updated)
  }
  const has = (column: string, kind: CellRule["kind"]) =>
    rules.find((rule) => rule.column === column && rule.kind === kind)
  const toggle = (column: string, kind: "bars" | "icons", on: boolean) =>
    save(
      on
        ? [...rules, kind === "bars" ? { column, kind } : { column, kind, upIsGood: spec.upIsGood ?? true }]
        : rules.filter((rule) => !(rule.column === column && rule.kind === kind))
    )
  const threshold = async (column: string, kind: "above" | "below") => {
    const current = has(column, kind)
    const value = await promptText({
      title: `Highlight ${column} ${kind}…`,
      label: `Mark values ${kind} this number (empty to clear)`,
      initial: current && current.kind === kind ? String(current.value) : "",
      action: "Apply",
    })
    if (value === null) return
    const others = rules.filter((rule) => !(rule.column === column && rule.kind === kind))
    const number = Number(value.trim())
    if (value.trim() === "" || !Number.isFinite(number)) return save(others)
    save([...others, { column, kind, value: number, tone: kind === "above" ? "good" : "bad" }])
  }
  const flipTone = (rule: CellRule) =>
    save(
      rules.map((item) =>
        item === rule && item.kind !== "bars" && item.kind !== "icons"
          ? { ...item, tone: item.tone === "good" ? "bad" : "good" }
          : item
      )
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant={rules.length ? "secondary" : "outline"} size="sm" className="h-7 text-xs">
            <Paintbrush />
            {rules.length ? `Format · ${rules.length}` : "Format…"}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        {columns.map((column, index) => {
          const above = has(column, "above")
          const below = has(column, "below")
          return (
            <DropdownMenuGroup key={column}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{column}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={!!has(column, "bars")}
                onCheckedChange={(next) => toggle(column, "bars", next)}
              >
                Data bars
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={!!has(column, "icons")}
                onCheckedChange={(next) => toggle(column, "icons", next)}
              >
                Arrows by sign
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onClick={() => void threshold(column, "above")}>
                {above && above.kind === "above" ? `Above ${above.value}` : "Highlight above…"}
              </DropdownMenuItem>
              {above && (
                <DropdownMenuItem onClick={() => flipTone(above)} className="pl-6 text-muted-foreground">
                  …as {above.kind === "above" && above.tone === "good" ? "good" : "bad"} news (switch)
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => void threshold(column, "below")}>
                {below && below.kind === "below" ? `Below ${below.value}` : "Highlight below…"}
              </DropdownMenuItem>
              {below && (
                <DropdownMenuItem onClick={() => flipTone(below)} className="pl-6 text-muted-foreground">
                  …as {below.kind === "below" && below.tone === "good" ? "good" : "bad"} news (switch)
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Puts a query — drawn as a chart or as a table — on a dashboard. */
export function PinMenu({
  connectionId,
  tile,
  onPinned,
  onError,
}: {
  connectionId: string
  tile: Omit<DashboardTile, "id">
  onPinned?: (title: string) => void
  onError?: (message: string) => void
}) {
  // The whole list is selected and filtered here: a selector that filters
  // returns a new array on every read, which the store takes for a change.
  const allDashboards = useStore((state) => state.dashboards)
  const dashboards = allDashboards.filter(
    (item) => item.connectionId === connectionId
  )
  const pin = useStore((state) => state.pin)
  const openDashboard = useStore((state) => state.openDashboard)

  const pinTo = async (dashboardId: string | null) => {
    let dashboardTitle: string | undefined
    if (!dashboardId) {
      const title = await promptText({
        title: "New dashboard",
        label: "Dashboard name",
        action: "Create",
      })
      if (!title) return
      dashboardTitle = title
    }
    try {
      const dashboard = await pin({
        connectionId,
        dashboardId,
        dashboardTitle,
        tile,
      })
      onPinned?.(dashboard.title)
      openDashboard(connectionId, dashboard.id)
    } catch (error) {
      onError?.(errorMessage(error))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs">
            <Pin />
            Pin to dashboard
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        {dashboards.map((dashboard) => (
          <DropdownMenuItem
            key={dashboard.id}
            onClick={() => void pinTo(dashboard.id)}
          >
            <LayoutDashboard />
            <span className="truncate">{dashboard.title}</span>
          </DropdownMenuItem>
        ))}
        {dashboards.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => void pinTo(null)}>
          <Plus />
          New dashboard…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
