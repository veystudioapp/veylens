import {
  Activity,
  AlignLeft,
  CircleAlert,
  Copy,
  ExternalLink,
  Gauge,
  Layers,
  ListTree,
  Pause,
  Play,
  Repeat,
  Search,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useDefaultLayout } from "react-resizable-panels"

import type { GatewayQuery, QueryResult } from "@shared/api"
import {
  findNPlusOne,
  fingerprint,
  groupQueries,
  inlinePostgresParams,
  slowQueries,
  type NPlusOne,
  type QueryGroup,
} from "@shared/query-insights"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { formatSql } from "@/lib/format-sql"
import { useGateway } from "@/lib/gateway"
import { errorMessage, useStore, type QueriesTab } from "@/lib/store"
import { IconTile, KIND_TONE, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { ResultTable } from "./Chart"
import { IconButton } from "./icon-button"
import { EmptyState, ErrorNote } from "./state-view"
import { SqlText } from "./sql-code"

/** Statements kept on screen, as the main process keeps them. */
const KEPT = 5000
/** Rows the live list draws; the rest are a search away. */
const LIVE_ROWS = 400
/** Past this a statement is slow; past ten times it, very. */
const SLOW_MS = 100

type View = "live" | "grouped" | "issues"

const clock = (at: number) => {
  const date = new Date(at)
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`
}

const duration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`

const speedTone = (ms: number) => (ms >= SLOW_MS * 10 ? "red" : ms >= SLOW_MS ? "amber" : "green")

/** A statement as it can be run again: Postgres values written in. */
const runnable = (query: GatewayQuery) => inlinePostgresParams(query.sql, query.params) ?? query.sql

/** A number to read, not a control: the views are switched by the tabs below. */
function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode
  label: string
  value: string
  tone?: Parameters<typeof toneColor>[0]
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border bg-card px-3 py-2">
      <span className="[&_svg]:size-4" style={{ color: tone ? toneColor(tone) : "var(--muted-foreground)" }}>
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className="block text-[15px] leading-tight font-semibold tabular-nums"
          style={tone && tone !== "green" ? { color: toneColor(tone) } : undefined}
        >
          {value}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
      </span>
    </div>
  )
}

/** One of the list's views, with how many it holds. */
function ViewTab({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string
  count: number
  /** For a count that is a problem: drawn in this colour when not zero. */
  tone?: Parameters<typeof toneColor>[0]
  active: boolean
  onClick: () => void
}) {
  const alarm = tone && count > 0
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors",
        active ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "min-w-4 rounded px-1 text-center text-[10.5px] leading-4 tabular-nums",
          alarm ? "text-white" : "bg-muted-foreground/15 text-muted-foreground"
        )}
        style={alarm ? { background: toneColor(tone) } : undefined}
      >
        {count.toLocaleString()}
      </span>
    </button>
  )
}

/** A bar for how long it took, against the slowest in view. */
function TimeBar({ ms, max }: { ms: number; max: number }) {
  return (
    <span className="flex w-24 shrink-0 items-center gap-1.5">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(3, Math.min(100, (Math.log1p(ms) / Math.log1p(Math.max(max, 1))) * 100))}%`,
            background: toneColor(speedTone(ms)),
          }}
        />
      </span>
      <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground">{duration(ms)}</span>
    </span>
  )
}

function LiveList({
  queries,
  repeated,
  selected,
  onSelect,
}: {
  queries: GatewayQuery[]
  repeated: Set<number>
  selected: number | null
  onSelect: (query: GatewayQuery) => void
}) {
  const shown = queries.slice(-LIVE_ROWS).reverse()
  const max = Math.max(1, ...shown.map((query) => query.ms))
  return (
    <div className="flex flex-col" role="list">
      {shown.map((query) => (
        <button
          key={query.id}
          type="button"
          role="listitem"
          onClick={() => onSelect(query)}
          className={cn(
            "flex h-8 shrink-0 items-center gap-2.5 border-b px-3 text-left text-xs hover:bg-muted/60",
            selected === query.id && "bg-primary/10 hover:bg-primary/15"
          )}
        >
          <span className="w-[86px] shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{clock(query.at)}</span>
          <span className="w-8 shrink-0 text-[11px] text-muted-foreground tabular-nums" title={`App connection #${query.session}`}>
            #{query.session}
          </span>
          <TimeBar ms={query.ms} max={max} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            <SqlText text={query.sql.replace(/\s+/g, " ").slice(0, 400)} />
          </span>
          {repeated.has(query.id) && (
            <span
              className="shrink-0 rounded px-1 text-[10px] font-medium"
              style={{ color: toneColor("red"), background: `color-mix(in oklch, ${toneColor("red")} 12%, transparent)` }}
              title="Part of a burst of the same statement: N+1"
            >
              N+1
            </span>
          )}
          {query.error ? (
            <CircleAlert className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
              {query.rows ?? ""}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

function GroupedList({
  groups,
  selected,
  onSelect,
}: {
  groups: QueryGroup[]
  selected: number | null
  onSelect: (query: GatewayQuery) => void
}) {
  const total = groups.reduce((sum, group) => sum + group.totalMs, 0) || 1
  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b text-left text-[11px] text-muted-foreground">
          <th className="px-3 py-1.5 font-medium">Statement</th>
          <th className="px-2 py-1.5 text-right font-medium">Calls</th>
          <th className="px-2 py-1.5 text-right font-medium">Total</th>
          <th className="px-2 py-1.5 text-right font-medium">Avg</th>
          <th className="px-2 py-1.5 text-right font-medium">p95</th>
          <th className="px-2 py-1.5 text-right font-medium">Rows</th>
          <th className="px-3 py-1.5 text-right font-medium">Errors</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr
            key={group.fingerprint}
            onClick={() => onSelect(group.sample)}
            className={cn(
              "cursor-pointer border-b hover:bg-muted/60",
              selected === group.sample.id && "bg-primary/10 hover:bg-primary/15"
            )}
          >
            <td className="max-w-0 px-3 py-1.5">
              <div className="truncate font-mono text-[11.5px]">
                <SqlText text={group.sample.sql.replace(/\s+/g, " ").slice(0, 300)} />
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(group.totalMs / total) * 100}%`, background: toneColor(speedTone(group.p95Ms)) }}
                />
              </div>
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">{group.count.toLocaleString()}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{duration(group.totalMs)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{duration(group.avgMs)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: toneColor(speedTone(group.p95Ms)) }}>
              {duration(group.p95Ms)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{group.rows.toLocaleString()}</td>
            <td className={cn("px-3 py-1.5 text-right tabular-nums", group.errors ? "text-destructive" : "text-muted-foreground")}>
              {group.errors || ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

type IssueKind = "all" | "bursts" | "slow"

/** The issues tab: N+1 bursts and slow statements, both or either. */
function IssueList({
  kind,
  onKind,
  bursts,
  slow,
  filtered,
  selected,
  onSelect,
  onAsk,
  onShowBurst,
}: {
  kind: IssueKind
  onKind: (kind: IssueKind) => void
  bursts: NPlusOne[]
  slow: GatewayQuery[]
  /** Set when a search left some out, to say so rather than "none". */
  filtered: boolean
  selected: number | null
  onSelect: (query: GatewayQuery) => void
  onAsk: (burst: NPlusOne) => void
  onShowBurst: (burst: NPlusOne) => void
}) {
  const showBursts = kind !== "slow" && bursts.length > 0
  const showSlow = kind !== "bursts" && slow.length > 0
  const what = { all: "No N+1 bursts and nothing slow", bursts: "No N+1 bursts", slow: "Nothing slow" }[kind]
  const chips: { kind: IssueKind; label: string; count: number; tone?: "red" | "amber" }[] = [
    { kind: "all", label: "All", count: bursts.length + slow.length },
    { kind: "bursts", label: "N+1", count: bursts.length, tone: "red" },
    { kind: "slow", label: `Slow >${SLOW_MS} ms`, count: slow.length, tone: "amber" },
  ]
  return (
    <div className="flex min-h-full flex-col">
      <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1.5 px-4 pt-3">
        {chips.map((chip) => {
          const on = kind === chip.kind
          return (
            <button
              key={chip.kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onKind(chip.kind)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                on ? "border-foreground/25 bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {chip.tone && (
                <span className="size-1.5 rounded-full" style={{ background: toneColor(chip.count ? chip.tone : "green") }} />
              )}
              {chip.label}
              <span className="tabular-nums">{chip.count.toLocaleString()}</span>
            </button>
          )
        })}
      </div>
      {!showBursts && !showSlow ? (
        <EmptyState icon={<Gauge />}>
          {filtered
            ? `${what} matches the filter.`
            : `${what} among what has been seen. Use the app and look again.`}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          {showBursts && (
            <section className="flex flex-col gap-2">
              {kind === "all" && (
                <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Repeat className="size-3.5" style={{ color: toneColor("red") }} />
                  N+1 · {bursts.length}
                </h3>
              )}
              <BurstList bursts={bursts} selected={selected} onSelect={onSelect} onAsk={onAsk} onShowBurst={onShowBurst} />
            </section>
          )}
          {showSlow && (
            <section className="flex flex-col gap-2">
              {kind === "all" && (
                <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Timer className="size-3.5" style={{ color: toneColor("amber") }} />
                  Slower than {SLOW_MS} ms · {slow.length}
                </h3>
              )}
              <SlowList slow={slow} selected={selected} onSelect={onSelect} />
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** The N+1 bursts: one statement run again and again on one connection. */
function BurstList({
  bursts,
  selected,
  onSelect,
  onAsk,
  onShowBurst,
}: {
  bursts: NPlusOne[]
  selected: number | null
  onSelect: (query: GatewayQuery) => void
  onAsk: (burst: NPlusOne) => void
  onShowBurst: (burst: NPlusOne) => void
}) {
  return (
    <div className="flex flex-col gap-2">
          {bursts.map((burst) => (
            <div key={`${burst.session}-${burst.queries[0]!.id}`} className="rounded-lg border bg-card p-3">
              <div className="flex items-baseline gap-2">
                <span className="text-lg leading-none font-semibold tabular-nums" style={{ color: toneColor("red") }}>
                  {burst.queries.length}×
                </span>
                <span className="text-xs text-muted-foreground">
                  in {duration(burst.spanMs)} on app connection #{burst.session} · {duration(burst.totalMs)} in the database
                </span>
                {burst.identical && (
                  <span className="rounded bg-muted px-1.5 text-[10.5px] leading-[18px] text-muted-foreground">
                    same values every time
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onSelect(burst.queries[0]!)}
                className={cn(
                  "mt-2 block w-full rounded-md border bg-muted/40 px-2.5 py-1.5 text-left font-mono text-[11.5px] hover:border-foreground/20",
                  selected === burst.queries[0]!.id && "border-primary/40"
                )}
              >
                <SqlText text={burst.queries[0]!.sql.replace(/\s+/g, " ").slice(0, 300)} />
              </button>
              {burst.trigger && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Right after{" "}
                  <button
                    type="button"
                    onClick={() => onSelect(burst.trigger!)}
                    className="font-mono text-foreground underline decoration-dotted underline-offset-2"
                  >
                    {burst.trigger.sql.replace(/\s+/g, " ").slice(0, 90)}
                    {burst.trigger.sql.length > 90 ? "…" : ""}
                  </button>{" "}
                  {burst.trigger.rows !== null ? `(${burst.trigger.rows} rows)` : ""}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed">
                {burst.identical
                  ? "The same statement with the same values, again and again: keep the answer rather than asking each time."
                  : "One statement per row of a list — usually a relation loaded lazily. Load them in one go: a JOIN, or WHERE … IN (…) with every id, or the ORM's eager loading."}
              </p>
              <div className="mt-2.5 flex gap-1.5">
                <Button variant="outline" size="xs" onClick={() => onAsk(burst)}>
                  <Sparkles />
                  Ask the assistant
                </Button>
                <Button variant="ghost" size="xs" onClick={() => onShowBurst(burst)}>
                  <ListTree />
                  Show them
                </Button>
              </div>
            </div>
          ))}
    </div>
  )
}

/** Statements slower than {@link SLOW_MS}, slowest first. */
function SlowList({
  slow,
  selected,
  onSelect,
}: {
  slow: GatewayQuery[]
  selected: number | null
  onSelect: (query: GatewayQuery) => void
}) {
  return (
    <div>
          <div className="overflow-hidden rounded-lg border bg-card">
            {slow.slice(0, 50).map((query) => (
              <button
                key={query.id}
                type="button"
                onClick={() => onSelect(query)}
                className={cn(
                  "flex h-8 w-full items-center gap-2.5 border-b px-3 text-left text-xs last:border-b-0 hover:bg-muted/60",
                  selected === query.id && "bg-primary/10"
                )}
              >
                <span className="w-16 shrink-0 text-right font-medium tabular-nums" style={{ color: toneColor(speedTone(query.ms)) }}>
                  {duration(query.ms)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  <SqlText text={query.sql.replace(/\s+/g, " ").slice(0, 300)} />
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{clock(query.at)}</span>
              </button>
            ))}
          </div>
          {slow.length > 50 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              The slowest 50 of {slow.length.toLocaleString()}. Filter by SQL to find the rest.
            </p>
          )}
    </div>
  )
}

type Plan = { state: "running" } | { state: "done"; result: QueryResult } | { state: "failed"; error: string }

/** One statement whole: its SQL and values, what came of it, what to do next. */
function Detail({
  query,
  group,
  onClose,
  onAsk,
}: {
  query: GatewayQuery
  group: QueryGroup | undefined
  onClose: () => void
  onAsk: (query: GatewayQuery) => void
}) {
  const connection = useStore((state) => state.connections.find((item) => item.id === query.connectionId))
  const openQuery = useStore((state) => state.openQuery)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [copied, setCopied] = useState(false)
  /** Kept from one statement to the next, so it is picked once. */
  const [pretty, setPretty] = useState(false)
  useEffect(() => setPlan(null), [query.id])

  const inlined = connection?.engine === "postgres" ? inlinePostgresParams(query.sql, query.params) : query.sql
  /** What is shown, copied and opened: the statement, laid out if asked. */
  const tidy = (sql: string) => (pretty ? formatSql(sql, connection?.engine) : sql)
  const engine = connection?.engine
  const shown = useMemo(() => (pretty ? formatSql(query.sql, engine) : query.sql), [query.sql, pretty, engine])
  const explain = async () => {
    if (!connection || !inlined) return
    setPlan({ state: "running" })
    try {
      setPlan({ state: "done", result: await window.veylens.explainQuery(connection.id, inlined) })
    } catch (failure) {
      setPlan({ state: "failed", error: errorMessage(failure) })
    }
  }
  const textPlan =
    plan?.state === "done" && plan.result.columns.length === 1
      ? plan.result.rows.map((row) => row[0] ?? "").join("\n")
      : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-[13px] font-semibold">Statement</span>
        <span className="text-[11px] text-muted-foreground">
          {clock(query.at)} · app connection #{query.session}
        </span>
        <span className="flex-1" />
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat icon={<Timer />} label="took" value={duration(query.ms)} tone={speedTone(query.ms)} />
          <Stat icon={<Layers />} label={query.command?.toLowerCase() ?? "rows"} value={query.rows === null ? "—" : query.rows.toLocaleString()} />
          <Stat
            icon={<Repeat />}
            label={group ? `calls · avg ${duration(group.avgMs)}` : "calls"}
            value={group ? group.count.toLocaleString() : "1"}
          />
        </div>
        {query.error && <ErrorNote mono>{query.error}</ErrorNote>}
        <div className="relative">
          <pre className="selectable max-h-72 overflow-auto rounded-md border bg-muted/50 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
            <SqlText text={shown} />
          </pre>
        </div>
        {query.params && query.params.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Values</span>
            <div className="selectable grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px]">
              {query.params.map((value, index) => (
                <div key={index} className="contents">
                  <span className="text-muted-foreground">${index + 1}</span>
                  <span className="truncate">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={!connection || !inlined || plan?.state === "running"}
            title={
              !connection
                ? "The connection it went to is no longer in Vey Lens"
                : !inlined
                  ? "Its values were sent in binary, so it cannot be run again as it was"
                  : `EXPLAIN on ${connection.name}, read-only`
            }
            onClick={() => void explain()}
          >
            {plan?.state === "running" ? <Spinner className="size-3" /> : <Gauge />}
            Explain
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={!connection}
            onClick={() => connection && openQuery(connection.id, { sql: tidy(inlined ?? query.sql), title: "From the gateway" })}
          >
            <ExternalLink />
            Open in SQL editor
          </Button>
          <Button variant="outline" size="xs" onClick={() => onAsk(query)}>
            <Sparkles />
            Ask the assistant
          </Button>
          <Button
            variant="outline"
            size="xs"
            aria-pressed={pretty}
            className={cn(pretty && "bg-muted text-foreground")}
            title={pretty ? "Show it as the app sent it" : "Lay it out one clause to a line"}
            onClick={() => setPretty((on) => !on)}
          >
            <AlignLeft />
            {pretty ? "Original" : "Format"}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void navigator.clipboard.writeText(tidy(runnable(query)))
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            <Copy />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {plan?.state === "failed" && <ErrorNote mono>{plan.error}</ErrorNote>}
        {plan?.state === "done" &&
          (textPlan !== null ? (
            <pre className="selectable overflow-x-auto rounded-md border bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
              {textPlan}
            </pre>
          ) : (
            <ResultTable data={plan.result} className="max-h-72" />
          ))}
        {connection && (
          <p className="text-[11px] text-muted-foreground">
            Went to <span className="font-medium text-foreground">{connection.name}</span>. EXPLAIN runs there
            through Vey Lens, read-only, under its permissions.
          </p>
        )}
      </div>
    </div>
  )
}

export function QueryInspector({ tab }: { tab: QueriesTab; active: boolean }) {
  const gatewayState = useGateway((store) => store.state)
  const connections = useStore((state) => state.connections)
  const setDraft = useStore((state) => state.setDraft)
  const gateway = gatewayState?.gateways.find((item) => item.id === tab.gatewayId)
  const status = gatewayState?.status.find((item) => item.gatewayId === tab.gatewayId)
  const live = connections.find((item) => item.id === gateway?.active)

  const [queries, setQueries] = useState<GatewayQuery[]>([])
  const [view, setView] = useState<View>("live")
  const [issueKind, setIssueKind] = useState<IssueKind>("all")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<GatewayQuery | null>(null)
  /** The list's and the statement's widths, kept from one opening to the next. */
  const layout = useDefaultLayout({
    id: "query-inspector-split",
    panelIds: selected ? ["list", "detail"] : ["list"],
    storage: localStorage,
  })
  /** The live list narrowed to one burst. */
  const [burst, setBurst] = useState<{ ids: Set<number>; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const stop = window.veylens.onGatewayQueries((batch) => {
      const mine = batch.queries.filter((query) => query.gatewayId === tab.gatewayId)
      if (mine.length) setQueries((current) => [...current, ...mine].slice(-KEPT))
    })
    void window.veylens.gatewayQueries(tab.gatewayId).then(
      (kept) => {
        if (!alive) return
        // What came in while asking is kept too, once.
        setQueries((current) => {
          const seen = new Set(kept.map((query) => query.id))
          return [...kept, ...current.filter((query) => !seen.has(query.id))].slice(-KEPT)
        })
      },
      (failure) => setError(errorMessage(failure))
    )
    return () => {
      alive = false
      stop()
    }
  }, [tab.gatewayId])

  const needle = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      queries.filter(
        (query) => (!needle || query.sql.toLowerCase().includes(needle)) && (!burst || burst.ids.has(query.id))
      ),
    [queries, needle, burst]
  )
  const bursts = useMemo(() => findNPlusOne(queries), [queries])
  const repeated = useMemo(() => new Set(bursts.flatMap((item) => item.queries.map((query) => query.id))), [bursts])
  const groups = useMemo(() => groupQueries(filtered), [filtered])
  const slow = useMemo(() => slowQueries(queries, SLOW_MS), [queries])
  const distinct = useMemo(() => new Set(queries.map((query) => fingerprint(query.sql))).size, [queries])
  /** The N+1 and slow tabs, narrowed by the same search as the others. */
  const shownSlow = useMemo(
    () => (needle ? slow.filter((query) => query.sql.toLowerCase().includes(needle)) : slow),
    [slow, needle]
  )
  const shownBursts = useMemo(
    () =>
      needle
        ? bursts.filter(
            (item) =>
              item.queries[0]!.sql.toLowerCase().includes(needle) ||
              !!item.trigger?.sql.toLowerCase().includes(needle)
          )
        : bursts,
    [bursts, needle]
  )
  /** Whether the tab shown is one a burst's "Show them" narrows. */
  const narrowed = view === "live" || view === "grouped"
  const matches = {
    live: filtered.length,
    grouped: groups.length,
    issues: (issueKind !== "slow" ? shownBursts.length : 0) + (issueKind !== "bursts" ? shownSlow.length : 0),
  }[view]
  const groupOf = (query: GatewayQuery) => groups.find((group) => group.fingerprint === fingerprint(query.sql))

  const totalMs = queries.reduce((sum, query) => sum + query.ms, 0)
  const errors = queries.filter((query) => query.error).length
  const recording = status?.recording ?? true
  const name = gateway?.name ?? "Gateway"

  const ask = (prompt: string) => setDraft(prompt)
  const askBurst = (item: NPlusOne) =>
    ask(
      `The app behind the gateway "${name}" ran this statement ${item.queries.length} times in ${duration(item.spanMs)} on one connection${item.trigger ? ", right after this one" : ""}:\n\n` +
        (item.trigger ? `\`\`\`sql\n${item.trigger.sql}\n\`\`\`\n\nThe repeated one:\n\n` : "") +
        `\`\`\`sql\n${item.queries[0]!.sql}\n\`\`\`\n\n` +
        (item.identical
          ? "Every time with the same values. Why might the app do that, and how would it keep the answer instead?"
          : "This looks like N+1. Show how to get the same in one statement on this database (a JOIN, or WHERE … IN), check it against the schema, and say which index would help.")
    )
  const askQuery = (query: GatewayQuery) =>
    ask(
      `The app behind the gateway "${name}" ran this${query.ms >= SLOW_MS ? ` and it took ${duration(query.ms)}` : ""}${query.error ? ` and it failed with: ${query.error}` : ""}:\n\n\`\`\`sql\n${runnable(query)}\n\`\`\`\n\n` +
        (query.error
          ? "Why did it fail, and what should the app send instead?"
          : "Look at its plan and the tables it reads. Is it as fast as it can be? Suggest a rewrite or an index if one would help.")
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <IconTile tone={KIND_TONE.gateway} size="sm">
          <Activity />
        </IconTile>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{name}</div>
        </div>
        <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground md:inline">
          {gateway ? `127.0.0.1:${gateway.port} → ${live?.name ?? "nothing"}` : "removed"}
          {status ? ` · ${status.sessions} app ${status.sessions === 1 ? "connection" : "connections"} open` : ""}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          disabled={!gateway}
          onClick={() => gateway && void window.veylens.setGatewayRecording(gateway.id, !recording).then((state) => useGateway.setState({ state }))}
          title={recording ? "Stop keeping what apps run" : "Keep what apps run again"}
        >
          {recording ? (
            <span className="size-2 animate-pulse rounded-full" style={{ background: toneColor("red") }} />
          ) : (
            <Play />
          )}
          {recording ? "Recording" : "Paused"}
          {recording && <Pause className="text-muted-foreground" />}
        </Button>
        <IconButton
          label="Clear"
          disabled={!queries.length}
          onClick={() => {
            void window.veylens.clearGatewayQueries(tab.gatewayId)
            setQueries([])
            setSelected(null)
            setBurst(null)
          }}
        >
          <Trash2 />
        </IconButton>
      </div>

      {error && <ErrorNote className="m-2">{error}</ErrorNote>}

      <div className="flex shrink-0 gap-2 border-b bg-muted/30 p-2.5 dark:bg-background">
        <Stat icon={<Activity />} label="statements" value={queries.length.toLocaleString()} />
        <Stat icon={<Layers />} label="distinct" value={distinct.toLocaleString()} />
        <Stat icon={<Timer />} label="in the database" value={duration(totalMs)} />
        <Stat icon={<Repeat />} label="N+1 bursts" value={String(bursts.length)} tone={bursts.length ? "red" : "green"} />
        <Stat icon={<Gauge />} label={`over ${SLOW_MS} ms`} value={String(slow.length)} tone={slow.length ? "amber" : "green"} />
        <Stat icon={<CircleAlert />} label="errors" value={String(errors)} tone={errors ? "red" : "green"} />
      </div>

      {queries.length === 0 ? (
        <EmptyState icon={<Activity />}>
          {gateway?.enabled === false
            ? `"${name}" is off. Turn it on in Settings › Gateways, point the app at 127.0.0.1:${gateway.port}, and use it.`
            : recording
              ? `Waiting for the app. Point it at 127.0.0.1:${gateway?.port ?? "…"} and use it: every statement it runs shows here, with N+1 bursts and slow ones picked out. Kept in memory only.`
              : "Paused: nothing is being kept."}
        </EmptyState>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="list" minSize={360} className="flex min-w-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <div role="tablist" aria-label="View" className="flex gap-0.5 rounded-md bg-muted p-0.5">
                <ViewTab label="Live" count={queries.length} active={view === "live"} onClick={() => setView("live")} />
                <ViewTab label="Grouped" count={distinct} active={view === "grouped"} onClick={() => setView("grouped")} />
                <ViewTab
                  label="Issues"
                  count={bursts.length + slow.length}
                  tone={bursts.length ? "red" : "amber"}
                  active={view === "issues"}
                  onClick={() => setView("issues")}
                />
              </div>
                  <div className="relative w-56 min-w-0">
                    <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Filter by SQL…"
                      aria-label="Filter by SQL"
                      spellCheck={false}
                      className="h-7 pl-7 text-xs shadow-none md:text-xs"
                    />
                  </div>
                  {/* One burst's statements, from its "Show them": only the
                      lists of every statement are narrowed to it. */}
                  {burst && narrowed && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2 text-[11px]">
                      {burst.label}
                      <IconButton label="Show everything" onClick={() => setBurst(null)}>
                        <X />
                      </IconButton>
                    </span>
                  )}
                  <span className="flex-1" />
                  {/* The tabs carry the totals; this says only what a filter or
                      the row limit leaves out. */}
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {view === "live" && filtered.length > LIVE_ROWS
                      ? `latest ${LIVE_ROWS} of ${filtered.length.toLocaleString()}`
                      : needle || (burst && narrowed)
                        ? `${matches.toLocaleString()} match`
                        : ""}
                  </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {view === "live" && (
                <LiveList queries={filtered} repeated={repeated} selected={selected?.id ?? null} onSelect={setSelected} />
              )}
              {view === "grouped" && <GroupedList groups={groups} selected={selected?.id ?? null} onSelect={setSelected} />}
              {view === "issues" && (
                <IssueList
                  kind={issueKind}
                  onKind={setIssueKind}
                  bursts={shownBursts}
                  slow={shownSlow}
                  filtered={!!needle}
                  selected={selected?.id ?? null}
                  onSelect={setSelected}
                  onAsk={askBurst}
                  onShowBurst={(item) => {
                    setBurst({
                      ids: new Set([...(item.trigger ? [item.trigger.id] : []), ...item.queries.map((query) => query.id)]),
                      label: `${item.queries.length}× on #${item.session}`,
                    })
                    setView("live")
                  }}
                />
              )}
            </div>
          </ResizablePanel>
          {selected && (
            <>
              <ResizableHandle />
              <ResizablePanel id="detail" defaultSize={400} minSize={300} maxSize="75%">
                <Detail query={selected} group={groupOf(selected)} onClose={() => setSelected(null)} onAsk={askQuery} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}
    </div>
  )
}
