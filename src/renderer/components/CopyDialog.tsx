import { ArrowRight, CircleAlert, Eye, Table2, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { create } from "zustand"

import {
  COPY_EXISTING_FOR,
  type CopyContent,
  type CopyExisting,
  type CopyInput,
  type CopyPlan,
  type CopyPlanItem,
  type CopyProgress,
  type CopyResult,
  type Engine,
  type TreeTable,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ENGINE_LOGO } from "@/lib/engines"
import { errorMessage, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

import { SimpleSelect } from "./simple-select"
import { SqlText } from "./sql-code"
import { ErrorNote } from "./state-view"

/** What was copied in the explorer, waiting to be pasted. */
export type CopiedTables = {
  connectionId: string
  engine: Engine
  schema: string
  /** What the schema showed when it was copied, views too. */
  tables: TreeTable[]
  /** The whole schema, rather than a table of it. */
  whole: boolean
}

type PasteTarget = { connectionId: string; schema: string | null }

export const useCopy = create<{
  copied: CopiedTables | null
  paste: { from: CopiedTables; into: PasteTarget } | null
}>(() => ({ copied: null, paste: null }))

/** Keeps tables to paste into another connection. Only the names: what they
 * are is read when they are pasted. */
export function copyTables(copied: CopiedTables): void {
  useCopy.setState({ copied })
}

export function openPaste(into: PasteTarget): void {
  const { copied } = useCopy.getState()
  if (copied) useCopy.setState({ paste: { from: copied, into } })
}

/** Whether what was copied can be pasted into a connection of this engine. */
export const pasteable = (copied: CopiedTables | null, engine: Engine): copied is CopiedTables =>
  !!copied && copied.engine === engine && engine !== "duckdb"

/** Says what is waiting to be pasted, for a menu. */
export const pasteLabel = (copied: CopiedTables) =>
  copied.whole
    ? `Paste ${copied.engine === "mysql" ? "database" : "schema"} ${copied.schema}…`
    : `Paste ${copied.tables[0]?.name ?? "table"}…`

const CONTENT: Record<CopyContent, string> = {
  structure_and_data: "Structure and data",
  structure: "Structure only",
  data: "Data only",
}

const EXISTING: Record<CopyExisting, string> = {
  fail: "Stop — change nothing",
  skip: "Leave it, skip it",
  replace: "Drop it and make it again",
  append: "Keep it, add the rows",
  truncate: "Empty it, then add the rows",
}

const ACTION: Record<CopyPlanItem["action"], { label: string; className: string }> = {
  create: { label: "new", className: "text-[var(--tone-green)]" },
  replace: { label: "replace", className: "text-destructive" },
  skip: { label: "skip", className: "text-muted-foreground" },
  append: { label: "add rows", className: "text-[var(--tone-blue)]" },
  truncate: { label: "empty, add rows", className: "text-destructive" },
}

let nextCopy = 1

type Stage =
  | { kind: "form" }
  | { kind: "planning" }
  | { kind: "review"; plan: CopyPlan }
  | { kind: "running"; plan: CopyPlan; copyId: string; progress: CopyProgress | null; stopping: boolean }
  | { kind: "done"; result: CopyResult }

export function CopyHost() {
  const paste = useCopy((state) => state.paste)
  if (!paste) return null
  // Fresh each time it opens.
  return (
    <PasteDialog
      key={`${paste.from.connectionId}:${paste.from.schema}:${paste.into.connectionId}:${paste.into.schema}`}
      from={paste.from}
      into={paste.into}
    />
  )
}

function PasteDialog({ from, into }: { from: CopiedTables; into: PasteTarget }) {
  const connections = useStore((state) => state.connections)
  const targetTree = useStore((state) => state.trees[into.connectionId])
  const loadTree = useStore((state) => state.loadTree)
  const source = connections.find((item) => item.id === from.connectionId)
  const target = connections.find((item) => item.id === into.connectionId)

  const same = from.connectionId === into.connectionId
  const [schema, setSchema] = useState(into.schema ?? (same ? `${from.schema}_copy` : from.schema))
  const [content, setContent] = useState<CopyContent>("structure_and_data")
  const [existing, setExisting] = useState<CopyExisting>("fail")
  const [picked, setPicked] = useState<Set<string>>(() => new Set(from.tables.map((table) => table.name)))
  const [stage, setStage] = useState<Stage>({ kind: "form" })
  const [error, setError] = useState<string | null>(null)
  const [showScript, setShowScript] = useState(false)
  const copyIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!targetTree) void loadTree(into.connectionId)
  }, [into.connectionId, loadTree, targetTree])

  // Progress of this dialog's copy only.
  useEffect(
    () =>
      window.veylens.onCopyProgress((event) => {
        if (event.copyId !== copyIdRef.current) return
        setStage((current) => (current.kind === "running" ? { ...current, progress: event } : current))
      }),
    []
  )

  const schemas = targetTree?.status === "ready" ? targetTree.schemas.map((item) => item.name) : []
  const choices = COPY_EXISTING_FOR[content]
  const tables = from.tables.filter((table) => content !== "data" || table.kind === "table")
  const chosen = tables.filter((table) => picked.has(table.name)).map((table) => table.name)

  const input = (): CopyInput => ({
    source: { connectionId: from.connectionId, schema: from.schema, tables: chosen },
    target: { connectionId: into.connectionId, schema: schema.trim() },
    content,
    existing,
  })

  const close = () => {
    if (stage.kind === "running") return
    useCopy.setState({ paste: null })
  }

  const review = async () => {
    setError(null)
    setStage({ kind: "planning" })
    try {
      setStage({ kind: "review", plan: await window.veylens.planCopy(input()) })
      setShowScript(false)
    } catch (caught) {
      setError(errorMessage(caught))
      setStage({ kind: "form" })
    }
  }

  const run = async (plan: CopyPlan) => {
    const copyId = `copy-${Date.now()}-${nextCopy++}`
    copyIdRef.current = copyId
    setError(null)
    setStage({ kind: "running", plan, copyId, progress: null, stopping: false })
    try {
      const result = await window.veylens.runCopy(copyId, input())
      setStage({ kind: "done", result })
    } catch (caught) {
      setError(errorMessage(caught))
      setStage({ kind: "review", plan })
    } finally {
      copyIdRef.current = null
      // What it made, or what a failure left, shows in the explorer.
      void loadTree(into.connectionId, { quiet: true })
      useStore.setState((state) => ({
        expanded: { ...state.expanded, [`c:${into.connectionId}`]: true, [`s:${into.connectionId}:${schema.trim()}`]: true },
        dataVersion: {
          ...state.dataVersion,
          [into.connectionId]: (state.dataVersion[into.connectionId] ?? 0) + 1,
        },
      }))
    }
  }

  const stop = (copyId: string) => {
    setStage((current) => (current.kind === "running" ? { ...current, stopping: true } : current))
    void window.veylens.cancelCopy(copyId)
  }

  const SourceLogo = ENGINE_LOGO[from.engine]
  const allPicked = tables.length > 0 && tables.every((table) => picked.has(table.name))

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        showCloseButton={stage.kind !== "running"}
        className="flex max-h-[calc(100%-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-4 pr-12">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs">
            <SourceLogo className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px]">Paste into {target?.name ?? "connection"}</DialogTitle>
            <DialogDescription className="flex items-center gap-1 truncate text-[11px]">
              <span className="truncate">
                {source?.name ?? "?"} › {from.schema}
              </span>
              <ArrowRight className="size-3 shrink-0" />
              <span className="truncate">
                {target?.name ?? "?"} › {schema.trim() || "…"}
              </span>
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {(stage.kind === "form" || stage.kind === "planning") && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="paste-schema" className="text-xs font-medium">
                  Into {from.engine === "mysql" ? "database" : "schema"}
                </label>
                <Input
                  id="paste-schema"
                  list="paste-schemas"
                  value={schema}
                  spellCheck={false}
                  onChange={(event) => setSchema(event.target.value)}
                  className="h-8 font-mono text-xs md:text-xs"
                />
                <datalist id="paste-schemas">
                  {schemas.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <span className="text-[11px] text-muted-foreground">
                  {schema.trim() && targetTree?.status === "ready" && !schemas.includes(schema.trim())
                    ? "Not there yet: it is made."
                    : " "}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Copy</span>
                  <SimpleSelect
                    label="What to copy"
                    value={content}
                    items={CONTENT}
                    onChange={(next) => {
                      setContent(next)
                      if (!COPY_EXISTING_FOR[next].includes(existing)) setExisting(COPY_EXISTING_FOR[next][0]!)
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">If a table is already there</span>
                  <SimpleSelect
                    label="If a table is already there"
                    value={existing}
                    items={Object.fromEntries(choices.map((choice) => [choice, EXISTING[choice]])) as Record<CopyExisting, string>}
                    onChange={setExisting}
                  />
                </div>
              </div>

              <div className="flex min-h-0 flex-col gap-1.5">
                <div className="flex items-center">
                  <span className="flex-1 text-xs font-medium">
                    Tables{" "}
                    <span className="font-normal text-muted-foreground">
                      {chosen.length} of {tables.length}
                    </span>
                  </span>
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto px-0"
                    onClick={() =>
                      setPicked(allPicked ? new Set() : new Set(tables.map((table) => table.name)))
                    }
                  >
                    {allPicked ? "None" : "All"}
                  </Button>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border bg-background p-1">
                  {tables.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No tables.</div>
                  ) : (
                    tables.map((table) => (
                      <label
                        key={table.name}
                        className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={picked.has(table.name)}
                          onChange={(event) => {
                            const next = new Set(picked)
                            if (event.target.checked) next.add(table.name)
                            else next.delete(table.name)
                            setPicked(next)
                          }}
                        />
                        {table.kind === "view" ? (
                          <Eye className="size-3.5 text-muted-foreground" />
                        ) : (
                          <Table2 className="size-3.5 text-muted-foreground" />
                        )}
                        <span className="truncate">{table.name}</span>
                      </label>
                    ))
                  )}
                </div>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  Columns, keys, indexes and comments come across
                  {from.engine === "postgres" ? ", and the enums and sequences they use" : ""}; views are made
                  after the tables. Triggers, functions and grants do not.
                </span>
              </div>
            </>
          )}

          {(stage.kind === "review" || stage.kind === "running") && (
            <PlanView
              plan={stage.plan}
              showScript={showScript}
              onShowScript={() => setShowScript((shown) => !shown)}
            />
          )}

          {stage.kind === "running" && <ProgressView progress={stage.progress} stopping={stage.stopping} />}

          {stage.kind === "done" && <ResultView result={stage.result} />}

          {error && <ErrorNote mono>{error}</ErrorNote>}
        </div>

        <DialogFooter className="m-0 items-center px-5 py-3">
          {stage.kind === "form" || stage.kind === "planning" ? (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={stage.kind === "planning" || chosen.length === 0 || !schema.trim()}
                onClick={() => void review()}
              >
                {stage.kind === "planning" && <Spinner className="size-3.5" />}
                Review
              </Button>
            </>
          ) : stage.kind === "review" ? (
            <>
              <Button variant="outline" onClick={() => setStage({ kind: "form" })}>
                Back
              </Button>
              <Button
                disabled={stage.plan.rule === "block" || stage.plan.items.every((item) => item.action === "skip")}
                variant={
                  stage.plan.items.some((item) => item.action === "replace" || item.action === "truncate")
                    ? "destructive"
                    : "default"
                }
                onClick={() => void run(stage.plan)}
              >
                {stage.plan.rule === "ask" ? "Copy anyway" : "Copy"}
              </Button>
            </>
          ) : stage.kind === "running" ? (
            <Button variant="outline" disabled={stage.stopping} onClick={() => stop(stage.copyId)}>
              {stage.stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button onClick={close}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlanView({
  plan,
  showScript,
  onShowScript,
}: {
  plan: CopyPlan
  showScript: boolean
  onShowScript: () => void
}) {
  const made = plan.items.filter((item) => item.action !== "skip").length
  const rows = plan.items.reduce((sum, item) => sum + (item.data ? (item.rowEstimate ?? 0) : 0), 0)
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs leading-relaxed">
        {plan.createsSchema && <>The schema is made, then </>}
        {made} of {plan.items.length} {plan.items.length === 1 ? "is" : "are"} copied
        {rows > 0 && <>, about {rows.toLocaleString()} rows</>}.
      </div>

      {plan.reasons.length > 0 && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-snug",
            plan.rule === "block"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-[var(--tone-amber)]/30 bg-[var(--tone-amber)]/5"
          )}
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex flex-col gap-1">
            {plan.rule === "ask" && <span className="font-medium">This connection asks first:</span>}
            {plan.reasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
          </div>
        </div>
      )}

      {plan.warnings.length > 0 && <Warnings warnings={plan.warnings} />}

      <div className="max-h-52 overflow-y-auto rounded-lg border bg-background p-1">
        {plan.items.map((item) => (
          <div key={item.name} className="flex h-7 items-center gap-2 rounded-md px-2 text-xs">
            {item.kind === "table" ? (
              <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Eye className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("min-w-0 flex-1 truncate", item.action === "skip" && "text-muted-foreground")}>
              {item.name}
            </span>
            {item.data && item.rowEstimate !== null && (
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                ~{item.rowEstimate.toLocaleString()} rows
              </span>
            )}
            <span className={cn("w-24 shrink-0 text-right text-[11px] font-medium", ACTION[item.action].className)}>
              {ACTION[item.action].label}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Button variant="link" size="xs" className="h-auto self-start px-0" onClick={onShowScript}>
          {showScript ? "Hide the SQL" : "Show the SQL it runs"}
        </Button>
        {showScript && (
          <pre className="selectable max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre">
            <SqlText text={plan.script || "-- Nothing to run."} />
          </pre>
        )}
      </div>
    </div>
  )
}

function ProgressView({ progress, stopping }: { progress: CopyProgress | null; stopping: boolean }) {
  const share = progress && progress.total ? progress.done / progress.total : 0
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <Spinner className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {stopping ? "Stopping after this batch…" : (progress?.step ?? "Starting…")}
        </span>
        {progress && progress.rows > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {progress.rows.toLocaleString()} rows
          </span>
        )}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      {progress && progress.total > 0 && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {progress.done} of {progress.total} tables filled
        </span>
      )}
    </div>
  )
}

function ResultView({ result }: { result: CopyResult }) {
  const copied = result.items.filter((item) => item.status === "copied").length
  const failed = result.items.filter((item) => item.status === "failed").length
  const ordered = useMemo(
    () => [...result.items].sort((a, b) => Number(a.status === "skipped") - Number(b.status === "skipped")),
    [result.items]
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs leading-relaxed">
        Copied {copied} {copied === 1 ? "table or view" : "tables and views"}
        {result.rows > 0 && <> and {result.rows.toLocaleString()} rows</>} in {(result.ms / 1000).toFixed(1)}s
        {failed > 0 && <>; {failed} could not be made</>}.
      </div>
      {result.warnings.length > 0 && <Warnings warnings={result.warnings} />}
      <div className="max-h-52 overflow-y-auto rounded-lg border bg-background p-1">
        {ordered.map((item) => (
          <div key={item.name} className="flex h-7 items-center gap-2 rounded-md px-2 text-xs">
            <span className={cn("min-w-0 flex-1 truncate", item.status === "skipped" && "text-muted-foreground")}>
              {item.name}
            </span>
            {item.rows > 0 && (
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {item.rows.toLocaleString()} rows
              </span>
            )}
            <span
              className={cn(
                "w-16 shrink-0 text-right text-[11px] font-medium",
                item.status === "copied"
                  ? "text-[var(--tone-green)]"
                  : item.status === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground"
              )}
            >
              {item.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--tone-amber)]/30 bg-[var(--tone-amber)]/5 px-3 py-2 text-xs leading-snug">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--tone-amber)]" />
      <div className="selectable flex flex-col gap-1">
        {warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </div>
    </div>
  )
}
