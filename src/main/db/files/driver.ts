import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type {
  DuckDBConnection,
  DuckDBInstance,
  DuckDBPreparedStatement,
  DuckDBValue,
} from "@duckdb/node-api"

import {
  DATA_FILE_EXTENSIONS,
  type Cell,
  type ChangeSet,
  type Column,
  type ColumnKind,
  type DataSource,
  type PlanStepResult,
  type QueryResult,
  type RowsRequest,
  type RowsResult,
  type TableColumn,
  type TableDetails,
  type TableInfo,
  type TableRef,
  type TreeSchema,
} from "../../../shared/api"
import { countRows, DUCKDB, selectRows, tableName, type Statement } from "../sql"
import { COUNT_TIMEOUT_MS, explained, lockedOut, type Driver, type QueryOptions } from "../types"
import { Day, type Shaped } from "./grid"
import { googleFetcher, readGoogleSheet, type SheetFetcher } from "./google-sheets"
import { readWorkbook, type Sheet } from "./workbook"

type NodeApi = typeof import("@duckdb/node-api")

let nodeApi: Promise<NodeApi> | null = null

/** DuckDB is a native module: loaded when a files connection is first
 * opened, so a machine it cannot load on loses only those. Required rather
 * than imported: the main bundle is CommonJS, and the package sits outside
 * the asar, where `require` is what Electron resolves for certain. */
function duckdb(): Promise<NodeApi> {
  nodeApi ??= Promise.resolve().then(() => require("@duckdb/node-api") as NodeApi).catch((error: unknown) => {
    nodeApi = null
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`DuckDB, which reads files connections, could not be loaded on this machine: ${message}`)
  })
  return nodeApi
}

export type FilesConfig = {
  sources: DataSource[]
  /** A directory this driver may keep copies in — a CSV re-encoded as
   * UTF-8 — under a folder of its own, removed when it closes. */
  cacheRoot: string
  /** Swapped by a test for one that needs no network. */
  sheets?: SheetFetcher
}

export type FileKind = keyof typeof DATA_FILE_EXTENSIONS

export function fileKind(file: string): FileKind | null {
  const extension = path.extname(file).slice(1).toLowerCase()
  for (const [kind, list] of Object.entries(DATA_FILE_EXTENSIONS)) {
    if ((list as readonly string[]).includes(extension)) return kind as FileKind
  }
  return null
}

/** How often a query looks at whether the files changed underneath. */
const CHECK_EVERY_MS = 2_000
/** How long a Google Sheet is kept before it is fetched again. */
const SHEET_TTL_MS = 5 * 60_000
/** How soon a Google Sheet that could not be read is tried again: what
 * stopped it — an API not yet enabled, a share not yet made — is often
 * fixed within the minute. */
const SHEET_RETRY_MS = 15_000
/** Below this a CSV's types are worked out from every row, not a sample. */
const FULL_SNIFF_BYTES = 64 * 1024 * 1024
/** Up to this a CSV is read through to check it is UTF-8. */
const ENCODING_CHECK_BYTES = 512 * 1024 * 1024

/** What a statement may be on this connection: a read. A script of several
 * reads comes back as the last one. PIVOT without IN is a MULTI. */
const READ_TYPES = new Set(["SELECT", "EXPLAIN", "MULTI"])

type Loaded = {
  source: DataSource
  /** Where its tables went: a schema of its own, or tables in main. */
  schema: string | null
  tables: string[]
  /** The file's size and time, to tell when it changed. */
  stamp: string | null
  at: number
  error: string | null
}

const quote = DUCKDB.quote
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

const label = (source: DataSource) =>
  source.kind === "file" ? path.basename(source.path) : source.url

function stampOf(file: string): string {
  const stat = statSync(file)
  return `${stat.size}:${stat.mtimeMs}`
}

/** `name` unless taken — DuckDB does not tell `A` from `a` — else `name_2`… */
function unique(name: string, taken: Set<string>): string {
  const base = name.trim() || "sheet"
  let candidate = base
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}_${n}`
  taken.add(candidate.toLowerCase())
  return candidate
}

const NUMBER = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|BIGNUM|VARINT)\b/
const DATETIME = /^(DATE|TIME|TIMESTAMP)/

export function kindOf(type: string): ColumnKind {
  const name = type.toUpperCase()
  if (NUMBER.test(name)) return "number"
  if (name === "BOOLEAN") return "boolean"
  if (DATETIME.test(name)) return "datetime"
  if (name === "JSON") return "json"
  if (name === "BLOB") return "binary"
  return "text"
}

function cellOf(value: DuckDBValue): Cell {
  if (value === null || value === undefined) return null
  return String(value)
}

/** The bytes of a CSV as UTF-8, and whether they had to be re-encoded. */
function asUtf8(data: Uint8Array): { text: string | null; encoding: string } {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: null, encoding: "utf-8" }
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    return { text: new TextDecoder("utf-16").decode(data), encoding: "utf-16" }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data)
    return { text: null, encoding: "utf-8" }
  } catch {
    // Not UTF-8: Excel in Japan saves CSV as Shift_JIS; elsewhere, Windows-1252.
  }
  try {
    return { text: new TextDecoder("shift_jis", { fatal: true }).decode(data), encoding: "Shift_JIS" }
  } catch {
    return { text: new TextDecoder("windows-1252").decode(data), encoding: "Windows-1252" }
  }
}

/**
 * Files and Google Sheets in an in-process DuckDB.
 *
 * Every source is read into tables when the driver opens, and again when
 * its file changes or, for a sheet, every few minutes. The database can
 * reach no file but the ones given — not by `read_csv`, `COPY` or `ATTACH`,
 * nor the network — and its settings are locked, so SQL from anyone,
 * the assistant included, reads these tables and nothing else. Nothing is
 * written back: a files connection is read-only, and every query runs in
 * a transaction that is thrown away.
 */
export class FilesDriver implements Driver {
  private readonly sources: DataSource[]
  private readonly cacheDir: string
  private readonly sheets: SheetFetcher
  private opened: Promise<{ instance: DuckDBInstance; loader: DuckDBConnection }> | null = null
  private loaded: Loaded[] = []
  /** Loads one at a time: they share the loader connection. */
  private queue: Promise<unknown> = Promise.resolve()
  private checkedAt = 0
  private closed = false

  constructor(config: FilesConfig) {
    this.sources = config.sources
    this.cacheDir = path.join(config.cacheRoot, randomUUID())
    this.sheets = config.sheets ?? googleFetcher
  }

  private files(): string[] {
    return this.sources.flatMap((source) => (source.kind === "file" ? [source.path] : []))
  }

  private open() {
    if (this.closed) return Promise.reject(new Error("This connection was closed; open it again."))
    this.opened ??= (async () => {
      const { DuckDBInstance } = await duckdb()
      mkdirSync(this.cacheDir, { recursive: true })
      const instance = await DuckDBInstance.create(":memory:", {
        autoinstall_known_extensions: "false",
        autoload_known_extensions: "false",
      })
      const loader = await instance.connect()
      // The files given and the copies made here are all it may read; then
      // no setting can be changed back.
      await loader.run(`SET allowed_directories = [${literal(this.cacheDir)}]`)
      const files = this.files()
      if (files.length) {
        await loader.run(`SET allowed_paths = [${files.map(literal).join(", ")}]`)
      }
      await loader.run("SET enable_external_access = false")
      await loader.run("SET lock_configuration = true")
      for (const source of this.sources) await this.load(loader, source)
      this.checkedAt = Date.now()
      return { instance, loader }
    })()
    this.opened.catch(() => {
      this.opened = null
    })
    return this.opened
  }

  /** Runs `task` after the loads before it. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  /** The database, every source in it as of a moment ago. */
  private async ready(): Promise<DuckDBInstance> {
    const { instance, loader } = await this.open()
    if (Date.now() - this.checkedAt >= CHECK_EVERY_MS) {
      this.checkedAt = Date.now()
      await this.serial(async () => {
        for (const entry of [...this.loaded]) {
          if (this.stale(entry)) await this.load(loader, entry.source)
        }
      })
    }
    return instance
  }

  private stale(entry: Loaded): boolean {
    if (entry.source.kind === "google_sheet") {
      return Date.now() - entry.at >= (entry.error ? SHEET_RETRY_MS : SHEET_TTL_MS)
    }
    try {
      return stampOf(entry.source.path) !== entry.stamp
    } catch {
      // Gone: say so on the next look, keep what was read.
      return entry.error === null
    }
  }

  /** Names taken by the other sources: schemas, and tables in main. */
  private taken(except: DataSource): { schemas: Set<string>; tables: Set<string> } {
    const schemas = new Set(["main", "information_schema", "pg_catalog", "temp"])
    const tables = new Set<string>()
    for (const entry of this.loaded) {
      if (entry.source === except) continue
      if (entry.schema) schemas.add(entry.schema.toLowerCase())
      else for (const table of entry.tables) tables.add(table.toLowerCase())
    }
    return { schemas, tables }
  }

  /** Reads one source into its tables, replacing what it had. A source that
   * fails keeps the tables it had, with the error kept to be told. */
  private async load(loader: DuckDBConnection, source: DataSource): Promise<void> {
    const previous = this.loaded.find((entry) => entry.source === source)
    const entry: Loaded = previous ?? { source, schema: null, tables: [], stamp: null, at: 0, error: null }
    if (!previous) this.loaded.push(entry)
    try {
      if (source.kind === "google_sheet") {
        const sheet = await readGoogleSheet(source.url, source.access, this.sheets)
        await this.replaceWorkbook(loader, entry, sheet.title, sheet.sheets, `Google Sheet ${source.url}`)
      } else {
        const stamp = stampOf(source.path)
        const kind = fileKind(source.path)
        if (!kind) throw new Error(`Not a file this can read: ${path.basename(source.path)}`)
        if (kind === "workbook") {
          const sheets = readWorkbook(readFileSync(source.path))
          const name = path.basename(source.path, path.extname(source.path))
          await this.replaceWorkbook(loader, entry, name, sheets, source.path)
        } else {
          await this.replaceFile(loader, entry, source.path, kind)
        }
        entry.stamp = stamp
      }
      entry.at = Date.now()
      entry.error = null
    } catch (error) {
      entry.at = Date.now()
      entry.error = error instanceof Error ? error.message : String(error)
      if (source.kind === "file") {
        try {
          entry.stamp = stampOf(source.path)
        } catch {
          entry.stamp = null
        }
      }
    }
  }

  private async drop(loader: DuckDBConnection, entry: Loaded): Promise<void> {
    if (entry.schema) await loader.run(`DROP SCHEMA IF EXISTS ${quote(entry.schema)} CASCADE`)
    else for (const table of entry.tables) await loader.run(`DROP TABLE IF EXISTS main.${quote(table)}`)
    entry.schema = null
    entry.tables = []
  }

  private async replaceWorkbook(
    loader: DuckDBConnection,
    entry: Loaded,
    title: string,
    sheets: Sheet[],
    origin: string
  ): Promise<void> {
    if (sheets.length === 0) throw new Error("It has no sheet with anything in it.")
    const keep = entry.schema && entry.schema.toLowerCase() === title.trim().toLowerCase() ? entry.schema : null
    await this.drop(loader, entry)
    const schema = keep ?? unique(title, this.taken(entry.source).schemas)
    await loader.run(`CREATE SCHEMA ${quote(schema)}`)
    entry.schema = schema
    const names = new Set<string>()
    for (const sheet of sheets) {
      const table = unique(sheet.name, names)
      await this.createTable(loader, { schema, table }, sheet.table)
      const header = sheet.table.headerRow ? `header on row ${sheet.table.headerRow}` : "no header row: columns named by letter"
      await loader.run(
        `COMMENT ON TABLE ${tableName(DUCKDB, { schema, table })} IS ${literal(`Sheet "${sheet.name}" of ${origin} (${header})`)}`
      )
      entry.tables.push(table)
    }
  }

  /** A sheet's rows, appended with the types worked out for its columns. */
  private async createTable(loader: DuckDBConnection, ref: TableRef, sheet: Shaped): Promise<void> {
    const { DuckDBDateValue, DuckDBTimestampValue } = await duckdb()
    const columns = sheet.columns.map((column) => `${quote(column.name)} ${column.type}`).join(", ")
    await loader.run(`CREATE TABLE ${tableName(DUCKDB, ref)} (${columns})`)
    const appender = await loader.createAppender(ref.table, ref.schema)
    try {
      for (const row of sheet.rows) {
        sheet.columns.forEach((column, index) => {
          const value = row[index] ?? null
          if (value === null) return appender.appendNull()
          switch (column.type) {
            case "BIGINT":
              return appender.appendBigInt(BigInt(value as number))
            case "DOUBLE":
              return appender.appendDouble(value as number)
            case "BOOLEAN":
              return appender.appendBoolean(value as boolean)
            case "DATE":
              return appender.appendDate(new DuckDBDateValue(Math.floor((value as Day).ms / 86_400_000)))
            case "TIMESTAMP":
              return appender.appendTimestamp(new DuckDBTimestampValue(BigInt((value as Day).ms) * 1000n))
            default:
              return appender.appendVarchar(String(value))
          }
        })
        appender.endRow()
      }
      appender.flushSync()
    } finally {
      appender.closeSync()
    }
  }

  private async replaceFile(
    loader: DuckDBConnection,
    entry: Loaded,
    file: string,
    kind: Exclude<FileKind, "workbook">
  ): Promise<void> {
    const stem = path.basename(file, path.extname(file))
    const keep = entry.tables[0]?.toLowerCase() === stem.trim().toLowerCase() ? entry.tables[0]! : null
    let reader: string
    let note = file
    if (kind === "csv") {
      const size = statSync(file).size
      let readFrom = file
      if (size <= ENCODING_CHECK_BYTES) {
        const { text, encoding } = asUtf8(readFileSync(file))
        if (text !== null) {
          readFrom = path.join(this.cacheDir, `${randomUUID()}.csv`)
          writeFileSync(readFrom, text)
          note = `${file}, read as ${encoding}`
        }
      }
      reader = `read_csv(${literal(readFrom)}${size <= FULL_SNIFF_BYTES ? ", sample_size = -1" : ""})`
    } else if (kind === "parquet") {
      reader = `read_parquet(${literal(file)})`
    } else {
      reader = `read_json(${literal(file)})`
    }
    await this.drop(loader, entry)
    const table = keep ?? unique(stem, this.taken(entry.source).tables)
    const ref = { schema: "main", table }
    await loader.run(`CREATE TABLE ${tableName(DUCKDB, ref)} AS SELECT * FROM ${reader}`)
    await loader.run(`COMMENT ON TABLE ${tableName(DUCKDB, ref)} IS ${literal(note)}`)
    entry.tables = [table]
  }

  /** A connection of its own for one call, in a transaction never kept. */
  private async session<T>(work: (connection: DuckDBConnection) => Promise<T>, timeoutMs?: number): Promise<T> {
    const instance = await this.ready()
    const connection = await instance.connect()
    const timer = timeoutMs ? setTimeout(() => connection.interrupt(), timeoutMs) : null
    try {
      await connection.run("BEGIN TRANSACTION")
      return await work(connection)
    } catch (error) {
      if (timer && /interrupt/i.test(error instanceof Error ? error.message : "")) {
        throw new Error(`The query was stopped after ${Math.round(timeoutMs! / 1000)} seconds.`)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      // Closing it ends the transaction, rolled back, open results and all.
      connection.closeSync()
    }
  }

  private async select(statement: Statement | string, timeoutMs?: number): Promise<Cell[][]> {
    const { text, values } = typeof statement === "string" ? { text: statement, values: [] } : statement
    return this.session(async (connection) => {
      const reader = await connection.runAndReadAll(text, values as DuckDBValue[])
      return reader.getRows().map((row) => row.map(cellOf))
    }, timeoutMs)
  }

  async ping(): Promise<string> {
    if (this.sources.length === 0) throw new Error("Add a file or a Google Sheet to read.")
    await this.ready()
    const failed = this.loaded.filter((entry) => entry.error)
    if (failed.length) {
      throw new Error(failed.map((entry) => `${label(entry.source)}: ${entry.error}`).join("\n"))
    }
    const [version] = (await this.select("SELECT version()"))[0] ?? []
    const tables = this.loaded.reduce((sum, entry) => sum + entry.tables.length, 0)
    return `DuckDB ${(version ?? "").replace(/^v/, "")} · ${tables} ${tables === 1 ? "table" : "tables"} from ${this.sources.length} ${this.sources.length === 1 ? "source" : "sources"}`
  }

  /** What could not be read, by source: none when all of it was. */
  problems(): string[] {
    return this.loaded.flatMap((entry) => (entry.error ? [`${label(entry.source)}: ${entry.error}`] : []))
  }

  async tree(): Promise<TreeSchema[]> {
    const rows = await this.select(
      `SELECT schema_name, table_name FROM duckdb_tables()
        WHERE database_name = current_database() AND NOT temporary
        ORDER BY schema_name <> 'main', schema_name, table_name`
    )
    // Some sources failing leaves the rest to browse; all of them, the why.
    const problems = this.problems()
    if (rows.length === 0 && problems.length) throw new Error(problems.join("\n"))
    const schemas = new Map<string, TreeSchema>()
    for (const [schema, table] of rows) {
      if (!schema || !table) continue
      let entry = schemas.get(schema)
      if (!entry) schemas.set(schema, (entry = { name: schema, tables: [] }))
      entry.tables.push({ name: table, kind: "table" })
    }
    return [...schemas.values()]
  }

  private async columns(ref: TableRef): Promise<Cell[][]> {
    const rows = await this.select({
      text: `SELECT column_name, data_type, is_nullable, column_default, comment
               FROM duckdb_columns()
              WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
              ORDER BY column_index`,
      values: [ref.schema, ref.table],
    })
    if (rows.length === 0) throw new Error(`No table "${ref.schema}"."${ref.table}".`)
    return rows
  }

  async table(ref: TableRef): Promise<TableInfo> {
    const rows = await this.columns(ref)
    return {
      kind: "table",
      foreignKeys: [],
      columns: rows.map(
        ([name, type, nullable, fallback]): TableColumn => ({
          name: name ?? "",
          type: type ?? "VARCHAR",
          kind: kindOf(type ?? ""),
          nullable: nullable !== "false",
          default: fallback ?? null,
          primaryKey: false,
          extra: "",
        })
      ),
    }
  }

  async details(ref: TableRef): Promise<TableDetails> {
    const [columns, tables] = await Promise.all([
      this.columns(ref),
      this.select({
        text: `SELECT comment, estimated_size, sql FROM duckdb_tables()
                WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2`,
        values: [ref.schema, ref.table],
      }),
    ])
    const [comment, estimate, ddl] = tables[0] ?? []
    const columnComments: Record<string, string> = {}
    for (const row of columns) if (row[4]) columnComments[row[0] ?? ""] = row[4]
    return {
      kind: "table",
      comment: comment ?? null,
      rowEstimate: estimate === null || estimate === undefined ? null : Number(estimate),
      totalBytes: null,
      indexBytes: null,
      engine: null,
      collation: null,
      columnComments,
      indexes: [],
      constraints: [],
      referencedBy: [],
      ddl: ddl ? `${ddl.replace(/;?\s*$/, "")};` : "",
    }
  }

  async rows(request: RowsRequest): Promise<RowsResult> {
    const info = await this.table(request)
    const select = selectRows(
      DUCKDB,
      request,
      info.columns.map((column) => column.name),
      request.filters,
      request.sort ? [request.sort] : [],
      request.limit,
      request.offset,
      request.match
    )
    const [rows, total] = await Promise.all([
      this.select(select),
      this.select(countRows(DUCKDB, request, request.filters, request.match), COUNT_TIMEOUT_MS).then(
        (result) => Number(result[0]?.[0] ?? 0),
        () => null
      ),
    ])
    return { columns: info.columns, rows, total }
  }

  async apply(_changes: ChangeSet): Promise<number> {
    lockedOut(true)
    return 0
  }

  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const started = Date.now()
    return this.session(async (connection) => {
      const extracted = await connection.extractStatements(sql)
      if (extracted.count === 0) throw new Error("There is no statement to run.")
      const { StatementType } = await duckdb()
      const statements: DuckDBPreparedStatement[] = []
      for (let index = 0; index < extracted.count; index++) {
        const statement = await extracted.prepare(index)
        const type = StatementType[statement.statementType] ?? "INVALID"
        if (!READ_TYPES.has(type)) {
          throw new Error(
            `A files connection is read-only: only queries run on it (this is ${type === "INVALID" ? "not one" : `a ${type} statement`}). Its tables are reloaded from the files, so a change would not last anyway.`
          )
        }
        statements.push(statement)
      }
      for (const statement of statements.slice(0, -1)) await statement.run()
      const last = statements.at(-1)!
      if (options.values?.length) last.bind(options.values as DuckDBValue[])
      const reader = await last.streamAndReadUntil(options.maxRows + 1)
      const columns: Column[] = reader.columnNames().map((name, index) => {
        const type = String(reader.columnType(index))
        return { name, type, kind: kindOf(type) }
      })
      // Read in chunks: there may be more than was asked for.
      const all = reader.getRows()
      return {
        columns,
        rows: all.slice(0, options.maxRows).map((row) => row.map(cellOf)),
        truncated: all.length > options.maxRows,
        affected: null,
        command: "SELECT",
        ms: Date.now() - started,
      }
    }, options.timeoutMs)
  }

  explain(sql: string): Promise<QueryResult> {
    return this.query(explained(sql), { readOnly: true, maxRows: 1000, timeoutMs: 15_000 })
  }

  async runPlan(): Promise<PlanStepResult[]> {
    lockedOut(true)
    return []
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const opened = this.opened
    this.opened = null
    if (opened) {
      try {
        const { instance, loader } = await opened
        await this.queue
        loader.closeSync()
        instance.closeSync()
      } catch {
        // It never opened: nothing to close.
      }
    }
    rmSync(this.cacheDir, { recursive: true, force: true })
  }
}
