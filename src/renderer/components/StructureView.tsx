import {
  ArrowRight,
  Check,
  CircleCheck,
  Copy,
  Eye,
  Fingerprint,
  KeyRound,
  Link2,
  ListTree,
  Search,
  SquareTerminal,
  Table2,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type {
  TableColumn,
  TableConstraint,
  TableDetails,
  TableInfo,
  Tone,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { errorMessage, useStore } from "@/lib/store"
import { IconTile, KIND_TONE, toneColor, toneStyle } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { ColumnKindIcon } from "./DataGrid"
import { IconButton } from "./icon-button"
import { ErrorNote } from "./state-view"
import { SqlText } from "./sql-code"

/** 1.2 MB, 340 kB, 8 kB: a size as people say it. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes)) return null
  const units = ["B", "kB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** About 12,300: an estimate never says more than it knows. */
function aboutRows(estimate: number | null): string | null {
  if (estimate === null) return null
  if (estimate < 1000) return `${estimate.toLocaleString()} rows`
  const rounded = Number(estimate.toPrecision(2))
  return `≈ ${rounded.toLocaleString()} rows`
}

const CONSTRAINT_LOOK: Record<TableConstraint["kind"], { label: string; tone: Tone; icon: typeof KeyRound }> = {
  primary: { label: "Primary key", tone: "amber", icon: KeyRound },
  unique: { label: "Unique", tone: "teal", icon: Fingerprint },
  foreign: { label: "Foreign key", tone: "blue", icon: Link2 },
  check: { label: "Check", tone: "green", icon: CircleCheck },
  exclusion: { label: "Exclusion", tone: "pink", icon: Fingerprint },
}

/** A short label on a wash of its tone. */
function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center rounded px-1.5 text-[10.5px] leading-[18px] font-medium whitespace-nowrap"
      style={{
        color: toneColor(tone),
        background: `color-mix(in oklch, ${toneColor(tone)} 13%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px]", className)}>{children}</span>
}

function CopyText({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <IconButton
      label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  )
}

/** A table named in another section, opened in its own tab on a click. */
function TableLink({
  connectionId,
  schema,
  table,
  columns,
  sameSchema,
}: {
  connectionId: string
  schema: string
  table: string
  columns: string[]
  sameSchema: boolean
}) {
  const openTable = useStore((state) => state.openTable)
  return (
    <button
      type="button"
      title={`Open ${schema}.${table}`}
      onClick={() => openTable(connectionId, schema, table)}
      className="inline-flex min-w-0 items-center gap-1 rounded px-1 font-mono text-[11px] text-primary hover:bg-primary/10 hover:underline"
    >
      <span className="truncate">
        {sameSchema ? "" : `${schema}.`}
        {table}
        {columns.length ? `.${columns.length === 1 ? columns[0] : `(${columns.join(", ")})`}` : ""}
      </span>
    </button>
  )
}

function Section({
  id,
  title,
  count,
  action,
  children,
}: {
  id: string
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-14 overflow-hidden rounded-lg border bg-card shadow-xs">
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-5 text-center text-xs text-muted-foreground">{children}</p>
}

/** The rows of a section's table: a quiet header, rows that light on hover. */
const TH = "h-8 border-b px-3 text-left text-[11px] font-medium whitespace-nowrap text-muted-foreground"
const TD = "border-b border-border/60 px-3 py-2 align-middle"

/**
 * A table's structure, read as a page: what it is and how big, its columns
 * with their keys and comments, its indexes and rules, the tables that point
 * at it, and the statement that would make it again.
 */
export function StructureView({
  connectionId,
  schema,
  table,
  info,
}: {
  connectionId: string
  schema: string
  table: string
  info: TableInfo
}) {
  const engine = useStore(
    (state) => state.connections.find((item) => item.id === connectionId)?.engine ?? "postgres"
  )
  const openQuery = useStore((state) => state.openQuery)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setDetails(null)
    setError(null)
    window.veylens
      .getTableDetails(connectionId, { schema, table })
      .then(
        (found) => live && setDetails(found),
        (failure) => live && setError(errorMessage(failure))
      )
    return () => {
      live = false
    }
  }, [connectionId, schema, table, info])

  const constraints = details?.constraints ?? []
  /** Per column: where its single-column foreign key points, if it has one. */
  const pointsTo = useMemo(() => {
    const map = new Map<string, NonNullable<TableConstraint["references"]>>()
    for (const key of constraints) {
      if (key.kind === "foreign" && key.references && key.columns.length === 1) {
        map.set(key.columns[0]!, { ...key.references, columns: key.references.columns })
      }
    }
    return map
  }, [constraints])
  const uniqueColumns = useMemo(
    () =>
      new Set(
        constraints
          .filter((key) => key.kind === "unique" && key.columns.length === 1)
          .map((key) => key.columns[0]!)
          .concat(
            (details?.indexes ?? [])
              .filter((index) => index.unique && !index.primary && index.columns.length === 1)
              .map((index) => index.columns[0]!)
          )
      ),
    [constraints, details]
  )

  const columns = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = info.columns.map((column, index) => ({ column, position: index + 1 }))
    if (!needle) return all
    return all.filter(
      ({ column }) =>
        column.name.toLowerCase().includes(needle) ||
        column.type.toLowerCase().includes(needle) ||
        (details?.columnComments[column.name] ?? "").toLowerCase().includes(needle)
    )
  }, [info, query, details])

  const view = info.kind === "view"
  const quote = (name: string) =>
    engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`
  const qualified = `${quote(schema)}.${quote(table)}`

  const jump = (id: string) =>
    scroller.current?.querySelector(`#${id}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" })

  const outgoing = constraints.filter((key) => key.kind === "foreign")
  const rules = constraints.filter((key) => key.kind !== "foreign")
  const stats = details
    ? [
        aboutRows(details.rowEstimate),
        formatBytes(details.totalBytes) &&
          `${formatBytes(details.totalBytes)}${details.indexBytes ? ` · ${formatBytes(details.indexBytes)} in indexes` : ""}`,
        details.engine && [details.engine, details.collation].filter(Boolean).join(" · "),
      ].filter(Boolean)
    : []

  const nav: { id: string; label: string; count?: number }[] = [
    { id: "structure-columns", label: "Columns", count: info.columns.length },
    ...(view ? [] : [{ id: "structure-indexes", label: "Indexes", count: details?.indexes.length }]),
    ...(view ? [] : [{ id: "structure-keys", label: "Keys & rules", count: details ? constraints.length : undefined }]),
    { id: "structure-referenced", label: "Referenced by", count: details?.referencedBy.length },
    { id: "structure-ddl", label: "DDL" },
  ]

  return (
    <div ref={scroller} className="selectable h-full overflow-auto bg-muted/40 dark:bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
        {/* What it is, and how big. */}
        <div className="flex items-start gap-3 rounded-lg border bg-card p-4 shadow-xs">
          <IconTile tone={view ? KIND_TONE.view : KIND_TONE.table} size="lg">
            {view ? <Eye /> : <Table2 />}
          </IconTile>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold">
                <span className="font-normal text-muted-foreground">{schema}.</span>
                {table}
              </h2>
              <Badge tone={view ? KIND_TONE.view : KIND_TONE.table}>{details?.kind ?? info.kind}</Badge>
            </div>
            {details?.comment ? (
              <p className="text-xs text-muted-foreground">{details.comment}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>
                {info.columns.length} {info.columns.length === 1 ? "column" : "columns"}
              </span>
              {stats.map((item) => (
                <span key={String(item)} className="before:mr-3 before:content-['·']">
                  {item}
                </span>
              ))}
              {!details && !error && <span className="h-3 w-32 animate-pulse rounded bg-muted" />}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openQuery(connectionId, {
                  sql: `SELECT *\nFROM ${qualified}\nLIMIT 100;`,
                  title: table,
                  autoRun: true,
                })
              }
            >
              <SquareTerminal />
              Query
            </Button>
            <CopyText text={qualified} label="Copy qualified name" />
          </div>
        </div>

        {/* Where to go on the page. */}
        <nav
          aria-label="Sections"
          className="sticky top-0 z-10 -mx-5 -my-2 flex gap-1 bg-muted/40 px-5 py-2 backdrop-blur dark:bg-background/80"
        >
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => jump(item.id)}
              className="flex h-7 items-center gap-1.5 rounded-full border bg-card px-3 text-xs hover:bg-muted"
            >
              {item.label}
              {item.count !== undefined && (
                <span className="text-muted-foreground tabular-nums">{item.count}</span>
              )}
            </button>
          ))}
        </nav>

        {error && <ErrorNote>{error}</ErrorNote>}

        <Section
          id="structure-columns"
          title="Columns"
          count={info.columns.length}
          action={
            <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border bg-background px-2 focus-within:ring-2 focus-within:ring-ring/40">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label="Find a column"
                value={query}
                placeholder="Find a column, type or comment"
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </label>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className={cn(TH, "w-10 text-right")}>#</th>
                  <th className={TH}>Name</th>
                  <th className={TH}>Type</th>
                  <th className={TH}>Nullable</th>
                  <th className={TH}>Default</th>
                  <th className={cn(TH, "w-full")}>Comment</th>
                </tr>
              </thead>
              <tbody>
                {columns.map(({ column, position }) => (
                  <ColumnRow
                    key={column.name}
                    column={column}
                    position={position}
                    connectionId={connectionId}
                    schema={schema}
                    comment={details?.columnComments[column.name] ?? null}
                    references={pointsTo.get(column.name)}
                    unique={uniqueColumns.has(column.name)}
                  />
                ))}
              </tbody>
            </table>
            {columns.length === 0 && <Empty>No column matches “{query}”.</Empty>}
          </div>
        </Section>

        {!view && (
          <Section id="structure-indexes" title="Indexes" count={details?.indexes.length}>
            {!details ? (
              <Pending />
            ) : details.indexes.length === 0 ? (
              <Empty>No indexes. Every lookup reads the whole table.</Empty>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>
                    <th className={TH}>Name</th>
                    <th className={TH}>Columns</th>
                    <th className={TH}>Kind</th>
                    <th className={cn(TH, "text-right")}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {details.indexes.map((index) => (
                    <tr key={index.name} className="hover:[&>td]:bg-muted/40">
                      <td className={TD}>
                        <Mono>{index.name}</Mono>
                      </td>
                      <td className={TD}>
                        <span className="flex flex-wrap gap-1">
                          {index.columns.map((name, at) => (
                            <span key={at} className="rounded border bg-muted/50 px-1.5 font-mono text-[11px] leading-[18px]">
                              {name}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className={TD}>
                        <span className="flex items-center gap-1">
                          {index.primary ? (
                            <Badge tone="amber">primary</Badge>
                          ) : index.unique ? (
                            <Badge tone="teal">unique</Badge>
                          ) : null}
                          {index.method && (
                            <span className="text-[11px] text-muted-foreground lowercase">{index.method}</span>
                          )}
                        </span>
                      </td>
                      <td className={cn(TD, "text-right text-muted-foreground tabular-nums")}>
                        {formatBytes(index.bytes) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {!view && (
          <Section id="structure-keys" title="Keys & rules" count={details ? constraints.length : undefined}>
            {!details ? (
              <Pending />
            ) : constraints.length === 0 ? (
              <Empty>No primary key, foreign keys or checks.</Empty>
            ) : (
              <ul className="flex flex-col">
                {[...rules, ...outgoing].map((key) => {
                  const look = CONSTRAINT_LOOK[key.kind]
                  const Icon = look.icon
                  return (
                    <li key={key.name} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0">
                      <IconTile tone={look.tone} size="xs">
                        <Icon />
                      </IconTile>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="text-xs font-medium">{look.label}</span>
                          <Mono className="truncate text-muted-foreground">{key.name}</Mono>
                        </div>
                        {key.references ? (
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                            <Mono>{key.columns.join(", ")}</Mono>
                            <ArrowRight className="size-3 text-muted-foreground" />
                            <TableLink
                              connectionId={connectionId}
                              schema={key.references.schema}
                              table={key.references.table}
                              columns={key.references.columns}
                              sameSchema={key.references.schema === schema}
                            />
                            {key.references.onDelete && key.references.onDelete !== "no action" && (
                              <Badge tone={key.references.onDelete === "cascade" ? "red" : "gray"}>
                                on delete {key.references.onDelete}
                              </Badge>
                            )}
                            {key.references.onUpdate && key.references.onUpdate !== "no action" && (
                              <Badge tone="gray">on update {key.references.onUpdate}</Badge>
                            )}
                          </div>
                        ) : (
                          <Mono className="break-all text-muted-foreground">{key.definition}</Mono>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        )}

        <Section id="structure-referenced" title="Referenced by" count={details?.referencedBy.length}>
          {!details ? (
            <Pending />
          ) : details.referencedBy.length === 0 ? (
            <Empty>No other table points here.</Empty>
          ) : (
            <ul className="flex flex-col">
              {details.referencedBy.map((key) => (
                <li
                  key={`${key.schema}.${key.table}.${key.name}`}
                  className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0"
                >
                  <IconTile tone="blue" size="xs">
                    <ListTree />
                  </IconTile>
                  <TableLink
                    connectionId={connectionId}
                    schema={key.schema}
                    table={key.table}
                    columns={key.columns}
                    sameSchema={key.schema === schema}
                  />
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                  <Mono>
                    {table}.{key.referencedColumns.join(", ")}
                  </Mono>
                  <span className="flex-1" />
                  <Mono className="truncate text-muted-foreground">{key.name}</Mono>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          id="structure-ddl"
          title="DDL"
          action={
            details && (
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => openQuery(connectionId, { sql: details.ddl, title: `${table} DDL` })}
                >
                  <SquareTerminal />
                  Open in query tab
                </Button>
                <CopyText text={details.ddl} label="Copy DDL" />
              </span>
            )
          }
        >
          {!details ? (
            <Pending />
          ) : (
            <pre className="max-h-[28rem] overflow-auto bg-muted/30 p-4 font-mono text-[11px] leading-5 whitespace-pre">
              <SqlText text={details.ddl} />
            </pre>
          )}
        </Section>
      </div>
    </div>
  )
}

function Pending() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-label="Loading">
      {[90, 70, 80].map((share, index) => (
        <div key={index} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${share}%` }} />
      ))}
    </div>
  )
}

function ColumnRow({
  column,
  position,
  connectionId,
  schema,
  comment,
  references,
  unique,
}: {
  column: TableColumn
  position: number
  connectionId: string
  schema: string
  comment: string | null
  references?: NonNullable<TableConstraint["references"]>
  unique: boolean
}) {
  const auto = /auto_increment/i.test(column.extra) || column.extra === "identity" || /^nextval\(/i.test(column.default ?? "")
  const generated = column.extra === "generated"
  // A serial's default is the sequence: said as "auto", the call kept in the title.
  const shownDefault = /^nextval\(/i.test(column.default ?? "") ? null : column.default
  const extras = column.extra
    .split(/\s+(?=on update)/i)
    .filter((part) => part && !/^(auto_increment|identity|generated)$/i.test(part))
  return (
    <tr className="group/row hover:[&>td]:bg-muted/40">
      <td className={cn(TD, "text-right text-[11px] text-muted-foreground tabular-nums")}>{position}</td>
      <td className={TD}>
        <span className="flex items-center gap-2">
          <ColumnKindIcon kind={column.kind} primaryKey={column.primaryKey} />
          <span className="font-medium whitespace-nowrap">{column.name}</span>
          {column.primaryKey && <Badge tone="amber">PK</Badge>}
          {references && (
            <span className="flex items-center gap-0.5" title={`Foreign key to ${references.schema}.${references.table}`}>
              <Link2 className="size-3 shrink-0" style={toneStyle("blue")} />
              <TableLink
                connectionId={connectionId}
                schema={references.schema}
                table={references.table}
                columns={references.columns}
                sameSchema={references.schema === schema}
              />
            </span>
          )}
          {unique && !column.primaryKey && <Badge tone="teal">unique</Badge>}
          <span className="opacity-0 group-hover/row:opacity-100">
            <CopyText text={column.name} label={`Copy ${column.name}`} />
          </span>
        </span>
      </td>
      <td className={TD}>
        <span className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap">
          {column.type}
        </span>
      </td>
      <td className={TD}>
        {column.nullable ? (
          <span className="text-muted-foreground">nullable</span>
        ) : (
          <span className="font-medium">required</span>
        )}
      </td>
      <td className={TD}>
        <span className="flex flex-wrap items-center gap-1">
          {auto && <Badge tone="pink" title={column.default ?? column.extra}>auto</Badge>}
          {generated && <Badge tone="gray" title="Computed by the database">generated</Badge>}
          {shownDefault && !generated && <Mono className="text-muted-foreground">{shownDefault}</Mono>}
          {extras.map((extra) => (
            <Badge key={extra} tone="gray">{extra}</Badge>
          ))}
        </span>
      </td>
      <td className={cn(TD, "max-w-80 text-muted-foreground")}>
        <span className="line-clamp-2" title={comment ?? undefined}>
          {comment}
        </span>
      </td>
    </tr>
  )
}
