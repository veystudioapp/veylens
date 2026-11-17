/**
 * The contract between the main process and the renderer. Types and channel
 * names only — neither side imports the other, both import this.
 *
 * Adding a call means: a method on `DesktopApi`, a name in `IPC`, a thunk in
 * `src/preload/index.ts`, a handler in `src/main/ipc.ts`.
 */

import type { ToolMode } from "./agent"
import type { ChatImage } from "./chat-images"
import type { MentionRef } from "./mentions"

export type { ChatImage } from "./chat-images"

// ── Connections ────────────────────────────────────────────────────────────

/**
 * `duckdb` is not a server: it is files — Excel, CSV, Parquet, JSON — and
 * Google Sheets, loaded into an in-process DuckDB and queried with its SQL.
 */
export type Engine = "postgres" | "mysql" | "duckdb"

/** The engines that are a server at a host and port. */
export type ServerEngine = Exclude<Engine, "duckdb">

export const isServerEngine = (engine: Engine): engine is ServerEngine => engine !== "duckdb"

/**
 * Where a Google Sheet is read from: `link`, its export as anyone with the
 * link may download it, no sign-in; `google`, the Sheets API as this
 * machine's Application Default Credentials, for a sheet shared privately.
 */
export const SHEET_ACCESS = ["link", "google"] as const
export type SheetAccess = (typeof SHEET_ACCESS)[number]

/**
 * What a files connection reads. A workbook (an Excel file or a Google
 * Sheet) is a schema with a table per sheet; a CSV, Parquet or JSON file is
 * a table in `main`.
 */
export type DataSource =
  | { kind: "file"; path: string }
  | { kind: "google_sheet"; url: string; access: SheetAccess }

/**
 * The Google account private Google Sheets are read as, signed in from the
 * app. `client` is the OAuth client signing in goes through: one built into
 * this build, one imported from its JSON, or none yet.
 */
export type GoogleAccountState = {
  email: string | null
  client: "built_in" | "imported" | null
  /** The browser is open, waiting for Google to send it back. */
  signingIn: boolean
}

/** The files a files connection can be given, by extension. */
export const DATA_FILE_EXTENSIONS = {
  workbook: ["xlsx", "xlsm", "xlsb", "xls", "ods"],
  csv: ["csv", "tsv", "txt"],
  parquet: ["parquet"],
  json: ["json", "jsonl", "ndjson"],
} as const

/** `require` encrypts without checking the certificate; `verify` checks it. */
export type SslMode = "off" | "require" | "verify"

export const CLOUD_SQL_IP_TYPES = ["public", "private", "psc"] as const
export type CloudSqlIpType = (typeof CLOUD_SQL_IP_TYPES)[number]

export const CLOUD_SQL_AUTHS = ["password", "iam"] as const
export type CloudSqlAuth = (typeof CLOUD_SQL_AUTHS)[number]

/**
 * A Google Cloud SQL instance reached through Google's connector instead of
 * a host and port: the connector finds the address, encrypts the connection
 * with certificates of its own and signs in to Google with the machine's
 * Application Default Credentials (`gcloud auth application-default login`).
 * `iam` signs in to the database as that Google account, without a password.
 */
export type CloudSql = {
  /** `project:region:instance`, as the console shows it. */
  instance: string
  ipType: CloudSqlIpType
  auth: CloudSqlAuth
}

/**
 * What this app lets anyone — you in a table or a SQL tab, or the assistant —
 * do through a connection, whatever the database user itself may do.
 * `confirm` asks before every write; `read_only` refuses them, in this
 * process and in a session the server itself holds read-only.
 */
export const ACCESS_MODES = ["read_write", "confirm", "read_only"] as const

export type AccessMode = (typeof ACCESS_MODES)[number]

/**
 * Finer than the access mode: what each kind of write may do, which schemas
 * and tables may be seen or written, and guards on what a statement may
 * touch. Read off the SQL by this app, on top of the access mode — which
 * stays the floor: `confirm` raises Allow to Ask, `read_only` blocks all.
 */
export const STATEMENT_KINDS = ["insert", "update", "delete", "ddl"] as const
export type StatementKind = (typeof STATEMENT_KINDS)[number]

export const RULES = ["allow", "ask", "block"] as const
export type Rule = (typeof RULES)[number]

/** A schema's or a table's: not seen at all, seen and not written, or as the
 * connection allows. The most specific rule wins: a table over its schema. */
export const OBJECT_ACCESS = ["hidden", "read", "write"] as const
/**
 * What a rule can say, plus `schema`: listed and described, its data
 * refused — what an object whose data the assistant may not read is to the
 * assistant. Never stored; made from `aiSchemaOnly` by `forAssistant`.
 */
export type ObjectAccess = (typeof OBJECT_ACCESS)[number] | "schema"

/**
 * `table` null is the whole schema. `aiSchemaOnly`: the assistant sees its
 * structure but none of its data — the user's own access is unchanged.
 */
export type ObjectRule = {
  schema: string
  table: string | null
  access: ObjectAccess
  aiSchemaOnly?: boolean
}

export type Guards = {
  /** An UPDATE or DELETE without WHERE is refused. */
  requireWhere: boolean
  /** A write that changes more rows than this is rolled back. */
  maxAffected: number | null
  /** A statement running longer than this is stopped. */
  timeoutSeconds: number | null
  /** Rows a query brings back, at most — below the app's own cap. */
  maxRows: number | null
}

export type Permissions = {
  statements: Record<StatementKind, Rule>
  objects: ObjectRule[]
  guards: Guards
}

/**
 * The colours the app draws with outside its charts: a connection's own, and
 * one per kind of thing (a table, a dashboard…) in the renderer's `tones.ts`.
 */
export const TONES = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "pink",
  "gray",
] as const

export type Tone = (typeof TONES)[number]

export type Connection = {
  id: string
  name: string
  engine: Engine
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  /** Set, the host, port and SSL are not used: the connector reaches it. */
  cloudSql: CloudSql | null
  /** What a `duckdb` connection reads; empty for a server. */
  sources: DataSource[]
  access: AccessMode
  permissions: Permissions
  /** Picked by the user — red for production, say; null follows the engine. */
  color: Tone | null
  /** The password itself never crosses to the renderer. */
  hasPassword: boolean
}

export type ConnectionInput = Omit<
  Connection,
  "id" | "hasPassword" | "access" | "color" | "permissions" | "cloudSql" | "sources"
> & {
  /** `undefined` keeps the stored colour. */
  color?: Tone | null
  /** `undefined` keeps the stored sources. */
  sources?: DataSource[]
  /** `undefined` keeps the stored setting; null is a plain host and port. */
  cloudSql?: CloudSql | null
  /** `undefined` keeps the stored password; a string (even empty) replaces it. */
  password?: string
  /** Read-only for new connections, kept as-is when editing, if not said. */
  access?: AccessMode
}

// ── Gateway ────────────────────────────────────────────────────────────────

/**
 * A port on this machine that an app under development connects to instead
 * of a database. It is for one engine and holds a few saved connections of
 * it ("PG local", "PG dev", …); the app's connections go to the one picked,
 * the gateway signing in as it. Picking another is the switch: the app's
 * `.env` never changes.
 */
export type GatewaySettings = {
  /** Empty for one not saved yet. */
  id: string
  name: string
  engine: ServerEngine
  /** On 127.0.0.1. */
  port: number
  enabled: boolean
  /** The saved connections it can go to, in order. */
  connections: string[]
  /** The one it goes to now; null while it holds none. */
  active: string | null
  /** What apps sign in to this gateway with, whatever user they name. It
   * goes in their `.env`, so it is shown. Empty asks for a new one. */
  password: string
}

export type GatewayStatus = {
  gatewayId: string
  listening: boolean
  /** Why it is not listening: the port is taken, say. */
  error: string | null
  /** App connections open through it now. */
  sessions: number
  /** Whether the statements apps run through it are being kept. */
  recording: boolean
}

/**
 * One statement an app ran through a gateway, as the gateway saw it go by.
 * Kept in memory only, a few thousand per gateway, and never written down:
 * the SQL and its values may be anyone's data.
 */
export type GatewayQuery = {
  /** Increasing, across gateways. */
  id: number
  gatewayId: string
  /** Which app connection: numbered as they arrive. */
  session: number
  /** The saved connection it went to. */
  connectionId: string | null
  /** When the app sent it, ms since the epoch. */
  at: number
  /** From the app sending it to the server's answer being complete. */
  ms: number
  sql: string
  /** Values bound to `$1`, `$2`…, as text; null when none could be read. */
  params: string[] | null
  command: string | null
  rows: number | null
  error: string | null
}

/** Statements just seen, sent in bursts to whoever is watching. */
export type GatewayQueryBatch = { queries: GatewayQuery[] }

export type GatewayState = {
  gateways: GatewaySettings[]
  status: GatewayStatus[]
}

export const GATEWAY_DEFAULT_PORT: Record<ServerEngine, number> = {
  postgres: 15432,
  mysql: 13306,
}

// ── Schema ─────────────────────────────────────────────────────────────────

export type TreeTable = { name: string; kind: "table" | "view" }
export type TreeSchema = { name: string; tables: TreeTable[] }

export type TableRef = { schema: string; table: string }

export type ColumnKind =
  "number" | "boolean" | "datetime" | "json" | "binary" | "text"

export type Column = { name: string; type: string; kind: ColumnKind }

export type TableColumn = Column & {
  nullable: boolean
  default: string | null
  primaryKey: boolean
  /** `auto_increment`, `generated`, … — whatever the engine says beyond the type. */
  extra: string
}

export type TableInfo = {
  columns: TableColumn[]
  /** One readable line per foreign key. */
  foreignKeys: string[]
  kind: "table" | "view"
}

/** An index, by the columns (or expressions) it is built on, in order. */
export type TableIndex = {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  /** btree, hash, gin, BTREE, FULLTEXT… */
  method: string | null
  /** Null when the engine does not say. */
  bytes: number | null
}

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default"

/** A rule the table keeps: its key, a unique set, a check, a foreign key. */
export type TableConstraint = {
  name: string
  kind: "primary" | "unique" | "check" | "foreign" | "exclusion"
  columns: string[]
  /** As the engine writes it: CHECK (price >= 0), FOREIGN KEY (…) REFERENCES … */
  definition: string
  references?: {
    schema: string
    table: string
    columns: string[]
    onDelete: ForeignKeyAction | null
    onUpdate: ForeignKeyAction | null
  }
}

/** A foreign key in another table that points at this one. */
export type IncomingKey = {
  name: string
  schema: string
  table: string
  /** Theirs, and the ones of this table they point at. */
  columns: string[]
  referencedColumns: string[]
}

/** What the Structure view shows beyond the columns. */
export type TableDetails = {
  kind: "table" | "view" | "materialized view"
  comment: string | null
  /** The planner's estimate — not a count. */
  rowEstimate: number | null
  totalBytes: number | null
  indexBytes: number | null
  /** MySQL's storage engine and collation. */
  engine: string | null
  collation: string | null
  columnComments: Record<string, string>
  indexes: TableIndex[]
  constraints: TableConstraint[]
  referencedBy: IncomingKey[]
  /** CREATE TABLE (or VIEW) as the engine has it, or as rebuilt from the catalogue. */
  ddl: string
}

// ── Schema diagram ─────────────────────────────────────────────────────────

/** A table as a schema diagram draws it: its columns, and which are its key. */
export type DiagramTable = {
  schema: string
  name: string
  kind: "table" | "view"
  columns: { name: string; type: string; primaryKey: boolean; nullable: boolean }[]
}

/**
 * A foreign key, from the columns of the table holding it to the ones they
 * point at. `inferred` is one read off the names (`customer_id` → customers)
 * where the database declares none — drawn, but never claimed as a key.
 */
export type DiagramLink = {
  name: string
  from: TableRef & { columns: string[] }
  to: TableRef & { columns: string[] }
  inferred?: boolean
}

/**
 * A schema's tables and the keys between them. Tables of another schema that
 * a key reaches are included, so the line has somewhere to go.
 */
export type SchemaDiagram = {
  schema: string
  tables: DiagramTable[]
  links: DiagramLink[]
}

// ── Rows ───────────────────────────────────────────────────────────────────

/** Every value travels as the text the database prints for it, or null. */
export type Cell = string | null

export const FILTER_OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
] as const

export type FilterOp = (typeof FILTER_OPS)[number]

/** The word before a condition or group: what joins it to the one before. */
export type FilterJoin = "and" | "or"

/** `join` is ignored on the first of a level; absent, the level's `match`. */
export type Filter = { column: string; op: FilterOp; value: string; join?: FilterJoin }

export type Sort = { column: string; direction: "asc" | "desc" }

/** How a level's conditions combine when they do not say: all, or any. */
export type FilterMatch = "all" | "any"

/** Conditions held together in brackets, one level deep. */
export type FilterGroup = { filters: Filter[]; join?: FilterJoin; match?: FilterMatch }

/** A condition, or a group of them, at the top of a table's filters. */
export type FilterNode = Filter | FilterGroup

export const isFilterGroup = (node: FilterNode): node is FilterGroup =>
  "filters" in node && Array.isArray(node.filters)

/**
 * Filters as one expression, each joined to the one before by its own word,
 * and binding before or as SQL has it: `a and b or c` is `(a and b) or c`.
 * The SQL that is run and the sentence the popover reads back both come from
 * here, so they cannot disagree. Null when nothing is said.
 */
export function combineFilters<T>(
  nodes: FilterNode[],
  match: FilterMatch,
  leaf: (filter: Filter) => T,
  join: (items: T[], word: FilterJoin) => T
): T | null {
  const fallback: FilterJoin = match === "any" ? "or" : "and"
  const runs: T[][] = []
  for (const node of nodes) {
    const part = isFilterGroup(node)
      ? combineFilters(node.filters, node.match ?? "all", leaf, join)
      : leaf(node)
    if (part === null) continue
    if (runs.length === 0 || (node.join ?? fallback) === "or") runs.push([part])
    else runs.at(-1)!.push(part)
  }
  if (runs.length === 0) return null
  const ands = runs.map((run) => (run.length === 1 ? run[0]! : join(run, "and")))
  return ands.length === 1 ? ands[0]! : join(ands, "or")
}

export type RowsRequest = TableRef & {
  filters: FilterNode[]
  /** All when absent. */
  match?: FilterMatch
  sort: Sort | null
  limit: number
  offset: number
}

export type RowsResult = {
  columns: TableColumn[]
  rows: Cell[][]
  /** Null when counting took too long to be worth waiting for. */
  total: number | null
}

/** Primary-key column → value: which row a change is about. */
export type RowKey = Record<string, Cell>

export type ChangeSet = TableRef & {
  updates: { key: RowKey; values: Record<string, Cell> }[]
  /** Columns left out take the table's default. */
  inserts: Record<string, Cell>[]
  deletes: RowKey[]
}

export type QueryResult = {
  columns: Column[]
  rows: Cell[][]
  /** There were more rows than the cap; `rows` holds the first ones. */
  truncated: boolean
  /** Rows changed by a statement that returns none. */
  affected: number | null
  command: string | null
  ms: number
}

/** One step of a plan run in a single transaction, as it went. */
export type PlanStepResult = {
  command: string | null
  affected: number | null
}

// ── Charts ─────────────────────────────────────────────────────────────────

/**
 * The forms a result can be drawn as. `bar` is columns over a category or a
 * time, `hbar` ranked horizontal bars (what a pie is asked for as), `line` and
 * `area` change over time, `stat` the one number a result is, `kpi` a number
 * against the period before with its trend, `pivot` a matrix of one value by
 * two dimensions, `table` the rows with numbers shaded by size. `scatter` is
 * one measure against another, a dot per row; `funnel` ordered steps and how
 * many are left at each; `waterfall` a starting figure, the changes that move
 * it, and where it ends; `progress` a figure against its target. `pie` and
 * `donut` are a few parts of one whole, `treemap` many parts as nested
 * rectangles, `combo` columns with one measure of another unit as a line on
 * a second axis — the one chart with two.
 */
export const CHART_TYPES = [
  "bar",
  "hbar",
  "line",
  "area",
  "combo",
  "scatter",
  "pie",
  "donut",
  "treemap",
  "funnel",
  "waterfall",
  "stat",
  "kpi",
  "progress",
  "pivot",
  "table",
] as const

export type ChartType = (typeof CHART_TYPES)[number]

export type ChartSpec = {
  type: ChartType
  /**
   * The column along the category or time axis — the rows of a pivot, the
   * period of a KPI's trend, a funnel's steps, a waterfall's changes, the
   * parts of a pie or a treemap, the horizontal measure of a scatter; null
   * for `stat`, `table`, a one-row KPI
   * and a one-row progress.
   */
  x: string | null
  /** The numeric columns plotted, one series each. */
  y: string[]
  /**
   * A column whose values become the series, for a result in long form
   * (`GROUP BY month, channel`): one line or bar per channel, of `y[0]`. The
   * columns of a pivot; the colour of a scatter's dots.
   */
  series?: string | null
  /** Bars of several series on top of each other rather than side by side. */
  stacked?: boolean
  /** Stacked to 100%: each series as its share of the category's total. */
  percent?: boolean
  /** For a combo: the column drawn as a line, on its own axis on the right. */
  line?: string | null
  /** For a scatter: the column sizing each dot by area — a bubble chart. */
  size?: string | null
  /** For a one-row KPI: the column holding the previous period's value. */
  compare?: string | null
  /** For a progress: the column holding the target `y[0]` is measured against. */
  target?: string | null
  /** For a KPI, a progress and a waterfall: whether a rise is good news. True
   * unless said otherwise. */
  upIsGood?: boolean
  /** Lines and marks worked out from the plotted values themselves. */
  analytics?: ChartAnalytics
  /**
   * Finer columns under x, coarse to fine — year, then quarter, then month:
   * clicking a category drills into it, its values summed at the next level.
   */
  levels?: string[]
  /** A column whose values each get a small chart of their own, on one scale. */
  facet?: string | null
  /** For a table and a pivot: how cells are marked beyond their shading. */
  rules?: CellRule[]
}

/** Power BI's analytics pane: what is drawn over a chart from its own data. */
export type ChartAnalytics = {
  /** A dashed line at each series' mean. */
  average?: boolean
  /** A dotted line at each series' median. */
  median?: boolean
  /** A straight line fitted to each series by least squares. */
  trend?: boolean
  /** Periods continued along the fitted line, with the range it is likely in. */
  forecast?: number
  /** Points ringed where they lie more than two standard deviations off the fit. */
  anomalies?: boolean
  /** A fixed value drawn across the plot: a goal, a limit. */
  constant?: number | null
  constantLabel?: string | null
}

export const ANALYTIC_TYPES = new Set<ChartType>(["bar", "line", "area", "combo", "scatter"])

/** A table's or a pivot's cell marked by its value: a bar in the cell, an
 * arrow by its sign, or a colour past a threshold. */
export type CellRule =
  | { column: string; kind: "bars" }
  | { column: string; kind: "icons"; upIsGood?: boolean }
  | { column: string; kind: "above" | "below"; value: number; tone: "good" | "bad" }

/** Series past this fold into the table view; no ninth colour is invented. */
export const MAX_SERIES = 8

// ── Business context ───────────────────────────────────────────────────────

/**
 * A business figure defined once — "net revenue", "AOV" — so that every
 * answer computes it the same way.
 */
export type Metric = {
  id: string
  name: string
  description: string
  /** The SQL that computes it: an expression, or a whole query. */
  sql: string
}

/** What one connection's data means, as the user wrote it down. */
export type Knowledge = {
  /** Markdown: what the tables are for, what codes mean, what to avoid. */
  notes: string
  metrics: Metric[]
  updatedAt: number
}

// ── Alerts ─────────────────────────────────────────────────────────────────

/**
 * When an alert fires: its number goes above or below the threshold, or —
 * `change` — moves by at least the threshold, in percent, since the check
 * before.
 */
export const ALERT_CONDITIONS = ["above", "below", "change"] as const
export type AlertCondition = (typeof ALERT_CONDITIONS)[number]

/** How often an alert may be checked, in minutes. */
export const ALERT_INTERVALS = [5, 15, 30, 60, 360, 1440] as const

/**
 * `pending` has not been checked yet; `ok` was within bounds at the last
 * check; `triggered` was not; `error` could not be checked.
 */
export type AlertStatus = "pending" | "ok" | "triggered" | "error"

export type AlertState = {
  status: AlertStatus
  /** The number the last check read. */
  value: number | null
  /** The one before it: what `change` compares with. */
  previous: number | null
  checkedAt: number | null
  /** When it last went from within bounds to out of them. */
  triggeredAt: number | null
  error: string | null
}

/**
 * A number watched in the background: a read-only query whose first row's
 * first column is the number, run every `everyMinutes` while the app is open,
 * with a system notification when it goes out of bounds.
 */
export type Alert = {
  id: string
  connectionId: string
  name: string
  sql: string
  condition: AlertCondition
  threshold: number
  everyMinutes: number
  enabled: boolean
  state: AlertState
}

/** An alert on its way to being saved: `id` null for a new one. Its state is
 * kept, unless the SQL or the condition changed. */
export type AlertInput = Omit<Alert, "id" | "state"> & { id: string | null }

// ── Skills ─────────────────────────────────────────────────────────────────

/**
 * Instructions the user wrote for one kind of task — "weekly sales report",
 * "how we write SQL here" — for every chat, on every connection. The agent
 * sees each enabled one's name and description with every message, and reads
 * the instructions themselves when a request calls for them.
 */
export type Skill = {
  id: string
  name: string
  /** When to use it: what the agent decides by. */
  description: string
  /** Markdown: what to do. */
  instructions: string
  enabled: boolean
  updatedAt: number
  /** One of the app's own (`BUILTIN_SKILLS`): renamed or deleted never, reset. */
  builtin: boolean
  /** A built-in one that no longer reads as it shipped. */
  modified: boolean
}

/**
 * A skill on its way to being saved: `id` null for a new one. For a built-in
 * one the name is ignored.
 */
export type SkillInput = Omit<Skill, "id" | "updatedAt" | "builtin" | "modified"> & {
  id: string | null
}

/** Tool name → the mode it was set to, for those set at all. */
export type ToolModes = Partial<Record<string, ToolMode>>

// ── Field settings ─────────────────────────────────────────────────────────

/*
 * How a table's columns are drawn in the grid — the field settings of
 * NocoDB, whose options these follow (docs: nocodb.com/docs/product/tables/
 * fields). Only the drawing: the value stored, sent and edited is still the
 * text the database printed. A column with no display is "automatic", read
 * off its type and values in the renderer's `cell-format.ts`.
 */

/** Grouping and decimal marks, as NocoDB lists them. */
export const SEPARATORS = [
  "locale",
  "comma-period",
  "period-comma",
  "space-period",
  "space-comma",
  "none-period",
  "none-comma",
] as const

export type Separator = (typeof SEPARATORS)[number]

/** Large numbers shortened: 1,200,000 → 1.2M. */
export const ABBREVIATIONS = ["none", "auto", "thousand", "million", "billion", "trillion"] as const

export type Abbreviation = (typeof ABBREVIATIONS)[number]

/**
 * NocoDB's date formats, plus the locale's own ("Nov 14, 2026"), "relative"
 * ("3 days ago") and "iso" (as the database printed it).
 */
export const DATE_FORMATS = [
  "locale",
  "YYYY-MM-DD",
  "dddd YYYY-MM-DD",
  "ddd YYYY-MM-DD",
  "YYYY/MM/DD",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD/MM/YYYY",
  "dddd DD/MM/YYYY",
  "ddd DD/MM/YYYY",
  "MM/DD/YYYY",
  "dddd MM/DD/YYYY",
  "ddd MM/DD/YYYY",
  "DD MM YYYY",
  "MM DD YYYY",
  "YYYY MM DD",
  "DD MMM YYYY",
  "DD MMM YY",
  "DD.MM.YYYY",
  "DD.MM.YY",
  "relative",
  "iso",
] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

export const TIME_FORMATS = ["none", "HH:mm", "HH:mm:ss"] as const

export type TimeFormat = (typeof TIME_FORMATS)[number]

export const DURATION_FORMATS = ["h:mm", "h:mm:ss", "h:mm:ss.s", "h:mm:ss.ss", "h:mm:ss.sss"] as const

export type DurationFormat = (typeof DURATION_FORMATS)[number]

export const RATING_ICONS = ["star", "heart", "thumbs-up", "flag", "flame", "circle"] as const

export type RatingIcon = (typeof RATING_ICONS)[number]

export const CHECK_ICONS = ["check", "square", "circle-check", "star", "heart", "thumbs-up", "flag"] as const

export type CheckIcon = (typeof CHECK_ICONS)[number]

/** A single or multi select's values: their colours, and their order. */
export type SelectOptions = {
  colors: Record<string, Tone>
  /**
   * The values known to the field, in the order put — those on a page, those
   * added by hand or suggested from the column. A multi select's tags are
   * drawn in this order.
   */
  options?: string[]
  /** Colour-coding off: every tag is drawn in the same grey. */
  plain?: boolean
  /** Values A–Z, in the list and in a multi select's cell. */
  alphabetize?: boolean
}

export type FieldDisplay =
  /** The text as printed, nothing read into it. */
  | { type: "text" }
  | {
      type: "number"
      /** Null keeps the digits as printed; otherwise 0–8. */
      decimals: number | null
      separator: Separator
      abbreviate: Abbreviation
    }
  | {
      type: "currency"
      code: string
      /** A BCP 47 locale such as en-US or vi-VN; how the amount is written. */
      locale: string
      decimals: number
      abbreviate: Abbreviation
    }
  | {
      type: "percent"
      decimals: number
      /** `whole`: 75 is 75%, as NocoDB stores it. `fraction`: 0.75 is 75%. */
      scale: "fraction" | "whole"
      progress: "none" | "bar" | "circle"
    }
  | {
      type: "date"
      format: DateFormat
      time: TimeFormat
      hour12: boolean
      /** "local", "UTC", or an IANA zone such as Asia/Ho_Chi_Minh. */
      timezone: string
    }
  | { type: "duration"; unit: "seconds" | "minutes"; format: DurationFormat }
  /** A tag per value; values without a colour get one of their own. */
  | ({ type: "select" } & SelectOptions)
  /** Several tags in one value: `a, b`, `{a,b}` or `["a","b"]`. */
  | ({ type: "multiselect" } & SelectOptions)
  | { type: "checkbox"; icon: CheckIcon; color: Tone }
  | { type: "rating"; max: number; icon: RatingIcon; color: Tone }
  | { type: "progress"; max: number }
  | { type: "email" }
  | { type: "phone" }
  | { type: "url" }
  | { type: "image" }
  /** A hex colour as a swatch. */
  | { type: "colour" }

export type FieldDisplayType = FieldDisplay["type"]

/** One column's settings: how it is drawn, and a note shown in its header. */
export type FieldSettings = {
  display?: FieldDisplay
  description?: string
}

/** A table's field settings, and the column its rows are known by. */
export type TableFields = {
  fields: Record<string, FieldSettings>
  /** Null: picked automatically (a name-like column). */
  displayColumn: string | null
}

// ── Dashboards ─────────────────────────────────────────────────────────────

/** Columns of the dashboard's grid a tile spans. */
export type TileWidth = 1 | 2 | 3 | 4

export type TileHeight = "s" | "m" | "l"

export type DashboardTile = {
  id: string
  title: string
  /** Empty for a text tile. May use the dashboard's filters as `{{name}}`. */
  sql: string
  /** Null shows the result as a table. */
  chart: ChartSpec | null
  /** Markdown, for a tile that is words rather than a query. */
  text?: string | null
  /** Out of 4. Two unless set. */
  width?: TileWidth
  height?: TileHeight
  /**
   * The rows behind one of the tile's categories: SQL using `{{value}}` for
   * the category clicked, and any of the dashboard's filters.
   */
  drillSql?: string | null
}

/** A tile that is words rather than a query. */
export const isTextTile = (tile: Pick<DashboardTile, "text" | "sql">) =>
  tile.text != null && !tile.sql.trim()

/**
 * A text tile's Markdown with line breaks a model wrote as the two characters
 * `\n` — escaped once too often — made real. Only when it has no real ones,
 * so a note that means a literal `\n` in code keeps it.
 */
export const tileText = (text: string) =>
  text.includes("\n") || !text.includes("\\n") ? text : text.replace(/\\n/g, "\n")

export const DATE_PRESETS = [
  "all",
  "7d",
  "30d",
  "90d",
  "12m",
  "mtd",
  "qtd",
  "ytd",
  "custom",
] as const

export type DatePreset = (typeof DATE_PRESETS)[number]

/**
 * A control above a dashboard that scopes every tile. Tiles read it as SQL
 * parameters: a date range named `date` gives `{{date_start}}` (inclusive)
 * and `{{date_end}}` (exclusive); a select named `country` gives
 * `{{country}}`. A clause in `[[ … ]]` is left out while its parameter has
 * no value — "All", or all time.
 */
export const FILTER_KINDS = [
  "date_range",
  "select",
  "multi_select",
  "text",
  "number_range",
  "toggle",
] as const
export type FilterKind = (typeof FILTER_KINDS)[number]

/** Contains: `%words%`; starts: `words%` — with `%` and `_` in the words
 * escaped; exact: the words as typed. */
export const TEXT_MATCHES = ["contains", "starts", "exact"] as const
export type TextMatch = (typeof TEXT_MATCHES)[number]

export type DashboardFilter =
  | {
      id: string
      kind: "date_range"
      name: string
      label: string
      preset: DatePreset
      /** For `custom`: YYYY-MM-DD, both days included. */
      from: string | null
      to: string | null
    }
  | {
      id: string
      kind: "select"
      name: string
      label: string
      /** A query whose first column is the choices. */
      optionsSql: string
      /** Null is "All". */
      value: string | null
    }
  | {
      id: string
      kind: "multi_select"
      name: string
      label: string
      /** A query whose first column is the choices. */
      optionsSql: string
      /** Empty is "All"; in SQL, `IN ({{name}})`, each bound on its own. */
      values: string[]
    }
  | {
      id: string
      kind: "text"
      name: string
      label: string
      /** How the words typed meet the column: `col ILIKE {{name}}`. */
      match: TextMatch
      /** Null or empty is "All". */
      value: string | null
    }
  | {
      id: string
      kind: "number_range"
      name: string
      label: string
      /** `{{name_min}}` and `{{name_max}}`, both included; null is open. */
      min: string | null
      max: string | null
    }
  | {
      id: string
      kind: "toggle"
      name: string
      label: string
      /** Yes is 1, No is 0 — true and false to Postgres, to MySQL too. Null is "All". */
      value: boolean | null
    }

export type Dashboard = {
  id: string
  connectionId: string
  title: string
  tiles: DashboardTile[]
  filters: DashboardFilter[]
  /** Every tile is run again this often while the dashboard is open; 0 is never. */
  refreshSeconds: number
  updatedAt: number
}

/** A parameter's value as SQL receives it; null, or an empty list, leaves
 * `[[ … ]]` out. A list is bound one placeholder per value: `$1, $2, $3`. */
export type ParamValues = Record<string, string | string[] | null>

/** A tile on its way to a dashboard: an existing one, or a new one named. */
export type PinInput = {
  connectionId: string
  dashboardId: string | null
  /** For a new dashboard. */
  dashboardTitle?: string
  tile: Omit<DashboardTile, "id">
}

// ── SQL assist ─────────────────────────────────────────────────────────────

export type AssistMode = "generate" | "explain" | "fix"

export type AssistInput = {
  /** Chosen by the caller, so that it can be cancelled. */
  requestId: string
  connectionId: string
  mode: AssistMode
  /** What the editor holds. */
  sql: string
  /** For `generate`: what the user asked for, in their words. */
  instruction?: string
  /** For `fix`: what the server said. */
  error?: string
  model: string | null
  effort: ChatEffort | null
}

export type AssistResult = {
  /** The statement proposed, if any. */
  sql: string | null
  /** Markdown: the explanation, or what was changed and why. */
  text: string
}

/** A dashboard's Summarise, answered in the dashboard rather than the chat. */
export type DashboardSummaryInput = {
  /** Chosen by the caller, so that it can be cancelled with `cancelAssist`. */
  requestId: string
  dashboardId: string
  /** What a click on a tile narrowed the rest to, if anything. */
  cross?: { column: string; value: Cell } | null
  model: string | null
  effort: ChatEffort | null
}

// ── Models ─────────────────────────────────────────────────────────────────

/** `--effort`, weakest first — the CLI's own words, as in Vey. */
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type ChatEffort = (typeof CHAT_EFFORTS)[number]

/** The level a chat runs at when nobody has picked one. */
export const DEFAULT_CHAT_EFFORT: ChatEffort = "medium"

/**
 * One model the user's own `claude` will answer on, as it lists them. The
 * same shape as Vey's: the rows are the CLI's, because which models an
 * install offers is a property of the account behind it.
 */
export type AgentModel = {
  /** What `--model` is given: an alias, a full id, or the CLI's `default`. */
  value: string
  /** The wire id `value` resolves to — what names the `default` row. */
  resolvedModel?: string
  label: string
  description: string
  /** What the CLI said; `[]` is "takes no effort"; null is "nobody asked". */
  efforts: ChatEffort[] | null
  isNew?: boolean
  isFavorite?: boolean
  order?: number
}

/** What the picker shows before the CLI has answered, or when it cannot. */
export const CHAT_MODEL_FALLBACK: AgentModel[] = [
  {
    value: "default",
    label: "Default (recommended)",
    description: "Whatever your claude is configured to use",
    efforts: null,
    isFavorite: true,
    order: 1,
  },
  {
    value: "opus",
    label: "Opus",
    description: "Frontier intelligence and deep reasoning",
    efforts: null,
    order: 2,
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Balanced speed and intelligence for daily tasks",
    efforts: null,
    order: 3,
  },
  {
    value: "haiku",
    label: "Haiku",
    description: "Fastest for quick answers",
    efforts: null,
    order: 4,
  },
]

// ── AI settings ────────────────────────────────────────────────────────────

/** What the assistant is asked to do: the chat, and the SQL editor's three. */
export const AI_TASKS = ["chat", "generate", "explain", "fix"] as const
export type AiTask = (typeof AI_TASKS)[number]

/**
 * The model and effort a task runs on. For the SQL editor's tasks a null
 * model follows the chat's picker, effort and all; the chat's is what a new
 * chat starts on, which its picker can still change for the session.
 */
export type AiModelChoice = { model: string | null; effort: ChatEffort | null }

/** How SQL the assistant writes spells its keywords. `keep` follows the
 * statement in the editor, or the assistant's habit when there is none. */
export const SQL_KEYWORD_CASES = ["keep", "upper", "lower"] as const
export type SqlKeywordCase = (typeof SQL_KEYWORD_CASES)[number]

/** The languages offered for answers, by their English names — which is
 * how the assistant is told. */
export const AI_LANGUAGES = [
  "English",
  "Vietnamese",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Thai",
  "Indonesian",
  "French",
  "German",
  "Spanish",
  "Portuguese",
] as const

export type AiSettings = {
  /** What answers are written in; null is the language of the request. */
  language: string | null
  models: Record<AiTask, AiModelChoice>
  keywordCase: SqlKeywordCase
  /** Told to the SQL editor's helper on every Generate, Explain and Fix. */
  sqlInstructions: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  language: null,
  models: {
    chat: { model: "default", effort: "medium" },
    generate: { model: null, effort: null },
    explain: { model: null, effort: null },
    fix: { model: null, effort: null },
  },
  keywordCase: "keep",
  sqlInstructions: "",
}

/** The longest instructions kept for the SQL helper. */
export const SQL_INSTRUCTIONS_MAX = 4000

/** The levels a model takes; every level where nobody could ask. */
export function chatEfforts(
  models: AgentModel[],
  model: string | null
): ChatEffort[] {
  const found = models.find((entry) => entry.value === model)
  return found?.efforts ?? [...CHAT_EFFORTS]
}

// ── Chat ───────────────────────────────────────────────────────────────────

export type ToolStatus = "running" | "awaiting" | "done" | "error" | "denied"

export type ChatItem =
  | {
      kind: "user"
      id: string
      text: string
      /** The pictures sent with it, by file name, `[n - 1]` for `[Image #n]`.
       * Kept as files beside the chats rather than in the chat, which would
       * otherwise be megabytes of base64 re-read on every open. */
      images?: string[]
    }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool"
      id: string
      /** `run_query`, `execute_sql`, … — without the MCP prefix. */
      tool: string
      input: Record<string, unknown>
      status: ToolStatus
      /** What the tool handed back to the model, verbatim. */
      output: string | null
      /** The model is still writing its input: what is there is partial. */
      writing?: boolean
    }
  | { kind: "error"; id: string; text: string }
  | {
      kind: "chart"
      id: string
      connectionId: string
      title: string
      sql: string
      spec: ChartSpec
      result: QueryResult
    }

export type ChatSummary = {
  id: string
  title: string
  updatedAt: number
  busy: boolean
  /** The start of the last answer, as plain text; empty before there is one. */
  preview: string
  /** How many times the user wrote. */
  turns: number
  /** What the conversation did, for the history's marks. */
  did: { chart: boolean; dashboard: boolean; change: boolean }
}

export type Chat = ChatSummary & { items: ChatItem[] }

/** What the viewer is showing, sent along so "this table" means something. */
export type ViewerContext = {
  connectionId: string | null
  tab:
    | { kind: "table"; schema: string; table: string }
    | { kind: "query"; sql: string }
    | { kind: "dashboard"; title: string; tiles: string[] }
    | { kind: "knowledge" }
    | { kind: "diagram"; schema: string }
    | { kind: "alerts" }
    | { kind: "queries"; gateway: string }
    | null
  /** What the message points at with `@`, looked up as it was sent. */
  mentions?: { token: string; ref: MentionRef }[]
}

export type ViewerTarget =
  | { kind: "table"; connectionId: string; schema: string; table: string }
  | {
      kind: "query"
      connectionId: string
      sql: string
      title: string
      /** Shown as this chart rather than as a grid. */
      chart?: ChartSpec
    }
  | { kind: "dashboard"; connectionId: string; dashboardId: string }
  | { kind: "knowledge"; connectionId: string }
  | { kind: "diagram"; connectionId: string; schema: string }
  | { kind: "alerts"; connectionId: string }
  | { kind: "queries"; connectionId: string; gatewayId: string }

export type SendInput = {
  chatId: string
  text: string
  context: ViewerContext
  /** Pasted or dropped pictures, each named by an `[Image #n]` in `text`. */
  images?: ChatImage[]
  /** A row's `value` from `agentModels`, or null to pass no `--model`. */
  model: string | null
  /** Null passes no `--effort`, leaving the CLI's own. */
  effort: ChatEffort | null
}

// ── Audit log ──────────────────────────────────────────────────────────────

/** What an entry is about. */
export const AUDIT_ACTIONS = [
  "query",
  "write",
  "edit_rows",
  "plan",
  "dashboard",
  "context",
  "connection",
  "permissions",
  "tools",
  "gateway",
  "alert",
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** ok ran; failed was tried and errored; refused was stopped by the
 * permissions or Settings; declined was turned down on its card. */
export type AuditStatus = "ok" | "failed" | "refused" | "declined"

/**
 * One thing that changed something, or read data on someone's behalf: who,
 * when, where, what, and how it ended. Kept on this machine only.
 */
export type AuditEntry = {
  id: string
  at: number
  actor: "you" | "assistant"
  action: AuditAction
  /** The tool, for the assistant's: execute_sql, run_query, … */
  tool?: string
  connectionId: string | null
  /** As it was called then, in case it is renamed or removed. */
  connectionName: string | null
  /** One line: what it did. */
  summary: string
  sql?: string
  status: AuditStatus
  /** The error, the refusal, or what came back — cut short. */
  detail?: string
  /** Rows changed, or brought back. */
  rows?: number
  ms?: number
  chatId?: string
}

export type ChatEvent =
  | { type: "item"; chatId: string; item: ChatItem }
  | { type: "delta"; chatId: string; itemId: string; text: string }
  | { type: "summary"; chat: ChatSummary }
  | { type: "open"; chatId: string; target: ViewerTarget }
  /** A statement the agent ran changed data: open tables should reload. */
  | { type: "changed"; chatId: string; connectionId: string }
  /** Not about one chat: the agent, or another window, changed these. */
  | { type: "dashboard"; dashboard: Dashboard }
  | { type: "dashboard_deleted"; dashboardId: string }
  | { type: "knowledge"; connectionId: string; knowledge: Knowledge }
  | { type: "audit"; entry: AuditEntry }
  | { type: "alert"; alert: Alert }
  | { type: "alert_deleted"; alertId: string }
  /** Not from a chat: a notification was clicked, or the like. */
  | { type: "show"; target: ViewerTarget }

export type AgentStatus =
  { ok: true; path: string } | { ok: false; error: string }

// ── The bridge ─────────────────────────────────────────────────────────────

export type DesktopApi = {
  platform: "darwin" | "win32" | "linux"

  listConnections(): Promise<Connection[]>
  saveConnection(id: string | null, input: ConnectionInput): Promise<Connection>
  deleteConnection(id: string): Promise<void>
  /** Resolves with the server's version line, rejects with why it failed. */
  testConnection(id: string | null, input: ConnectionInput): Promise<string>
  /** The system's file picker, for a files connection's sources: the paths
   * picked, none when it is cancelled. */
  pickDataFiles(): Promise<string[]>

  googleAccount(): Promise<GoogleAccountState>
  /** Picks the OAuth client's JSON (a "Desktop app" client) and keeps it. */
  importGoogleClient(): Promise<GoogleAccountState>
  /** Back to the built-in client, if this build has one; signs out. */
  forgetGoogleClient(): Promise<GoogleAccountState>
  /** Opens the browser on Google's sign-in and resolves once it is back. */
  signInWithGoogle(): Promise<GoogleAccountState>
  cancelGoogleSignIn(): Promise<void>
  signOutOfGoogle(): Promise<GoogleAccountState>

  getTree(connectionId: string): Promise<TreeSchema[]>
  /** Every schema and table, hidden ones too: for setting permissions. */
  listObjects(connectionId: string): Promise<TreeSchema[]>
  setPermissions(connectionId: string, permissions: Permissions): Promise<Connection>
  getTable(connectionId: string, ref: TableRef): Promise<TableInfo>
  getTableDetails(connectionId: string, ref: TableRef): Promise<TableDetails>
  getRows(connectionId: string, request: RowsRequest): Promise<RowsResult>
  applyChanges(connectionId: string, changes: ChangeSet): Promise<number>
  /**
   * `readOnly` is for a statement the user did not type — one the agent put
   * in the viewer. It runs in a read-only transaction or not at all.
   */
  runQuery(
    connectionId: string,
    sql: string,
    readOnly: boolean,
    /** For SQL that uses `{{name}}` parameters: bound, never spliced in. */
    params?: ParamValues
  ): Promise<QueryResult>
  /** The server's plan for a statement, without running it. */
  explainQuery(connectionId: string, sql: string): Promise<QueryResult>
  /** A schema's tables and the foreign keys between them, hidden ones left out. */
  getSchemaDiagram(connectionId: string, schema: string): Promise<SchemaDiagram>

  listAlerts(): Promise<Alert[]>
  saveAlert(input: AlertInput): Promise<Alert>
  deleteAlert(alertId: string): Promise<void>
  /** Checks it now, whatever its schedule, and resolves with how it went. */
  checkAlert(alertId: string): Promise<Alert>

  getKnowledge(connectionId: string): Promise<Knowledge>
  saveKnowledge(connectionId: string, knowledge: Knowledge): Promise<Knowledge>
  listDashboards(): Promise<Dashboard[]>
  saveDashboard(dashboard: Dashboard): Promise<Dashboard>
  deleteDashboard(dashboardId: string): Promise<void>
  /** Newest first. */
  listAudit(): Promise<AuditEntry[]>
  clearAudit(): Promise<void>
  pinToDashboard(input: PinInput): Promise<Dashboard>
  /** A dashboard as the page draws it, saved where the user picks as a PDF
   * or a PNG. False when they cancel. */
  exportDashboard(input: DashboardExport): Promise<boolean>

  listSkills(): Promise<Skill[]>
  saveSkill(input: SkillInput): Promise<Skill>
  deleteSkill(skillId: string): Promise<void>
  /** The field settings of a table's columns. */
  getTableFields(connectionId: string, ref: TableRef): Promise<TableFields>
  /** Null clears the column's settings: automatic, no description. */
  setFieldSettings(
    connectionId: string,
    ref: TableRef,
    column: string,
    settings: FieldSettings | null
  ): Promise<TableFields>
  /** Null goes back to picking it automatically. */
  setDisplayColumn(
    connectionId: string,
    ref: TableRef,
    column: string | null
  ): Promise<TableFields>
  /** A built-in skill as it shipped. */
  resetSkill(skillId: string): Promise<Skill>
  /** Only the tools set away from their default; see `effectiveToolMode`. */
  getToolModes(): Promise<ToolModes>
  setToolMode(tool: string, mode: ToolMode): Promise<ToolModes>
  /** Models, effort and language for the chat and the SQL editor's helper. */
  getAiSettings(): Promise<AiSettings>
  setAiSettings(settings: AiSettings): Promise<AiSettings>

  /** One question about the SQL in an editor, answered by the agent. */
  assistSql(input: AssistInput): Promise<AssistResult>
  cancelAssist(requestId: string): Promise<void>
  /** What stands out on a dashboard, as Markdown, without touching the chat. */
  summarizeDashboard(input: DashboardSummaryInput): Promise<string>

  agentStatus(): Promise<AgentStatus>
  /** The models the user's `claude` offers. `fresh` asks again. */
  agentModels(fresh?: boolean): Promise<AgentModel[]>
  listChats(): Promise<ChatSummary[]>
  createChat(): Promise<Chat>
  getChat(chatId: string): Promise<Chat | null>
  deleteChat(chatId: string): Promise<void>
  sendMessage(input: SendInput): Promise<void>
  /** A sent picture as a `data:` URL, or null once it is gone. */
  chatImage(name: string): Promise<string | null>
  stopChat(chatId: string): Promise<void>
  /** Answers the card an `execute_sql` call is waiting on. */
  answerApproval(chatId: string, toolId: string, allow: boolean): Promise<void>
  onChatEvent(listener: (event: ChatEvent) => void): () => void

  getGateway(): Promise<GatewayState>
  /** Adds one (an empty id) or replaces it, and starts, stops or moves its
   * port as it says. Sessions to a connection it no longer goes to are
   * closed. */
  saveGateway(settings: GatewaySettings): Promise<GatewayState>
  /** Its ports stop listening and its sessions are closed. */
  deleteGateway(gatewayId: string): Promise<GatewayState>
  /** Points the gateway at one of its connections, closing the sessions
   * open to the old one so the app's pool reconnects. */
  switchGateway(gatewayId: string, connectionId: string): Promise<GatewayState>
  /** A new password for the gateway; the app connections open through it
   * are closed, so only the new one gets back in. */
  resetGatewayPassword(gatewayId: string): Promise<GatewayState>
  /** Ports opening or failing, sessions coming and going, a switch. */
  onGatewayState(listener: (state: GatewayState) => void): () => void
  /** The statements kept of a gateway, oldest first. */
  gatewayQueries(gatewayId: string): Promise<GatewayQuery[]>
  clearGatewayQueries(gatewayId: string): Promise<void>
  /** Keeps, or stops keeping, what apps run through it. */
  setGatewayRecording(gatewayId: string, recording: boolean): Promise<GatewayState>
  /** Statements as they are seen, a few times a second at most. */
  onGatewayQueries(listener: (batch: GatewayQueryBatch) => void): () => void

  /** This build's version. */
  appVersion(): Promise<string>
  /** Asks GitHub for the latest release. An unreachable GitHub is `unknown`,
   * not a rejection. */
  checkForUpdate(): Promise<UpdateCheck>
  /**
   * Downloads a release and quits into it: Squirrel.Mac on macOS, the NSIS
   * installer on Windows. Throws while there is still a window to say why;
   * success is the app quitting.
   */
  installUpdate(version: string): Promise<void>
  onUpdateProgress(listener: (event: UpdateProgress) => void): () => void
  /** Cmd/Ctrl+W: the main process takes it from the window menu and asks the
   * page to close its active tab instead. */
  onCloseTab(listener: () => void): () => void
}

/** A standalone page of a dashboard, its size in CSS pixels. */
export type DashboardExport = {
  html: string
  width: number
  height: number
  title: string
  format: "pdf" | "png"
}

export type UpdateCheck =
  | { status: "current"; current: string }
  | {
      status: "available"
      /** Without the tag's `v`. */
      version: string
      current: string
      /** GitHub's markdown; empty when the release has none. */
      notes: string
      url: string
      /** Whether `installUpdate` works here (macOS and Windows); elsewhere the
       * release page is the only option. */
      installable: boolean
    }
  | { status: "unknown"; current: string; error: string }

/**
 * How far an install has got. Only the download can be measured; `installing`
 * is the installer checking and replacing the app while it quits.
 */
export type UpdateProgress =
  | {
      stage: "downloading"
      version: string
      received: number
      /** Zero when the size is not known. */
      total: number
    }
  | { stage: "installing"; version: string }

export const IPC = {
  listConnections: "connections:list",
  saveConnection: "connections:save",
  deleteConnection: "connections:delete",
  testConnection: "connections:test",
  pickDataFiles: "connections:pick-files",
  googleAccount: "google:account",
  importGoogleClient: "google:import-client",
  forgetGoogleClient: "google:forget-client",
  signInWithGoogle: "google:sign-in",
  cancelGoogleSignIn: "google:cancel-sign-in",
  signOutOfGoogle: "google:sign-out",
  getTree: "db:tree",
  getTable: "db:table",
  getTableDetails: "db:table-details",
  getRows: "db:rows",
  applyChanges: "db:apply",
  runQuery: "db:query",
  explainQuery: "db:explain",
  getSchemaDiagram: "db:diagram",
  listAlerts: "alerts:list",
  saveAlert: "alerts:save",
  deleteAlert: "alerts:delete",
  checkAlert: "alerts:check",
  getKnowledge: "knowledge:get",
  saveKnowledge: "knowledge:save",
  listDashboards: "dashboards:list",
  saveDashboard: "dashboards:save",
  deleteDashboard: "dashboards:delete",
  listAudit: "audit:list",
  clearAudit: "audit:clear",
  pinToDashboard: "dashboards:pin",
  exportDashboard: "dashboards:export",
  listSkills: "skills:list",
  saveSkill: "skills:save",
  deleteSkill: "skills:delete",
  resetSkill: "skills:reset",
  getTableFields: "fields:get",
  setFieldSettings: "fields:set",
  setDisplayColumn: "fields:display-column",
  getToolModes: "tools:modes",
  setToolMode: "tools:set-mode",
  getAiSettings: "ai:settings",
  setAiSettings: "ai:set-settings",
  listObjects: "db:objects",
  setPermissions: "connections:permissions",
  assistSql: "assist:sql",
  cancelAssist: "assist:cancel",
  summarizeDashboard: "assist:dashboard-summary",
  agentStatus: "agent:status",
  agentModels: "agent:models",
  listChats: "chats:list",
  createChat: "chats:create",
  getChat: "chats:get",
  deleteChat: "chats:delete",
  sendMessage: "chats:send",
  chatImage: "chats:image",
  stopChat: "chats:stop",
  answerApproval: "chats:approval",
  chatEvent: "chats:event",
  getGateway: "gateway:get",
  saveGateway: "gateway:save",
  deleteGateway: "gateway:delete",
  switchGateway: "gateway:switch",
  resetGatewayPassword: "gateway:reset-password",
  gatewayState: "gateway:state",
  gatewayQueries: "gateway:queries",
  clearGatewayQueries: "gateway:clear-queries",
  setGatewayRecording: "gateway:recording",
  gatewayQueryBatch: "gateway:query-batch",
  appVersion: "app:version",
  checkForUpdate: "update:check",
  installUpdate: "update:install",
  updateProgress: "update:progress",
  closeTab: "window:close-tab",
} as const
