import { Eye, EyeOff, Filter as FilterIcon, Group, Plus, Search, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"

import {
  combineFilters,
  isFilterGroup,
  type ColumnKind,
  type Filter,
  type FilterJoin,
  type FilterNode,
  type FilterOp,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import { ColumnKindIcon } from "./DataGrid"
import { SimpleSelect } from "./simple-select"
import { Switch } from "./switch"

type FilterColumn = { name: string; kind: ColumnKind; primaryKey?: boolean }

export const takesNoValue = (op: FilterOp) => op === "is_null" || op === "is_not_null"

const NULLS: FilterOp[] = ["is_null", "is_not_null"]

/** The conditions that read naturally for a kind of column, likeliest first. */
const OPS_OF: Record<ColumnKind, FilterOp[]> = {
  text: ["contains", "not_contains", "=", "!=", "starts_with", "ends_with", ...NULLS],
  number: ["=", "!=", ">", ">=", "<", "<=", ...NULLS],
  datetime: [">=", "<", "=", "!=", ">", "<=", ...NULLS],
  boolean: ["=", "!=", ...NULLS],
  json: ["contains", "not_contains", ...NULLS],
  binary: NULLS,
}

const WORDS: Record<FilterOp, string> = {
  "=": "is",
  "!=": "is not",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_null: "is empty",
  is_not_null: "is not empty",
}

/** Dates read as before and after, numbers as signs, the rest in words. */
function opLabel(op: FilterOp, kind: ColumnKind): string {
  if (kind === "number" && (op === "=" || op === "!=")) return op === "=" ? "=" : "≠"
  if (kind === "datetime") {
    const dated: Partial<Record<FilterOp, string>> = {
      ">": "is after",
      ">=": "is on or after",
      "<": "is before",
      "<=": "is on or before",
    }
    if (dated[op]) return dated[op]!
  }
  return WORDS[op]
}

const PLACEHOLDER: Record<ColumnKind, string> = {
  text: "Value",
  number: "Number",
  datetime: "YYYY-MM-DD",
  boolean: "",
  json: "Text in the JSON",
  binary: "",
}

const isNumber = (value: string) => /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(value)

/** A condition that says something: one with a value, or about emptiness. */
export const complete = (filter: Filter) => takesNoValue(filter.op) || filter.value !== ""

/** What the filters say, without what is half-written or a group left empty. */
export function cleanFilters(nodes: FilterNode[]): FilterNode[] {
  return nodes.flatMap((node): FilterNode[] => {
    if (!isFilterGroup(node)) return complete(node) ? [node] : []
    const filters = node.filters.filter(complete)
    return filters.length ? [{ ...node, filters }] : []
  })
}

/** The word a row is joined by, as it would be read: the first has none. */
const joinOf = (node: FilterNode, index: number): FilterJoin | null =>
  index === 0 ? null : (node.join ?? "and")

/** For comparing: the words the first of each level does not use dropped. */
const said = (nodes: FilterNode[]) =>
  JSON.stringify(
    cleanFilters(nodes).map((node, index) => ({
      ...node,
      join: joinOf(node, index),
      ...(isFilterGroup(node)
        ? { filters: node.filters.map((item, j) => ({ ...item, join: joinOf(item, j) })) }
        : {}),
    }))
  )

const same = (a: FilterNode[], b: FilterNode[]) => said(a) === said(b)

/** The conditions in them all, groups opened. */
const conditionsOf = (nodes: FilterNode[]): Filter[] =>
  nodes.flatMap((node) => (isFilterGroup(node) ? node.filters : [node]))

/** Whether a level, or a group in it, has both words: then how it reads is told. */
const mixes = (nodes: FilterNode[]): boolean => {
  const words = new Set(nodes.slice(1).map((node) => node.join ?? "and"))
  return words.size > 1 || nodes.some((node) => isFilterGroup(node) && mixes(node.filters))
}

/** A condition in words, short: `country is VN`, `total > 100`. */
function sentence(filter: Filter, kind: ColumnKind): string {
  const how = opLabel(filter.op, kind)
  return takesNoValue(filter.op) ? `${filter.column} ${how}` : `${filter.column} ${how} ${filter.value}`
}

const JOIN_WORDS: Record<FilterJoin, string> = { and: "and", or: "or" }

/** Before a row: Where on the first, then its own and / or. */
function Lead({
  index,
  join,
  onJoin,
  width,
}: {
  index: number
  join: FilterJoin
  onJoin: (next: FilterJoin) => void
  width: string
}) {
  if (index === 0) {
    return (
      <span className={cn(width, "shrink-0 pr-2 text-right text-xs text-muted-foreground")}>
        Where
      </span>
    )
  }
  return (
    <SimpleSelect
      label="Join"
      heading="Joined by"
      value={join}
      className={cn(
        width,
        "shrink-0 justify-between px-2",
        join === "or" && "border-primary/40 text-primary"
      )}
      items={JOIN_WORDS}
      onChange={onJoin}
    />
  )
}

/** One condition: field, how, and the value when it takes one. */
function ConditionRow({
  filter,
  columns,
  lead,
  narrow,
  label,
  autoFocus,
  onChange,
  onRemove,
  onEnter,
}: {
  filter: Filter
  columns: FilterColumn[]
  lead: ReactNode
  narrow?: boolean
  label: string
  autoFocus: boolean
  onChange: (patch: Partial<Filter>, wait: number) => void
  onRemove: () => void
  onEnter: () => void
}) {
  const column = columns.find((item) => item.name === filter.column)
  const kind = column?.kind ?? "text"
  const ops = OPS_OF[kind]
  return (
    <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={label}>
      {lead}
      <SimpleSelect
        label="Column"
        heading="Field"
        value={filter.column}
        className={cn(narrow ? "w-36" : "w-40", "justify-between")}
        leading={<ColumnKindIcon kind={kind} primaryKey={column?.primaryKey} />}
        items={Object.fromEntries(columns.map((item) => [item.name, item.name]))}
        onChange={(name) => onChange({ column: name }, 0)}
      />
      <SimpleSelect
        label="Condition"
        heading="Condition"
        value={filter.op}
        className={cn(narrow ? "w-32" : "w-36", "justify-between")}
        items={
          Object.fromEntries(
            (ops.includes(filter.op) ? ops : [...ops, filter.op]).map((op) => [op, opLabel(op, kind)])
          ) as Record<FilterOp, string>
        }
        onChange={(op) => onChange({ op }, 0)}
      />
      {takesNoValue(filter.op) ? (
        <span className="flex-1" />
      ) : kind === "boolean" ? (
        <SimpleSelect
          label="Value"
          value={filter.value === "false" ? "false" : "true"}
          className="min-w-0 flex-1 justify-between"
          items={{ true: "true", false: "false" }}
          onChange={(value) => onChange({ value }, 0)}
        />
      ) : (
        <Input
          aria-label="Value"
          value={filter.value}
          autoFocus={autoFocus}
          inputMode={kind === "number" ? "decimal" : undefined}
          placeholder={PLACEHOLDER[kind]}
          aria-invalid={
            kind === "number" &&
            ["=", "!=", ">", ">=", "<", "<="].includes(filter.op) &&
            filter.value !== "" &&
            !isNumber(filter.value)
              ? true
              : undefined
          }
          className={cn("h-7 min-w-0 flex-1 text-xs md:text-xs", kind === "number" && "tabular-nums")}
          onChange={(event) => onChange({ value: event.target.value }, 450)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter()
          }}
        />
      )}
      <RemoveButton label="Remove condition" onClick={onRemove} />
    </div>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
      onClick={onClick}
    >
      <X />
    </button>
  )
}

/**
 * The table's filters, in a popover under its button: conditions, and groups
 * of them in brackets. Each row after the first says whether it is joined by
 * and or by or; and binds first, as in SQL, and when both are used the
 * popover reads the whole back with its brackets. Filters apply as they are
 * written — after a pause in typing, at once for a pick — unless there are
 * unsaved edits, which an Apply would throw away and so waits to be asked.
 */
export function FilterPopover({
  columns,
  applied,
  draft,
  onDraft,
  onApply,
  holding,
}: {
  columns: FilterColumn[]
  applied: FilterNode[]
  draft: FilterNode[]
  onDraft: (next: FilterNode[]) => void
  onApply: (filters: FilterNode[]) => void
  /** Unsaved edits on the page: changes wait for Apply. */
  holding: boolean
}) {
  const [open, setOpen] = useState(false)
  const kindOf = (name: string) =>
    columns.find((column) => column.name === name)?.kind ?? "text"
  const blank = (join?: FilterJoin): Filter => {
    const first = columns[0]
    const kind = first?.kind ?? "text"
    return { column: first?.name ?? "", op: OPS_OF[kind][0]!, value: "", ...(join ? { join } : {}) }
  }
  /** A new row takes the word of the row above it. */
  const nextJoin = (nodes: FilterNode[]): FilterJoin =>
    nodes.length > 1 ? (nodes.at(-1)!.join ?? "and") : "and"

  /** A condition changed: its column's kind decides what still fits. */
  const patched = (item: Filter, patch: Partial<Filter>): Filter => {
    const merged = { ...item, ...patch }
    if (patch.column) {
      const ops = OPS_OF[kindOf(patch.column)]
      if (!ops.includes(merged.op)) merged.op = ops[0]!
      if (kindOf(patch.column) === "boolean" && !["true", "false"].includes(merged.value)) {
        merged.value = "true"
      }
    }
    if (patch.op && takesNoValue(patch.op)) merged.value = ""
    return merged
  }

  // Nothing runs until Apply (or Enter): a half-typed value is not a query.
  const commit = (next: FilterNode[], _wait?: number) => onDraft(next)

  /** Why the written filters cannot be run yet, if they cannot. */
  const problems = conditionsOf(draft).flatMap((filter) =>
    complete(filter) &&
    !takesNoValue(filter.op) &&
    kindOf(filter.column) === "number" &&
    ["=", "!=", ">", ">=", "<", "<="].includes(filter.op) &&
    !isNumber(filter.value)
      ? [`${filter.column} needs a number`]
      : []
  )
  const changed = !same(draft, applied)
  const canApply = changed && problems.length === 0
  const applyNow = () => {
    if (canApply) onApply(draft)
  }

  const setCondition = (at: number, inner: number | null, patch: Partial<Filter>, wait: number) =>
    commit(
      draft.map((node, index) => {
        if (index !== at) return node
        if (inner === null || !isFilterGroup(node)) return patched(node as Filter, patch)
        return {
          ...node,
          filters: node.filters.map((item, j) => (j === inner ? patched(item, patch) : item)),
        }
      }),
      wait
    )

  const setJoin = (at: number, inner: number | null, join: FilterJoin) =>
    commit(
      draft.map((node, index) => {
        if (index !== at) return node
        if (inner === null || !isFilterGroup(node)) return { ...node, join }
        return {
          ...node,
          filters: node.filters.map((item, j) => (j === inner ? { ...item, join } : item)),
        }
      }),
      0
    )

  const remove = (at: number, inner: number | null) => {
    const next = draft.flatMap((node, index): FilterNode[] => {
      if (index !== at) return [node]
      if (inner === null || !isFilterGroup(node)) return []
      const filters = node.filters.filter((_, j) => j !== inner)
      // A group's last condition takes the group with it.
      return filters.length ? [{ ...node, filters }] : []
    })
    // Removing takes effect at once: nothing is left to type.
    commit(next, 0)
  }

  const conditions = conditionsOf(cleanFilters(applied))
  const count = conditions.length
  const lastIndex = draft.length - 1

  // Read back, brackets and all, once and and or are mixed: what will run.
  const cleaned = cleanFilters(draft)
  const readBack = mixes(cleaned)
    ? combineFilters<{ text: string; joined: boolean }>(
        cleaned,
        "all",
        (filter) => ({ text: sentence(filter, kindOf(filter.column)), joined: false }),
        (items, word) => ({
          text: items.map((item) => (item.joined ? `(${item.text})` : item.text)).join(` ${word} `),
          joined: true,
        })
      )?.text
    : null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && draft.length === 0) onDraft([blank()])
        // Rows left half-written are let go of as it closes.
        if (!next && !holding) onDraft(cleanFilters(draft))
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={count ? `Filter, ${count} on` : "Filter"}
            className={cn(
              count > 0 && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              open && count === 0 && "bg-muted"
            )}
          >
            <FilterIcon />
            {count === 0
              ? "Filter"
              : count === 1
                ? `Filtered by ${conditions[0]!.column}`
                : `Filtered by ${count} conditions`}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[620px] gap-0 p-0" aria-label="Filters">
        <div className="flex h-10 items-center gap-2 border-b px-3">
          <span className="text-[13px] font-medium">Filters</span>
          <span className="text-xs text-muted-foreground">
            {draft.length > 1 ? "and is read before or, as in SQL" : "Rows that match"}
          </span>
          <span className="flex-1" />
          {draft.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => {
                onDraft([])
                onApply([])
              }}
            >
              Clear all
            </Button>
          )}
        </div>

        <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto overscroll-contain p-3">
          {draft.length === 0 && (
            <div className="flex flex-col items-center gap-1 py-4 text-center">
              <FilterIcon className="size-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">No filters: every row is shown.</p>
            </div>
          )}
          {draft.map((node, index) => {
            const lead = (
              <Lead
                index={index}
                join={node.join ?? "and"}
                width="w-[72px]"
                onJoin={(join) => setJoin(index, null, join)}
              />
            )
            if (!isFilterGroup(node)) {
              return (
                <ConditionRow
                  key={index}
                  label={`Condition ${index + 1}`}
                  filter={node}
                  columns={columns}
                  lead={lead}
                  autoFocus={!complete(node) && index === lastIndex}
                  onChange={(patch, wait) => setCondition(index, null, patch, wait)}
                  onRemove={() => remove(index, null)}
                  onEnter={applyNow}
                />
              )
            }
            return (
              <div key={index} className="flex shrink-0 items-start gap-1.5">
                <div className="flex h-[46px] items-center">{lead}</div>
                <div
                  role="group"
                  aria-label={`Group ${index + 1}`}
                  className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border bg-muted/40 p-2"
                >
                  {node.filters.map((filter, inner) => (
                    <ConditionRow
                      key={inner}
                      label={`Condition ${index + 1}.${inner + 1}`}
                      filter={filter}
                      columns={columns}
                      narrow
                      lead={
                        <Lead
                          index={inner}
                          join={filter.join ?? "and"}
                          width="w-[60px]"
                          onJoin={(join) => setJoin(index, inner, join)}
                        />
                      }
                      autoFocus={!complete(filter) && inner === node.filters.length - 1}
                      onChange={(patch, wait) => setCondition(index, inner, patch, wait)}
                      onRemove={() => remove(index, inner)}
                      onEnter={applyNow}
                    />
                  ))}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                      onClick={() =>
                        onDraft(
                          draft.map((item, at) =>
                            at === index && isFilterGroup(item)
                              ? { ...item, filters: [...item.filters, blank(nextJoin(item.filters))] }
                              : item
                          )
                        )
                      }
                    >
                      <Plus />
                      Add condition
                    </Button>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => commit(draft.filter((_, at) => at !== index), 0)}
                    >
                      <Trash2 />
                      Remove group
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {readBack && (
          <div className="flex gap-2 border-t bg-muted/30 px-3 py-2 text-xs" aria-label="Reads as">
            <span className="shrink-0 text-muted-foreground">Reads as</span>
            <span className="min-w-0 font-mono text-[11px] leading-5 break-words">{readBack}</span>
          </div>
        )}

        <div className="flex h-11 items-center gap-1 border-t px-3">
          <Button variant="ghost" size="xs" onClick={() => onDraft([...draft, blank(nextJoin(draft))])}>
            <Plus />
            Add filter
          </Button>
          <Button
            variant="ghost"
            size="xs"
            title="Conditions in brackets, joined among themselves"
            onClick={() =>
              onDraft([
                ...draft,
                // Grouped, usually, to put an or inside an and.
                { join: "and", filters: [blank(), blank("or")] },
              ])
            }
          >
            <Group />
            Add group
          </Button>
          <span className="flex-1" />
          <span
            className={cn(
              "truncate text-[11px]",
              problems.length ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {problems.length
              ? problems[0]
              : !changed
                ? count
                  ? "Applied"
                  : ""
                : holding
                  ? "Applying discards your unsaved edits"
                  : conditionsOf(draft).some((filter) => !complete(filter))
                    ? "Rows without a value are left out"
                    : "Not applied yet"}
          </span>
          <Button size="xs" disabled={!canApply} onClick={applyNow}>
            Apply
            <kbd className="ml-0.5 font-sans text-[10px] opacity-70">↵</kbd>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The columns a table has hidden, kept per table on this machine. */
export function useHiddenColumns(key: string) {
  const storage = `veydata:hidden-columns:${key}`
  const read = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(storage) ?? "[]")
      return new Set<string>(Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [])
    } catch {
      return new Set<string>()
    }
  }
  const [hidden, setHidden] = useState<Set<string>>(read)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setHidden(read()), [storage])
  const save = (next: Set<string>) => {
    setHidden(next)
    try {
      if (next.size) localStorage.setItem(storage, JSON.stringify([...next]))
      else localStorage.removeItem(storage)
    } catch {
      // Not kept, but still hidden for now.
    }
  }
  return [hidden, save] as const
}

/** Which of the table's fields the grid shows: searched, switched, all at once. */
export function FieldsPopover({
  columns,
  hidden,
  onChange,
}: {
  columns: FilterColumn[]
  hidden: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  const [query, setQuery] = useState("")
  // Hidden names the table no longer has do not count.
  const count = columns.filter((column) => hidden.has(column.name)).length
  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? columns.filter((column) => column.name.toLowerCase().includes(needle))
      : columns
  }, [columns, query])
  const shownCount = columns.length - count
  const toggle = (name: string) => {
    const next = new Set(hidden)
    if (next.has(name)) next.delete(name)
    // The last one shown stays: a grid of no columns is not a view.
    else if (shownCount > 1) next.add(name)
    onChange(next)
  }

  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={count ? `Fields, ${count} hidden` : "Fields"}
            className={cn(count > 0 && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary")}
          >
            {count > 0 ? <EyeOff /> : <Eye />}
            {count > 0 ? `${count} hidden` : "Fields"}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 gap-0 p-0" aria-label="Fields">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Find a field"
            value={query}
            placeholder="Find a field"
            className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex max-h-80 flex-col overflow-y-auto overscroll-contain p-1" role="list">
          {listed.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No field matches “{query}”.
            </p>
          )}
          {listed.map((column) => {
            const on = !hidden.has(column.name)
            const last = on && shownCount === 1
            return (
              <div
                key={column.name}
                role="listitem"
                onClick={() => !last && toggle(column.name)}
                title={last ? "At least one field stays shown" : undefined}
                className={cn(
                  "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted",
                  last && "cursor-default"
                )}
              >
                <ColumnKindIcon kind={column.kind} primaryKey={column.primaryKey} />
                <span className={cn("min-w-0 flex-1 truncate text-xs", !on && "text-muted-foreground")}>
                  {column.name}
                </span>
                <Switch
                  checked={on}
                  label={`Show ${column.name}`}
                  onChange={() => !last && toggle(column.name)}
                />
              </div>
            )
          })}
        </div>
        <div className="flex h-10 items-center gap-1 border-t px-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={count === 0}
            onClick={() => onChange(new Set())}
          >
            Show all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={shownCount <= 1}
            onClick={() =>
              // All but the first: the key, usually, that a row is known by.
              onChange(new Set(columns.slice(1).map((column) => column.name)))
            }
          >
            Hide all
          </Button>
          <span className="flex-1" />
          <span className="pr-1 text-[11px] text-muted-foreground tabular-nums">
            {shownCount} of {columns.length} shown
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
