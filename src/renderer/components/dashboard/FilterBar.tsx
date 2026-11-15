import {
  CalendarRange,
  ChevronDown,
  Hash,
  ListChecks,
  ListFilter,
  Rows3,
  Search,
  SlidersHorizontal,
  ToggleRight,
  X,
} from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import {
  DATE_PRESETS,
  type Cell,
  type DashboardFilter,
  type DatePreset,
} from "@shared/api"
import { DATE_PRESET_LABELS, numberOrNull } from "@shared/params"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/store"
import { cn } from "@/lib/utils"

import { categoryLabel } from "../Chart"
import { SimpleSelect } from "../simple-select"

const ALL = "\u0000all"

/** Choices for a select filter, asked of the database once per query. */
const optionCache = new Map<string, Promise<string[]>>()

function useOptions(connectionId: string, sql: string) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; options: string[] } | { status: "error"; error: string }
  >({ status: "loading" })
  useEffect(() => {
    const key = `${connectionId}\n${sql}`
    let pending = optionCache.get(key)
    if (!pending) {
      pending = window.veylens
        .runQuery(connectionId, sql, true)
        .then((result) =>
          result.rows
            .map((row) => row[0])
            .filter((value): value is string => value !== null && value !== undefined)
            .slice(0, 500)
        )
      optionCache.set(key, pending)
      pending.catch(() => optionCache.delete(key))
    }
    let live = true
    pending
      .then((options) => live && setState({ status: "ready", options }))
      .catch((error) => live && setState({ status: "error", error: errorMessage(error) }))
    return () => {
      live = false
    }
  }, [connectionId, sql])
  return state
}

/**
 * A filter as one pill: its icon and name, then its value — all of it the
 * select's button, so it hovers and opens as one. Tinted while it narrows
 * the tiles, so a scoped dashboard says so at a glance.
 */
const pillClass = (active: boolean) =>
  cn(
    "h-7 gap-0 rounded-md border bg-background pr-1.5 pl-2 text-xs shadow-xs hover:bg-accent dark:bg-background dark:hover:bg-accent aria-expanded:bg-accent",
    active &&
      "border-primary/35 bg-primary/[0.06] hover:bg-primary/10 dark:bg-primary/10 dark:hover:bg-primary/15 aria-expanded:bg-primary/10"
  )

function PillLead({ icon, label, active }: { icon: ReactNode; label: string; active: boolean }) {
  return (
    <>
      <span className={cn("mr-1.5 [&_svg]:size-3.5", active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="mr-1 font-normal text-muted-foreground">{label}</span>
    </>
  )
}

function DateControl({
  filter,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "date_range" }>
  onChange: (filter: DashboardFilter) => void
}) {
  const presets = Object.fromEntries(
    DATE_PRESETS.map((preset) => [preset, DATE_PRESET_LABELS[preset]])
  ) as Record<DatePreset, string>
  return (
    <div className="flex items-center gap-1.5">
      <SimpleSelect
        label={filter.label}
        heading={filter.label}
        value={filter.preset}
        items={presets}
        onChange={(preset) => onChange({ ...filter, preset })}
        className={cn(pillClass(filter.preset !== "all"), "font-medium")}
        leading={<PillLead icon={<CalendarRange />} label={filter.label} active={filter.preset !== "all"} />}
      />
      {filter.preset === "custom" && (
        <>
          <Input
            type="date"
            aria-label={`${filter.label} from`}
            value={filter.from ?? ""}
            onChange={(event) => onChange({ ...filter, from: event.target.value || null })}
            className="h-7 w-36 bg-background text-xs md:text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label={`${filter.label} to`}
            value={filter.to ?? ""}
            onChange={(event) => onChange({ ...filter, to: event.target.value || null })}
            className="h-7 w-36 bg-background text-xs md:text-xs"
          />
        </>
      )}
    </div>
  )
}

function SelectControl({
  filter,
  connectionId,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "select" }>
  connectionId: string
  onChange: (filter: DashboardFilter) => void
}) {
  const options = useOptions(connectionId, filter.optionsSql)
  const items: Record<string, string> = { [ALL]: "All" }
  if (options.status === "ready") {
    for (const option of options.options) items[option] = option
  }
  // A value chosen before the options changed stays selectable.
  if (filter.value !== null && !(filter.value in items)) items[filter.value] = filter.value
  return (
    <div title={options.status === "error" ? options.error : undefined}>
      <SimpleSelect
        label={filter.label}
        heading={filter.label}
        value={filter.value ?? ALL}
        items={items}
        onChange={(value) => onChange({ ...filter, value: value === ALL ? null : value })}
        className={cn(pillClass(filter.value !== null), "max-w-64 font-medium")}
        leading={<PillLead icon={<ListFilter />} label={filter.label} active={filter.value !== null} />}
      />
    </div>
  )
}

/** A pill that holds its own inputs rather than being one button. */
const boxClass = (active: boolean) =>
  cn(
    "flex h-7 items-center rounded-md border bg-background pl-2 text-xs shadow-xs focus-within:border-ring",
    active && "border-primary/35 bg-primary/[0.06] dark:bg-primary/10"
  )

function MultiControl({
  filter,
  connectionId,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "multi_select" }>
  connectionId: string
  onChange: (filter: DashboardFilter) => void
}) {
  const options = useOptions(connectionId, filter.optionsSql)
  const chosen = filter.values
  const listed = options.status === "ready" ? options.options : []
  // A value chosen before the options changed stays, and stays ticked.
  const all = [...chosen.filter((value) => !listed.includes(value)), ...listed]
  const active = chosen.length > 0
  const shown =
    chosen.length === 0 ? "All" : chosen.length === 1 ? chosen[0] : `${chosen[0]} +${chosen.length - 1}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={filter.label}
            title={options.status === "error" ? options.error : chosen.join(", ") || undefined}
            className={cn(pillClass(active), "inline-flex max-w-72 items-center font-medium")}
          >
            <PillLead icon={<ListChecks />} label={filter.label} active={active} />
            <span className="truncate">{shown}</span>
            <ChevronDown className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 w-auto min-w-52 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
          <DropdownMenuItem disabled={!active} onClick={() => onChange({ ...filter, values: [] })}>
            <X />
            Clear — show all
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {options.status === "loading" && <DropdownMenuLabel className="font-normal">Loading…</DropdownMenuLabel>}
        {all.map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={chosen.includes(value)}
            onCheckedChange={(checked) =>
              onChange({
                ...filter,
                values: checked ? [...chosen, value] : chosen.filter((item) => item !== value),
              })
            }
          >
            {value}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TextControl({
  filter,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "text" }>
  onChange: (filter: DashboardFilter) => void
}) {
  const [text, setText] = useState(filter.value ?? "")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => setText(filter.value ?? ""), [filter.value])
  useEffect(() => () => clearTimeout(timer.current), [])
  // Every tile runs again on a change: once the typing stops, not per key.
  const commit = (value: string, now = false) => {
    clearTimeout(timer.current)
    const send = () => {
      const next = value.trim() ? value : null
      if (next !== filter.value) onChange({ ...filter, value: next })
    }
    if (now) send()
    else timer.current = setTimeout(send, 450)
  }
  const active = !!filter.value?.trim()
  return (
    <div className={boxClass(active)}>
      <PillLead icon={<Search />} label={filter.label} active={active} />
      <input
        aria-label={filter.label}
        value={text}
        placeholder={filter.match === "starts" ? "Starts with…" : filter.match === "exact" ? "Exactly…" : "Contains…"}
        onChange={(event) => {
          setText(event.target.value)
          commit(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(text, true)
          if (event.key === "Escape") {
            setText("")
            commit("", true)
          }
        }}
        className="h-full w-36 min-w-0 bg-transparent font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground/70"
      />
      {text ? (
        <button
          type="button"
          aria-label={`Clear ${filter.label}`}
          onClick={() => {
            setText("")
            commit("", true)
          }}
          className="mr-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : (
        <span className="w-1.5" />
      )}
    </div>
  )
}

function NumberRangeControl({
  filter,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "number_range" }>
  onChange: (filter: DashboardFilter) => void
}) {
  const [min, setMin] = useState(filter.min ?? "")
  const [max, setMax] = useState(filter.max ?? "")
  useEffect(() => setMin(filter.min ?? ""), [filter.min])
  useEffect(() => setMax(filter.max ?? ""), [filter.max])
  const commit = () => {
    const next = { ...filter, min: numberOrNull(min), max: numberOrNull(max) }
    if (next.min !== filter.min || next.max !== filter.max) onChange(next)
  }
  const active = !!(numberOrNull(filter.min) ?? numberOrNull(filter.max))
  const bad = (text: string) => text.trim() !== "" && numberOrNull(text) === null
  const field = (value: string, set: (value: string) => void, label: string) => (
    <input
      aria-label={`${filter.label} ${label}`}
      inputMode="decimal"
      value={value}
      placeholder={label}
      onChange={(event) => set(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit()
      }}
      className={cn(
        "h-5 w-16 rounded bg-muted/60 px-1.5 text-right font-medium tabular-nums outline-none placeholder:font-normal placeholder:text-muted-foreground/70 focus:bg-background focus:ring-1 focus:ring-ring",
        bad(value) && "text-destructive ring-1 ring-destructive"
      )}
    />
  )
  return (
    <div className={cn(boxClass(active), "gap-1 pr-1")}>
      <PillLead icon={<Hash />} label={filter.label} active={active} />
      {field(min, setMin, "min")}
      <span className="text-muted-foreground">–</span>
      {field(max, setMax, "max")}
    </div>
  )
}

function ToggleControl({
  filter,
  onChange,
}: {
  filter: Extract<DashboardFilter, { kind: "toggle" }>
  onChange: (filter: DashboardFilter) => void
}) {
  const active = filter.value !== null
  const options: { value: boolean | null; label: string }[] = [
    { value: null, label: "All" },
    { value: true, label: "Yes" },
    { value: false, label: "No" },
  ]
  return (
    <div className={cn(boxClass(active), "pr-0.5")}>
      <PillLead icon={<ToggleRight />} label={filter.label} active={active} />
      <div role="radiogroup" aria-label={filter.label} className="flex rounded bg-muted/70 p-0.5">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={filter.value === option.value}
            onClick={() => onChange({ ...filter, value: option.value })}
            className={cn(
              "h-5 rounded-[3px] px-2 text-[11px] text-muted-foreground hover:text-foreground",
              filter.value === option.value && "bg-background font-medium text-foreground shadow-xs"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export type CrossFilter = { tileId: string; column: string; value: Cell }

/**
 * One row above the tiles, scoping all of them: the filters, then the
 * category a click picked out, with the rows behind it when the tile says
 * how to find them.
 */
export function FilterBar({
  connectionId,
  filters,
  cross,
  canDrill,
  onChange,
  onClearCross,
  onDrill,
  onEdit,
}: {
  connectionId: string
  filters: DashboardFilter[]
  cross: CrossFilter | null
  canDrill: boolean
  onChange: (filter: DashboardFilter) => void
  onClearCross: () => void
  onDrill: () => void
  onEdit: () => void
}) {
  if (filters.length === 0 && !cross) {
    return (
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2.5">
        <Button
          variant="outline"
          size="xs"
          onClick={onEdit}
          className="border-dashed bg-transparent text-muted-foreground shadow-none"
        >
          <SlidersHorizontal />
          Add a filter
        </Button>
        <span className="text-xs text-muted-foreground">
          A date range or a choice that scopes every tile.
        </span>
      </div>
    )
  }
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 px-4 pt-3 pb-2.5"
    >
      {filters.map((given) => {
        // Saved filters have an id; the name is unique among them too.
        const filter = given
        const key = given.id || `name:${given.name}`
        switch (filter.kind) {
          case "date_range":
            return <DateControl key={key} filter={filter} onChange={onChange} />
          case "select":
            return (
              <SelectControl key={key} filter={filter} connectionId={connectionId} onChange={onChange} />
            )
          case "multi_select":
            return (
              <MultiControl key={key} filter={filter} connectionId={connectionId} onChange={onChange} />
            )
          case "text":
            return <TextControl key={key} filter={filter} onChange={onChange} />
          case "number_range":
            return <NumberRangeControl key={key} filter={filter} onChange={onChange} />
          case "toggle":
            return <ToggleControl key={key} filter={filter} onChange={onChange} />
        }
      })}
      {cross && (
        <span className="flex h-7 items-center gap-1 rounded-md border border-primary/35 bg-primary/[0.06] pr-0.5 pl-2.5 text-xs shadow-xs dark:bg-primary/10">
          <span className="text-muted-foreground">{cross.column} =</span>
          <span className="font-medium">{categoryLabel(cross.value)}</span>
          {canDrill && (
            <Button variant="ghost" size="xs" className="h-5 px-1.5" onClick={onDrill}>
              <Rows3 />
              Show rows
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-full"
            aria-label="Clear selection"
            onClick={onClearCross}
          >
            <X />
          </Button>
        </span>
      )}
      <div className="flex-1" />
      <Button variant="ghost" size="xs" onClick={onEdit} className="text-muted-foreground">
        <SlidersHorizontal />
        Edit filters
      </Button>
    </div>
  )
}
