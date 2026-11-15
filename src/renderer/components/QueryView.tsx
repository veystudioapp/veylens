import {
  BookOpen,
  ChartColumn,
  Gauge,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
  Table2,
  Wrench,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import type {
  AssistMode,
  AssistResult,
  ChartSpec,
  QueryResult,
} from "@shared/api"
import { chartProblem, inferChart } from "@shared/chart"
import { defaultSchemaOf, judge } from "@shared/permissions"
import { startsLikeRead } from "@shared/statements"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage, useStore, type Tab } from "@/lib/store"
import { cn } from "@/lib/utils"

import { Chart } from "./Chart"
import { confirm } from "./confirm"
import { ChartControls, PinMenu } from "./chart-controls"
import { DataGrid } from "./DataGrid"
import { Markdown } from "./Markdown"
import { EmptyState, ErrorNote, Loading } from "./state-view"

type QueryTab = Extract<Tab, { kind: "query" }>

type Run =
  | { state: "idle" }
  | { state: "running"; plan: boolean }
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
  if (assisting.state === "idle") return null

  return (
    <div className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b bg-muted/40 px-3 py-2.5">
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
                {assisting.answer.sql}
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
  const [view, setView] = useState<"grid" | "chart">(tab.chart ? "chart" : "grid")
  const [spec, setSpec] = useState<ChartSpec | null>(tab.chart ?? null)
  const [pinNote, setPinNote] = useState<string | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const request = useRef(0)

  /** What a run or a dry run is about: the selection, when there is one. */
  const chosen = (text: string) => {
    const area = editor.current
    return area && area.selectionStart !== area.selectionEnd
      ? text.slice(area.selectionStart, area.selectionEnd)
      : text
  }

  const execute = useCallback(
    async (text: string, asReadOnly: boolean, plan = false) => {
      const area = editor.current
      const statement =
        area && area.selectionStart !== area.selectionEnd
          ? text.slice(area.selectionStart, area.selectionEnd)
          : text
      if (!statement.trim()) return
      const writes = !plan && !startsLikeRead(statement)
      if (writes && access === "read_only") {
        setRun({
          state: "failed",
          error: `${connection?.name ?? "This connection"} is read-only in Vey Data, so only reads run here (SELECT, WITH, SHOW, EXPLAIN).`,
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
      setRun({ state: "running", plan })
      setPinNote(null)
      try {
        const result = plan
          ? await window.veydata.explainQuery(tab.connectionId, statement)
          : await window.veydata.runQuery(
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
          setRun({ state: "failed", error: errorMessage(failure), sql: statement })
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
    setSql(text)
    setTabSql(tab.id, text)
    setReadOnly(false)
  }

  const assist = async (mode: AssistMode, instruction?: string) => {
    const requestId = crypto.randomUUID()
    setAssisting({ state: "running", mode, requestId })
    try {
      const answer = await window.veydata.assistSql({
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[32%] min-h-28 shrink-0 flex-col border-b">
        <textarea
          ref={editor}
          value={sql}
          spellCheck={false}
          placeholder="SELECT …   (⌘↵ to run; select text to run only that)"
          aria-label="SQL"
          onChange={(event) => setEditor(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              void execute(sql, readOnly)
            }
          }}
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-t bg-muted/40 px-2">
          <Button
            size="sm"
            disabled={busy || !sql.trim()}
            onClick={() => void execute(sql, readOnly)}
          >
            {busy && !run.plan ? <Spinner className="size-3.5" /> : <Play />}
            Run
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !sql.trim()}
            title="Ask the server how it would run this, without running it"
            onClick={() => void execute(sql, true, true)}
          >
            {busy && run.plan ? <Spinner className="size-3.5" /> : <Gauge />}
            Dry run
          </Button>
          <span className="mx-0.5 h-4 w-px bg-border" />
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
            Explain
          </Button>
          {run.state === "failed" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={thinking}
              onClick={() => void assist("fix")}
            >
              <Wrench />
              Fix
            </Button>
          )}
          <span className="ml-1 truncate text-xs text-muted-foreground">
            on {connection?.name ?? "a removed connection"}
          </span>
          {(readOnly || access === "read_only") && (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title={
                access === "read_only"
                  ? "This connection is read-only in Vey Data: only reads run."
                  : "Opened by the assistant, so it runs in a read-only transaction. Editing it makes it yours."
              }
            >
              <Lock className="size-3" />
              {access === "read_only" ? "read-only connection" : "read-only"}
            </span>
          )}
          {access === "confirm" && !readOnly && (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title="Statements that change data ask before they run."
            >
              <ShieldCheck className="size-3" />
              confirm writes
            </span>
          )}
          <div className="flex-1" />
          {run.state === "done" && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {summary(run.result, run.plan)}
            </span>
          )}
        </div>
      </div>

      <AssistPanel
        assisting={assisting}
        onAsk={(instruction) => void assist("generate", instruction)}
        onCancel={() => {
          if (assisting.state === "running") {
            void window.veydata.cancelAssist(assisting.requestId)
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

      {result && result.columns.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
          <div role="group" aria-label="Show as" className="flex rounded-md border p-0.5">
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <Table2 />
              Grid
            </Button>
            <Button
              variant={view === "chart" ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={view === "chart"}
              disabled={!spec}
              title={spec ? undefined : "Nothing in this result is numeric"}
              onClick={() => setView("chart")}
            >
              <ChartColumn />
              Chart
            </Button>
          </div>
          {view === "chart" && spec && (
            <ChartControls spec={spec} data={result} onChange={setSpec} />
          )}
          <div className="flex-1" />
          {pinNote && (
            <span className="truncate text-[11px] text-muted-foreground">{pinNote}</span>
          )}
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
        </div>
      )}

      <div className="min-h-0 flex-1">
        {run.state === "failed" ? (
          <ErrorNote mono className="m-3">
            {run.error}
          </ErrorNote>
        ) : run.state === "done" && view === "chart" && chartable && !run.plan ? (
          <div className={cn("h-full overflow-auto p-4")}>
            <Chart spec={spec!} data={result!} height={360} limit={200} large />
          </div>
        ) : run.state === "done" && run.result.columns.length > 0 ? (
          <DataGrid columns={run.result.columns} rows={run.result.rows} />
        ) : run.state === "done" ? (
          <EmptyState icon={<Play />}>{summary(run.result, run.plan)}</EmptyState>
        ) : run.state === "running" ? (
          <Loading />
        ) : (
          <EmptyState icon={<Play />}>
            Run a statement to see its result here, or describe one with
            Generate.
          </EmptyState>
        )}
      </div>
    </div>
  )
}
