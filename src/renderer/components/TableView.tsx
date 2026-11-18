import {
  ChevronLeft,
  ChevronRight,
  Lock,
  FoldVertical,
  Palette,
  UnfoldVertical,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  type Cell,
  type ChangeSet,
  type FilterNode,
  type RowKey,
  type RowsResult,
  type Sort,
  type TableInfo,
  type TableFields,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { judgeChanges, objectAccess } from "@shared/permissions"

import { errorMessage, useStore, type Tab } from "@/lib/store"
import { referencesOf, splitValues, useFormatValues, useRowHeight } from "@/lib/cell-format"
import { quoteName } from "@/lib/sql-complete"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"

import {
  DataGrid,
  rowKey,
  type GridColumn,
  type GridEditing,
  type RowTarget,
} from "./DataGrid"
import { FieldSettingsDialog } from "./FieldSettingsDialog"
import { IconButton } from "./icon-button"
import { SimpleSelect } from "./simple-select"
import { StructureView } from "./StructureView"
import { cleanFilters, FieldsPopover, FilterPopover, useHiddenColumns } from "./table-popovers"
import { ErrorNote, Loading } from "./state-view"

type TableTab = Extract<Tab, { kind: "table" }>

const PAGE_SIZES = { "50": "50 rows", "100": "100 rows", "200": "200 rows", "500": "500 rows" }

export function TableView({ tab, active }: { tab: TableTab; active: boolean }) {
  const version = useStore((state) => state.dataVersion[tab.connectionId] ?? 0)

  const [data, setData] = useState<RowsResult | null>(null)
  const [info, setInfo] = useState<TableInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [view, setView] = useState<"data" | "structure">("data")
  const [filters, setFilters] = useState<FilterNode[]>([])
  const [draft, setDraft] = useState<FilterNode[]>([])
  const [sort, setSort] = useState<Sort | null>(null)
  const [limit, setLimit] = useState(100)
  const [offset, setOffset] = useState(0)
  const [reload, setReload] = useState(0)

  const [edits, setEdits] = useState<Record<number, Record<string, Cell>>>({})
  const [inserts, setInserts] = useState<Record<string, Cell>[]>([])
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const pending =
    Object.keys(edits).length + inserts.length + deleted.size

  const clearPending = useCallback(() => {
    setEdits({})
    setInserts([])
    setDeleted(new Set())
    setSelected(new Set())
    setAnchor(null)
    setSaveError(null)
  }, [])

  // The agent changed something on this connection. Reloading would throw
  // away what is being typed here, so a tab with pending changes waits.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const seenVersion = useRef(version)
  useEffect(() => {
    if (version === seenVersion.current) return
    seenVersion.current = version
    if (pendingRef.current === 0) setReload((value) => value + 1)
  }, [version])

  const request = useRef(0)
  useEffect(() => {
    const id = ++request.current
    setLoading(true)
    const ref = { schema: tab.schema, table: tab.table }
    Promise.all([
      window.veylens.getRows(tab.connectionId, {
        ...ref,
        filters,
        sort,
        limit,
        offset,
      }),
      window.veylens.getTable(tab.connectionId, ref),
    ]).then(
      ([rows, table]) => {
        // An answer to a question that has since been replaced is dropped.
        if (id !== request.current) return
        setData(rows)
        setInfo(table)
        setError(null)
        setLoading(false)
      },
      (failure) => {
        if (id !== request.current) return
        setError(errorMessage(failure))
        setLoading(false)
      }
    )
  }, [tab.connectionId, tab.schema, tab.table, filters, sort, limit, offset, reload])

  const keyColumns = useMemo(
    () => (data?.columns ?? []).filter((column) => column.primaryKey),
    [data]
  )
  const access = useStore(
    (state) =>
      state.connections.find((item) => item.id === tab.connectionId)?.access ??
      "read_write"
  )
  const engine = useStore(
    (state) =>
      state.connections.find((item) => item.id === tab.connectionId)?.engine ?? "postgres"
  )
  const connectionName = useStore(
    (state) => state.connections.find((item) => item.id === tab.connectionId)?.name
  )
  const permissions = useStore(
    (state) => state.connections.find((item) => item.id === tab.connectionId)?.permissions
  )
  /** A short label for the toolbar, with the full explanation in its tooltip. */
  const readOnlyReason: { label: string; detail: string } | null = !info
    ? null
    : access === "read_only"
      ? {
          label: "Read-only",
          detail: "This connection is read-only in Vey Lens, so rows cannot be edited.",
        }
      : permissions &&
          objectAccess(permissions, { schema: tab.schema, table: tab.table }) !== "write"
        ? {
            label: "Read-only table",
            detail:
              "This table is read-only in the connection's permissions (Settings › Permissions).",
          }
      : info.kind === "view"
      ? { label: "View · read-only", detail: "A view is read-only here." }
      : keyColumns.length === 0
        ? {
            label: "No primary key",
            detail: "No primary key, so rows cannot be edited here — use a SQL tab.",
          }
        : null
  const editable = info !== null && readOnlyReason === null

  /** Moving to other rows drops what was typed against these ones. */
  const leave = async (action: () => void) => {
    if (
      pending > 0 &&
      !(await confirm({
        title: "Discard unsaved changes?",
        description: `${pending} ${pending === 1 ? "change" : "changes"} on this page will be lost.`,
        action: "Discard",
        destructive: true,
      }))
    ) {
      return
    }
    clearPending()
    action()
  }

  const applyFilters = (next: FilterNode[]) =>
    void leave(() => {
      setFilters(cleanFilters(next))
      setOffset(0)
    })

  const cycleSort = (column: string) =>
    void leave(() => {
      setSort(
        sort?.column !== column
          ? { column, direction: "asc" }
          : sort.direction === "asc"
            ? { column, direction: "desc" }
            : null
      )
      setOffset(0)
    })

  const tableKey = `${tab.connectionId}/${tab.schema}.${tab.table}`

  /**
   * Every value a column holds, for a select's options: an ENUM's are in its
   * type; anything else is asked of the database, read-only.
   */
  const suggestValues = async (column: string, multi: boolean): Promise<string[]> => {
    const type = info?.columns.find((item) => item.name === column)?.type ?? ""
    const listed = /^enum\((.*)\)$/i.exec(type)
    if (listed) {
      return [...listed[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
        match[1]!.replaceAll("''", "'")
      )
    }
    const name = quoteName(column, engine)
    const result = await window.veylens.runQuery(
      tab.connectionId,
      `SELECT DISTINCT ${name} FROM ${quoteName(tab.schema, engine)}.${quoteName(tab.table, engine)} WHERE ${name} IS NOT NULL ORDER BY 1 LIMIT 200`,
      true
    )
    const values = result.rows
      .map((row) => row[0])
      .filter((value): value is string => typeof value === "string" && value !== "")
    return multi ? [...new Set(values.flatMap(splitValues))] : values
  }
  const [hidden, setHidden] = useHiddenColumns(tableKey)

  const [fields, setFields] = useState<TableFields>({ fields: {}, displayColumn: null })
  // The column whose field settings are open, and its header they hang from.
  const [settingsFor, setSettingsFor] = useState<{
    column: string
    header: HTMLElement | null
  } | null>(null)
  const settingsOf = settingsFor?.column ?? null
  useEffect(() => {
    let live = true
    void window.veylens
      .getTableFields(tab.connectionId, { schema: tab.schema, table: tab.table })
      .then((found) => live && setFields(found), () => {})
    return () => {
      live = false
    }
  }, [tab.connectionId, tab.schema, tab.table])

  const references = useMemo(
    () => referencesOf(info?.foreignKeys ?? []),
    [info]
  )
  const formatValues = useFormatValues()
  const rowHeight = useRowHeight()

  const gridColumns: GridColumn[] = useMemo(
    () =>
      (data?.columns ?? []).map((column) => ({
        ...column,
        readOnly: column.extra === "generated",
        // Identity, serial (a nextval default) and AUTO_INCREMENT columns.
        auto:
          column.extra === "identity" ||
          /auto_increment/i.test(column.extra) ||
          /^nextval\(/i.test(column.default ?? ""),
        references: references[column.name],
      })),
    [data, references]
  )

  const editing: GridEditing | undefined =
    editable && data
      ? {
          edits,
          inserts,
          deleted,
          selected,
          onSelect(target, mode) {
            const key = rowKey(target)
            const order = [
              ...data.rows.map((_, index) => `r${index}`),
              ...inserts.map((_, index) => `n${index}`),
            ]
            if (mode === "range" && anchor) {
              const from = order.indexOf(anchor)
              const to = order.indexOf(key)
              if (from !== -1 && to !== -1) {
                setSelected(
                  new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1))
                )
                return
              }
            }
            const next = new Set(mode === "toggle" ? selected : [])
            if (mode === "toggle" && next.has(key)) next.delete(key)
            else next.add(key)
            setSelected(next)
            setAnchor(key)
          },
          onChange(target: RowTarget, column, value) {
            if (target.kind === "insert") {
              setInserts(
                inserts.map((row, index) =>
                  index === target.index ? { ...row, [column]: value } : row
                )
              )
              return
            }
            const columnIndex = data.columns.findIndex(
              (item) => item.name === column
            )
            const original = data.rows[target.index]?.[columnIndex]
            const row = { ...edits[target.index] }
            // Typing a cell back to what it was is not a change.
            if (value === original) delete row[column]
            else row[column] = value
            const next = { ...edits }
            if (Object.keys(row).length) next[target.index] = row
            else delete next[target.index]
            setEdits(next)
          },
        }
      : undefined

  const deleteSelected = () => {
    const existing = [...selected]
      .filter((key) => key.startsWith("r"))
      .map((key) => Number(key.slice(1)))
    const added = new Set(
      [...selected]
        .filter((key) => key.startsWith("n"))
        .map((key) => Number(key.slice(1)))
    )
    // Pressing it again on rows already marked takes the mark off.
    const unmark =
      existing.length > 0 && existing.every((index) => deleted.has(index))
    const next = new Set(deleted)
    for (const index of existing) {
      if (unmark) next.delete(index)
      else next.add(index)
    }
    setDeleted(next)
    if (added.size) setInserts(inserts.filter((_, index) => !added.has(index)))
    setSelected(new Set())
  }

  const save = useCallback(async () => {
    if (!data || pending === 0 || saving) return
    const keyOf = (index: number): RowKey =>
      Object.fromEntries(
        keyColumns.map((column) => [
          column.name,
          data.rows[index]?.[data.columns.indexOf(column)] ?? null,
        ])
      )
    const changes: ChangeSet = {
      schema: tab.schema,
      table: tab.table,
      updates: Object.entries(edits)
        .filter(([index]) => !deleted.has(Number(index)))
        .map(([index, values]) => ({ key: keyOf(Number(index)), values })),
      inserts,
      deletes: [...deleted].map(keyOf),
    }
    const verdict = permissions
      ? judgeChanges(changes, { permissions, access })
      : null
    if (verdict?.rule === "block") {
      setSaveError(
        `Refused by the permissions of ${connectionName ?? "this connection"}: ${verdict.reasons.join(" ")} They are set in Settings › Permissions.`
      )
      return
    }
    if (verdict?.rule === "ask") {
      const parts = [
        changes.updates.length && `${changes.updates.length} ${changes.updates.length === 1 ? "row" : "rows"} updated`,
        changes.inserts.length && `${changes.inserts.length} added`,
        changes.deletes.length && `${changes.deletes.length} deleted`,
      ].filter(Boolean)
      const ok = await confirm({
        title: `Save to ${tab.schema}.${tab.table}?`,
        description: `${parts.join(", ")} on ${connectionName ?? "this connection"}, in one transaction.\n\n${verdict.reasons.join("\n")}`,
        action: "Save changes",
      })
      if (!ok) return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await window.veylens.applyChanges(tab.connectionId, changes)
      clearPending()
      setReload((value) => value + 1)
    } catch (failure) {
      setSaveError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }, [access, clearPending, connectionName, data, deleted, edits, inserts, keyColumns, pending, permissions, saving, tab])

  // ⌘S saves the tab on screen.
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
  }, [active, save])

  const total = data?.total ?? null
  const count = data?.rows.length ?? 0
  const hasNext = total !== null ? offset + limit < total : count === limit

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Tabs
          value={view}
          onValueChange={(next) => setView(next as "data" | "structure")}
        >
          <TabsList className="mr-1 h-7! bg-muted/70 p-0.5 group-data-horizontal/tabs:h-7">
            <TabsTrigger value="data" className="px-2 text-xs">
              Data
            </TabsTrigger>
            <TabsTrigger value="structure" className="px-2 text-xs">
              Structure
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {view === "data" && (
          <>
            <FilterPopover
              columns={data?.columns ?? []}
              applied={filters}
              draft={draft}
              onDraft={setDraft}
              onApply={applyFilters}
              holding={pending > 0}
            />
            <FieldsPopover
              columns={data?.columns ?? []}
              hidden={hidden}
              onChange={setHidden}
            />
            <IconButton
              label="Reload"
              onClick={() => void leave(() => setReload(reload + 1))}
            >
              {loading ? <Spinner className="size-3" /> : <RefreshCw />}
            </IconButton>
            <IconButton
              label={
                formatValues.on
                  ? "Show values as printed"
                  : "Format values: tags, links, grouped digits"
              }
              pressed={formatValues.on}
              className={cn(formatValues.on && "bg-muted text-foreground")}
              onClick={formatValues.toggle}
            >
              <Palette />
            </IconButton>
            <IconButton
              label={rowHeight.compact ? "Comfortable rows" : "Compact rows"}
              onClick={rowHeight.toggle}
            >
              {rowHeight.compact ? <UnfoldVertical /> : <FoldVertical />}
            </IconButton>

            {editable && (
              <>
                <div className="mx-1 h-4 w-px bg-border" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setInserts([...inserts, {}])}
                >
                  <Plus />
                  Row
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={deleteSelected}
                >
                  <Trash2 />
                  Delete
                </Button>
              </>
            )}
            {readOnlyReason && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="ml-1 inline-flex cursor-default items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
                      aria-label={readOnlyReason.detail}
                    >
                      <Lock className="size-3" />
                      {readOnlyReason.label}
                    </span>
                  }
                />
                <TooltipContent>{readOnlyReason.detail}</TooltipContent>
              </Tooltip>
            )}
          </>
        )}

        <div className="flex-1" />

        {pending > 0 && (
          <>
            <span className="text-xs text-muted-foreground">
              {pending} unsaved {pending === 1 ? "change" : "changes"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearPending}
              disabled={saving}
            >
              <Undo2 />
              Discard
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner className="size-3.5" /> : <Save />}
              Save
            </Button>
          </>
        )}
      </div>

      {(saveError ?? error) && (
        <ErrorNote className="m-2 shrink-0">{saveError ?? error}</ErrorNote>
      )}

      <div className="min-h-0 flex-1">
        {view === "structure" ? (
          info && (
            <StructureView
              connectionId={tab.connectionId}
              schema={tab.schema}
              table={tab.table}
              info={info}
            />
          )
        ) : data ? (
          <DataGrid
            widthKey={tableKey}
            hidden={hidden}
            onHide={(column) => setHidden(new Set([...hidden, column]))}
            columns={gridColumns}
            rows={data.rows}
            firstRowNumber={offset + 1}
            sort={sort}
            onSort={cycleSort}
            onSortTo={(next) =>
              void leave(() => {
                setSort(next)
                setOffset(0)
              })
            }
            fields={fields}
            onEditField={(column, header) => setSettingsFor({ column, header })}
            editing={editing}
          />
        ) : (
          loading && <Loading />
        )}
      </div>

      {view === "data" && data && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-t bg-muted/30 pr-2 pl-3 text-xs text-muted-foreground tabular-nums">
          <span>
            {count === 0
              ? "No rows"
              : `${(offset + 1).toLocaleString()}–${(offset + count).toLocaleString()}`}
            {total !== null && ` of ${total.toLocaleString()}`}
            {filters.length > 0 && " (filtered)"}
          </span>
          <div className="flex-1" />
          <SimpleSelect
            label="Rows per page"
            heading="Rows per page"
            value={String(limit) as keyof typeof PAGE_SIZES}
            items={PAGE_SIZES}
            align="end"
            className="h-6! border-transparent"
            onChange={(size) =>
              void leave(() => {
                setLimit(Number(size))
                setOffset(0)
              })
            }
          />
          {total !== null && total > limit && (
            <span className="px-1">
              Page {Math.floor(offset / limit) + 1} of{" "}
              {Math.ceil(total / limit).toLocaleString()}
            </span>
          )}
          <IconButton
            label="Previous page"
            disabled={offset === 0}
            onClick={() =>
              void leave(() => setOffset(Math.max(0, offset - limit)))
            }
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="Next page"
            disabled={!hasNext}
            onClick={() => void leave(() => setOffset(offset + limit))}
          >
            <ChevronRight />
          </IconButton>
        </div>
      )}

      {settingsOf && data && (
        <FieldSettingsDialog
          column={gridColumns.find((column) => column.name === settingsOf)!}
          header={settingsFor?.header ?? null}
          current={fields.fields[settingsOf] ?? null}
          samples={data.rows.map(
            (row) => row[data.columns.findIndex((column) => column.name === settingsOf)] ?? null
          )}
          onSave={async (settings) =>
            setFields(
              await window.veylens.setFieldSettings(
                tab.connectionId,
                { schema: tab.schema, table: tab.table },
                settingsOf,
                settings
              )
            )
          }
          onSuggest={(multi) => suggestValues(settingsOf, multi)}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  )
}
