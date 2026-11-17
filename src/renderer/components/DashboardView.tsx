import {
  ChartColumn,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileImage,
  FileText,
  GripVertical,
  LayoutDashboard,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  SquarePen,
  Table2,
  Timer,
  Trash2,
  Type,
} from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import {
  isTextTile,
  tileText,
  type Cell,
  type Dashboard,
  type DashboardTile,
  type ParamValues,
  type QueryResult,
  type TileHeight,
} from "@shared/api"
import { filterValueLabel, filterValues, inlineParameters } from "@shared/params"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { downloadCsv, downloadPng, EXPORT_HIDDEN, exportDashboard } from "@/lib/export"
import { errorMessage, useStore, type Tab } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE, toneColor, toneStyle } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { Chart, ResultTable } from "./Chart"
import { confirm } from "./confirm"
import { FilterBar, type CrossFilter } from "./dashboard/FilterBar"
import { FilterDialog } from "./dashboard/FilterDialog"
import { TileEditor } from "./dashboard/TileEditor"
import { IconButton } from "./icon-button"
import { Markdown } from "./Markdown"
import { promptText } from "./prompt"
import { DashboardArt } from "./illustrations"
import { EmptyState, ErrorNote } from "./state-view"

type DashboardTab = Extract<Tab, { kind: "dashboard" }>

type Load =
  | { state: "loading"; previous: QueryResult | null }
  | { state: "done"; result: QueryResult }
  | { state: "failed"; error: string }

const HEIGHT: Record<TileHeight, number> = { s: 150, m: 320, l: 480 }
/** The plot inside a tile of each height, leaving room for title and legend. */
const PLOT: Record<TileHeight, number> = { s: 90, m: 220, l: 370 }

const REFRESH: Record<string, { label: string; short: string }> = {
  "0": { label: "Off", short: "" },
  "60": { label: "Every minute", short: "1m" },
  "300": { label: "Every 5 minutes", short: "5m" },
  "900": { label: "Every 15 minutes", short: "15m" },
}

/** How long ago the tiles were run: "Just now", "4 min ago", then the hour. */
export function updatedAgo(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} min ago`
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** The time, again every `every` ms, for words like "4 min ago". */
function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

/**
 * One control for freshness: when the tiles last ran — click to run them
 * again — and, beside it, how often they run on their own.
 */
function RefreshControl({
  refreshedAt,
  every,
  onRefresh,
  onEvery,
}: {
  refreshedAt: Date
  every: number
  onRefresh: () => void
  onEvery: (seconds: number) => void
}) {
  const now = useNow(30_000)
  const [spin, setSpin] = useState(0)
  const auto = every > 0 ? (REFRESH[String(every)]?.short ?? `${Math.round(every / 60)}m`) : ""
  return (
    <div className="flex h-7 items-center rounded-md border bg-background shadow-xs">
      <button
        type="button"
        title={`Updated ${refreshedAt.toLocaleTimeString()}. Run every tile again.`}
        onClick={() => {
          setSpin((current) => current + 1)
          onRefresh()
        }}
        className="flex h-full items-center gap-1.5 rounded-l-md pr-2 pl-2 text-xs outline-offset-[-2px] hover:bg-accent"
      >
        <RefreshCw
          key={spin}
          className={cn("size-3.5 text-muted-foreground", spin > 0 && "animate-[spin_0.6s_ease-out_1]")}
        />
        <span className="text-muted-foreground">Updated</span>
        <span className="tabular-nums">{updatedAgo(refreshedAt.getTime(), Math.max(now, refreshedAt.getTime()))}</span>
      </button>
      <span aria-hidden className="h-4 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Auto-refresh: ${REFRESH[String(every)]?.label ?? "Off"}`}
              title="Auto-refresh"
              className={cn(
                "flex h-full items-center gap-1 rounded-r-md px-1.5 text-xs outline-offset-[-2px] hover:bg-accent aria-expanded:bg-accent",
                auto ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Timer className="size-3.5" />
              {auto && <span className="font-medium tabular-nums">{auto}</span>}
              <ChevronDown className="size-3 opacity-70" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(every)}
              onValueChange={(value) => onEvery(Number(value))}
            >
              {Object.entries(REFRESH).map(([value, { label }]) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Types whose categories can be clicked to filter the rest. */
const SELECTABLE = new Set([
  "bar",
  "hbar",
  "line",
  "area",
  "combo",
  "pie",
  "donut",
  "treemap",
  "pivot",
  "funnel",
  "waterfall",
  "progress",
])
/** Charts drawn as a picture, which is what a PNG can be made of: figures and
 * tables are text, and are exported as CSV. */
const PICTURED = new Set([
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
])

/** The grid's columns at this width: 4, then 2, then 1. */
function useColumns() {
  const ref = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(4)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const fit = (width: number) => setColumns(width >= 900 ? 4 : width >= 540 ? 2 : 1)
    if (element.clientWidth > 0) fit(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) fit(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, columns] as const
}

/**
 * A note's single line breaks kept as written — a title over its
 * description — rather than run together as Markdown runs a paragraph.
 * Not inside code fences.
 */
function lineBreaks(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, index) => (index % 2 ? part : part.replace(/([^\n])\n(?=[^\n])/g, "$1  \n")))
    .join("")
}

/** The shape of what is coming, while a tile runs for the first time. */
function Placeholder({ kind }: { kind: "figure" | "chart" | "rows" }) {
  if (kind === "figure") {
    return <div className="h-8 w-28 animate-pulse rounded-md bg-muted" aria-label="Loading" />
  }
  if (kind === "rows") {
    return (
      <div className="flex flex-col gap-2.5 pt-1" aria-label="Loading">
        {[100, 92, 96, 88].map((share, index) => (
          <div key={index} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${share}%` }} />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-1 items-end gap-2 pt-4" aria-label="Loading">
      {[45, 70, 55, 85, 60, 95, 75].map((share, index) => (
        <div
          key={index}
          className="flex-1 animate-pulse rounded-t-sm bg-muted"
          style={{ height: `${share}%`, minHeight: 12 * (index + 1) }}
        />
      ))}
    </div>
  )
}

function TileCard({
  tile,
  connectionId,
  params,
  version,
  columns,
  cross,
  dragging,
  onSelect,
  onEdit,
  onChange,
  onDuplicate,
  onRemove,
  onDragStart,
  onDrop,
}: {
  tile: DashboardTile
  connectionId: string
  params: ParamValues
  version: number
  columns: number
  cross: CrossFilter | null
  dragging: string | null
  onSelect: (column: string, value: Cell) => void
  onEdit: () => void
  onChange: (tile: DashboardTile) => void
  onDuplicate: () => void
  onRemove: () => void
  onDragStart: () => void
  onDrop: () => void
}) {
  const openQuery = useStore((state) => state.openQuery)
  const engine = useStore(
    (state) => state.connections.find((item) => item.id === connectionId)?.engine ?? "postgres"
  )
  const [load, setLoad] = useState<Load>({ state: "loading", previous: null })
  const [table, setTable] = useState(false)
  const [over, setOver] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const request = useRef(0)
  const body = useRef<HTMLDivElement>(null)
  const text = isTextTile(tile)
  const paramsKey = JSON.stringify(params)

  useEffect(() => {
    if (text) return
    const id = ++request.current
    // A refresh keeps the last result on screen, dimmed, rather than
    // flashing back to a spinner.
    setLoad((current) => ({
      state: "loading",
      previous: current.state === "done" ? current.result : null,
    }))
    window.veylens
      .runQuery(connectionId, tile.sql, true, params)
      .then((result) => {
        if (id === request.current) setLoad({ state: "done", result })
      })
      .catch((error) => {
        if (id === request.current) {
          setLoad({ state: "failed", error: errorMessage(error) })
        }
      })
    // `params` is followed through its key, so an equal one does not re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tile.sql, paramsKey, version, text])

  const loaded =
    load.state === "done" ? load.result : load.state === "loading" ? load.previous : null
  const spec = tile.chart
  const source = cross?.tileId === tile.id

  // Another tile's selection narrows this one where it has the same column:
  // a breakdown that includes `status` keeps only that status's rows.
  const crossIndex =
    cross && !source && loaded
      ? loaded.columns.findIndex((column) => column.name === cross.column)
      : -1
  const result = useMemo(() => {
    if (!loaded || crossIndex < 0 || !cross) return loaded
    return { ...loaded, rows: loaded.rows.filter((row) => row[crossIndex] === cross.value) }
  }, [loaded, crossIndex, cross])
  const unaffected = !!cross && !source && !!loaded && crossIndex < 0

  const width = Math.min(tile.width ?? 2, columns)
  const height = tile.height ?? "m"
  const selectable = !!spec && !table && SELECTABLE.has(spec.type) && !!spec.x
  const figureOnly =
    !!spec &&
    !table &&
    (spec.type === "kpi" || spec.type === "stat" || (spec.type === "progress" && !spec.x))
  const plotted = !text && !figureOnly
  // Rows scroll inside a tile of its height, rather than stretch the grid.
  const rows = !text && (!spec || table || spec.type === "table")
  const pictured = !!spec && !table && PICTURED.has(spec.type) && !!result?.rows.length

  const openAsQuery = () => {
    try {
      openQuery(connectionId, {
        sql: inlineParameters(tile.sql, params, engine),
        title: tile.title,
        chart: spec ?? undefined,
      })
    } catch (error) {
      setNote(errorMessage(error))
    }
  }

  return (
    <section
      aria-label={tile.title || "Text"}
      onDragOver={(event) => {
        if (!dragging || dragging === tile.id) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        onDrop()
      }}
      // Words and figures take the room they need; only a plot is given a
      // height to fill, or a heading would stand in 320px of nothing.
      style={{
        gridColumn: `span ${width}`,
        minHeight: plotted && !rows ? HEIGHT[height] : undefined,
        height: rows ? HEIGHT[height] : undefined,
      }}
      className={cn(
        "group/tile relative flex min-w-0 flex-col rounded-lg border bg-card shadow-xs transition-[box-shadow,opacity]",
        figureOnly ? "gap-1.5 px-4 pt-3 pb-4" : "gap-3 p-4 pt-3",
        over && "ring-2 ring-ring",
        dragging === tile.id && "opacity-50",
        text && "border-transparent bg-transparent px-1 pt-2 pb-0 shadow-none"
      )}
    >
      <header
        className={cn(
          "flex h-6 items-center gap-1.5",
          // A text tile's words are its title: its controls float over it.
          text &&
            "absolute top-1 right-1 z-10 h-auto rounded-md bg-card/90 opacity-0 group-hover/tile:opacity-100 has-[[aria-expanded=true]]:opacity-100"
        )}
      >
        <span
          draggable
          role="button"
          aria-label="Drag to move"
          title="Drag to move"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move"
            event.dataTransfer.setData("text/plain", tile.id)
            onDragStart()
          }}
          // In the tile's margin, so the title lines up with what is below it.
          className={cn(
            "flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100",
            !text && "absolute top-3.5 left-0",
            EXPORT_HIDDEN
          )}
          tabIndex={0}
        >
          <GripVertical className="size-3.5" />
        </span>
        {!text && (
          <h3
            className={cn(
              "min-w-0 flex-1 truncate",
              // A figure's title is its label, quiet above it; a chart's
              // heads what is below.
              figureOnly
                ? "text-xs font-medium text-muted-foreground"
                : "text-[13px] font-semibold"
            )}
          >
            {tile.title}
          </h3>
        )}
        {load.state === "loading" && loaded && !text && (
          <Spinner className="size-3.5 text-muted-foreground" />
        )}
        {cross && !source && !text && (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-px text-[11px]",
              unaffected ? "text-muted-foreground" : "bg-primary/10 text-primary"
            )}
            title={
              unaffected
                ? `This tile has no "${cross.column}" column, so the selection does not narrow it.`
                : undefined
            }
          >
            {unaffected ? "not filtered" : `by ${cross.column}`}
          </span>
        )}
        {/* Its controls show when it is pointed at, focused, or its menu is
            open — at rest a dashboard shows its numbers, not its buttons. */}
        <span
          className={cn(
            "-mr-1.5 flex items-center",
            EXPORT_HIDDEN,
            !text &&
              "opacity-0 transition-opacity group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 has-[[aria-expanded=true]]:opacity-100"
          )}
        >
        {spec && !text && (
          <IconButton
            label={table ? "Show as chart" : "Show as table"}
            onClick={() => setTable(!table)}
          >
            {table ? <ChartColumn /> : <Table2 />}
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label="Tile actions">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onEdit}>
              <SquarePen />
              Edit tile
            </DropdownMenuItem>
            {!text && (
              <DropdownMenuItem onClick={openAsQuery}>
                <ExternalLink />
                Open as query
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={async () => {
                const title = await promptText({
                  title: "Rename tile",
                  label: "Tile title",
                  initial: tile.title,
                  action: "Rename",
                })
                if (title) onChange({ ...tile, title })
              }}
            >
              <Pencil />
              Rename
            </DropdownMenuItem>
            {!text && result && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => downloadCsv(tile.title, result)}>
                  <Download />
                  Export CSV
                </DropdownMenuItem>
                {pictured && (
                  <DropdownMenuItem
                    onClick={() => {
                      const svg = body.current?.querySelector<SVGSVGElement>('svg[role="img"]')
                      if (!svg) return
                      downloadPng(tile.title, svg).catch((error) =>
                        setNote(errorMessage(error))
                      )
                    }}
                  >
                    <FileImage />
                    Export PNG
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 />
              Remove tile
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </span>
      </header>

      {note && (
        <ErrorNote className="py-1">
          {note}{" "}
          <button type="button" className="underline" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </ErrorNote>
      )}

      <div
        ref={body}
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-opacity",
          load.state === "loading" && loaded && "opacity-50"
        )}
      >
        {text ? (
          <div className="tile-text">
            <Markdown text={lineBreaks(tileText(tile.text ?? ""))} />
          </div>
        ) : load.state === "failed" ? (
          <ErrorNote mono>{load.error}</ErrorNote>
        ) : !result ? (
          <Placeholder kind={figureOnly ? "figure" : spec && !table ? "chart" : "rows"} />
        ) : spec && !table ? (
          <Chart
            spec={spec}
            data={result}
            fill
            height={PLOT[height]}
            limit={height === "l" ? 20 : height === "s" ? 4 : 10}
            titled={!!tile.title.trim()}
            selected={source ? cross!.value : undefined}
            onSelect={
              selectable
                ? (value, column) => onSelect(column ?? spec.x!, value)
                : undefined
            }
          />
        ) : (
          <ResultTable data={result} maxRows={200} bare className="min-h-0 flex-1" />
        )}
      </div>
    </section>
  )
}

export function DashboardView({ tab, active }: { tab: DashboardTab; active: boolean }) {
  const dashboard = useStore((state) =>
    state.dashboards.find((item) => item.id === tab.dashboardId)
  )
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId)
  )
  const dataVersion = useStore((state) => state.dataVersion[tab.connectionId] ?? 0)
  const chatBusy = useStore((state) => state.chat?.busy ?? false)
  const send = useStore((state) => state.send)
  const setDraft = useStore((state) => state.setDraft)
  const openQuery = useStore((state) => state.openQuery)
  const saveDashboard = useStore((state) => state.saveDashboard)
  const deleteDashboard = useStore((state) => state.deleteDashboard)
  const [version, setVersion] = useState(0)
  const [refreshedAt, setRefreshedAt] = useState(() => new Date())
  const [error, setError] = useState<string | null>(null)
  const [cross, setCross] = useState<CrossFilter | null>(null)
  const [editing, setEditing] = useState<DashboardTile | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [grid, columns] = useColumns()
  const sheet = useRef<HTMLDivElement>(null)

  // Data the agent changed is data every tile may show.
  useEffect(() => {
    if (dataVersion) setVersion((current) => current + 1)
  }, [dataVersion])

  useEffect(() => {
    setRefreshedAt(new Date())
  }, [version])

  // While it is on screen, as often as it was asked to.
  const every = dashboard?.refreshSeconds ?? 0
  useEffect(() => {
    if (!active || every <= 0) return
    const timer = setInterval(() => setVersion((current) => current + 1), every * 1000)
    return () => clearInterval(timer)
  }, [active, every])

  const filters = dashboard?.filters
  const params = useMemo(() => filterValues(filters ?? []), [filters])

  if (!dashboard) {
    return (
      <EmptyState icon={<LayoutDashboard />}>This dashboard was deleted.</EmptyState>
    )
  }

  const update = (next: Dashboard) => {
    setError(null)
    return saveDashboard(next).then(
      () => undefined,
      (failure) => {
        setError(errorMessage(failure))
        throw failure
      }
    )
  }
  const quietly = (next: Dashboard) => void update(next).catch(() => {})
  const setTiles = (tiles: DashboardTile[]) => quietly({ ...dashboard, tiles })

  const sourceTile = cross ? dashboard.tiles.find((tile) => tile.id === cross.tileId) : undefined

  const drill = () => {
    if (!cross || !sourceTile?.drillSql || !connection) return
    try {
      openQuery(connection.id, {
        sql: inlineParameters(
          sourceTile.drillSql,
          { ...params, value: cross.value },
          connection.engine
        ),
        title: `${sourceTile.title}: ${cross.value ?? "NULL"}`,
        autoRun: true,
      })
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const summarize = () => {
    const scope = dashboard.filters
      .map((filter) => `${filter.label}: ${filterValueLabel(filter)}`)
      .join("; ")
    void send(
      `Summarise the dashboard "${dashboard.title}"${scope ? ` (${scope})` : ""}: what stands out, what changed against the previous period, and anything that needs attention. Read it with get_dashboard and run its tiles' queries with the current filter values.`
    ).catch((failure) => setError(errorMessage(failure)))
  }

  /** The tiles as they stand, with what they are scoped to written above them. */
  const exportAs = (format: "pdf" | "png") => {
    if (!sheet.current) return
    const scope = [
      connection?.name,
      ...dashboard.filters.map((filter) => `${filter.label}: ${filterValueLabel(filter)}`),
      cross ? `${cross.column} = ${cross.value ?? "NULL"}` : null,
      `as of ${refreshedAt.toLocaleString()}`,
    ].filter(Boolean)
    setError(null)
    exportDashboard(sheet.current, dashboard.title, scope.join(" · "), format).catch((failure) =>
      setError(errorMessage(failure))
    )
  }

  const blankTile = (kind: "query" | "text"): DashboardTile => ({
    id: "",
    title: kind === "text" ? "" : "New tile",
    sql: "",
    chart: null,
    text: kind === "text" ? "" : null,
    width: kind === "text" ? 4 : 2,
    height: kind === "text" ? "s" : "m",
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <IconTile tone={KIND_TONE.dashboard} size="md">
          <LayoutDashboard />
        </IconTile>
        <div className="min-w-0">
          <h2 className="truncate text-sm leading-tight font-semibold">{dashboard.title}</h2>
          <div className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
            {connection && (
              <>
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: toneColor(connectionTone(connection)) }}
                />
                <span className="truncate">{connection.name}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="shrink-0">
              {dashboard.tiles.length} {dashboard.tiles.length === 1 ? "tile" : "tiles"}
            </span>
          </div>
        </div>
        <div className="flex-1" />
        <RefreshControl
          refreshedAt={refreshedAt}
          every={every}
          onRefresh={() => setVersion(version + 1)}
          onEvery={(seconds) => quietly({ ...dashboard, refreshSeconds: seconds })}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={chatBusy || dashboard.tiles.length === 0}
          title={chatBusy ? "The assistant is busy" : "Ask the assistant what stands out"}
          onClick={summarize}
        >
          <Sparkles style={toneStyle("pink")} />
          Summarise
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm">
                <Plus />
                Add tile
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setEditing(blankTile("query"))}>
              <ChartColumn />
              Chart or table
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditing(blankTile("text"))}>
              <Type />
              Text
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label="Dashboard actions">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={async () => {
                const title = await promptText({
                  title: "Rename dashboard",
                  label: "Dashboard name",
                  initial: dashboard.title,
                  action: "Rename",
                })
                if (title) quietly({ ...dashboard, title })
              }}
            >
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={dashboard.tiles.length === 0}
              onClick={() => exportAs("pdf")}
            >
              <FileText />
              Export PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={dashboard.tiles.length === 0}
              onClick={() => exportAs("png")}
            >
              <FileImage />
              Export PNG
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete "${dashboard.title}"?`,
                  description:
                    "The dashboard, its filters and its tiles are removed. The data they show is not touched.",
                  action: "Delete",
                  destructive: true,
                })
                if (ok) void deleteDashboard(dashboard.id)
              }}
            >
              <Trash2 />
              Delete dashboard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* White cards on a grey desk, filters on the desk above them. */}
      <div className="flex min-h-0 flex-1 flex-col bg-muted/50 dark:bg-background">
      <FilterBar
        connectionId={dashboard.connectionId}
        filters={dashboard.filters}
        cross={cross}
        canDrill={!!sourceTile?.drillSql}
        onChange={(filter) =>
          quietly({
            ...dashboard,
            filters: dashboard.filters.map((item) => (item.id === filter.id ? filter : item)),
          })
        }
        onClearCross={() => setCross(null)}
        onDrill={drill}
        onEdit={() => setFiltersOpen(true)}
      />

      {error && <ErrorNote className="mx-4 mt-3">{error}</ErrorNote>}

      <div ref={grid} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {dashboard.tiles.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="flex max-w-sm flex-col items-center text-center">
              <DashboardArt className="mb-5 w-56" />
              <h2 className="text-[13px] font-medium">No tiles yet</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Add one above, pin a chart from the chat or a query tab, or
                have the assistant build it.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() =>
                  setDraft(
                    `Build the dashboard "${dashboard.title}": the key figures for [topic], the trend over the last 12 months, and the breakdown by [dimension].`
                  )
                }
              >
                Ask the assistant
              </Button>
            </div>
          </div>
        ) : (
          <div
            ref={sheet}
            className="grid content-start gap-3 px-4 pt-1 pb-6"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            onDragEnd={() => setDragging(null)}
          >
            {dashboard.tiles.map((tile, index) => (
              <TileCard
                key={tile.id}
                tile={tile}
                connectionId={dashboard.connectionId}
                params={params}
                version={version}
                columns={columns}
                cross={cross}
                dragging={dragging}
                onSelect={(column, value) =>
                  setCross((current) =>
                    current?.tileId === tile.id && current.value === value
                      ? null
                      : { tileId: tile.id, column, value }
                  )
                }
                onEdit={() => setEditing(tile)}
                onChange={(next) =>
                  setTiles(dashboard.tiles.map((item) => (item.id === next.id ? next : item)))
                }
                onDuplicate={() => {
                  const tiles = [...dashboard.tiles]
                  tiles.splice(index + 1, 0, { ...tile, id: "", title: `${tile.title} (copy)` })
                  setTiles(tiles)
                }}
                onRemove={() => {
                  if (cross?.tileId === tile.id) setCross(null)
                  setTiles(dashboard.tiles.filter((item) => item.id !== tile.id))
                }}
                onDragStart={() => setDragging(tile.id)}
                onDrop={() => {
                  if (!dragging || dragging === tile.id) return
                  const moving = dashboard.tiles.find((item) => item.id === dragging)
                  if (!moving) return
                  const rest = dashboard.tiles.filter((item) => item.id !== dragging)
                  const at = rest.findIndex((item) => item.id === tile.id)
                  // Dropped on a tile further down: it goes after it; further
                  // up: before it — where the pointer was heading.
                  const from = dashboard.tiles.findIndex((item) => item.id === dragging)
                  rest.splice(from < index ? at + 1 : at, 0, moving)
                  setDragging(null)
                  setTiles(rest)
                }}
              />
            ))}
          </div>
        )}
      </div>
      </div>

      <TileEditor
        open={editing !== null}
        tile={editing}
        connectionId={dashboard.connectionId}
        params={params}
        onClose={() => setEditing(null)}
        onSave={(tile) => {
          setEditing(null)
          setTiles(
            tile.id
              ? dashboard.tiles.map((item) => (item.id === tile.id ? tile : item))
              : [...dashboard.tiles, tile]
          )
        }}
      />

      <FilterDialog
        open={filtersOpen}
        filters={dashboard.filters}
        connectionId={dashboard.connectionId}
        tiles={dashboard.tiles}
        onClose={() => setFiltersOpen(false)}
        onSave={async (next) => {
          await update({ ...dashboard, filters: next })
        }}
      />
    </div>
  )
}
