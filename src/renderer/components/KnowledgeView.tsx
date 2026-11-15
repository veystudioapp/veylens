import {
  BookOpen,
  ChevronDown,
  ExternalLink,
  Eye,
  Lightbulb,
  PencilLine,
  Play,
  Plus,
  Save,
  Sigma,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type { Knowledge, Metric, QueryResult } from "@shared/api"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage, useStore, type Tab } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { formatNumber } from "./Chart"
import { confirm } from "./confirm"
import { IconButton } from "./icon-button"
import { Markdown } from "./Markdown"
import { ErrorNote, Loading } from "./state-view"
import { SqlText, SqlTextarea } from "./sql-code"

type KnowledgeTab = Extract<Tab, { kind: "knowledge" }>

/** Lines someone new to the data needs, offered as starts. */
const NOTE_STARTERS: { label: string; text: string }[] = [
  { label: "Status codes", text: "- `orders.status`: 1 = pending, 2 = paid, 3 = cancelled, 4 = refunded" },
  { label: "How revenue is counted", text: "- Revenue excludes cancelled and refunded orders, and is net of VAT" },
  { label: "Columns to avoid", text: "- `customers.legacy_id` is from the old system; do not join on it" },
  { label: "Fiscal calendar", text: "- Our fiscal year starts in April" },
  { label: "Test data", text: "- Rows with `email` ending in `@example.com` are test accounts; leave them out" },
]

/** Figures most businesses define, offered as starts. */
const METRIC_STARTERS: { name: string; description: string }[] = [
  { name: "Net revenue", description: "Paid orders, minus refunds, net of VAT" },
  { name: "Active customers", description: "Customers with an order in the last 90 days" },
  { name: "Average order value", description: "Net revenue divided by the number of paid orders" },
]

const blankMetric = (patch: Partial<Metric> = {}): Metric => ({
  id: "",
  name: "",
  description: "",
  sql: "",
  ...patch,
})

const same = (a: Knowledge, b: Knowledge) =>
  a.notes === b.notes && JSON.stringify(a.metrics) === JSON.stringify(b.metrics)

/** A whole query, which runs on its own — not an expression to put in one. */
const isQuery = (sql: string) => /^\s*(select|with)\b/i.test(sql)

/** "Saved just now", "Saved 4 min ago", then the date. */
function savedAgo(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return "Saved just now"
  if (minutes < 60) return `Saved ${minutes} min ago`
  return `Saved ${new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
}

function SectionHead({
  icon,
  tone,
  title,
  hint,
  children,
}: {
  icon: ReactNode
  tone: Parameters<typeof IconTile>[0]["tone"]
  title: string
  hint: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5">
      <IconTile tone={tone} size="sm">
        {icon}
      </IconTile>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  )
}

type Test =
  | { state: "running" }
  | { state: "done"; result: QueryResult }
  | { state: "failed"; error: string }

/** A metric: its name, meaning and SQL at a glance; opened, to edit. */
function MetricCard({
  metric,
  open,
  autoFocus,
  connectionId,
  onToggle,
  onChange,
  onRemove,
  onOpenQuery,
}: {
  metric: Metric
  open: boolean
  autoFocus: boolean
  connectionId: string
  onToggle: () => void
  onChange: (patch: Partial<Metric>) => void
  onRemove: () => void
  onOpenQuery: () => void
}) {
  const [test, setTest] = useState<Test | null>(null)
  const query = isQuery(metric.sql)
  const firstLine = metric.sql.trim().split("\n")[0] ?? ""

  // What a test said is about the SQL it ran.
  useEffect(() => setTest(null), [metric.sql])

  const run = async () => {
    setTest({ state: "running" })
    try {
      setTest({ state: "done", result: await window.veylens.runQuery(connectionId, metric.sql, true) })
    } catch (failure) {
      setTest({ state: "failed", error: errorMessage(failure) })
    }
  }

  const answer = test?.state === "done" ? test.result : null
  const single = answer && answer.rows.length === 1 && answer.columns.length === 1 ? answer.rows[0]![0] : undefined

  return (
    <div className={cn("rounded-lg border bg-card transition-shadow", open ? "shadow-sm" : "hover:border-foreground/15")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) onToggle()
        }}
        className="flex cursor-pointer items-start gap-3 px-3.5 py-3 outline-offset-[-2px]"
      >
        <IconTile tone="teal" size="md" className="mt-0.5">
          <Sigma />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-[13px] font-semibold", !metric.name && "text-muted-foreground")}>
              {metric.name || "Unnamed metric"}
            </span>
            {metric.sql.trim() && (
              <span className="shrink-0 rounded bg-muted px-1.5 text-[10.5px] leading-[18px] text-muted-foreground">
                {query ? "query" : "expression"}
              </span>
            )}
          </div>
          {metric.description && !open && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{metric.description}</p>
          )}
          {!open && (
            <code className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground/90">
              {firstLine ? <SqlText text={firstLine} /> : <span className="italic">No SQL yet</span>}
            </code>
          )}
        </div>
        <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
          {query && (
            <IconButton label="Open in a query tab" onClick={onOpenQuery}>
              <ExternalLink />
            </IconButton>
          )}
          <IconButton label="Remove metric" onClick={onRemove}>
            <Trash2 />
          </IconButton>
        </span>
        <ChevronDown
          className={cn("mt-1.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t px-3.5 pt-3 pb-3.5">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Name</span>
              <Input
                autoFocus={autoFocus}
                value={metric.name}
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="Net revenue"
                aria-label="Metric name"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">What it means</span>
              <Input
                value={metric.description}
                onChange={(event) => onChange({ description: event.target.value })}
                placeholder="What it includes and leaves out"
                aria-label="Metric description"
              />
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">How it is computed</span>
            <div className="relative overflow-hidden rounded-lg border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
              <SqlTextarea
                value={metric.sql}
                onChange={(event) => onChange({ sql: event.target.value })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && isQuery(metric.sql)) {
                    event.preventDefault()
                    void run()
                  }
                }}
                placeholder={"SELECT sum(total) AS net_revenue\n  FROM orders\n WHERE status = 2"}
                aria-label="Metric SQL"
                spellCheck={false}
                className="block min-h-24 w-full resize-y bg-muted/30 px-3 py-2.5 font-mono text-xs leading-5 outline-none"
              />
              <div className="flex items-center gap-2 border-t bg-muted/40 px-2 py-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!query || test?.state === "running"}
                  title={query ? "Run it read-only (⌘↵)" : "An expression runs inside a query, not on its own"}
                  onClick={() => void run()}
                >
                  {test?.state === "running" ? <Spinner className="size-3" /> : <Play />}
                  Test
                </Button>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {test?.state === "done"
                    ? single !== undefined
                      ? null
                      : `${answer!.rows.length} ${answer!.rows.length === 1 ? "row" : "rows"} · ${Math.round(answer!.ms)} ms`
                    : query
                      ? "A whole query; the assistant runs it as it is."
                      : "An expression — sum(total) FILTER (WHERE …) — the assistant puts in its queries."}
                </span>
                {single !== undefined && (
                  <span className="flex items-baseline gap-1.5 text-xs">
                    <span className="text-muted-foreground">=</span>
                    <span className="font-semibold tabular-nums">
                      {single === null
                        ? "NULL"
                        : Number.isFinite(Number(single))
                          ? formatNumber(Number(single))
                          : single}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{Math.round(answer!.ms)} ms</span>
                  </span>
                )}
              </div>
            </div>
            {test?.state === "failed" && <ErrorNote mono>{test.error}</ErrorNote>}
          </div>
        </div>
      )}
    </div>
  )
}

export function KnowledgeView({ tab, active }: { tab: KnowledgeTab; active: boolean }) {
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId)
  )
  const stored = useStore((state) => state.knowledge[tab.connectionId])
  const loadKnowledge = useStore((state) => state.loadKnowledge)
  const saveKnowledge = useStore((state) => state.saveKnowledge)
  const openQuery = useStore((state) => state.openQuery)
  const setChatDraft = useStore((state) => state.setDraft)

  const [draft, setDraft] = useState<Knowledge | null>(stored ?? null)
  /** What `draft` was last in step with: edits are the difference. */
  const [base, setBase] = useState<Knowledge | null>(stored ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Written notes open as they read; empty ones, to be written. */
  const [editing, setEditing] = useState<boolean | null>(null)
  const [openMetric, setOpenMetric] = useState<number | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const notesArea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (stored) return
    loadKnowledge(tab.connectionId).catch((error) =>
      setLoadError(errorMessage(error))
    )
  }, [loadKnowledge, stored, tab.connectionId])

  const dirty = !!draft && !!base && !same(draft, base)

  // What the assistant saved lands here too, unless there are edits of the
  // user's own in the way.
  useEffect(() => {
    if (!stored || stored === base) return
    if (!draft || !base || same(draft, base)) {
      setDraft(stored)
      setBase(stored)
    }
  }, [stored, base, draft])

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // A metric left with nothing in it is not one.
      const kept = {
        ...draft,
        metrics: draft.metrics.filter((metric) => metric.name.trim() || metric.sql.trim()),
      }
      const saved = await saveKnowledge(tab.connectionId, kept)
      setDraft(saved)
      setBase(saved)
      setFresh(null)
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (loadError) return <ErrorNote className="m-4">{loadError}</ErrorNote>
  if (!draft) return <Loading />

  const writing = editing ?? !draft.notes.trim()

  const setMetric = (index: number, patch: Partial<Metric>) =>
    setDraft({
      ...draft,
      metrics: draft.metrics.map((metric, i) =>
        i === index ? { ...metric, ...patch } : metric
      ),
    })

  const addMetric = (patch: Partial<Metric> = {}) => {
    const index = draft.metrics.length
    setDraft({ ...draft, metrics: [...draft.metrics, blankMetric(patch)] })
    setOpenMetric(index)
    setFresh(index)
  }

  const removeMetric = async (index: number) => {
    const metric = draft.metrics[index]!
    if (
      (metric.name.trim() || metric.sql.trim()) &&
      !(await confirm({
        title: `Remove "${metric.name || "this metric"}"?`,
        description: "It goes when you save; Discard brings it back until then.",
        action: "Remove",
        destructive: true,
      }))
    ) {
      return
    }
    setDraft({ ...draft, metrics: draft.metrics.filter((_, i) => i !== index) })
    setOpenMetric(null)
  }

  const addStarter = (text: string) => {
    const notes = draft.notes.trim() ? `${draft.notes.replace(/\s+$/, "")}\n${text}` : text
    setDraft({ ...draft, notes })
    setEditing(true)
    requestAnimationFrame(() => {
      const area = notesArea.current
      if (!area) return
      area.focus()
      area.setSelectionRange(notes.length, notes.length)
    })
  }

  const name = connection?.name ?? "removed connection"
  const lines = draft.notes.split("\n").filter((line) => line.trim()).length

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 dark:bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-6 pt-6 pb-10">
          <header className="flex items-start gap-3.5">
            <IconTile tone={KIND_TONE.context} size="lg">
              <BookOpen />
            </IconTile>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">Business context</h2>
                {connection && (
                  <span className="flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: toneColor(connectionTone(connection)) }}
                    />
                    {name}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                What this data means, in your words. The assistant reads it before every
                answer on {name}, and computes a metric defined here the same way each time.
              </p>
            </div>
            <div className="hidden shrink-0 gap-4 text-right sm:flex">
              <div>
                <div className="text-lg leading-none font-semibold tabular-nums">{lines}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{lines === 1 ? "note line" : "note lines"}</div>
              </div>
              <div>
                <div className="text-lg leading-none font-semibold tabular-nums">{draft.metrics.length}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{draft.metrics.length === 1 ? "metric" : "metrics"}</div>
              </div>
            </div>
          </header>

          {/* Notes */}
          <section className="flex flex-col gap-3">
            <SectionHead
              icon={<BookOpen />}
              tone={KIND_TONE.context}
              title="Notes"
              hint="What codes mean, how figures are counted, what to stay away from. Markdown."
            >
              {draft.notes.trim() && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setEditing(!writing)}
                  aria-pressed={writing}
                >
                  {writing ? <Eye /> : <PencilLine />}
                  {writing ? "Preview" : "Edit"}
                </Button>
              )}
            </SectionHead>

            <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
              {writing ? (
                <textarea
                  ref={notesArea}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                  placeholder="What someone new to this data should know — one point a line."
                  aria-label="Notes"
                  className="block min-h-44 w-full resize-y bg-transparent px-4 py-3 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70 [field-sizing:content]"
                />
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  title="Click to edit"
                  onClick={() => setEditing(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setEditing(true)
                  }}
                  className="cursor-text px-4 py-3 outline-offset-[-2px] hover:bg-muted/30"
                >
                  <Markdown text={draft.notes} />
                </div>
              )}
              {writing && (
                <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/30 px-3 py-2">
                  <Lightbulb className="size-3.5 text-[var(--tone-amber)]" />
                  <span className="mr-1 text-[11px] text-muted-foreground">Add a line on</span>
                  {NOTE_STARTERS.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      onClick={() => addStarter(starter.text)}
                      className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/20 hover:text-foreground"
                    >
                      {starter.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Metrics */}
          <section className="flex flex-col gap-3">
            <SectionHead
              icon={<Sigma />}
              tone="teal"
              title={`Metrics${draft.metrics.length ? ` · ${draft.metrics.length}` : ""}`}
              hint="Figures defined once, so every answer computes them the same way."
            >
              <Button variant="outline" size="xs" onClick={() => addMetric()}>
                <Plus />
                Add metric
              </Button>
            </SectionHead>

            {draft.metrics.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-4 py-7 text-center">
                <IconTile tone="teal" size="lg">
                  <Sigma />
                </IconTile>
                <div>
                  <p className="text-[13px] font-medium">No metrics yet</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Start from one most businesses define:</p>
                </div>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {METRIC_STARTERS.map((starter) => (
                    <button
                      key={starter.name}
                      type="button"
                      onClick={() => addMetric(starter)}
                      className="flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs hover:border-foreground/20 hover:bg-accent/50"
                    >
                      <Plus className="size-3 text-muted-foreground" />
                      {starter.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {draft.metrics.map((metric, index) => (
                  <MetricCard
                    key={metric.id || `new-${index}`}
                    metric={metric}
                    open={openMetric === index}
                    autoFocus={fresh === index}
                    connectionId={tab.connectionId}
                    onToggle={() => setOpenMetric(openMetric === index ? null : index)}
                    onChange={(patch) => setMetric(index, patch)}
                    onRemove={() => void removeMetric(index)}
                    onOpenQuery={() =>
                      openQuery(tab.connectionId, { sql: metric.sql, title: metric.name || "Metric" })
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* The assistant can write this too. */}
          <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <IconTile tone="pink" size="md">
              <Sparkles />
            </IconTile>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              The assistant can draft this from the schema and the data, and adds
              to it as it learns — you approve each note and metric in the chat.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!connection}
              onClick={() =>
                setChatDraft(
                  `Read the schema of ${name} and sample its data, then propose business context: notes on what the main tables and status codes mean and what to avoid, and metrics for the key figures — each for me to approve.`
                )
              }
            >
              Ask the assistant
            </Button>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 border-t px-4 transition-colors",
          dirty ? "bg-[color-mix(in_oklch,var(--tone-amber)_8%,var(--background))]" : "bg-background"
        )}
      >
        {saveError ? (
          <ErrorNote className="min-w-0 flex-1 py-1">{saveError}</ErrorNote>
        ) : (
          <span className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
            {dirty && <span className="size-1.5 rounded-full bg-[var(--tone-amber)]" />}
            {dirty
              ? "Unsaved changes"
              : stored?.updatedAt
                ? savedAgo(stored.updatedAt, Math.max(now, stored.updatedAt))
                : "Nothing saved yet"}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => {
            if (!stored) return
            setDraft(stored)
            setBase(stored)
            setOpenMetric(null)
          }}
        >
          Discard
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()} title="Save (⌘S)">
          {saving ? <Spinner className="size-3.5" /> : <Save />}
          Save
        </Button>
      </div>
    </div>
  )
}
