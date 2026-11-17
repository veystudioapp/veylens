import type {
  AccessMode,
  Cell,
  ChangeSet,
  CloudSql,
  DataSource,
  DiagramTable,
  Engine,
  PlanStepResult,
  QueryResult,
  RowsRequest,
  RowsResult,
  SchemaDiagram,
  SslMode,
  TableDetails,
  TableInfo,
  TableRef,
  TreeSchema,
} from "../../shared/api"

/** Everything a driver needs to reach a server, password included. */
export type ConnectionConfig = {
  engine: Engine
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: SslMode
  /** Reached through Google's Cloud SQL connector, not `host` and `port`. */
  cloudSql?: CloudSql | null
  /** `read_only` opens every session read-only, on the server's side too. */
  access?: AccessMode
  /** What a `duckdb` connection reads. */
  sources?: DataSource[]
  /** Where a `duckdb` connection may keep copies it makes of its files. */
  cacheRoot?: string
}

export type QueryOptions = {
  /** Run inside a READ ONLY transaction and refuse anything but a read. */
  readOnly: boolean
  /** Rows past this are not fetched; the result says it was cut. */
  maxRows: number
  timeoutMs?: number
  /** A write changing more rows than this is rolled back, and refused. */
  maxAffected?: number
  /** For `$1`/`?` placeholders in the statement. */
  values?: Cell[]
}

export type PlanLimits = { maxAffected?: number; timeoutMs?: number }

export type ViewSource = { view: TableRef; source: TableRef }

export interface Driver {
  /** The server's version line — also the connection test. */
  ping(): Promise<string>
  tree(): Promise<TreeSchema[]>
  table(ref: TableRef): Promise<TableInfo>
  /** Indexes, constraints, keys pointing in, size, comments and DDL. */
  details(ref: TableRef): Promise<TableDetails>
  rows(request: RowsRequest): Promise<RowsResult>
  /** All of it in one transaction, or none of it. Resolves with rows changed. */
  apply(changes: ChangeSet): Promise<number>
  query(sql: string, options: QueryOptions): Promise<QueryResult>
  /** The server's plan for one statement. Nothing is run that could change
   * anything, whatever the statement is. */
  explain(sql: string): Promise<QueryResult>
  /**
   * Statements one after another in one transaction: all of them, or — where
   * the engine allows — none. Rejects with which step failed.
   */
  runPlan(statements: string[], limits?: PlanLimits): Promise<PlanStepResult[]>
  /** Each view and a table or view it reads, from the server's catalog: so
   * a view over a hidden table is hidden too. */
  viewSources?(): Promise<ViewSource[]>
  /** A schema's tables, their columns and the foreign keys between them —
   * for an engine that has foreign keys. */
  diagram?(schema: string): Promise<SchemaDiagram>
  close(): Promise<void>
}

/** One column as a driver's catalogue query reads it, for `assembleDiagram`. */
export type DiagramColumnRow = {
  schema: string
  table: string
  view: boolean
  column: string
  type: string
  nullable: boolean
  primaryKey: boolean
}

/** One foreign key, its columns in order. */
export type DiagramKeyRow = {
  name: string
  schema: string
  table: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

/** Column rows, in table order, and keys made into a diagram. */
export function assembleDiagram(
  schema: string,
  columns: DiagramColumnRow[],
  keys: DiagramKeyRow[]
): SchemaDiagram {
  const tables = new Map<string, DiagramTable>()
  for (const row of columns) {
    const key = JSON.stringify([row.schema, row.table])
    let table = tables.get(key)
    if (!table) {
      table = { schema: row.schema, name: row.table, kind: row.view ? "view" : "table", columns: [] }
      tables.set(key, table)
    }
    table.columns.push({
      name: row.column,
      type: row.type,
      nullable: row.nullable,
      primaryKey: row.primaryKey,
    })
  }
  const present = (ref: string, name: string) => tables.has(JSON.stringify([ref, name]))
  return {
    schema,
    tables: [...tables.values()],
    links: keys
      .filter((key) => present(key.schema, key.table) && present(key.refSchema, key.refTable))
      .map((key) => ({
        name: key.name,
        from: { schema: key.schema, table: key.table, columns: key.columns },
        to: { schema: key.refSchema, table: key.refTable, columns: key.refColumns },
      })),
  }
}

/** A statement without the semicolon or blank lines it ends with. */
export function bare(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim()
}

/** EXPLAIN in front, unless it is already there. */
export function explained(sql: string): string {
  const body = bare(sql)
  if (!body) throw new Error("There is no statement to explain.")
  return /^explain\b/i.test(body) ? body : `EXPLAIN ${body}`
}

/** The error a plan step failed with, saying which step and what follows. */
export function planFailure(
  error: unknown,
  index: number,
  total: number,
  rolledBack: boolean
): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    `Step ${index + 1} of ${total} failed: ${message}\n` +
      (rolledBack
        ? "The transaction was rolled back; nothing was changed."
        : "Steps before it that changed the schema were committed by the server as they ran (MySQL commits DDL immediately); the rest was rolled back.")
  )
}

/** How long a table's row count is waited for before the grid goes without. */
export const COUNT_TIMEOUT_MS = 5_000

/** The refusal a driver for a read-only connection gives a write. */
export function lockedOut(locked: boolean): void {
  if (locked) {
    throw new Error(
      "This connection is read-only in Vey Lens, so nothing is written through it."
    )
  }
}

/** The refusal for a write that changed more rows than allowed: it was
 * rolled back. */
export function tooMany(changed: number, most: number): Error {
  return new Error(
    `This would change ${changed.toLocaleString()} rows, more than the ${most.toLocaleString()} this connection allows at once. It was rolled back; nothing was changed.`
  )
}
