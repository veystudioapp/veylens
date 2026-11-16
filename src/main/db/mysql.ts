import type { EventEmitter } from "node:events"

import mysql from "mysql2/promise"

import type {
  Cell,
  ChangeSet,
  Column,
  ColumnKind,
  PlanStepResult,
  QueryResult,
  RowsRequest,
  RowsResult,
  Sort,
  ForeignKeyAction,
  TableColumn,
  TableConstraint,
  TableDetails,
  TableIndex,
  TableInfo,
  TableRef,
  TreeSchema,
} from "../../shared/api"
import { referencesIn, tokenize } from "../../shared/permissions"
import { startsLikeRead } from "../../shared/statements"
import {
  assertReadOnly,
  changeStatements,
  countRows,
  MYSQL,
  selectRows,
  type Statement,
} from "./sql"
import {
  bare,
  COUNT_TIMEOUT_MS,
  explained,
  lockedOut,
  planFailure,
  tooMany,
  type ConnectionConfig,
  type Driver,
  type PlanLimits,
  type QueryOptions,
  type ViewSource,
} from "./types"

const tick = (name: string) => `\`${name.replace(/`/g, "``")}\``

const MYSQL_ACTION: Record<string, ForeignKeyAction> = {
  "NO ACTION": "no action",
  RESTRICT: "restrict",
  CASCADE: "cascade",
  "SET NULL": "set null",
  "SET DEFAULT": "set default",
}

const MYSQL_CONSTRAINT: Record<string, TableConstraint["kind"]> = {
  "PRIMARY KEY": "primary",
  UNIQUE: "unique",
  "FOREIGN KEY": "foreign",
  CHECK: "check",
}

const numberOrNull = (value: Cell | undefined): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value)

/** The charset number MySQL gives a column of bytes rather than of text. */
const BINARY_CHARSET = 63

/** How much of a binary value is spelled out before it is cut. */
const BINARY_PREVIEW_BYTES = 64

const NUMBER_TYPES = new Set([
  "DECIMAL",
  "NEWDECIMAL",
  "TINY",
  "SHORT",
  "LONG",
  "LONGLONG",
  "INT24",
  "FLOAT",
  "DOUBLE",
  "YEAR",
  "BIT",
])
const DATETIME_TYPES = new Set([
  "TIMESTAMP",
  "DATE",
  "TIME",
  "DATETIME",
  "NEWDATE",
])
/** Types whose bytes are read as they are and decoded once the column's
 * charset is known — the type alone does not say text from bytes. */
const BYTE_TYPES = new Set([
  "TINY_BLOB",
  "MEDIUM_BLOB",
  "LONG_BLOB",
  "BLOB",
  "VARCHAR",
  "VAR_STRING",
  "STRING",
  "GEOMETRY",
  "BIT",
])

type Field = { name: string; columnType: number; characterSet: number }

type TypeCastField = {
  type: string
  string(encoding?: string): string | null
  buffer(): Buffer | null
}

/** Everything as the text the server sent, bytes as bytes. */
function typeCast(field: TypeCastField): unknown {
  if (BYTE_TYPES.has(field.type)) return field.buffer()
  // JSON is declared binary but is always utf8.
  return field.type === "JSON" ? field.string("utf8") : field.string()
}

const typeNames = mysql.Types as unknown as Record<number, string>

function typeName(field: Field): string {
  return typeNames[field.columnType] ?? `type ${field.columnType}`
}

function kindOfField(field: Field): ColumnKind {
  const name = typeName(field)
  if (NUMBER_TYPES.has(name)) return "number"
  if (DATETIME_TYPES.has(name)) return "datetime"
  if (name === "JSON") return "json"
  if (name === "GEOMETRY") return "binary"
  if (name.endsWith("BLOB") && field.characterSet === BINARY_CHARSET) {
    return "binary"
  }
  return "text"
}

/** A column's kind from the type `information_schema` names it by. */
function kindOfDataType(dataType: string): ColumnKind {
  const type = dataType.toLowerCase()
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/.test(
      type
    )
  ) {
    return "number"
  }
  if (/^(date|datetime|timestamp|time)$/.test(type)) return "datetime"
  if (type === "json") return "json"
  if (/blob$|binary$|^geometry$/.test(type)) return "binary"
  return "text"
}

function isReadable(text: string): boolean {
  // A replacement character means the bytes were not utf8; a control
  // character means they were not written to be read.
  // eslint-disable-next-line no-control-regex
  return !/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)
}

function decode(value: unknown, field: Field | undefined): Cell {
  if (value === null || value === undefined) return null
  if (!Buffer.isBuffer(value)) return String(value)
  if (!field || field.characterSet !== BINARY_CHARSET) {
    return value.toString("utf8")
  }
  if (typeName(field) === "BIT") {
    return value.length ? BigInt(`0x${value.toString("hex")}`).toString() : "0"
  }
  // Bytes that happen to be text — the result of a function, a VARBINARY
  // holding a name — read better as the text they are.
  const text = value.toString("utf8")
  if (isReadable(text)) return text
  const shown = value.subarray(0, BINARY_PREVIEW_BYTES).toString("hex")
  return `0x${shown}${value.length > BINARY_PREVIEW_BYTES ? "…" : ""}`
}

type Raw = {
  fields: Field[]
  rows: Cell[][]
  truncated: boolean
  /** Rows changed, for a statement that returned none. */
  affected: number | null
}

type Runner = mysql.Pool | mysql.PoolConnection

/** Whether any of these makes MySQL commit on the spot. */
function hasDdl(statements: string[]): boolean {
  return statements.some((text) =>
    /^\s*(create|alter|drop|rename|truncate)\b/i.test(text)
  )
}

export class MysqlDriver implements Driver {
  /** Built for a read-only connection: writes are refused here too. */
  private readonly locked: boolean
  private readonly pool: mysql.Pool

  /** `overrides` is for Cloud SQL, which hands the pool a stream of its own. */
  constructor(config: ConnectionConfig, overrides: mysql.PoolOptions = {}) {
    this.locked = config.access === "read_only"
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      ssl:
        config.ssl === "off"
          ? undefined
          : { rejectUnauthorized: config.ssl === "verify" },
      connectionLimit: 4,
      connectTimeout: 10_000,
      rowsAsArray: true,
      // The types do not know the function form; the driver does.
      typeCast: typeCast as never,
      ...overrides,
    })
    // Read-only to the server as well; see the Postgres driver.
    if (config.access === "read_only") {
      this.pool.on("connection", (connection) => {
        // The core connection, not the promise wrapper: a callback, so that
        // a failure is not an unhandled `error` event.
        ;(
          connection as unknown as {
            query(sql: string, done: (error: unknown) => void): void
          }
        ).query("SET SESSION TRANSACTION READ ONLY", () => {})
      })
    }
  }

  /** A statement run whole: for the driver's own queries, whose results are
   * a page at most. */
  private async run(
    runner: Runner,
    statement: Statement | string
  ): Promise<Raw> {
    const { text, values } =
      typeof statement === "string"
        ? { text: statement, values: [] as Cell[] }
        : statement
    const [result, fields] = await runner.query({
      sql: text,
      values,
      rowsAsArray: true,
    })
    if (!Array.isArray(result)) {
      return {
        fields: [],
        rows: [],
        truncated: false,
        affected: (result as mysql.ResultSetHeader).affectedRows ?? 0,
      }
    }
    const described = (fields ?? []) as unknown as Field[]
    return {
      fields: described,
      rows: (result as unknown[][]).map((row) =>
        row.map((value, index) => decode(value, described[index]))
      ),
      truncated: false,
      affected: null,
    }
  }

  /**
   * A statement read row by row and abandoned past `maxRows`, for SQL somebody
   * else wrote. Abandoning a result means dropping the connection — the
   * protocol has no way to stop a result set part-way — so the caller is told
   * to destroy it rather than hand it back.
   */
  private stream(
    connection: mysql.PoolConnection,
    sql: string,
    maxRows: number,
    timeoutMs: number | undefined,
    values: Cell[] = []
  ): Promise<Raw & { spent: boolean }> {
    return new Promise((resolve, reject) => {
      let fields: Field[] = []
      let rows: Cell[][] = []
      let affected: number | null = null
      let settled = false

      const settle = (outcome: (Raw & { spent: boolean }) | Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }

      const timer = timeoutMs
        ? setTimeout(() => {
            connection.destroy()
            settle(
              new Error(
                `The query was stopped after ${Math.round(timeoutMs / 1000)}s.`
              )
            )
          }, timeoutMs)
        : null

      // The event form lives on the connection underneath the promise wrapper.
      const core = connection.connection as unknown as {
        query(options: {
          sql: string
          values: Cell[]
          rowsAsArray: boolean
        }): EventEmitter
      }
      const query = core.query({ sql, values, rowsAsArray: true })
      // A throw inside a listener goes nowhere but the emitter; this promise
      // would then never settle, and whoever awaits it would wait for good.
      const on = (event: string, listener: (...args: unknown[]) => void) =>
        query.on(event, (...args: unknown[]) => {
          try {
            listener(...args)
          } catch (error) {
            // `fatal`: the rest of this statement may still be on the wire,
            // so `query` destroys the connection rather than reusing it.
            settle(
              Object.assign(
                error instanceof Error ? error : new Error(String(error)),
                { fatal: true }
              )
            )
          }
        })

      on("fields", (next: unknown) => {
        // A second result set (a CALL) replaces the first. A statement that
        // returns no rows — DDL, INSERT, UPDATE — announces `undefined` here.
        fields = (next as Field[] | undefined) ?? []
        rows = []
      })
      on("result", (row: unknown) => {
        if (settled) return
        if (!Array.isArray(row)) {
          affected = (row as mysql.ResultSetHeader).affectedRows ?? 0
          return
        }
        if (rows.length >= maxRows) {
          settle({ fields, rows, truncated: true, affected: null, spent: true })
          return
        }
        rows.push(row.map((value, index) => decode(value, fields[index])))
      })
      query.on("error", (error: Error) => settle(error))
      on("end", () =>
        settle({
          fields,
          rows,
          truncated: false,
          affected: fields.length ? null : affected,
          spent: false,
        })
      )
    })
  }

  async ping(): Promise<string> {
    const result = await this.run(this.pool, "SELECT VERSION()")
    const version = result.rows[0]?.[0] ?? ""
    return /mariadb/i.test(version) ? `MariaDB ${version}` : `MySQL ${version}`
  }

  async tree(): Promise<TreeSchema[]> {
    const result = await this.run(
      this.pool,
      `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
        WHERE table_schema NOT IN
              ('information_schema', 'mysql', 'performance_schema', 'sys')
        ORDER BY table_schema, table_name`
    )
    const schemas = new Map<string, TreeSchema>()
    for (const [schema, name, type] of result.rows) {
      if (!schema || !name) continue
      let entry = schemas.get(schema)
      if (!entry) schemas.set(schema, (entry = { name: schema, tables: [] }))
      entry.tables.push({ name, kind: type === "VIEW" ? "view" : "table" })
    }
    return [...schemas.values()]
  }

  /**
   * What each view reads: VIEW_TABLE_USAGE where the server has it (MySQL
   * 8.0.13+), else each view's definition read for its table names.
   */
  async viewSources(): Promise<ViewSource[]> {
    const system = "('information_schema', 'mysql', 'performance_schema', 'sys')"
    try {
      const usage = await this.run(
        this.pool,
        `SELECT VIEW_SCHEMA, VIEW_NAME, TABLE_SCHEMA, TABLE_NAME
           FROM information_schema.VIEW_TABLE_USAGE
          WHERE VIEW_SCHEMA NOT IN ${system}`
      )
      return usage.rows.flatMap(([viewSchema, view, schema, table]) =>
        viewSchema && view && schema && table
          ? [{ view: { schema: viewSchema, table: view }, source: { schema, table } }]
          : []
      )
    } catch {
      const views = await this.run(
        this.pool,
        `SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION
           FROM information_schema.VIEWS
          WHERE TABLE_SCHEMA NOT IN ${system}`
      )
      return views.rows.flatMap(([schema, name, definition]) => {
        if (!schema || !name || !definition) return []
        const view = { schema, table: name }
        return tokenize(definition, "mysql").flatMap((tokens) =>
          referencesIn(tokens, schema).map((ref) => ({
            view,
            source: { schema: ref.schema, table: ref.table },
          }))
        )
      })
    }
  }

  async table(ref: TableRef): Promise<TableInfo> {
    const values = [ref.schema, ref.table]
    const [columns, kind, foreignKeys] = await Promise.all([
      this.run(this.pool, {
        text: `SELECT column_name, column_type, data_type, is_nullable,
                      column_default, column_key, extra
                 FROM information_schema.columns
                WHERE table_schema = ? AND table_name = ?
                ORDER BY ordinal_position`,
        values,
      }),
      this.run(this.pool, {
        text: `SELECT table_type FROM information_schema.tables
                WHERE table_schema = ? AND table_name = ?`,
        values,
      }),
      this.run(this.pool, {
        text: `SELECT constraint_name, column_name, referenced_table_schema,
                      referenced_table_name, referenced_column_name
                 FROM information_schema.key_column_usage
                WHERE table_schema = ? AND table_name = ?
                  AND referenced_table_name IS NOT NULL
                ORDER BY constraint_name, ordinal_position`,
        values,
      }),
    ])

    if (columns.rows.length === 0) {
      throw new Error(`No table or view \`${ref.schema}\`.\`${ref.table}\`.`)
    }

    return {
      kind: kind.rows[0]?.[0] === "VIEW" ? "view" : "table",
      columns: columns.rows.map(
        (row): TableColumn => ({
          name: row[0] ?? "",
          type: row[1] ?? "unknown",
          kind: kindOfDataType(row[2] ?? ""),
          nullable: row[3] === "YES",
          default: row[4] ?? null,
          primaryKey: row[5] === "PRI",
          // VIRTUAL / STORED GENERATED is a computed column; DEFAULT_GENERATED
          // only says the default is an expression, and the column is typed into.
          extra: /\b(virtual|stored) generated\b/i.test(row[6] ?? "")
            ? "generated"
            : (row[6] ?? "")
                .replace(/\bDEFAULT_GENERATED\b/gi, "")
                .trim()
                .toLowerCase(),
        })
      ),
      foreignKeys: foreignKeys.rows.map(
        (row) =>
          `${row[0]}: FOREIGN KEY (${row[1]}) REFERENCES ${row[2]}.${row[3]}(${row[4]})`
      ),
    }
  }

  async details(ref: TableRef): Promise<TableDetails> {
    const values = [ref.schema, ref.table]
    const [relation, columns, statistics, constraints, keyColumns, rules, incoming, create] =
      await Promise.all([
        this.run(this.pool, {
          text: `SELECT table_type, table_comment, table_rows, data_length, index_length,
                        engine, table_collation
                   FROM information_schema.tables
                  WHERE table_schema = ? AND table_name = ?`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT column_name, column_comment FROM information_schema.columns
                  WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT index_name, non_unique, column_name, index_type, sub_part
                   FROM information_schema.statistics
                  WHERE table_schema = ? AND table_name = ?
                  ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT constraint_name, constraint_type FROM information_schema.table_constraints
                  WHERE table_schema = ? AND table_name = ?`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT constraint_name, column_name, referenced_table_schema,
                        referenced_table_name, referenced_column_name
                   FROM information_schema.key_column_usage
                  WHERE table_schema = ? AND table_name = ?
                  ORDER BY constraint_name, ordinal_position`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT constraint_name, update_rule, delete_rule
                   FROM information_schema.referential_constraints
                  WHERE constraint_schema = ? AND table_name = ?`,
          values,
        }),
        this.run(this.pool, {
          text: `SELECT constraint_name, table_schema, table_name, column_name, referenced_column_name
                   FROM information_schema.key_column_usage
                  WHERE referenced_table_schema = ? AND referenced_table_name = ?
                  ORDER BY table_name, constraint_name, ordinal_position`,
          values,
        }),
        this.run(this.pool, `SHOW CREATE TABLE ${tick(ref.schema)}.${tick(ref.table)}`),
      ])

    const rel = relation.rows[0]
    if (!rel) throw new Error(`No table or view \`${ref.schema}\`.\`${ref.table}\`.`)

    // CHECK clauses: MySQL 8.0.16 and MariaDB 10.2 on; older servers have none.
    const checks = new Map<string, string>()
    try {
      const found = await this.run(this.pool, {
        text: `SELECT cc.constraint_name, cc.check_clause
                 FROM information_schema.check_constraints cc
                 JOIN information_schema.table_constraints tc
                   ON tc.constraint_schema = cc.constraint_schema
                  AND tc.constraint_name = cc.constraint_name
                WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'`,
        values,
      })
      for (const row of found.rows) checks.set(row[0] ?? "", row[1] ?? "")
    } catch {
      // Not there to read.
    }

    const columnComments: Record<string, string> = {}
    for (const row of columns.rows) if (row[1]) columnComments[row[0] ?? ""] = row[1]

    const indexes: TableIndex[] = []
    for (const row of statistics.rows) {
      const name = row[0] ?? ""
      let index = indexes.find((item) => item.name === name)
      if (!index) {
        index = {
          name,
          unique: row[1] === "0",
          primary: name === "PRIMARY",
          method: row[3] ?? null,
          bytes: null,
          columns: [],
        }
        indexes.push(index)
      }
      index.columns.push(row[4] ? `${row[2]}(${row[4]})` : (row[2] ?? "expression"))
    }

    const keyed = new Map<string, Cell[][]>()
    for (const row of keyColumns.rows) {
      const name = row[0] ?? ""
      keyed.set(name, [...(keyed.get(name) ?? []), row])
    }
    const ruleOf = new Map(rules.rows.map((row) => [row[0] ?? "", row]))
    const list = (items: string[]) => items.map(tick).join(", ")

    const keys: TableConstraint[] = constraints.rows
      .map((row): TableConstraint => {
        const name = row[0] ?? ""
        const type = MYSQL_CONSTRAINT[row[1] ?? ""] ?? "check"
        const parts = keyed.get(name) ?? []
        const cols = parts.map((part) => part[1] ?? "")
        if (type === "foreign") {
          const first = parts[0]
          const rule = ruleOf.get(name)
          const target = {
            schema: first?.[2] ?? ref.schema,
            table: first?.[3] ?? "",
            columns: parts.map((part) => part[4] ?? ""),
            onDelete: MYSQL_ACTION[rule?.[2] ?? ""] ?? null,
            onUpdate: MYSQL_ACTION[rule?.[1] ?? ""] ?? null,
          }
          const actions = [
            target.onDelete && target.onDelete !== "no action" && target.onDelete !== "restrict"
              ? ` ON DELETE ${target.onDelete.toUpperCase()}`
              : "",
            target.onUpdate && target.onUpdate !== "no action" && target.onUpdate !== "restrict"
              ? ` ON UPDATE ${target.onUpdate.toUpperCase()}`
              : "",
          ].join("")
          return {
            name,
            kind: type,
            columns: cols,
            definition: `FOREIGN KEY (${list(cols)}) REFERENCES ${tick(target.table)} (${list(target.columns)})${actions}`,
            references: target,
          }
        }
        return {
          name,
          kind: type,
          columns: cols,
          definition:
            type === "primary"
              ? `PRIMARY KEY (${list(cols)})`
              : type === "unique"
                ? `UNIQUE (${list(cols)})`
                : `CHECK (${checks.get(name) ?? "…"})`,
        }
      })
      .sort(
        (a, b) =>
          ["primary", "unique", "foreign", "check", "exclusion"].indexOf(a.kind) -
            ["primary", "unique", "foreign", "check", "exclusion"].indexOf(b.kind) ||
          a.name.localeCompare(b.name)
      )

    const referencedBy = new Map<string, TableDetails["referencedBy"][number]>()
    for (const row of incoming.rows) {
      const id = `${row[1]}.${row[2]}.${row[0]}`
      const key = referencedBy.get(id) ?? {
        name: row[0] ?? "",
        schema: row[1] ?? "",
        table: row[2] ?? "",
        columns: [],
        referencedColumns: [],
      }
      key.columns.push(row[3] ?? "")
      key.referencedColumns.push(row[4] ?? "")
      referencedBy.set(id, key)
    }

    const view = rel[0] === "VIEW"
    const data = numberOrNull(rel[3])
    const index = numberOrNull(rel[4])
    return {
      kind: view ? "view" : "table",
      // A view's comment is the word VIEW.
      comment: !view && rel[1] ? rel[1] : null,
      rowEstimate: view ? null : numberOrNull(rel[2]),
      totalBytes: view || data === null ? null : data + (index ?? 0),
      indexBytes: view ? null : index,
      engine: rel[5] ?? null,
      collation: rel[6] ?? null,
      columnComments,
      indexes,
      constraints: keys,
      referencedBy: [...referencedBy.values()],
      ddl: `${(create.rows[0]?.[1] ?? "").trim()};`,
    }
  }

  async rows(request: RowsRequest): Promise<RowsResult> {
    const info = await this.table(request)
    const order: Sort[] = request.sort
      ? [request.sort]
      : info.columns
          .filter((column) => column.primaryKey)
          .map((column) => ({ column: column.name, direction: "asc" }))

    const [rows, total] = await Promise.all([
      this.run(
        this.pool,
        selectRows(
          MYSQL,
          request,
          info.columns.map((column) => column.name),
          request.filters,
          order,
          request.limit,
          request.offset,
          request.match
        )
      ),
      this.count(request),
    ])

    return { columns: info.columns, rows: rows.rows, total }
  }

  /** Null rather than a wait: counting a very large table can take minutes. */
  private async count(request: RowsRequest): Promise<number | null> {
    const statement = countRows(MYSQL, request, request.filters, request.match)
    try {
      const result = await this.run(this.pool, {
        // A hint MySQL obeys and MariaDB reads as a comment.
        text: statement.text.replace(
          /^SELECT/,
          `SELECT /*+ MAX_EXECUTION_TIME(${COUNT_TIMEOUT_MS}) */`
        ),
        values: statement.values,
      })
      return Number(result.rows[0]?.[0] ?? 0)
    } catch {
      return null
    }
  }

  async apply(changes: ChangeSet): Promise<number> {
    lockedOut(this.locked)
    const statements = changeStatements(MYSQL, changes)
    if (statements.length === 0) return 0

    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      let affected = 0
      for (const statement of statements) {
        const count = (await this.run(connection, statement)).affected ?? 0
        if (statement.single && count !== 1) {
          throw new Error(
            count === 0
              ? "A row being changed no longer exists, or its key has changed. Nothing was saved."
              : `A change matched ${count} rows instead of one. Nothing was saved.`
          )
        }
        affected += count
      }
      await connection.commit()
      return affected
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async query(sql: string, given: QueryOptions): Promise<QueryResult> {
    // On a read-only connection everything is a read, whoever asked.
    if (this.locked && !given.readOnly && !startsLikeRead(sql)) lockedOut(true)
    const options = this.locked ? { ...given, readOnly: true } : given
    if (options.readOnly) assertReadOnly(sql)

    const started = Date.now()
    const connection = await this.pool.getConnection()
    let spent = false
    // A write under a row limit runs in a transaction of its own, so one
    // past it can be taken back (DDL, which MySQL commits at once, changes
    // no rows to count).
    let open = false
    try {
      if (options.readOnly) {
        await connection.query("START TRANSACTION READ ONLY")
      } else if (options.maxAffected !== undefined) {
        await connection.query("START TRANSACTION")
        open = true
      }
      const raw = await this.stream(
        connection,
        sql,
        options.maxRows,
        options.timeoutMs,
        options.values
      )
      spent = raw.spent
      if (open && !spent) {
        if (options.maxAffected !== undefined && (raw.affected ?? 0) > options.maxAffected) {
          throw tooMany(raw.affected ?? 0, options.maxAffected)
        }
        await connection.query("COMMIT")
        open = false
      }
      return {
        columns: raw.fields.map(
          (field): Column => ({
            name: field.name,
            type: typeName(field).toLowerCase(),
            kind: kindOfField(field),
          })
        ),
        rows: raw.rows,
        truncated: raw.truncated,
        affected: raw.affected,
        command: null,
        ms: Date.now() - started,
      }
    } catch (error) {
      // Fatal errors and the timeout have already taken the connection down.
      spent ||= (error as { fatal?: boolean }).fatal === true
      throw error
    } finally {
      if (spent) {
        connection.destroy()
      } else {
        if (options.readOnly || open) {
          await connection.query("ROLLBACK").catch(() => {
            spent = true
          })
        }
        if (spent) connection.destroy()
        else connection.release()
      }
    }
  }

  async explain(sql: string): Promise<QueryResult> {
    // Not in a read-only transaction: MySQL refuses to EXPLAIN a write in
    // one, and needs no such guard — its EXPLAIN never runs a write, and
    // only one statement is sent, since the pool does not allow several.
    // Except EXPLAIN ANALYZE, which does run what it explains — UPDATE and
    // DELETE included — so it is let through for a read only.
    const text = explained(sql)
    const analyze =
      /^explain\s+(format\s*=\s*\w+\s+)?analyze\s+(format\s*=\s*\w+\s+)?/i.exec(
        text
      )
    if (analyze) assertReadOnly(text.slice(analyze[0].length))
    const started = Date.now()
    const raw = await this.run(this.pool, text)
    return {
      columns: raw.fields.map(
        (field): Column => ({
          name: field.name,
          type: typeName(field).toLowerCase(),
          kind: kindOfField(field),
        })
      ),
      rows: raw.rows,
      truncated: false,
      affected: null,
      command: "EXPLAIN",
      ms: Date.now() - started,
    }
  }

  async runPlan(statements: string[], limits: PlanLimits = {}): Promise<PlanStepResult[]> {
    lockedOut(this.locked)
    const steps = statements.map(bare).filter(Boolean)
    if (steps.length === 0) throw new Error("The plan has no statements.")
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const results: PlanStepResult[] = []
      let changed = 0
      for (const [index, text] of steps.entries()) {
        try {
          const raw = await this.run(connection, text)
          results.push({ command: null, affected: raw.affected })
          changed += raw.affected ?? 0
          if (limits.maxAffected !== undefined && changed > limits.maxAffected) {
            throw tooMany(changed, limits.maxAffected)
          }
        } catch (error) {
          await connection.rollback().catch(() => {})
          throw planFailure(error, index, steps.length, !hasDdl(steps.slice(0, index)))
        }
      }
      await connection.commit()
      return results
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}
