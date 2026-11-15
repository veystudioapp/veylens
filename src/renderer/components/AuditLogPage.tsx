import {
  Ban,
  BookOpen,
  ChevronRight,
  Copy,
  CircleX,
  Database,
  Download,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Pencil,
  Play,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  User,
  Wrench,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type { AuditAction, AuditEntry, Tone } from "@shared/api"

import { Button } from "@/components/ui/button"
import { downloadCsv } from "@/lib/export"
import { errorMessage, useStore } from "@/lib/store"
import { IconTile, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"
import { IconButton } from "./icon-button"
import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"

const ACTION_LOOK: Record<AuditAction, { label: string; icon: LucideIcon; tone: Tone }> = {
  query: { label: "Query", icon: Play, tone: "blue" },
  write: { label: "Statement", icon: Pencil, tone: "orange" },
  edit_rows: { label: "Row edits", icon: Pencil, tone: "orange" },
  plan: { label: "Plan", icon: ListChecks, tone: "orange" },
  dashboard: { label: "Dashboard", icon: LayoutDashboard, tone: "orange" },
  context: { label: "Business context", icon: BookOpen, tone: "green" },
  connection: { label: "Connection", icon: Database, tone: "teal" },
  permissions: { label: "Permissions", icon: ShieldCheck, tone: "green" },
  tools: { label: "Tools", icon: Wrench, tone: "amber" },
}

/** What can be picked to narrow the list. */
const KINDS = {
  all: "Everything",
  changes: "Changes to data",
  reads: "Reads",
  stopped: "Refused, declined or failed",
  settings: "Settings & dashboards",
}
type Kind = keyof typeof KINDS

const ACTORS = { all: "Anyone", you: "You", assistant: "Assistant" }
type Actor = keyof typeof ACTORS

const CHANGES = new Set<AuditAction>(["write", "edit_rows", "plan"])
const SETTINGS = new Set<AuditAction>(["connection", "permissions", "tools", "dashboard", "context"])

function matchesKind(entry: AuditEntry, kind: Kind): boolean {
  switch (kind) {
    case "all":
      return true
    case "changes":
      return CHANGES.has(entry.action)
    case "reads":
      return entry.action === "query"
    case "stopped":
      return entry.status !== "ok"
    case "settings":
      return SETTINGS.has(entry.action)
  }
}

const STATUS_LOOK: Record<Exclude<AuditEntry["status"], "ok">, { label: string; tone: Tone; icon: LucideIcon }> = {
  failed: { label: "Failed", tone: "red", icon: CircleX },
  refused: { label: "Refused", tone: "amber", icon: Ban },
  declined: { label: "Declined", tone: "gray", icon: Ban },
}

/** Today, Yesterday, then the date. */
function dayOf(at: number, now: Date): string {
  const day = new Date(at)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= start) return "Today"
  if (at >= start - 86_400_000) return "Yesterday"
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })
}

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

function Pill({ tone, icon: Icon, children }: { tone: Tone; icon?: LucideIcon; children: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] leading-[18px] font-medium"
      style={{ color: toneColor(tone), background: `color-mix(in oklch, ${toneColor(tone)} 13%, transparent)` }}
    >
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  )
}

/**
 * Settings › Audit log: what was run, changed or refused through this app —
 * by you in a SQL tab or the grid, by the assistant through its tools — and
 * changes to connections, permissions, tools and dashboards. Newest first,
 * by day, narrowed by who, what and where; each opens to its SQL and how it
 * ended. Kept on this machine only.
 */
export function AuditLogPage() {
  const connections = useStore((state) => state.connections)
  const openQuery = useStore((state) => state.openQuery)
  const selectChat = useStore((state) => state.selectChat)
  const openSettings = useStore((state) => state.openSettings)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<Kind>("all")
  const [actor, setActor] = useState<Actor>("all")
  const [connection, setConnection] = useState<string>("all")
  const [open, setOpen] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)

  useEffect(() => {
    let live = true
    window.veydata.listAudit().then(
      (found) => live && setEntries(found),
      (failure) => live && setError(errorMessage(failure))
    )
    // New entries come in as they happen.
    const stop = window.veydata.onChatEvent((event) => {
      if (event.type === "audit") setEntries((current) => (current ? [event.entry, ...current] : current))
    })
    return () => {
      live = false
      stop()
    }
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (entries ?? []).filter(
      (entry) =>
        matchesKind(entry, kind) &&
        (actor === "all" || entry.actor === actor) &&
        (connection === "all" || entry.connectionId === connection) &&
        (!needle ||
          [entry.summary, entry.sql, entry.detail, entry.connectionName, entry.tool]
            .some((text) => text?.toLowerCase().includes(needle)))
    )
  }, [entries, query, kind, actor, connection])

  const shown = filtered.slice(0, limit)
  const now = new Date()
  const days: { day: string; entries: AuditEntry[] }[] = []
  for (const entry of shown) {
    const day = dayOf(entry.at, now)
    if (days.at(-1)?.day !== day) days.push({ day, entries: [] })
    days.at(-1)!.entries.push(entry)
  }

  // Connections the log has seen, removed ones included, by their names then.
  const places = useMemo(() => {
    const names = new Map<string, string>()
    for (const entry of entries ?? []) {
      if (entry.connectionId && !names.has(entry.connectionId)) {
        names.set(entry.connectionId, entry.connectionName ?? entry.connectionId)
      }
    }
    for (const item of connections) names.set(item.id, item.name)
    return { all: "All connections", ...Object.fromEntries(names) } as Record<string, string>
  }, [entries, connections])

  const exportCsv = () =>
    downloadCsv(`Vey Data audit log ${new Date().toISOString().slice(0, 10)}`, {
      columns: ["time", "actor", "action", "tool", "connection", "status", "summary", "sql", "rows", "ms", "detail"].map(
        (name) => ({ name, type: "text", kind: "text" as const })
      ),
      rows: filtered.map((entry) => [
        new Date(entry.at).toISOString(),
        entry.actor,
        entry.action,
        entry.tool ?? null,
        entry.connectionName,
        entry.status,
        entry.summary,
        entry.sql ?? null,
        entry.rows === undefined ? null : String(entry.rows),
        entry.ms === undefined ? null : String(entry.ms),
        entry.detail ?? null,
      ]),
    })

  const filtering = query.trim() !== "" || kind !== "all" || actor !== "all" || connection !== "all"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b py-4 pr-14 pl-6">
        <h2 className="text-[15px] font-semibold tracking-tight">Audit log</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          What was run, changed or refused through Vey Data — by you in a SQL tab or a
          table, and by the assistant through its tools — and changes to connections,
          permissions and tools. Browsing a table and dashboards refreshing are not
          kept. The last 5,000 entries stay on this machine only.
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-6 py-2.5">
        <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search the log"
            value={query}
            placeholder="Search SQL, tables, errors"
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
        <SimpleSelect label="Kind" heading="Show" value={kind} items={KINDS} onChange={setKind} className="justify-between" />
        <SimpleSelect label="Who" heading="By" value={actor} items={ACTORS} onChange={setActor} className="justify-between" />
        <SimpleSelect
          label="Connection"
          heading="Connection"
          value={connection}
          items={places}
          onChange={setConnection}
          className="max-w-44 justify-between"
        />
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={filtered.length === 0} onClick={exportCsv}>
          <Download />
          Export CSV
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          disabled={!entries?.length}
          onClick={async () => {
            if (
              await confirm({
                title: "Clear the audit log?",
                description: `All ${entries?.length.toLocaleString()} entries are deleted from this machine. This cannot be undone.`,
                action: "Clear log",
                destructive: true,
              })
            ) {
              await window.veydata.clearAudit()
              setEntries([])
            }
          }}
        >
          <Trash2 />
          Clear
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6" aria-label="Audit entries">
        {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
        {entries && entries.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
            <IconTile tone="green" size="md">
              <ShieldCheck />
            </IconTile>
            <p className="text-[13px] font-medium">Nothing yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Statements from a SQL tab, saved row edits, the assistant&apos;s queries and
              changes, and edits to connections and permissions will be listed here.
            </p>
          </div>
        )}
        {entries && entries.length > 0 && filtered.length === 0 && (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Nothing matches.{" "}
            {filtering && (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => {
                  setQuery("")
                  setKind("all")
                  setActor("all")
                  setConnection("all")
                }}
              >
                Clear the filters
              </button>
            )}
          </p>
        )}

        {days.map((group) => (
          <section key={group.day} aria-label={group.day} className="pt-4">
            <h3 className="sticky top-0 z-[1] -mx-6 bg-background/95 px-6 py-1.5 text-[11px] font-medium text-muted-foreground backdrop-blur">
              {group.day}
            </h3>
            <ul className="overflow-hidden rounded-lg border">
              {group.entries.map((entry) => {
                const look = ACTION_LOOK[entry.action] ?? ACTION_LOOK.query
                const expanded = open === entry.id
                const status = entry.status === "ok" ? null : STATUS_LOOK[entry.status]
                return (
                  <li key={entry.id} className="border-b last:border-b-0">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : entry.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50",
                        expanded && "bg-muted/40"
                      )}
                    >
                      <ChevronRight
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
                      />
                      <span className="w-[62px] shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {timeOf(entry.at)}
                      </span>
                      <IconTile tone={look.tone} size="xs">
                        <look.icon />
                      </IconTile>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs">{entry.summary}</span>
                        {entry.sql && !expanded && (
                          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                            {entry.sql.replace(/\s+/g, " ").slice(0, 160)}
                          </span>
                        )}
                      </span>
                      {status && <Pill tone={status.tone} icon={status.icon}>{status.label}</Pill>}
                      {entry.rows !== undefined && entry.status === "ok" && (
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {entry.rows.toLocaleString()} {entry.rows === 1 ? "row" : "rows"}
                        </span>
                      )}
                      {entry.connectionName && (
                        <span className="max-w-28 shrink-0 truncate rounded bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground">
                          {entry.connectionName}
                        </span>
                      )}
                      <span
                        className="flex w-[78px] shrink-0 items-center justify-end gap-1 text-[11px] text-muted-foreground"
                        title={entry.actor === "you" ? "Done by you" : "Done by the assistant"}
                      >
                        {entry.actor === "you" ? (
                          <User className="size-3" />
                        ) : (
                          <Sparkles className="size-3 text-pink-500" />
                        )}
                        {entry.actor === "you" ? "You" : "Assistant"}
                      </span>
                    </button>
                    {expanded && (
                      <div className="flex flex-col gap-2 border-t bg-muted/20 px-3 py-3 pl-[46px]">
                        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[11px]">
                          <dt className="text-muted-foreground">When</dt>
                          <dd className="tabular-nums">{new Date(entry.at).toLocaleString()}</dd>
                          <dt className="text-muted-foreground">Kind</dt>
                          <dd>
                            {look.label}
                            {entry.tool && <span className="font-mono text-muted-foreground"> · {entry.tool}</span>}
                          </dd>
                          {entry.ms !== undefined && (
                            <>
                              <dt className="text-muted-foreground">Took</dt>
                              <dd className="tabular-nums">{entry.ms.toLocaleString()} ms</dd>
                            </>
                          )}
                        </dl>
                        {entry.sql && (
                          <div className="relative">
                            <pre className="max-h-64 overflow-auto rounded-md border bg-background p-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap">
                              {entry.sql}
                            </pre>
                          </div>
                        )}
                        {entry.detail && (
                          <pre
                            className={cn(
                              "max-h-40 overflow-auto rounded-md px-2.5 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap",
                              entry.status === "ok" ? "bg-muted/60 text-muted-foreground" : "bg-destructive/5 text-destructive"
                            )}
                          >
                            {entry.detail}
                          </pre>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {entry.sql && entry.connectionId && entry.action !== "edit_rows" &&
                            connections.some((item) => item.id === entry.connectionId) && (
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => {
                                  openQuery(entry.connectionId!, { sql: entry.sql, title: "From the audit log" })
                                  openSettings(null)
                                }}
                              >
                                <SquareTerminal />
                                Open in a SQL tab
                              </Button>
                            )}
                          {entry.chatId && (
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => {
                                void selectChat(entry.chatId!)
                                openSettings(null)
                              }}
                            >
                              <MessageSquare />
                              Open the chat
                            </Button>
                          )}
                          {entry.sql && (
                            <IconButton
                              label="Copy SQL"
                              onClick={() => void navigator.clipboard.writeText(entry.sql!)}
                            >
                              <Copy />
                            </IconButton>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        {filtered.length > limit && (
          <div className="flex justify-center pt-4">
            <Button variant="outline" size="sm" onClick={() => setLimit(limit + 300)}>
              Show older ({(filtered.length - limit).toLocaleString()} more)
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
