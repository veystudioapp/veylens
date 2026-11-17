import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Focus,
  Key,
  Rows3,
  X,
  LayoutGrid,
  Link2,
  Maximize,
  Minus,
  Network,
  Plus,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"

import type { DiagramLink, DiagramTable, SchemaDiagram } from "@shared/api"
import {
  HEADER_HEIGHT,
  inferLinks,
  layoutDiagram,
  linkCounts,
  linkPath,
  nodeHeight,
  relatedTo,
  ROW_HEIGHT,
  rowY,
  shownColumns,
  tableKeyOf,
  toMermaid,
  type Box,
  type ColumnMode,
} from "@shared/diagram"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { errorMessage, useStore, type Tab } from "@/lib/store"
import { IconTile, KIND_TONE, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { IconButton } from "./icon-button"
import { SimpleSelect } from "./simple-select"
import { EmptyState, ErrorNote, Loading } from "./state-view"
import { Switch } from "./switch"

type DiagramTab = Extract<Tab, { kind: "diagram" }>

type View = { x: number; y: number; scale: number }

const MIN_SCALE = 0.15
const MAX_SCALE = 2
const FIT_PADDING = 40
/** Past this many tables a diagram opens on their keys only. */
const KEYS_ONLY_PAST = 25

/** Roughly what fits in `width` pixels of 12px text. */
const clip = (text: string, width: number) => {
  const most = Math.max(1, Math.floor(width / 6.6))
  return text.length > most ? `${text.slice(0, most - 1)}…` : text
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

function TableNode({
  table,
  box,
  columns,
  foreign,
  qualified,
  state,
  onPointerDown,
  onOpen,
  onHover,
}: {
  table: DiagramTable
  box: Box
  columns: DiagramTable["columns"]
  /** Columns of this table that a key goes out from. */
  foreign: Set<string>
  qualified: boolean
  /** `picked` is the table clicked; `lit`, one linked to it or hovered. */
  state: "normal" | "lit" | "dim" | "match" | "picked"
  onPointerDown: (event: ReactPointerEvent) => void
  onOpen: () => void
  onHover: (on: boolean) => void
}) {
  const tone = table.kind === "view" ? KIND_TONE.view : KIND_TONE.table
  const colour = toneColor(tone)
  const Icon = table.kind === "view" ? Eye : Table2
  const title = qualified ? `${table.schema}.${table.name}` : table.name
  return (
    <g
      transform={`translate(${box.x} ${box.y})`}
      opacity={state === "dim" ? 0.35 : 1}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerDown={onPointerDown}
      onDoubleClick={onOpen}
      style={{ transition: "opacity 120ms", cursor: "grab" }}
    >
      <rect
        width={box.width}
        height={box.height}
        rx={8}
        fill="var(--card)"
        stroke={state === "lit" || state === "match" || state === "picked" ? colour : "var(--border)"}
        strokeWidth={state === "match" || state === "picked" ? 2 : 1}
        style={{ filter: "drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.06))" }}
      />
      <g>
        <title>{`${table.kind} ${table.schema}.${table.name} — click to select, double-click to open`}</title>
        <path
          d={`M 0 8 A 8 8 0 0 1 8 0 H ${box.width - 8} A 8 8 0 0 1 ${box.width} 8 V ${HEADER_HEIGHT} H 0 Z`}
          fill={`color-mix(in oklch, ${colour} 12%, var(--card))`}
        />
        <Icon x={10} y={9} width={14} height={14} color={colour} />
        <text x={30} y={20.5} fontSize={12.5} fontWeight={600} fill="var(--foreground)">
          {clip(title, box.width - 44)}
        </text>
        {columns.length > 0 && (
          <line x1={0} x2={box.width} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} stroke="var(--border)" />
        )}
      </g>
      {columns.map((column, index) => {
        const y = HEADER_HEIGHT + index * ROW_HEIGHT
        const isForeign = foreign.has(column.name)
        return (
          <g key={column.name} transform={`translate(0 ${y})`}>
            <title>{`${column.name} ${column.type}${column.nullable ? "" : " not null"}${column.primaryKey ? " · primary key" : ""}${isForeign ? " · foreign key" : ""}`}</title>
            {column.primaryKey ? (
              <Key x={10} y={5} width={12} height={12} color={toneColor("amber")} />
            ) : isForeign ? (
              <Link2 x={10} y={5} width={12} height={12} color={toneColor("blue")} />
            ) : null}
            <text
              x={28}
              y={15}
              fontSize={12}
              fill="var(--foreground)"
              fontWeight={column.primaryKey ? 600 : 400}
            >
              {clip(column.name, box.width * 0.55 - 28)}
            </text>
            <text
              x={box.width - 10}
              y={15}
              fontSize={11}
              textAnchor="end"
              fill="var(--muted-foreground)"
              fontFamily="var(--font-mono, ui-monospace, monospace)"
            >
              {clip(column.type, box.width * 0.42 - 10)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/**
 * Which tables the diagram draws: each on or off, found by name, or all,
 * none, the ones with keys, or a few and what they link to.
 */
function TablePicker({
  tables,
  links,
  hidden,
  primary,
  onChange,
  onShowOnly,
}: {
  tables: DiagramTable[]
  links: DiagramLink[]
  hidden: Set<string>
  /** The diagram's own schema: tables of another are named with theirs. */
  primary: string
  onChange: (hidden: Set<string>) => void
  onShowOnly: (keys: string[]) => void
}) {
  const [query, setQuery] = useState("")
  const counts = useMemo(() => linkCounts(links), [links])
  const needle = query.trim().toLowerCase()
  const label = (table: DiagramTable) => (table.schema === primary ? table.name : `${table.schema}.${table.name}`)
  const listed = useMemo(
    () =>
      [...tables]
        .sort((a, b) => label(a).localeCompare(label(b)))
        .filter((table) => !needle || label(table).toLowerCase().includes(needle)),
    // `label` reads only `primary`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables, needle, primary]
  )
  const shownCount = tables.length - tables.filter((table) => hidden.has(tableKeyOf(table))).length

  const toggle = (key: string) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={hidden.size ? `Tables, ${shownCount} of ${tables.length} shown` : "Tables"}
            className={cn(hidden.size > 0 && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
          >
            <Rows3 />
            {hidden.size > 0 ? `${shownCount} of ${tables.length}` : "Tables"}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 gap-0 p-0" aria-label="Tables">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Find a table to show or hide"
            value={query}
            placeholder="Find a table"
            className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
          />
          {needle && listed.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              title="Show only the tables found, and the ones their keys reach"
              onClick={() => onShowOnly(listed.map(tableKeyOf))}
            >
              Only these
            </Button>
          )}
        </div>
        <div className="flex max-h-80 flex-col overflow-y-auto overscroll-contain p-1" role="list">
          {listed.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No table matches “{query}”.</p>
          )}
          {listed.map((table) => {
            const key = tableKeyOf(table)
            const on = !hidden.has(key)
            const linked = counts.get(key) ?? 0
            return (
              <div
                key={key}
                role="listitem"
                onClick={() => toggle(key)}
                className="group/row flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted"
              >
                {table.kind === "view" ? (
                  <Eye className="size-3.5 shrink-0" style={{ color: toneColor(KIND_TONE.view) }} />
                ) : (
                  <Table2 className="size-3.5 shrink-0" style={{ color: toneColor(KIND_TONE.table) }} />
                )}
                <span className={cn("min-w-0 flex-1 truncate text-xs", !on && "text-muted-foreground")}>
                  {label(table)}
                </span>
                <button
                  type="button"
                  title={`Show only ${table.name} and the tables its keys reach`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onShowOnly([key])
                  }}
                  className="hidden shrink-0 rounded px-1 text-[11px] text-muted-foreground group-hover/row:block hover:bg-background hover:text-foreground"
                >
                  Only
                </button>
                <span
                  className="w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
                  title={`${linked} ${linked === 1 ? "key" : "keys"} to or from it`}
                >
                  {linked || ""}
                </span>
                <Switch checked={on} label={`Show ${table.name}`} onChange={() => toggle(key)} />
              </div>
            )
          })}
        </div>
        <div className="flex h-10 items-center gap-1 border-t px-2">
          <Button variant="ghost" size="xs" disabled={hidden.size === 0} onClick={() => onChange(new Set())}>
            Show all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={shownCount === 0}
            onClick={() => onChange(new Set(tables.map(tableKeyOf)))}
          >
            Hide all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            title="Put away the tables no key reaches"
            disabled={!tables.some((table) => !counts.has(tableKeyOf(table)) && !hidden.has(tableKeyOf(table)))}
            onClick={() =>
              onChange(new Set([...hidden, ...tables.map(tableKeyOf).filter((key) => !counts.has(key))]))
            }
          >
            Hide unlinked
          </Button>
          <span className="flex-1" />
          <span className="pr-1 text-[11px] text-muted-foreground tabular-nums">
            {shownCount} of {tables.length}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DiagramView({ tab, active }: { tab: DiagramTab; active: boolean }) {
  const connection = useStore((state) => state.connections.find((item) => item.id === tab.connectionId))
  const version = useStore((state) => state.dataVersion[tab.connectionId] ?? 0)
  const openTable = useStore((state) => state.openTable)

  const [diagram, setDiagram] = useState<SchemaDiagram | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<ColumnMode | null>(null)
  const [showInferred, setShowInferred] = useState<boolean | null>(null)
  const [search, setSearch] = useState("")
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  /** Where tables were dragged to, over the layout's own places. */
  const [moved, setMoved] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const [copied, setCopied] = useState(false)
  const canvas = useRef<HTMLDivElement>(null)
  const fitted = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDiagram(await window.veylens.getSchemaDiagram(tab.connectionId, tab.schema))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setLoading(false)
    }
  }, [tab.connectionId, tab.schema])

  useEffect(() => {
    void load()
  }, [load, version])

  const inferred = useMemo(
    () => (diagram ? inferLinks(diagram.tables, diagram.links) : []),
    [diagram]
  )
  // Names are a guess, so they are shown unasked only where nothing is declared.
  const withInferred = showInferred ?? (diagram ? diagram.links.length === 0 && inferred.length > 0 : false)
  /** Every key, whether or not both its tables are shown: what the picker
   * counts and "related" follows. */
  const allLinks: DiagramLink[] = useMemo(
    () => (diagram ? (withInferred ? [...diagram.links, ...inferred] : diagram.links) : []),
    [diagram, inferred, withInferred]
  )

  /** Tables put away, by key; remembered per connection and schema, so a
   * big schema opens on the part last looked at. New tables are shown. */
  const storageKey = `veylens.diagram.hidden:${tab.connectionId}:${tab.schema}`
  const [hidden, setHiddenState] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[])
    } catch {
      return new Set()
    }
  })
  const setHidden = useCallback(
    (next: Set<string>) => {
      setHiddenState(next)
      if (next.size) localStorage.setItem(storageKey, JSON.stringify([...next]))
      else localStorage.removeItem(storageKey)
    },
    [storageKey]
  )

  const tables = useMemo(
    () => (diagram?.tables ?? []).filter((table) => !hidden.has(tableKeyOf(table))),
    [diagram, hidden]
  )
  const links = useMemo(
    () => allLinks.filter((link) => !hidden.has(tableKeyOf(link.from)) && !hidden.has(tableKeyOf(link.to))),
    [allLinks, hidden]
  )
  const columnMode: ColumnMode = mode ?? (tables.length > KEYS_ONLY_PAST ? "keys" : "all")

  const shown = useMemo(() => {
    const out = new Map<string, DiagramTable["columns"]>()
    for (const table of tables) out.set(tableKeyOf(table), shownColumns(table, links, columnMode))
    return out
  }, [tables, links, columnMode])

  const layout = useMemo(
    () =>
      diagram
        ? layoutDiagram(tables, links, (table) => nodeHeight(shown.get(tableKeyOf(table))!.length))
        : null,
    [diagram, tables, links, shown]
  )

  const boxOf = useCallback(
    (key: string): Box | undefined => {
      const box = layout?.boxes.get(key)
      const at = moved.get(key)
      return box && at ? { ...box, x: at.x, y: at.y } : box
    },
    [layout, moved]
  )

  const fit = useCallback(() => {
    const el = canvas.current
    if (!el || !layout || layout.boxes.size === 0) return
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const key of layout.boxes.keys()) {
      const box = boxOf(key)!
      left = Math.min(left, box.x)
      top = Math.min(top, box.y)
      right = Math.max(right, box.x + box.width)
      bottom = Math.max(bottom, box.y + box.height)
    }
    const width = right - left + FIT_PADDING * 2
    const height = bottom - top + FIT_PADDING * 2
    const scale = clamp(Math.min(el.clientWidth / width, el.clientHeight / height), MIN_SCALE, 1)
    setView({
      scale,
      x: (el.clientWidth - (right - left) * scale) / 2 - left * scale,
      y: Math.max(FIT_PADDING * scale, (el.clientHeight - (bottom - top) * scale) / 2) - top * scale,
    })
  }, [layout, boxOf])

  // Fitted once it is first seen with something to show; a hidden tab has
  // no size to fit to.
  useEffect(() => {
    if (!active || fitted.current || !layout || layout.boxes.size === 0) return
    fitted.current = true
    requestAnimationFrame(fit)
  }, [active, layout, fit])

  useEffect(() => {
    if (!active || !focused) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocused(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, focused])

  // Fitted again when the tables picked change: the ones left may be anywhere.
  const pickedSignature = [...hidden].sort().join("\n")
  const lastPicked = useRef(pickedSignature)
  useEffect(() => {
    if (lastPicked.current === pickedSignature) return
    lastPicked.current = pickedSignature
    if (active) requestAnimationFrame(fit)
  }, [pickedSignature, active, fit])

  // A wheel pans; with ⌘ or Ctrl held — or a pinch, which arrives as one — it
  // zooms around the pointer.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect()
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        setView((current) => {
          const scale = clamp(current.scale * Math.exp(-event.deltaY * 0.01), MIN_SCALE, MAX_SCALE)
          const ratio = scale / current.scale
          return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
        })
      } else {
        setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
      }
    }
    el.addEventListener("wheel", wheel, { passive: false })
    return () => el.removeEventListener("wheel", wheel)
  }, [diagram])

  const zoom = (factor: number) => {
    const el = canvas.current
    if (!el) return
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    setView((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / current.scale
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
    })
  }

  /** Dragging the background pans; dragging a table's header moves it. */
  const drag = useRef<
    | { kind: "pan"; startX: number; startY: number; from: View }
    | { kind: "move"; key: string; startX: number; startY: number; from: { x: number; y: number }; travelled: boolean }
    | null
  >(null)

  const onCanvasDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag.current = { kind: "pan", startX: event.clientX, startY: event.clientY, from: view }
  }

  const onNodeDown = (key: string) => (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const box = boxOf(key)
    if (!box) return
    canvas.current?.setPointerCapture(event.pointerId)
    drag.current = {
      kind: "move",
      key,
      startX: event.clientX,
      startY: event.clientY,
      from: { x: box.x, y: box.y },
      travelled: false,
    }
  }

  const onMove = (event: ReactPointerEvent) => {
    const current = drag.current
    if (!current) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (current.kind === "pan") {
      setView({ ...current.from, x: current.from.x + dx, y: current.from.y + dy })
      return
    }
    if (!current.travelled && Math.hypot(dx, dy) < 3) return
    current.travelled = true
    setMoved((before) =>
      new Map(before).set(current.key, {
        x: current.from.x + dx / view.scale,
        y: current.from.y + dy / view.scale,
      })
    )
  }

  const onUp = (event: ReactPointerEvent) => {
    const current = drag.current
    drag.current = null
    if (!current) return
    const still = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3
    // A click, not a drag: on a table it is picked, on the background let go.
    if (still) setFocused(current.kind === "move" ? (focused === current.key ? null : current.key) : null)
  }

  const needle = search.trim().toLowerCase()
  const matches = useMemo(
    () => (needle ? tables.filter((table) => table.name.toLowerCase().includes(needle)) : []),
    [tables, needle]
  )

  const centreOn = (key: string) => {
    const el = canvas.current
    const box = boxOf(key)
    if (!el || !box) return
    setView((current) => {
      const scale = Math.max(current.scale, 0.8)
      return {
        scale,
        x: el.clientWidth / 2 - (box.x + box.width / 2) * scale,
        y: el.clientHeight / 2 - (box.y + Math.min(box.height, 200) / 2) * scale,
      }
    })
  }

  /** What is on screen, and nothing put away. */
  const copyMermaid = () => {
    if (!diagram) return
    void navigator.clipboard.writeText(toMermaid({ ...diagram, tables }, links))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  /** Only these, and what their keys reach. */
  const showOnly = (keys: string[]) => {
    if (!diagram) return
    const keep = relatedTo(keys, allLinks)
    setHidden(new Set(diagram.tables.map(tableKeyOf).filter((key) => !keep.has(key))))
  }

  const hide = (key: string) => {
    setHidden(new Set(hidden).add(key))
    if (focused === key) setFocused(null)
  }

  if (error && !diagram) {
    return (
      <div className="p-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
    )
  }
  if (!diagram || !layout) return <Loading />

  const lit = hovered ?? focused
  const litLinks = new Set<DiagramLink>()
  const litTables = new Set<string>()
  if (lit) {
    litTables.add(lit)
    for (const link of links) {
      const from = tableKeyOf(link.from)
      const to = tableKeyOf(link.to)
      if (from === lit || to === lit) {
        litLinks.add(link)
        litTables.add(from)
        litTables.add(to)
      }
    }
  }
  const matched = new Set(matches.map(tableKeyOf))
  const foreignBy = new Map<string, Set<string>>()
  for (const link of links) {
    const key = tableKeyOf(link.from)
    const set = foreignBy.get(key) ?? new Set<string>()
    link.from.columns.forEach((column) => set.add(column))
    foreignBy.set(key, set)
  }
  const declared = diagram.links.length

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <IconTile tone={KIND_TONE.schema} size="sm">
          <Network />
        </IconTile>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{tab.schema}</div>
        </div>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
          {diagram.tables.length} {diagram.tables.length === 1 ? "table" : "tables"} · {declared}{" "}
          {declared === 1 ? "key" : "keys"}
          {connection ? ` · ${connection.name}` : ""}
        </span>
        <div className="flex-1" />
        <TablePicker
          tables={diagram.tables}
          links={allLinks}
          hidden={hidden}
          primary={diagram.schema}
          onChange={setHidden}
          onShowOnly={showOnly}
        />
        <div className="relative w-44">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) centreOn(tableKeyOf(matches[0]))
              if (event.key === "Escape") setSearch("")
            }}
            placeholder="Find a table…"
            aria-label="Find a table"
            spellCheck={false}
            className="h-7 pl-7 text-xs shadow-none md:text-xs"
          />
        </div>
        <SimpleSelect
          value={columnMode}
          items={{ all: "All columns", keys: "Keys only" }}
          onChange={setMode}
          label="Columns shown"
        />
        <label
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs",
            inferred.length === 0 && "text-muted-foreground opacity-60"
          )}
          title="Keys guessed from column names — customer_id → customers.id — where the database declares none. Drawn dashed."
        >
          <Switch
            checked={withInferred}
            label="Show inferred keys"
            onChange={(on) => inferred.length > 0 && setShowInferred(on)}
          />
          Inferred{inferred.length ? ` · ${inferred.length}` : ""}
        </label>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <IconButton label="Zoom out" onClick={() => zoom(1 / 1.25)}>
          <Minus />
        </IconButton>
        <span className="w-9 text-center text-[11px] text-muted-foreground tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => zoom(1.25)}>
          <Plus />
        </IconButton>
        <IconButton label="Fit to window" onClick={fit}>
          <Maximize />
        </IconButton>
        <IconButton
          label="Tidy up: put moved tables back"
          disabled={moved.size === 0}
          onClick={() => {
            setMoved(new Map())
            requestAnimationFrame(fit)
          }}
        >
          <LayoutGrid />
        </IconButton>
        <IconButton label="Reload from the database" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
        </IconButton>
        <Button variant="outline" size="xs" onClick={copyMermaid} title="Copy as a Mermaid erDiagram">
          {copied ? <Check /> : null}
          {copied ? "Copied" : "Copy Mermaid"}
        </Button>
      </div>

      {error && <ErrorNote className="m-2">{error}</ErrorNote>}

      {diagram.tables.length === 0 ? (
        <EmptyState icon={<Network />}>No tables in {tab.schema} to draw.</EmptyState>
      ) : (
        <div
          ref={canvas}
          className="relative min-h-0 flex-1 touch-none overflow-hidden bg-muted/30 select-none dark:bg-background"
          style={{
            backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onCanvasDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => (drag.current = null)}
        >
          <svg className="absolute inset-0 size-full" role="img" aria-label={`Diagram of ${tab.schema}`}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {links.map((link, index) => {
                const fromKey = tableKeyOf(link.from)
                const toKey = tableKeyOf(link.to)
                const from = boxOf(fromKey)
                const to = boxOf(toKey)
                if (!from || !to) return null
                const fromRow = shown.get(fromKey)!.findIndex((column) => column.name === link.from.columns[0])
                const toRow = shown.get(toKey)!.findIndex((column) => column.name === link.to.columns[0])
                const fromY = rowY(from, fromRow)
                const toY = rowY(to, toRow)
                const on = litLinks.has(link)
                const colour = on ? toneColor("blue") : "var(--muted-foreground)"
                const leftward = from.x > to.x && Math.abs(from.x - to.x) >= 1
                const fromX = leftward ? from.x : from.x + from.width
                const toX = leftward ? to.x + to.width : from === to || Math.abs(from.x - to.x) < 1 ? to.x + to.width : to.x
                return (
                  <g key={`${link.name}-${index}`} opacity={lit && !on ? 0.15 : on ? 1 : 0.55}>
                    <title>{`${link.from.table}(${link.from.columns.join(", ")}) → ${link.to.table}(${link.to.columns.join(", ")})${link.inferred ? " — inferred from the name" : ""}`}</title>
                    <path
                      d={linkPath(from, fromY, to, toY)}
                      fill="none"
                      stroke={colour}
                      strokeWidth={on ? 2 : 1.25}
                      strokeDasharray={link.inferred ? "5 4" : undefined}
                    />
                    <circle cx={fromX} cy={fromY} r={3} fill={colour} />
                    <line x1={toX} x2={toX} y1={toY - 5} y2={toY + 5} stroke={colour} strokeWidth={2} />
                  </g>
                )
              })}
              {tables.map((table) => {
                const key = tableKeyOf(table)
                const box = boxOf(key)!
                return (
                  <TableNode
                    key={key}
                    table={table}
                    box={box}
                    columns={shown.get(key)!}
                    foreign={foreignBy.get(key) ?? new Set()}
                    qualified={table.schema !== diagram.schema}
                    state={
                      matched.has(key)
                        ? "match"
                        : focused === key
                          ? "picked"
                          : needle
                          ? "dim"
                          : lit
                            ? litTables.has(key)
                              ? "lit"
                              : "dim"
                            : "normal"
                    }
                    onPointerDown={onNodeDown(key)}
                    onOpen={() => openTable(tab.connectionId, table.schema, table.name)}
                    onHover={(on) => setHovered((current) => (on ? key : current === key ? null : current))}
                  />
                )
              })}
            </g>
          </svg>
          {tables.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              Every table is put away.
              <Button
                variant="outline"
                size="xs"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setHidden(new Set())}
              >
                Show all {diagram.tables.length}
              </Button>
            </div>
          )}
          {focused && boxOf(focused) && (() => {
            const table = tables.find((item) => tableKeyOf(item) === focused)
            if (!table) return null
            const related = relatedTo([focused], allLinks).size - 1
            return (
              <div
                onPointerDown={(event) => event.stopPropagation()}
                className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-3 text-xs shadow-md"
              >
                <span className="max-w-48 truncate font-medium">
                  {table.schema !== diagram.schema ? `${table.schema}.` : ""}
                  {table.name}
                </span>
                <span className="mr-1 text-muted-foreground">
                  · {related} related
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => openTable(tab.connectionId, table.schema, table.name)}
                >
                  <ExternalLink />
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  title="Put every other table away, but the ones its keys reach"
                  onClick={() => showOnly([focused])}
                >
                  <Focus />
                  Only this & related
                </Button>
                <Button variant="ghost" size="xs" onClick={() => hide(focused)}>
                  <EyeOff />
                  Hide
                </Button>
                <IconButton label="Deselect" onClick={() => setFocused(null)}>
                  <X />
                </IconButton>
              </div>
            )
          })()}
          {!focused && (
            <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted-foreground">
              Drag to pan · ⌘ + scroll to zoom · click a table to select it · double-click to open
            </div>
          )}
        </div>
      )}
    </div>
  )
}
