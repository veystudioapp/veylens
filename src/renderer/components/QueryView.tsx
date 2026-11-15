import {
  BookOpen,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  Database,
  Gauge,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Table2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react"
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useDefaultLayout } from "react-resizable-panels"

import type {
  AssistMode,
  AssistResult,
  ChartSpec,
  QueryResult,
} from "@shared/api"
import { chartProblem, inferChart } from "@shared/chart"
import { defaultSchemaOf, judge } from "@shared/permissions"
import { errorRange, splitErrorOffset } from "@shared/sql-errors"
import { startsLikeRead } from "@shared/statements"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage, useStore, type Tab } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { Chart } from "./Chart"
import { confirm } from "./confirm"
import { ChartControls, PinMenu } from "./chart-controls"
import { DataGrid } from "./DataGrid"
import { Markdown } from "./Markdown"
import { EmptyState, ErrorNote, Loading } from "./state-view"
import { SqlText } from "./sql-code"
import { SqlEditor, type SqlEditorCursor, type SqlEditorHandle } from "./sql-editor"

type QueryTab = Extract<Tab, { kind: "query" }>

type Run =
  | { state: "idle" }
  | { state: "running"; plan: boolean; since: number }
  | { state: "done"; result: QueryResult; plan: boolean }
  | { state: "failed"; error: string; sql: string }

type Assisting =
  | { state: "idle" }
  | { state: "asking" }
  | { state: "running"; mode: AssistMode; requestId: string }
  | { state: "done"; mode: AssistMode; answer: AssistResult }
  | { state: "failed"; error: string }

function summary(result: QueryResult, plan: boolean): string {
  const time = `${result.ms.toLocaleString()} ms`
  if (plan) return `Query plan — nothing was run · ${time}`
  if (result.columns.length === 0) {
    const rows =
      result.affected === null
        ? ""
        : ` — ${result.affected.toLocaleString()} ${result.affected === 1 ? "row" : "rows"} affected`
    return `${result.command ?? "Done"}${rows} · ${time}`
  }
  const count = result.rows.length.toLocaleString()
  return result.truncated
    ? `First ${count} rows (there are more — add a LIMIT or a filter) · ${time}`
    : `${count} ${result.rows.length === 1 ? "row" : "rows"} · ${time}`
}

const ASSIST_LABEL: Record<AssistMode, string> = {
  generate: "Writing SQL",
  explain: "Explaining",
  fix: "Fixing",
}

/** Where the height an answer was dragged to is kept, for every SQL tab. */
const ANSWER_HEIGHT_KEY = "veylens.queryAnswerHeight"
const ANSWER_HEIGHT = 200
const ANSWER_MIN = 64
/** What an answer leaves of the result below it, at least. */
const RESULT_MIN = 96

/** A line to drag, or to move with ↑ and ↓, that sets the height of what is
 * above it. Drawn as the panels' own handle is. */
function RowResizer({
  label,
  height,
  onChange,
}: {
  label: string
  height: number
  onChange: (height: number) => void
}) {
  const drag = useRef<{ y: number; height: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Kept between the least and what leaves the result room. */
  const fit = (element: HTMLElement, next: number) => {
    const room = (element.parentElement?.clientHeight ?? Infinity) - RESULT_MIN
    return Math.round(Math.max(ANSWER_MIN, Math.min(next, room)))
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={height}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title="Drag to resize; double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { y: event.clientY, height }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        onChange(fit(event.currentTarget, drag.current.height + event.clientY - drag.current.y))
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={(event) => onChange(fit(event.currentTarget, ANSWER_HEIGHT))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault()
          onChange(fit(event.currentTarget, height + (event.key === "ArrowUp" ? -step : step)))
        }
      }}
      className="relative h-px w-full shrink-0 cursor-row-resize bg-border outline-none after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2 hover:bg-ring/60 focus-visible:bg-ring data-dragging:bg-ring"
    />
  )
}

/** The editor's helper: a request line, then what came back. */
function AssistPanel({
  assisting,
  onAsk,
  onCancel,
  onClose,
  onUse,
}: {
  assisting: Assisting
  onAsk: (instruction: string) => void
  onCancel: () => void
  onClose: () => void
  onUse: (sql: string) => void
}) {
  const [instruction, setInstruction] = useState("")
  const [height, setHeight] = useState(
    () => Number(localStorage.getItem(ANSWER_HEIGHT_KEY)) || ANSWER_HEIGHT
  )
  useEffect(() => {
    localStorage.setItem(ANSWER_HEIGHT_KEY, String(height))
  }, [height])
  if (assisting.state === "idle") return null
  // An answer is read at a length of one's own choosing; the request line
  // and the spinner are one line, and stay it.
  const sized = assisting.state === "done"

  return (
    <>
      <div
        className={cn(
          "flex shrink-0 flex-col gap-2 overflow-y-auto bg-muted/40 px-3 py-2.5",
          sized ? "max-h-[calc(100%-6rem)]" : "max-h-[45%] border-b"
        )}
        style={sized ? { height } : undefined}
      >
        {assisting.state === "asking" && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (instruction.trim()) onAsk(instruction.trim())
            }}
          >
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Describe the result you want — e.g. revenue per month this year, by channel"
              aria-label="Describe the query"
              className="h-7 text-xs md:text-xs"
            />
            <Button type="submit" size="sm" disabled={!instruction.trim()}>
              Generate
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </form>
        )}

        {assisting.state === "running" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            <span className="text-shimmer">{ASSIST_LABEL[assisting.mode]}…</span>
            <div className="flex-1" />
            <Button variant="ghost" size="xs" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}

        {assisting.state === "failed" && (
          <div className="flex items-start gap-2">
            <ErrorNote className="flex-1">{assisting.error}</ErrorNote>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
        )}

        {assisting.state === "done" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-[13px]">
                <Markdown text={assisting.answer.text} />
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <X />
              </Button>
            </div>
            {assisting.answer.sql && (
              <>
                <pre className="selectable overflow-x-auto rounded-md border bg-background px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  <SqlText text={assisting.answer.sql} />
                </pre>
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() => onUse(assisting.answer.sql!)}
                >
                  Use this SQL
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {sized && <RowResizer label="Resize the answer" height={height} onChange={setHeight} />}
    </>
  )
}

export function QueryView({ tab, active }: { tab: QueryTab; active: boolean }) {
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId)
  )
  const access = connection?.access ?? "read_write"
  const setTabSql = useStore((state) => state.setTabSql)
  const model = useStore((state) => state.model)
  const effort = useStore((state) => state.effort)
  const [sql, setSql] = useState(tab.sql)
  const [run, setRun] = useState<Run>({ state: "idle" })
  const [assisting, setAssisting] = useState<Assisting>({ state: "idle" })
  // A statement the agent put here is run read-only until somebody edits it:
  // from then on it is the user's own.
  const [readOnly, setReadOnly] = useState(tab.autoRun)
  // Read by the editor's ⌘↵, which is bound once.
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const [view, setView] = useState<"grid" | "chart">(tab.chart ? "chart" : "grid")
  const [spec, setSpec] = useState<ChartSpec | null>(tab.chart ?? null)
  const [pinNote, setPinNote] = useState<string | null>(null)
  const editor = useRef<SqlEditorHandle>(null)
  const request = useRef(0)
  const [cursor, setCursor] = useState<SqlEditorCursor>({ line: 1, column: 1, selected: 0 })
  /** Where the last run's error points, until the SQL is edited. */
  const [errorMark, setErrorMark] = useState<{ from: number; to: number; message: string } | null>(null)
  const latestSql = useRef(sql)
  latestSql.current = sql
  const upperCaseKeywords = useStore((state) => state.ai.keywordCase !== "lower")
  // The editor's share of the tab, the same in every SQL tab and kept.
  const layout = useDefaultLayout({ id: "query-split", storage: localStorage })

  /** What a run or a dry run is about: the selection, when there is one. */
  const chosen = (text: string) => {
    const range = editor.current?.selection()
    return range && range.from !== range.to ? text.slice(range.from, range.to) : text
  }

  const execute = useCallback(
    async (text: string, asReadOnly: boolean, plan = false) => {
      const range = editor.current?.selection()
      const start = range && range.from !== range.to ? range.from : 0
      const statement = range && range.from !== range.to ? text.slice(range.from, range.to) : text
      if (!statement.trim()) return
      setErrorMark(null)
      const writes = !plan && !startsLikeRead(statement)
      if (writes && access === "read_only") {
        setRun({
          state: "failed",
          error: `${connection?.name ?? "This connection"} is read-only in Vey Lens, so only reads run here (SELECT, WITH, SHOW, EXPLAIN).`,
          sql: statement,
        })
        return
      }
      // The connection's permissions, read off the statement: what they
      // block is refused here before it is sent (and again in the main
      // process); what they ask about is asked.
      const verdict =
        connection && !plan && !asReadOnly
          ? judge(statement, {
              permissions: connection.permissions,
              access,
              engine: connection.engine,
              defaultSchema: defaultSchemaOf(connection),
            })
          : null
      if (verdict?.rule === "block") {
        setRun({
          state: "failed",
          error: `Refused by the permissions of ${connection?.name ?? "this connection"}: ${verdict.reasons.join(" ")} They are set in Settings › Permissions.`,
          sql: statement,
        })
        return
      }
      if (writes && verdict?.rule === "ask") {
        const shown = statement.trim()
        const ok = await confirm({
          title: `Run this on ${connection?.name ?? "this connection"}?`,
          description:
            (shown.length > 600 ? `${shown.slice(0, 600)}…` : shown) +
            `\n\n${verdict.reasons.join("\n")}`,
          action: "Run statement",
          destructive: verdict.kinds.includes("delete") || verdict.kinds.includes("ddl"),
        })
        if (!ok) return
      }
      const id = ++request.current
      setRun({ state: "running", plan, since: Date.now() })
      setPinNote(null)
      try {
        const result = plan
          ? await window.veylens.explainQuery(tab.connectionId, statement)
          : await window.veylens.runQuery(
              tab.connectionId,
              statement,
              asReadOnly || access === "read_only"
            )
        if (id !== request.current) return
        setRun({ state: "done", result, plan })
        // The chart follows the result: kept while it still fits, guessed
        // afresh when it does not.
        if (!plan) {
          setSpec((current) =>
            current && !chartProblem(current, result) ? current : inferChart(result)
          )
        }
      } catch (failure) {
        if (id === request.current) {
          const error = errorMessage(failure)
          setRun({ state: "failed", error, sql: statement })
          const { offset } = splitErrorOffset(failure instanceof Error ? failure.message : String(failure))
          const range = offset === null ? null : errorRange(text, start + offset)
          // Not on SQL that was changed while it ran.
          if (range && latestSql.current === text) setErrorMark({ ...range, message: error })
        }
      }
    },
    [access, connection?.name, tab.connectionId]
  )

  // Once, when the tab was opened with a statement to show.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (tab.autoRun && tab.sql.trim()) void execute(tab.sql, true)
    else editor.current?.focus()
  }, [execute, tab.autoRun, tab.sql])

  useEffect(() => {
    if (active && !tab.autoRun) editor.current?.focus()
  }, [active, tab.autoRun])

  const setEditor = (text: string) => {
    setErrorMark(null)
    setSql(text)
    setTabSql(tab.id, text)
    setReadOnly(false)
  }

  const assist = async (mode: AssistMode, instruction?: string) => {
    const requestId = crypto.randomUUID()
    setAssisting({ state: "running", mode, requestId })
    try {
      const answer = await window.veylens.assistSql({
        requestId,
        connectionId: tab.connectionId,
        mode,
        sql: mode === "generate" ? sql : chosen(sql),
        instruction,
        error: run.state === "failed" ? run.error : undefined,
        model,
        effort,
      })
      setAssisting((current) =>
        current.state === "running" && current.requestId === requestId
          ? { state: "done", mode, answer }
          : current
      )
    } catch (failure) {
      setAssisting((current) =>
        current.state === "running" && current.requestId === requestId
          ? { state: "failed", error: errorMessage(failure) }
          : current
      )
    }
  }

  const result = run.state === "done" && !run.plan ? run.result : null
  const chartable = !!result && result.columns.length > 0 && spec !== null
  const busy = run.state === "running"
  const thinking = assisting.state === "running"
  const selected = cursor.selected > 0
  const tone = connection ? connectionTone(connection) : "gray"

  return (
    <div className="flex h-full flex-col">
      {/* What to do, then where it is done. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Button
          size="sm"
          disabled={busy || !sql.trim()}
          onClick={() => void execute(sql, readOnly)}
          className="pr-1.5"
        >
          {busy && !run.plan ? <Spinner className="size-3.5" /> : <Play />}
          {selected ? "Run selection" : "Run"}
          <Kbd onPrimary>{MOD}↵</Kbd>
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !sql.trim()}
                onClick={() => void execute(sql, true, true)}
              >
                {busy && run.plan ? <Spinner className="size-3.5" /> : <Gauge />}
                Dry run
              </Button>
            }
          />
          <TooltipContent>
            How the server would run it, without running it · {MOD}⇧↵
          </TooltipContent>
        </Tooltip>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          disabled={thinking}
          onClick={() => setAssisting({ state: "asking" })}
        >
          <Sparkles />
          Generate
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={thinking || !sql.trim()}
          onClick={() => void assist("explain")}
        >
          <BookOpen />
          {selected ? "Explain selection" : "Explain"}
        </Button>
        <div className="flex-1" />
        {(readOnly || access === "read_only") && (
          <Badge
            icon={<Lock />}
            title={
              access === "read_only"
                ? "This connection is read-only in Vey Lens: only reads run."
                : "Opened by the assistant, so it runs in a read-only transaction. Editing it makes it yours."
            }
          >
            {access === "read_only" ? "Read-only" : "Runs read-only"}
          </Badge>
        )}
        {access === "confirm" && !readOnly && (
          <Badge icon={<ShieldCheck />} title="Statements that change data ask before they run.">
            Confirm writes
          </Badge>
        )}
        <span
          className="ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
          title={connection ? `${connection.engine === "postgres" ? "PostgreSQL" : "MySQL"} · ${connection.name}` : undefined}
        >
          <IconTile tone={tone} size="xs">
            <Database />
          </IconTile>
          <span className="max-w-48 truncate font-medium">
            {connection?.name ?? "A removed connection"}
          </span>
        </span>
      </div>

      <ResizablePanelGroup
        orientation="vertical"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="editor" defaultSize="40" minSize={72}>
          <div className="relative h-full overflow-hidden">
            <SqlEditor
              ref={editor}
              value={sql}
              onChange={setEditor}
              onCursor={setCursor}
              onRun={() => void execute(latestSql.current, readOnlyRef.current)}
              onPlan={() => void execute(latestSql.current, true, true)}
              connectionId={tab.connectionId}
              engine={connection?.engine ?? "postgres"}
              defaultSchema={connection ? defaultSchemaOf(connection) : "public"}
              upperCaseKeywords={upperCaseKeywords}
              error={errorMark}
              placeholder={"SELECT *\n  FROM …\n LIMIT 100"}
              label="SQL"
            />
            <span className="pointer-events-none absolute right-2 bottom-1.5 z-10 rounded bg-background/85 px-1.5 text-[11px] text-muted-foreground tabular-nums">
              {selected
                ? `${cursor.selected.toLocaleString()} selected`
                : `Ln ${cursor.line}, Col ${cursor.column}`}
            </span>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel id="result" minSize={120}>
          <div className="flex h-full flex-col">
            <AssistPanel
              assisting={assisting}
              onAsk={(instruction) => void assist("generate", instruction)}
              onCancel={() => {
                if (assisting.state === "running") {
                  void window.veylens.cancelAssist(assisting.requestId)
                }
                setAssisting({ state: "idle" })
              }}
              onClose={() => setAssisting({ state: "idle" })}
              onUse={(text) => {
                setEditor(text)
                setAssisting({ state: "idle" })
                editor.current?.focus()
              }}
            />

            {run.state !== "idle" && (
              <div className="flex h-9 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2">
                {result && result.columns.length > 0 && (
                  <>
                    <Segmented
                      label="Show as"
                      value={view}
                      onChange={setView}
                      options={[
                        { value: "grid", label: <><Table2 />Grid</> },
                        {
                          value: "chart",
                          label: <><ChartColumn />Chart</>,
                          disabled: !spec,
                          title: spec ? undefined : "Nothing in this result is numeric",
                        },
                      ]}
                    />
                  </>
                )}
                <div className="flex-1" />
                <RunStatus run={run} />
                {pinNote && (
                  <span className="truncate text-[11px] text-muted-foreground">{pinNote}</span>
                )}
                {result && result.columns.length > 0 && (
                  <PinMenu
                    connectionId={tab.connectionId}
                    tile={{
                      title: tab.title,
                      sql: chosen(sql).trim() || tab.sql,
                      chart: view === "chart" ? spec : null,
                    }}
                    onPinned={(title) => setPinNote(`Pinned to "${title}".`)}
                    onError={setPinNote}
                  />
                )}
              </div>
            )}

            {/* The chart's settings on a row of their own, as high as they
                wrap to: a narrow pane takes them on two lines. */}
            {result && result.columns.length > 0 && view === "chart" && spec && (
              <div className="shrink-0 border-b px-2 py-1.5">
                <ChartControls spec={spec} data={result} onChange={setSpec} />
              </div>
            )}

            <div className="min-h-0 flex-1">
              {run.state === "failed" ? (
                <div className="flex flex-col gap-2 p-3">
                  <ErrorNote mono>{run.error}</ErrorNote>
                  <div className="flex gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={thinking}
                      onClick={() => void assist("fix")}
                    >
                      <Wrench />
                      Fix with AI
                    </Button>
                  </div>
                </div>
              ) : run.state === "done" && view === "chart" && chartable && !run.plan ? (
                <div className="h-full overflow-auto p-4">
                  <Chart spec={spec!} data={result!} height={360} limit={200} large />
                </div>
              ) : run.state === "done" && run.result.columns.length > 0 ? (
                <DataGrid columns={run.result.columns} rows={run.result.rows} />
              ) : run.state === "done" ? (
                <EmptyState icon={<CircleCheck />}>{summary(run.result, run.plan)}</EmptyState>
              ) : run.state === "running" ? (
                <Loading />
              ) : (
                <Ready onGenerate={() => setAssisting({ state: "asking" })} />
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"

/** A key, as the keyboard has it. */
function Kbd({ children, onPrimary }: { children: ReactNode; onPrimary?: boolean }) {
  return (
    <kbd
      className={cn(
        "ml-0.5 inline-flex h-4.5 items-center rounded px-1 font-sans text-[10px] font-medium",
        onPrimary
          ? "bg-primary-foreground/20 text-primary-foreground"
          : "border bg-background text-muted-foreground"
      )}
    >
      {children}
    </kbd>
  )
}

/** A setting of the tab's that changes what runs, said in passing. */
function Badge({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className="flex h-6 shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 text-[11px] text-muted-foreground [&_svg]:size-3"
    >
      {icon}
      {children}
    </span>
  )
}

/** Two or three ways to see the same thing, as the rest of the app draws them. */
function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: { value: Value; label: ReactNode; disabled?: boolean; title?: string }[]
  onChange: (value: Value) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-6 items-center justify-center gap-1 rounded-[5px] px-2 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground [&_svg]:size-3.5",
            option.value === value && "bg-background font-medium text-foreground shadow-xs"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** How the last run went, at the head of its result. */
function RunStatus({ run }: { run: Run }) {
  if (run.state === "running") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        {run.plan ? "Asking for the plan…" : "Running…"}
        <Elapsed since={run.since} />
      </span>
    )
  }
  if (run.state === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive">
        <CircleAlert className="size-3.5" />
        Failed
      </span>
    )
  }
  if (run.state !== "done") return null
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs tabular-nums",
        run.result.truncated ? "text-warning" : "text-muted-foreground"
      )}
    >
      {run.plan ? (
        <Gauge className="size-3.5 shrink-0" />
      ) : run.result.truncated ? (
        <TriangleAlert className="size-3.5 shrink-0" />
      ) : (
        <CircleCheck className="size-3.5 shrink-0 text-success" />
      )}
      <span className="truncate">{summary(run.result, run.plan)}</span>
    </span>
  )
}

/** Seconds since, ticking. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{((now - since) / 1000).toFixed(1)} s</span>
}

/** Before anything has run: what can be done, and the keys for it. */
function Ready({ onGenerate }: { onGenerate: () => void }) {
  const keys: [string, string][] = [
    [`${MOD}↵`, "Run — or only the selected text"],
    [`${MOD}⇧↵`, "Dry run: the plan, nothing run"],
    [`${MOD}/`, "Comment lines in or out"],
    ["Tab", "Indent; ⇧Tab outdents"],
  ]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <IconTile tone={KIND_TONE.query} size="md">
          <SquareTerminal />
        </IconTile>
        <p className="text-[13px] font-medium">Write a query, then run it</p>
        <p className="max-w-72 text-xs text-muted-foreground">
          Its result shows here, as a grid or a chart, and can be pinned to a dashboard.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        {keys.map(([key, what]) => (
          <Fragment key={key}>
            <dt className="justify-self-end">
              <Kbd>{key}</Kbd>
            </dt>
            <dd className="text-muted-foreground">{what}</dd>
          </Fragment>
        ))}
      </dl>
      <Button variant="outline" size="sm" onClick={onGenerate}>
        <Sparkles />
        Describe it instead
      </Button>
    </div>
  )
}
