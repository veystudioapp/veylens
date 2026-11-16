import { ChevronDown, Layers, LayoutDashboard, Pin, Plus } from "lucide-react"

import {
  CHART_TYPES,
  MAX_SERIES,
  type ChartSpec,
  type ChartType,
  type DashboardTile,
  type QueryResult,
} from "@shared/api"
import { isNumeric, STACKABLE } from "@shared/chart"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  scatter: "Scatter",
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
  "scatter",
  "funnel",
  "waterfall",
  "kpi",
  "progress",
  "pivot",
])
const TAKES_SERIES = new Set<ChartType>(["bar", "hbar", "line", "area", "scatter", "pivot"])
/** Types that draw one value. */
const SINGLE = new Set<ChartType>(["kpi", "pivot", "scatter", "funnel", "waterfall", "progress"])
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
    if (!STACKABLE.has(type)) next.stacked = false
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
                : spec.type === "hbar" || spec.type === "progress"
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
            numeric.map((name) => {
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
      {TAKES_SERIES.has(spec.type) && dimensions.length > 0 && (
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
        <Button
          variant={spec.stacked ? "secondary" : "outline"}
          size="sm"
          aria-pressed={!!spec.stacked}
          className="h-7 text-xs"
          onClick={() => onChange({ ...spec, stacked: !spec.stacked })}
        >
          <Layers />
          Stacked
        </Button>
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
