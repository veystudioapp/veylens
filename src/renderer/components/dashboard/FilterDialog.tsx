import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartColumnDecreasing,
  ChartLine,
  ChartNoAxesCombined,
  ChartPie,
  ChartScatter,
  Funnel,
  Gauge,
  Grid3x3,
  Hash,
  LayoutGrid,
  ListChecks,
  ListFilter,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Table2,
  ToggleRight,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Type,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import {
  DATE_PRESETS,
  FILTER_KINDS,
  type ChartType,
  TEXT_MATCHES,
  type DashboardFilter,
  type DashboardTile,
  type DatePreset,
  type Engine,
  type FilterKind,
  type TextMatch,
  type Tone,
} from "@shared/api"
import { DATE_PRESET_LABELS, filterParams, numberOrNull, validParamName } from "@shared/params"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { SqlText, SqlTextarea } from "../sql-code"
import { errorMessage, useStore } from "@/lib/store"
import { IconTile } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { CopyButton } from "../copy-button"
import { ErrorNote } from "../state-view"

const TILE_ICON: Record<ChartType, LucideIcon> = {
  bar: ChartColumn,
  hbar: ChartBar,
  line: ChartLine,
  area: ChartArea,
  combo: ChartNoAxesCombined,
  scatter: ChartScatter,
  pie: ChartPie,
  donut: ChartPie,
  treemap: LayoutGrid,
  funnel: Funnel,
  waterfall: ChartColumnDecreasing,
  stat: Hash,
  kpi: TrendingUp,
  progress: Gauge,
  pivot: Grid3x3,
  table: Table2,
}

/** Past this many, the tiles a filter narrows wait behind "more". */
const USERS_SHOWN = 6

/** The tiles a filter narrows, each a chip with its form, or a warning that none is. */
function UsedBy({ tiles }: { tiles: DashboardTile[] }) {
  const [all, setAll] = useState(false)
  if (tiles.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--tone-amber)]">
        <TriangleAlert className="size-3.5 shrink-0" />
        No tile uses it yet, so it narrows nothing.
      </p>
    )
  }
  const shown = all ? tiles : tiles.slice(0, USERS_SHOWN)
  const hidden = tiles.length - shown.length
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted-foreground">
        Narrows{" "}
        <span className="font-medium text-foreground tabular-nums">
          {tiles.length} {tiles.length === 1 ? "tile" : "tiles"}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((tile) => {
          const Icon = tile.chart ? TILE_ICON[tile.chart.type] : Type
          const title = tile.title.trim() || "Untitled"
          return (
            <li
              key={tile.id}
              title={title}
              className="flex h-6 max-w-64 items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-foreground"
            >
              <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{title}</span>
            </li>
          )
        })}
        {(hidden > 0 || (all && tiles.length > USERS_SHOWN)) && (
          <li>
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {all ? "Show fewer" : `+${hidden} more`}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

type Entry = {
  /** Stable while the dialog is open, for a filter not yet saved too. */
  key: string
  filter: DashboardFilter
  /** Its parameter name was typed, so the label no longer writes it. */
  named: boolean
}

type Choices =
  | { state: "running" }
  | { state: "done"; options: string[]; more: boolean }
  | { state: "failed"; error: string }

const KIND: Record<FilterKind, { label: string; icon: LucideIcon; tone: Tone; about: string; base: string }> = {
  date_range: {
    label: "Date range",
    icon: CalendarRange,
    tone: "blue",
    about: "Last 30 days, this quarter… as a start and an end",
    base: "date",
  },
  select: { label: "Choice", icon: ListFilter, tone: "teal", about: "One value of a list a query gives", base: "choice" },
  multi_select: {
    label: "Multi-choice",
    icon: ListChecks,
    tone: "green",
    about: "Several values of that list, as IN ( … )",
    base: "choices",
  },
  text: { label: "Text search", icon: Search, tone: "amber", about: "Words typed, matched with LIKE", base: "q" },
  number_range: {
    label: "Number range",
    icon: Hash,
    tone: "orange",
    about: "From and to, either left open",
    base: "amount",
  },
  toggle: { label: "Toggle", icon: ToggleRight, tone: "pink", about: "Yes, No or All", base: "flag" },
}

const LABEL_EXAMPLE: Record<FilterKind, string> = {
  date_range: "Order date",
  select: "Country",
  multi_select: "Order status",
  text: "Customer name",
  number_range: "Order total",
  toggle: "VIP only",
}

const MATCH_LABEL: Record<TextMatch, string> = { contains: "Contains", starts: "Starts with", exact: "Exactly" }

/** A new filter of a kind, opening on All. */
function blank(kind: FilterKind, name: string): DashboardFilter {
  const base = { id: "", name, label: "" }
  switch (kind) {
    case "date_range":
      return { ...base, kind, label: "Date", preset: "90d", from: null, to: null }
    case "select":
      return { ...base, kind, optionsSql: "", value: null }
    case "multi_select":
      return { ...base, kind, optionsSql: "", values: [] }
    case "text":
      return { ...base, kind, match: "contains", value: null }
    case "number_range":
      return { ...base, kind, min: null, max: null }
    case "toggle":
      return { ...base, kind, value: null }
  }
}

/** How a tile's SQL would use a filter, for a column guessed or named. */
function snippetOf(filter: DashboardFilter, engine: Engine): string {
  const name = filter.name
  switch (filter.kind) {
    case "date_range":
      return `WHERE true\n  [[AND ordered_at >= {{${name}_start}}]]\n  [[AND ordered_at < {{${name}_end}}]]`
    case "select":
      return `WHERE true\n  [[AND ${listedColumn(filter.optionsSql) ?? name} = {{${name}}}]]`
    case "multi_select":
      return `WHERE true\n  [[AND ${listedColumn(filter.optionsSql) ?? name} IN ({{${name}}})]]`
    case "text":
      // DuckDB's LIKE takes no escape character unless given one.
      return `WHERE true\n  [[AND name ${engine === "mysql" ? "LIKE" : "ILIKE"} {{${name}}}${engine === "duckdb" ? " ESCAPE '\\'" : ""}]]`
    case "number_range":
      return `WHERE true\n  [[AND total >= {{${name}_min}}]]\n  [[AND total <= {{${name}_max}}]]`
    case "toggle":
      return `WHERE true\n  [[AND vip = {{${name}}}]]`
  }
}

/** What else the snippet needs said. */
const SNIPPET_NOTE: Record<FilterKind, string> = {
  date_range: "Put your own date column in; the end is the day after the last, so use <.",
  select: "",
  multi_select: "Each value chosen is bound on its own: IN ($1, $2, $3).",
  text: "Put your own column in. The words arrive as a LIKE pattern, % and _ in them escaped.",
  number_range: "Put your own column in. Both ends are included; either may be left open.",
  toggle: "Put your own column in. Yes is 1 and No is 0 — read as true and false by Postgres.",
}

/** A label as a parameter name: "Trạng thái đơn hàng" is `trang_thai_don_hang`. */
export function paramNameOf(label: string): string {
  const name = label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return /^[0-9]/.test(name) ? `f_${name}` : name
}

/** The column a choices query lists, for an example clause. */
const listedColumn = (sql: string) =>
  /select\s+(?:distinct\s+)?([A-Za-z_][\w.]*)/i.exec(sql)?.[1]?.split(".").pop() ?? null

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold">{title}</h3>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </section>
  )
}

/** One choice among a few, as a rounded button. */
function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-full border px-3 text-xs transition-colors",
        on
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

/**
 * A dashboard's filters: the list on the left, in the order the bar shows
 * them; the one picked on the right, with what its choices are and how a
 * tile uses it. Saved all at once.
 */
export function FilterDialog({
  open,
  filters,
  connectionId,
  tiles,
  onClose,
  onSave,
}: {
  open: boolean
  filters: DashboardFilter[]
  connectionId: string
  /** To say which tiles use a filter. */
  tiles: DashboardTile[]
  onClose: () => void
  /** Rejects with why, which is shown here. */
  onSave: (filters: DashboardFilter[]) => Promise<void>
}) {
  const engine = useStore(
    (state) => state.connections.find((item) => item.id === connectionId)?.engine ?? "postgres"
  )
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, Choices>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const next = useRef(0)

  useEffect(() => {
    if (!open) return
    const loaded = filters.map((filter) => ({ key: `f${next.current++}`, filter, named: true }))
    setEntries(loaded)
    setSelected(loaded[0]?.key ?? null)
    setChoices({})
    setError(null)
  }, [filters, open])

  const index = entries.findIndex((entry) => entry.key === selected)
  const entry = index >= 0 ? entries[index]! : null

  const update = (key: string, change: (entry: Entry) => Entry) =>
    setEntries((current) => current.map((item) => (item.key === key ? change(item) : item)))

  // Every name, against the rest: what is wrong with each, if anything.
  const problems = new Map<string, string>()
  for (const item of entries) {
    const { name } = item.filter
    if (!name) problems.set(item.key, "It needs a parameter name.")
    else if (!validParamName(name)) {
      problems.set(item.key, "Letters, digits and underscores, starting with a letter.")
    } else {
      const clash = entries.find(
        (other) =>
          other !== item &&
          filterParams(other.filter).some((param) => filterParams(item.filter).includes(param))
      )
      if (clash) problems.set(item.key, `Taken by "${clash.filter.label || clash.filter.name}".`)
    }
  }

  const add = (kind: FilterKind) => {
    const taken = new Set(entries.flatMap((item) => filterParams(item.filter)))
    const base = KIND[kind].base
    let name = base
    for (let n = 2; filterParams({ kind, name }).some((param) => taken.has(param)); n++) {
      name = `${base}${n}`
    }
    const key = `f${next.current++}`
    setEntries([...entries, { key, filter: blank(kind, name), named: false }])
    setSelected(key)
  }

  const move = (from: number, by: number) => {
    const to = from + by
    if (to < 0 || to >= entries.length) return
    const reordered = [...entries]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved!)
    setEntries(reordered)
  }

  const remove = (key: string) => {
    const at = entries.findIndex((item) => item.key === key)
    const rest = entries.filter((item) => item.key !== key)
    setEntries(rest)
    setSelected(rest[Math.min(at, rest.length - 1)]?.key ?? null)
  }

  const runChoices = async (key: string, sql: string) => {
    setChoices((current) => ({ ...current, [key]: { state: "running" } }))
    try {
      const result = await window.veylens.runQuery(connectionId, sql, true)
      const options = result.rows
        .map((row) => row[0])
        .filter((value): value is string => value !== null && value !== undefined)
      setChoices((current) => ({
        ...current,
        [key]: { state: "done", options: options.slice(0, 40), more: options.length > 40 || result.truncated },
      }))
    } catch (failure) {
      setChoices((current) => ({ ...current, [key]: { state: "failed", error: errorMessage(failure) } }))
    }
  }

  const save = async () => {
    const bad = entries.find((item) => problems.has(item.key))
    if (bad) {
      setSelected(bad.key)
      setError(`"${bad.filter.label || bad.filter.name || "A filter"}": ${problems.get(bad.key)}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(entries.map((item) => item.filter))
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const usedBy = (filter: DashboardFilter) =>
    tiles.filter((tile) =>
      filterParams(filter).some((param) => tile.sql.includes(`{{${param}}}`) || tile.drillSql?.includes(`{{${param}}}`))
    )

  const presets = DATE_PRESETS.filter((preset): preset is Exclude<DatePreset, "custom"> => preset !== "custom")

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="flex h-[min(640px,88vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b pr-12 pl-5">
          <IconTile tone="blue" size="md">
            <SlidersHorizontal />
          </IconTile>
          <div className="min-w-0">
            <DialogTitle className="text-[15px]">Dashboard filters</DialogTitle>
            <DialogDescription className="truncate text-xs">
              Each is a parameter every tile's SQL can use — and leave out while it is on All.
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The filters, in the bar's order. */}
          <div className="flex w-64 shrink-0 flex-col border-r bg-muted/30">
            <div className="flex h-9 items-center px-4 text-[11px] font-medium text-muted-foreground">
              <span className="flex-1">In the filter bar</span>
              <span className="tabular-nums">{entries.length}</span>
            </div>
            <div role="listbox" aria-label="Filters" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {entries.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No filters yet. Add a date range or a choice below.
                </p>
              )}
              {entries.map((item, at) => {
                const kind = KIND[item.filter.kind]
                const on = item.key === selected
                const problem = problems.get(item.key)
                return (
                  <div
                    key={item.key}
                    role="option"
                    aria-selected={on}
                    tabIndex={0}
                    onClick={() => setSelected(item.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setSelected(item.key)
                    }}
                    className={cn(
                      "group/filter flex items-center gap-2.5 rounded-md px-2 py-2 outline-offset-[-2px]",
                      on ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <IconTile tone={kind.tone} size="md">
                      <kind.icon />
                    </IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {item.filter.label || <span className="text-muted-foreground">Untitled</span>}
                      </div>
                      <div
                        className={cn(
                          "truncate font-mono text-[11px]",
                          problem ? "text-destructive" : "text-muted-foreground"
                        )}
                      >
                        {item.filter.name ? `{{${item.filter.name}}}` : "no name"}
                      </div>
                    </div>
                    <span className="flex flex-col opacity-0 group-hover/filter:opacity-100 group-focus-within/filter:opacity-100">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={at === 0}
                        onClick={(event) => {
                          event.stopPropagation()
                          move(at, -1)
                        }}
                        className="rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp className="size-3" />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={at === entries.length - 1}
                        onClick={(event) => {
                          event.stopPropagation()
                          move(at, 1)
                        }}
                        className="rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown className="size-3" />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="border-t p-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" className="w-full">
                      <Plus />
                      Add filter
                    </Button>
                  }
                />
                <DropdownMenuContent align="start" side="top" className="w-64">
                  {FILTER_KINDS.map((kind) => {
                    const look = KIND[kind]
                    return (
                      <DropdownMenuItem key={kind} onClick={() => add(kind)} className="items-start py-1.5">
                        <IconTile tone={look.tone} size="sm">
                          <look.icon />
                        </IconTile>
                        <span>
                          <span className="block font-medium">{look.label}</span>
                          <span className="block text-[11px] text-muted-foreground">{look.about}</span>
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* The one picked. */}
          {!entry ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <IconTile tone="blue" size="lg">
                <SlidersHorizontal />
              </IconTile>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                A filter scopes every tile at once: a date range for the period,
                a choice for a status or a country.
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
              <div className="flex items-center gap-3">
                <IconTile tone={KIND[entry.filter.kind].tone} size="lg">
                  {(() => {
                    const Icon = KIND[entry.filter.kind].icon
                    return <Icon />
                  })()}
                </IconTile>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-muted-foreground">{KIND[entry.filter.kind].label}</div>
                  <div className="truncate text-[15px] font-semibold">
                    {entry.filter.label || "Untitled filter"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => remove(entry.key)}
                >
                  <Trash2 />
                  Remove
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="filter-label" className="text-xs font-medium">
                    Label
                  </Label>
                  <Input
                    id="filter-label"
                    aria-label="Filter label"
                    autoFocus={!entry.named}
                    value={entry.filter.label}
                    placeholder={LABEL_EXAMPLE[entry.filter.kind]}
                    onChange={(event) => {
                      const label = event.target.value
                      update(entry.key, (item) => ({
                        ...item,
                        filter: {
                          ...item.filter,
                          label,
                          // Until it is typed, the name follows the label.
                          ...(item.named ? {} : { name: paramNameOf(label) || item.filter.name }),
                        },
                      }))
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">Shown in the filter bar.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="filter-name" className="text-xs font-medium">
                    Parameter name
                  </Label>
                  <Input
                    id="filter-name"
                    aria-label="Parameter name"
                    aria-invalid={problems.has(entry.key) || undefined}
                    value={entry.filter.name}
                    spellCheck={false}
                    onChange={(event) =>
                      update(entry.key, (item) => ({
                        ...item,
                        named: true,
                        filter: { ...item.filter, name: event.target.value.trim() },
                      }))
                    }
                    className="font-mono text-[13px]"
                  />
                  <p
                    className={cn(
                      "text-[11px]",
                      problems.has(entry.key) ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {problems.get(entry.key) ??
                      `In SQL: ${filterParams(entry.filter)
                        .map((param) => `{{${param}}}`)
                        .join(" and ")}`}
                  </p>
                </div>
              </div>

              {entry.filter.kind === "date_range" && (
                <Section title="Opens on" hint="The range the dashboard starts with; anyone can change it in the bar.">
                  <div role="radiogroup" aria-label="Default range" className="flex flex-wrap gap-1.5">
                    {presets.map((preset) => {
                      const filter = entry.filter as Extract<DashboardFilter, { kind: "date_range" }>
                      const on = (filter.preset === "custom" ? "90d" : filter.preset) === preset
                      return (
                        <Pill
                          key={preset}
                          on={on}
                          onClick={() =>
                            update(entry.key, (item) => ({
                              ...item,
                              filter: { ...filter, preset },
                            }))
                          }
                        >
                          {DATE_PRESET_LABELS[preset]}
                        </Pill>
                      )
                    })}
                  </div>
                </Section>
              )}
              {(entry.filter.kind === "select" || entry.filter.kind === "multi_select") && (
                <Section
                  title="Choices"
                  hint={
                    entry.filter.kind === "multi_select"
                      ? "A query whose first column lists them; any number can be ticked in the bar."
                      : "A query whose first column lists them; run when the dashboard opens."
                  }
                >
                  <div className="relative overflow-hidden rounded-lg border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                    <SqlTextarea
                      aria-label="Choices query"
                      value={(entry.filter as Extract<DashboardFilter, { kind: "select" | "multi_select" }>).optionsSql}
                      spellCheck={false}
                      placeholder="SELECT DISTINCT country FROM customers ORDER BY 1"
                      onChange={(event) => {
                        const optionsSql = event.target.value
                        update(entry.key, (item) => ({
                          ...item,
                          filter: { ...(item.filter as Extract<DashboardFilter, { kind: "select" | "multi_select" }>), optionsSql },
                        }))
                      }}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault()
                          void runChoices(entry.key, event.currentTarget.value)
                        }
                      }}
                      className="block min-h-20 w-full resize-y bg-muted/30 px-3 py-2.5 font-mono text-xs leading-5 outline-none"
                    />
                    <div className="flex items-center gap-2 border-t bg-muted/40 px-2 py-1.5">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={
                          !(entry.filter as Extract<DashboardFilter, { kind: "select" | "multi_select" }>).optionsSql.trim() ||
                          choices[entry.key]?.state === "running"
                        }
                        onClick={() =>
                          void runChoices(
                            entry.key,
                            (entry.filter as Extract<DashboardFilter, { kind: "select" | "multi_select" }>).optionsSql
                          )
                        }
                      >
                        {choices[entry.key]?.state === "running" ? <Spinner className="size-3" /> : <Play />}
                        Run
                      </Button>
                      <span className="text-[11px] text-muted-foreground">⌘↵ to see the choices it gives</span>
                    </div>
                  </div>
                  {(() => {
                    const shown = choices[entry.key]
                    if (!shown || shown.state === "running") return null
                    if (shown.state === "failed") return <ErrorNote mono>{shown.error}</ErrorNote>
                    if (shown.options.length === 0) {
                      return <p className="text-xs text-muted-foreground">It gives no choices.</p>
                    }
                    return (
                      <div className="flex flex-wrap gap-1">
                        <span className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
                          All
                        </span>
                        {shown.options.map((option) => (
                          <span key={option} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                            {option}
                          </span>
                        ))}
                        {shown.more && <span className="px-1 text-[11px] text-muted-foreground">and more</span>}
                      </div>
                    )
                  })()}
                </Section>
              )}
              {entry.filter.kind === "text" && (
                <Section
                  title="Matches"
                  hint={
                    (entry.filter as Extract<DashboardFilter, { kind: "text" }>).match === "exact"
                      ? "The words as typed: use it with = or with LIKE and your own wildcards."
                      : "What is typed, matched anywhere or at the start; case-insensitive with ILIKE on Postgres."
                  }
                >
                  <div role="radiogroup" aria-label="Matches" className="flex flex-wrap gap-1.5">
                    {TEXT_MATCHES.map((match) => {
                      const filter = entry.filter as Extract<DashboardFilter, { kind: "text" }>
                      return (
                        <Pill
                          key={match}
                          on={filter.match === match}
                          onClick={() => update(entry.key, (item) => ({ ...item, filter: { ...filter, match } }))}
                        >
                          {MATCH_LABEL[match]}
                        </Pill>
                      )
                    })}
                  </div>
                </Section>
              )}
              {entry.filter.kind === "number_range" && (
                <Section title="Opens with" hint="Blank is open: the dashboard starts on All.">
                  <div className="flex items-center gap-2">
                    {(["min", "max"] as const).map((end, at) => {
                      const filter = entry.filter as Extract<DashboardFilter, { kind: "number_range" }>
                      const text = filter[end] ?? ""
                      return (
                        <span key={end} className="contents">
                          {at === 1 && <span className="text-muted-foreground">to</span>}
                          <Input
                            aria-label={end === "min" ? "From" : "To"}
                            inputMode="decimal"
                            value={text}
                            placeholder={end === "min" ? "From" : "To"}
                            aria-invalid={(text.trim() !== "" && numberOrNull(text) === null) || undefined}
                            onChange={(event) =>
                              update(entry.key, (item) => ({
                                ...item,
                                filter: { ...filter, [end]: event.target.value || null },
                              }))
                            }
                            className="w-32 text-right tabular-nums"
                          />
                        </span>
                      )
                    })}
                  </div>
                </Section>
              )}
              {entry.filter.kind === "toggle" && (
                <Section title="Opens on" hint="Anyone can switch it in the bar.">
                  <div role="radiogroup" aria-label="Opens on" className="flex flex-wrap gap-1.5">
                    {([null, true, false] as const).map((value) => {
                      const filter = entry.filter as Extract<DashboardFilter, { kind: "toggle" }>
                      return (
                        <Pill
                          key={String(value)}
                          on={filter.value === value}
                          onClick={() => update(entry.key, (item) => ({ ...item, filter: { ...filter, value } }))}
                        >
                          {value === null ? "All" : value ? "Yes" : "No"}
                        </Pill>
                      )
                    })}
                  </div>
                </Section>
              )}

              {(() => {
                const filter = entry.filter
                const snippet = snippetOf(filter, engine)
                const users = usedBy(filter)
                return (
                  <Section
                    title="In a tile's SQL"
                    hint={
                      <>
                        {SNIPPET_NOTE[filter.kind] && `${SNIPPET_NOTE[filter.kind]} `}A
                        clause in <code className="font-mono">[[ … ]]</code> is left out while
                        the filter is on All. Values are bound, never pasted into the SQL.
                      </>
                    }
                  >
                    <div className="relative rounded-lg border bg-muted/30">
                      <pre className="overflow-x-auto px-3 py-2.5 pr-10 font-mono text-xs leading-5"><SqlText text={snippet} /></pre>
                      <span className="absolute top-1.5 right-1.5">
                        <CopyButton text={snippet} />
                      </span>
                    </div>
                    <UsedBy key={entry.key} tiles={users} />
                  </Section>
                )
              })()}
            </div>
          )}
        </div>

        <div className="flex h-14 shrink-0 items-center gap-2 border-t bg-muted/40 px-5">
          <div className="min-w-0 flex-1">{error && <ErrorNote className="py-1">{error}</ErrorNote>}</div>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="size-3.5" />}
            Save filters
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
