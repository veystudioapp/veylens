import {
  ArrowUp,
  AtSign,
  Ban,
  BookOpen,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  ImagePlus,
  LayoutDashboard,
  PanelRightClose,
  Plus,
  Search,
  Sigma,
  Square,
  Table2,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type Ref,
} from "react"

import {
  attachedIn,
  imageTag,
  MAX_IMAGES,
  namedIn,
  withoutTag,
  type ChatImage,
} from "@shared/chat-images"
import {
  chatEfforts,
  isTextTile,
  type ChatItem,
  type Connection,
  type Dashboard,
  type Tone,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { IconTile, KIND_TONE } from "@/lib/tones"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { dataUrlOf, readImages } from "@/lib/images"
import { effortFor, useAgentModels } from "@/lib/models"
import { errorMessage, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

import { Chart, ResultTable } from "./Chart"
import { PinMenu } from "./chart-controls"
import { ChatHistory } from "./ChatHistory"
import { ImageThumb, SentImages } from "./chat-images"
import { IconButton } from "./icon-button"
import { ChatArt } from "./illustrations"
import { Markdown } from "./Markdown"
import { MentionField, MentionText, type MentionFieldHandle } from "./mention-field"
import { ModelMenu } from "./model-menu"
import { ErrorNote } from "./state-view"

type ToolItem = Extract<ChatItem, { kind: "tool" }>
type ChartItem = Extract<ChatItem, { kind: "chart" }>

/** Rows of a result shown in the chat itself; the viewer has the rest. */
const PREVIEW_ROWS = 8

type Preview = {
  columns: string[]
  rows: (string | null)[][]
  row_count: number
  truncated: boolean
}

function parsePreview(output: string | null): Preview | null {
  if (!output?.startsWith("{")) return null
  try {
    const parsed = JSON.parse(output) as Partial<Preview>
    return Array.isArray(parsed.columns) && Array.isArray(parsed.rows)
      ? (parsed as Preview)
      : null
  } catch {
    return null
  }
}

function findConnection(
  connections: Connection[],
  reference: unknown
): Connection | undefined {
  const text = String(reference ?? "")
  return (
    connections.find((item) => item.id === text) ??
    connections.find((item) => item.name.toLowerCase() === text.toLowerCase())
  )
}

/** The dashboard a call names, by id or title, as the store has it. */
function namedDashboard(reference: unknown): Dashboard | undefined {
  const needle = String(reference ?? "").trim()
  const all = useStore.getState().dashboards
  return (
    all.find((item) => item.id === needle) ??
    all.find((item) => item.title.trim().toLowerCase() === needle.toLowerCase())
  )
}

/** A tile by its number in get_dashboard, its id or its title. */
function namedTile(dashboard: Dashboard | undefined, reference: unknown) {
  if (!dashboard) return undefined
  const needle = String(reference ?? "").trim().replace(/^#/, "")
  return (
    dashboard.tiles.find((tile) => tile.id === needle) ??
    (/^\d+$/.test(needle) ? dashboard.tiles[Number(needle) - 1] : undefined) ??
    dashboard.tiles.find((tile) => tile.title.trim().toLowerCase() === needle.toLowerCase())
  )
}

const tileLabel = (tile: Dashboard["tiles"][number] | undefined, reference: unknown) =>
  !tile
    ? `tile ${String(reference ?? "")}`
    : isTextTile(tile)
      ? "a text tile"
      : `"${tile.title}"`

const dashboardLabel = (reference: unknown) =>
  `"${namedDashboard(reference)?.title ?? String(reference ?? "a dashboard")}"`

function toolLabel(item: ToolItem, preview: Preview | null): string {
  const input = item.input
  switch (item.tool) {
    case "list_connections":
      return "Listed connections"
    case "list_tables":
      return "Listed tables"
    case "describe_table":
      return `Inspected ${Array.isArray(input.tables) ? input.tables.join(", ") : "table"}`
    case "run_query":
      return preview
        ? `Ran query · ${preview.row_count}${preview.truncated ? "+" : ""} ${preview.row_count === 1 ? "row" : "rows"}`
        : item.status === "running"
          ? "Running query"
          : "Ran query"
    case "execute_sql":
      return item.status === "denied"
        ? "Statement declined"
        : item.status === "running"
          ? "Running statement"
          : "Ran statement"
    case "execute_plan": {
      const steps = Array.isArray(input.statements) ? input.statements.length : 0
      const what = `${String(input.title ?? "plan")} · ${steps} ${steps === 1 ? "step" : "steps"}`
      return item.status === "denied"
        ? `Plan declined: ${what}`
        : item.status === "running"
          ? `Running plan: ${what}`
          : `Ran plan: ${what}`
    }
    case "show_chart":
      return item.status === "running"
        ? "Drawing chart"
        : `Charted ${String(input.title ?? "")}`.trim()
    case "add_to_dashboard":
      return `Added "${String(input.title ?? "tile")}" to ${String(input.dashboard ?? "a dashboard")}`
    case "add_dashboard_filter":
      return `Added the filter "${String(input.label ?? input.name ?? "")}" to ${dashboardLabel(input.dashboard)}`
    case "get_dashboard":
      return `Read ${dashboardLabel(input.dashboard)}`
    case "edit_dashboard_tile": {
      const dashboard = namedDashboard(input.dashboard)
      const tile = namedTile(dashboard, input.tile)
      return `Edited ${typeof input.title === "string" && input.title.trim() ? `"${input.title.trim()}"` : tileLabel(tile, input.tile)} on ${dashboardLabel(input.dashboard)}`
    }
    case "edit_dashboard":
      return typeof input.title === "string" && input.title.trim()
        ? `Renamed the dashboard to "${input.title.trim()}"`
        : `Set ${dashboardLabel(input.dashboard)} to refresh ${input.refresh_seconds ? `every ${Number(input.refresh_seconds) / 60} min` : "only when asked"}`
    case "remove_from_dashboard": {
      const what = input.filter
        ? `the filter "${String(input.filter)}"`
        : tileLabel(namedTile(namedDashboard(input.dashboard), input.tile), input.tile)
      return item.status === "denied"
        ? `Kept ${what}`
        : item.status === "awaiting"
          ? `Remove ${what}?`
          : `Removed ${what} from ${dashboardLabel(input.dashboard)}`
    }
    case "delete_dashboard":
      return item.status === "denied"
        ? `Kept ${dashboardLabel(input.dashboard)}`
        : item.status === "awaiting"
          ? `Delete ${dashboardLabel(input.dashboard)}?`
          : `Deleted the dashboard ${String(input.dashboard ?? "")}`.trim()
    case "get_business_context":
      return "Read business context"
    case "save_metric":
      return item.status === "denied"
        ? "Metric not saved"
        : `Saved metric "${String(input.name ?? "")}"`
    case "append_note":
      return item.status === "denied" ? "Note not saved" : "Added a note"
    case "open_in_viewer":
      return `Opened ${typeof input.table === "string" ? input.table : typeof input.dashboard === "string" ? input.dashboard : (input.title ?? "query")} in the viewer`
    default:
      return item.tool
  }
}

function Sql({ text }: { text: string }) {
  return (
    <pre className="selectable overflow-x-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  )
}

function ResultPreview({ preview }: { preview: Preview }) {
  const rows = preview.rows.slice(0, PREVIEW_ROWS)
  if (preview.columns.length === 0) return null
  return (
    <div className="selectable overflow-x-auto rounded-md border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="bg-muted text-left">
            {preview.columns.map((column, index) => (
              <th key={index} className="border-b px-2 py-1 font-medium whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td
                  key={cell}
                  className="max-w-52 truncate border-b px-2 py-1 whitespace-nowrap"
                >
                  {value === null ? (
                    <span className="text-muted-foreground/70 italic">NULL</span>
                  ) : (
                    value
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows.length > rows.length && (
        <div className="px-2 py-1 font-sans text-[11px] text-muted-foreground">
          {preview.rows.length - rows.length} more
          {preview.truncated ? ", and the query has more still" : ""} — open it
          in the viewer to see them all.
        </div>
      )}
    </div>
  )
}

function PlanSteps({ statements }: { statements: string[] }) {
  return (
    <ol className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
      {statements.map((statement, index) => (
        <li key={index} className="flex gap-2">
          <span className="w-5 shrink-0 pt-2 text-right text-[11px] text-muted-foreground tabular-nums">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <Sql text={statement} />
          </div>
        </li>
      ))}
    </ol>
  )
}

/** What taking a tile, a filter or a whole dashboard away would take. */
function DashboardRemoval({ item }: { item: ToolItem }) {
  const input = item.input
  const dashboard = useStore((state) => {
    const needle = String(input.dashboard ?? "").trim()
    return (
      state.dashboards.find((entry) => entry.id === needle) ??
      state.dashboards.find((entry) => entry.title.trim().toLowerCase() === needle.toLowerCase())
    )
  })
  const title = dashboard?.title ?? String(input.dashboard ?? "")
  if (item.tool === "delete_dashboard") {
    const tiles = dashboard?.tiles.length ?? 0
    const filters = dashboard?.filters.length ?? 0
    return (
      <>
        <div className="flex items-center gap-2.5 rounded-md border bg-muted/50 px-2.5 py-2">
          <IconTile tone={KIND_TONE.dashboard} size="sm">
            <LayoutDashboard />
          </IconTile>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{title}</div>
            {dashboard && (
              <div className="text-[11px] text-muted-foreground">
                {tiles} {tiles === 1 ? "tile" : "tiles"} · {filters}{" "}
                {filters === 1 ? "filter" : "filters"}
              </div>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The dashboard, its tiles and its filters are deleted, and its tab is
          closed. It cannot be undone.
        </p>
      </>
    )
  }
  if (input.filter) {
    const name = String(input.filter)
    const filter = dashboard?.filters.find(
      (entry) => entry.name === name || entry.label.toLowerCase() === name.toLowerCase()
    )
    return (
      <>
        <div className="rounded-md border bg-muted/50 px-2.5 py-2 text-xs">
          The filter <span className="font-medium">{filter?.label ?? name}</span>
          {filter && <span className="text-muted-foreground"> ({filter.kind.replace("_", " ")})</span>}{" "}
          from <span className="font-medium">{title}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tiles that still read it fail until their SQL is changed.
        </p>
      </>
    )
  }
  const tile = namedTile(dashboard, input.tile)
  return (
    <>
      <div className="flex flex-col gap-1 rounded-md border bg-muted/50 px-2.5 py-2">
        <div className="text-xs">
          <span className="font-medium">
            {tile ? (isTextTile(tile) ? "A text tile" : tile.title) : `Tile ${String(input.tile ?? "")}`}
          </span>{" "}
          <span className="text-muted-foreground">from {title}</span>
        </div>
        {tile && isTextTile(tile) ? (
          <p className="line-clamp-3 text-xs text-muted-foreground">{tile.text}</p>
        ) : tile ? (
          <Sql text={tile.sql} />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">It cannot be undone from here.</p>
    </>
  )
}

/** What an approval card says the call will do. */
function ApprovalBody({ item, engine }: { item: ToolItem; engine?: string }) {
  const input = item.input
  switch (item.tool) {
    case "execute_plan": {
      const statements = Array.isArray(input.statements)
        ? input.statements.map(String)
        : []
      return (
        <>
          {typeof input.summary === "string" && input.summary.trim() && (
            <p className="text-xs leading-relaxed">{input.summary}</p>
          )}
          <PlanSteps statements={statements} />
          <p className="text-xs text-muted-foreground">
            {engine === "mysql"
              ? "Runs in one transaction, but MySQL commits schema changes (CREATE, ALTER, DROP) as each runs: if a later step fails, those stay. It cannot be undone from here."
              : "Runs in one transaction: if any step fails, nothing is changed. It cannot be undone from here."}
          </p>
        </>
      )
    }
    case "save_metric":
      return (
        <>
          <div className="text-[13px] font-medium">{String(input.name ?? "")}</div>
          {typeof input.description === "string" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {input.description}
            </p>
          )}
          <Sql text={String(input.sql ?? "")} />
          <p className="text-xs text-muted-foreground">
            Saved to this connection's metrics, and used from then on whenever
            the figure comes up. A metric of the same name is replaced.
          </p>
        </>
      )
    case "remove_from_dashboard":
    case "delete_dashboard":
      return <DashboardRemoval item={item} />
    case "append_note":
      return (
        <>
          <div className="rounded-md border bg-muted px-2.5 py-2">
            <Markdown text={String(input.text ?? "")} />
          </div>
          <p className="text-xs text-muted-foreground">
            Added to this connection's notes, which the assistant reads before
            working with its data.
          </p>
        </>
      )
    default:
      return (
        <>
          <Sql text={String(input.sql ?? "")} />
          <p className="text-xs text-muted-foreground">
            It changes the database and cannot be undone from here.
          </p>
        </>
      )
  }
}

const APPROVAL_COPY: Record<string, { title: string; action: string }> = {
  execute_sql: { title: "Run this on", action: "Run statement" },
  execute_plan: { title: "Run this plan on", action: "Run plan" },
  save_metric: { title: "Save this metric for", action: "Save metric" },
  append_note: { title: "Add this note to", action: "Add note" },
  remove_from_dashboard: { title: "Remove this from a dashboard on", action: "Remove" },
  delete_dashboard: { title: "Delete this dashboard on", action: "Delete dashboard" },
}

/** The card a call that changes something waits behind until it is answered. */
function Approval({ item, chatId }: { item: ToolItem; chatId: string }) {
  const connections = useStore((state) => state.connections)
  const connection = findConnection(connections, item.input.connection)
  const copy = APPROVAL_COPY[item.tool] ?? APPROVAL_COPY.execute_sql!
  const answer = (allow: boolean) =>
    void window.veydata.answerApproval(chatId, item.id, allow)
  const writes = item.tool === "execute_sql" || item.tool === "execute_plan"
  const removes = item.tool === "remove_from_dashboard" || item.tool === "delete_dashboard"

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        writes ? "border-warning/50 bg-warning/5" : "bg-card"
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {writes ? (
          <TriangleAlert className="size-3.5 text-warning" />
        ) : removes ? (
          <Trash2 className="size-3.5 text-destructive" />
        ) : item.tool === "save_metric" ? (
          <Sigma className="size-3.5 text-muted-foreground" />
        ) : (
          <BookOpen className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate">
          {copy.title} {connection?.name ?? String(item.input.connection)}
          {item.tool === "execute_plan" && typeof item.input.title === "string"
            ? ` — ${item.input.title}`
            : ""}
          ?
        </span>
      </div>
      <ApprovalBody item={item} engine={connection?.engine} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => answer(false)}>
          Decline
        </Button>
        <Button
          size="sm"
          variant={removes ? "destructive" : "default"}
          onClick={() => answer(true)}
        >
          {copy.action}
        </Button>
      </div>
    </div>
  )
}

/** A chart the agent drew, with what it can be turned into. */
function ChartCard({ item }: { item: ChartItem }) {
  const [table, setTable] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const openQuery = useStore((state) => state.openQuery)
  const connectionExists = useStore((state) =>
    state.connections.some((connection) => connection.id === item.connectionId)
  )

  return (
    <figure className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <figcaption className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {item.title}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={table ? "Show as chart" : "Show as table"}
                aria-pressed={table}
                onClick={() => setTable(!table)}
              >
                {table ? <ChartColumn /> : <Table2 />}
              </Button>
            }
          />
          <TooltipContent>{table ? "Show as chart" : "Show as table"}</TooltipContent>
        </Tooltip>
      </figcaption>
      {table ? (
        <ResultTable data={item.result} className="max-h-72" />
      ) : (
        <Chart spec={item.spec} data={item.result} height={200} limit={15} />
      )}
      {item.result.truncated && (
        <p className="text-[11px] text-muted-foreground">
          Drawn from the first {item.result.rows.length} rows only.
        </p>
      )}
      {connectionExists && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              openQuery(item.connectionId, {
                sql: item.sql,
                title: item.title,
                autoRun: true,
                chart: item.spec,
              })
            }
          >
            <ExternalLink />
            Open in viewer
          </Button>
          <PinMenu
            connectionId={item.connectionId}
            tile={{ title: item.title, sql: item.sql, chart: item.spec }}
            onPinned={(title) => setNote(`Pinned to "${title}".`)}
            onError={setNote}
          />
          {note && (
            <span className="text-[11px] text-muted-foreground">{note}</span>
          )}
        </div>
      )}
    </figure>
  )
}

/** What a call is while its input is still being written. */
const WRITING: Record<string, string> = {
  run_query: "Writing a query…",
  execute_sql: "Writing a statement — you will be asked before it runs",
  execute_plan: "Writing a plan — you will be asked before it runs",
  show_chart: "Preparing a chart…",
  add_to_dashboard: "Preparing a tile…",
  add_dashboard_filter: "Preparing a filter…",
  edit_dashboard_tile: "Preparing the change…",
  save_metric: "Writing a metric…",
  append_note: "Writing a note…",
}

/**
 * A call the model is still writing: a second or more for a long statement.
 * Its SQL shows as it comes; the approval card takes its place when done.
 */
function WritingRow({ item }: { item: ToolItem }) {
  const connections = useStore((state) => state.connections)
  const connection = findConnection(connections, item.input.connection)
  const sql =
    typeof item.input.sql === "string"
      ? item.input.sql
      : Array.isArray(item.input.statements)
        ? item.input.statements.map(String).join(";\n\n")
        : ""
  const asks = item.tool === "execute_sql" || item.tool === "execute_plan"
  const box = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [sql])
  return (
    <div
      aria-busy
      aria-label={WRITING[item.tool] ?? "Preparing"}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-2.5 text-xs",
        asks ? "border-warning/40 bg-warning/5" : "bg-card"
      )}
    >
      <div className="flex items-center gap-2">
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {WRITING[item.tool] ?? `Preparing ${item.tool}…`}
        </span>
        {connection && (
          <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground">
            {connection.name}
          </span>
        )}
      </div>
      {sql && (
        <pre
          ref={box}
          className="selectable max-h-48 overflow-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {sql}
          <span className="writing-caret" aria-hidden />
        </pre>
      )}
    </div>
  )
}

function ToolRow({ item, chatId }: { item: ToolItem; chatId: string }) {
  const [open, setOpen] = useState(false)
  const connections = useStore((state) => state.connections)
  const openQuery = useStore((state) => state.openQuery)
  const preview = useMemo(
    () => (item.status === "done" ? parsePreview(item.output) : null),
    [item.output, item.status]
  )

  if (item.status === "awaiting") return <Approval item={item} chatId={chatId} />
  if (item.writing && item.status === "running") return <WritingRow item={item} />
  // The card the chart is drawn in says it all; the row would only repeat it.
  if (item.tool === "show_chart" && item.status === "done") return null

  const sql = typeof item.input.sql === "string" ? item.input.sql : null
  const connection = findConnection(connections, item.input.connection)
  const failed = item.status === "error"

  return (
    <div className="rounded-lg border bg-card text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-accent/50"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {item.status === "running" ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : failed ? (
            <CircleAlert className="size-3.5 text-destructive" />
          ) : item.status === "denied" ? (
            <Ban className="size-3.5 text-muted-foreground" />
          ) : (
            <Check className="size-3.5 text-success" />
          )}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", failed && "text-destructive")}>
          {failed ? `${toolLabel(item, null)} — failed` : toolLabel(item, preview)}
        </span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t p-2.5">
          {sql && <Sql text={sql} />}
          {item.tool === "execute_plan" && Array.isArray(item.input.statements) && (
            <PlanSteps statements={item.input.statements.map(String)} />
          )}
          {preview ? (
            <ResultPreview preview={preview} />
          ) : (
            item.output && (
              <pre
                className={cn(
                  "selectable max-h-56 overflow-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap",
                  failed && "border-destructive/30 text-destructive"
                )}
              >
                {item.output}
              </pre>
            )
          )}
          {sql && connection && item.tool === "run_query" && !failed && (
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() =>
                openQuery(connection.id, { sql, title: "Query", autoRun: true })
              }
            >
              <ExternalLink />
              Open in viewer
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Item({ item, chatId }: { item: ChatItem; chatId: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="selectable ml-8 self-end rounded-md border bg-muted px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
          {item.images && <SentImages names={item.images} />}
          <MentionText text={item.text} images={item.images?.length} />
        </div>
      )
    case "assistant":
      return item.text ? <Markdown text={item.text} /> : null
    case "tool":
      return <ToolRow item={item} chatId={chatId} />
    case "error":
      return <ErrorNote>{item.text}</ErrorNote>
    case "chart":
      return <ChartCard item={item} />
  }
}

/** Put in the field, not sent: the parts in brackets are the user's to fill. */
const DIAGNOSE =
  "Diagnose: why did [metric] change in [this period] compared with [the previous period]?"

type ComposerHandle = {
  /** The pictures among `files`, read and written into the draft. */
  addFiles(files: Iterable<File>): void
}

const NO_IMAGES: ChatImage[] = []

/** Whether a drag carries files — a drag of text is the field's own. */
const carriesFiles = (event: DragEvent) =>
  [...event.dataTransfer.types].includes("Files")

function Composer({ ref }: { ref?: Ref<ComposerHandle> }) {
  const chat = useStore((state) => state.chat)
  const draft = useStore((state) => state.draft)
  const setDraft = useStore((state) => state.setDraft)
  const send = useStore((state) => state.send)
  const model = useStore((state) => state.model)
  const effort = useStore((state) => state.effort)
  const setModel = useStore((state) => state.setModel)
  const models = useAgentModels()

  // Once the CLI has said which levels a model takes, an effort it does not
  // take is not sent: it lands on one the model does, or on none at all.
  useEffect(() => {
    if (model === null) return
    const fitted = effortFor(chatEfforts(models, model), effort)
    if (fitted !== effort) setModel(model, fitted)
  }, [effort, model, models, setModel])
  const agentOk = useStore((state) => state.agent?.ok !== false)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const field = useRef<MentionFieldHandle>(null)
  const busy = chat?.busy ?? false
  /**
   * Every picture added to this draft, in the order it was added: `[Image #n]`
   * is `images[n - 1]`. Never shortened while the draft lives, so a number
   * keeps meaning the same picture after another is taken out.
   */
  const [images, setImages] = useState(NO_IMAGES)
  const held = useRef(images)
  held.current = images
  const pictures = namedIn(text, images)

  function insertImages(added: ChatImage[]) {
    const room = MAX_IMAGES - namedIn(field.current?.element?.value ?? "", held.current).length
    const taken = added.slice(0, Math.max(0, room))
    if (taken.length < added.length) {
      setError(`At most ${MAX_IMAGES} pictures go in one message.`)
    }
    if (!taken.length) return
    const first = held.current.length + 1
    held.current = [...held.current, ...taken]
    setImages(held.current)
    field.current?.insert(taken.map((_, index) => imageTag(first + index)).join(" "))
    field.current?.element?.focus()
  }

  function addFiles(files: Iterable<File>) {
    const list = [...files]
    if (!agentOk || !list.length) return
    void readImages(list).then((read) => {
      if (read.length) {
        setError(null)
        insertImages(read)
      } else {
        setError("Only pictures can be added to a message — PNG, JPEG, GIF or WebP.")
      }
    })
  }

  useImperativeHandle(ref, () => ({ addFiles }))

  /** A picture on the clipboard goes in as one; anything else pasted is the
   * field's own business. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/")
    )
    if (!files.length) return
    event.preventDefault()
    addFiles(files)
  }

  const picker = useRef<HTMLInputElement>(null)

  // Text put here from elsewhere — a quick action, a starter — with its first
  // [blank] selected, ready to be typed over.
  useEffect(() => {
    if (draft === null) return
    setDraft(null)
    setText(draft)
    requestAnimationFrame(() => {
      const element = field.current?.element
      if (!element) return
      element.focus()
      const blank = /\[[^\]]*\]/.exec(draft)
      if (blank) element.setSelectionRange(blank.index, blank.index + blank[0].length)
      else element.setSelectionRange(draft.length, draft.length)
    })
  }, [draft, setDraft])

  // The field grows with what is typed, up to a point.
  useLayoutEffect(() => {
    const element = field.current?.element
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [text])

  const submit = async () => {
    const draftText = text
    const draftImages = images
    const message = attachedIn(text.trim(), images)
    if (!message.text || busy || !chat) return
    setText("")
    setImages(NO_IMAGES)
    setError(null)
    try {
      await send(message.text, message.images)
    } catch (failure) {
      setError(errorMessage(failure))
      setText(draftText)
      setImages(draftImages)
    }
  }

  return (
    <div className="shrink-0 px-3 pb-3">
      {error && <ErrorNote className="mb-2">{error}</ErrorNote>}
      <div className="rounded-lg border border-input bg-background shadow-xs transition-colors focus-within:border-ring dark:bg-input/30">
        {/* The pictures the text still names: a tag deleted by hand takes
            its thumbnail with it, so the strip is the truth about what goes. */}
        {pictures.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Pictures">
            {pictures.map(({ n, image }) => (
              <ImageThumb
                key={n}
                n={n}
                src={dataUrlOf(image)}
                onRemove={() => setText((current) => withoutTag(current, n))}
              />
            ))}
          </div>
        )}
        <MentionField
          ref={field}
          rows={2}
          value={text}
          disabled={!agentOk}
          placeholder="Ask about your data — type @ to mention a table or dashboard…"
          aria-label="Message"
          onValueChange={setText}
          onPaste={paste}
          images={images.length}
          onKeyDown={(event) => {
            // Enter while an input method is composing picks a candidate; it
            // is not the user sending.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void submit()
            }
          }}
          className="placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <ModelMenu
            models={models}
            model={model}
            effort={effort}
            onPick={setModel}
          />
          <IconButton
            label="Mention a table, dashboard, metric or connection (@)"
            className="size-7 text-muted-foreground"
            disabled={!agentOk}
            onClick={() => field.current?.startMention()}
          >
            <AtSign className="size-3.5" />
          </IconButton>
          <IconButton
            label="Add a picture — or paste or drop one"
            className="size-7 text-muted-foreground"
            disabled={!agentOk}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus className="size-3.5" />
          </IconButton>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/*"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.currentTarget.files ?? [])
              // The same file can be picked again.
              event.currentTarget.value = ""
            }}
          />
          <div className="flex-1" />
          {busy ? (
            <IconButton
              label="Stop"
              variant="outline"
              className="size-7 rounded-full"
              onClick={() => chat && void window.veydata.stopChat(chat.id)}
            >
              <Square className="size-2.5 fill-current" />
            </IconButton>
          ) : (
            <IconButton
              label="Send (Enter)"
              variant="default"
              className="size-7 rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={!text.trim() || !agentOk}
              onClick={() => void submit()}
            >
              <ArrowUp className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  )
}

/** Sent as they are; the ones that need filling in are quick actions. */
const SUGGESTIONS = [
  {
    icon: Table2,
    tone: KIND_TONE.table,
    text: "What tables are here, and what is each one for?",
  },
  {
    icon: ChartColumn,
    tone: KIND_TONE.chart,
    text: "Chart the main activity over the last 12 months",
  },
  {
    icon: LayoutDashboard,
    tone: KIND_TONE.dashboard,
    text: "Build a dashboard of the key figures",
  },
] as const

function Suggestion({
  icon,
  tone,
  onClick,
  children,
}: {
  icon: ReactNode
  tone: Tone
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-xs leading-snug transition-colors hover:bg-accent"
    >
      <IconTile tone={tone}>{icon}</IconTile>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

export function ChatPanel({ onCollapse }: { onCollapse: () => void }) {
  const chat = useStore((state) => state.chat)
  const agent = useStore((state) => state.agent)
  const newChat = useStore((state) => state.newChat)
  const send = useStore((state) => state.send)
  const setDraft = useStore((state) => state.setDraft)
  const hasConnections = useStore((state) => state.connections.length > 0)
  const connectionName = useStore(
    (state) =>
      (
        state.connections.find((item) => item.id === state.activeConnectionId) ??
        (state.connections.length === 1 ? state.connections[0] : undefined)
      )?.name
  )
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  /** Enter and leave fire for every child crossed; the drag is over the
   * panel while more have been entered than left. */
  const depth = useRef(0)
  const [dropping, setDropping] = useState(false)
  // Whether the view was at the bottom before this render: only then does
  // new text pull it down, so reading back is not interrupted.
  const pinned = useRef(true)

  const items = chat?.items ?? []
  const last = items.at(-1)

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && (pinned.current || last?.kind === "user")) {
      element.scrollTop = element.scrollHeight
    }
  })

  const waiting =
    !!chat?.busy &&
    !(last?.kind === "assistant" && last.text) &&
    !(last?.kind === "tool" && (last.status === "running" || last.status === "awaiting"))

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 pr-2.5 pl-3.5">
        <span className="drag-region flex h-full min-w-0 flex-1 items-center truncate text-xs font-medium">
          {items.length ? chat?.title : "Assistant"}
        </span>
        <ChatHistory />
        <Button size="xs" variant="ghost" onClick={() => void newChat()}>
          <Plus />
          New chat
        </Button>
        <IconButton label="Hide chat" onClick={onCollapse}>
          <PanelRightClose />
        </IconButton>
      </div>

      <div
        className="sheet relative mr-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg"
        onDragEnter={(event) => {
          if (!carriesFiles(event) || agent?.ok === false) return
          event.preventDefault()
          depth.current += 1
          setDropping(true)
        }}
        onDragOver={(event) => {
          if (!carriesFiles(event) || agent?.ok === false) return
          // Without this the drop is refused, and the window would open the file.
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          if (!carriesFiles(event)) return
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDropping(false)
        }}
        onDrop={(event) => {
          if (!carriesFiles(event)) return
          event.preventDefault()
          depth.current = 0
          setDropping(false)
          composer.current?.addFiles(event.dataTransfer.files)
        }}
      >
        {dropping && (
          <div className="pointer-events-none absolute inset-1.5 z-40 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/50 bg-background/85 text-xs text-muted-foreground backdrop-blur-[1px]">
            <ImagePlus className="size-5 text-primary" />
            Drop pictures to add them to the message
          </div>
        )}
        {agent?.ok === false && (
          <div className="selectable shrink-0 border-b border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-relaxed">
            {agent.error}
          </div>
        )}

        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            pinned.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 60
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {items.length === 0 ? (
            // Anchored above the composer, where the eye already is.
            <div className="flex min-h-full flex-col justify-end px-3.5 pt-8 pb-4">
              <ChatArt className="mb-5 w-44" />
              <h2 className="text-[13px] font-medium">
                {connectionName ? `Ask about ${connectionName}` : "Ask about your data"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {hasConnections
                  ? "It reads the schema, runs read-only SQL and shows what it found. Every change is put to you first."
                  : "Add a connection in the explorer first."}
              </p>
              {hasConnections && agent?.ok !== false && (
                <div className="-mx-1.5 mt-3 flex flex-col">
                  {SUGGESTIONS.map((suggestion) => (
                    <Suggestion
                      key={suggestion.text}
                      icon={<suggestion.icon />}
                      tone={suggestion.tone}
                      onClick={() => void send(suggestion.text)}
                    >
                      {suggestion.text}
                    </Suggestion>
                  ))}
                  <Suggestion
                    icon={<Search />}
                    tone="red"
                    onClick={() => setDraft(DIAGNOSE)}
                  >
                    Diagnose a change…
                  </Suggestion>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 px-3 py-4">
              {items.map((item) => (
                <Item key={item.id} item={item} chatId={chat!.id} />
              ))}
              {waiting && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  <span className="text-shimmer">Working…</span>
                </div>
              )}
            </div>
          )}
        </div>

        <Composer ref={composer} />
      </div>
    </div>
  )
}
