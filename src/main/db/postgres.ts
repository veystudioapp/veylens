import pg from "pg"
import Cursor from "pg-cursor"

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
  TableInfo,
  TableRef,
  TreeSchema,
} from "../../shared/api"
import { startsLikeRead } from "../../shared/statements"
import {
  assertReadOnly,
  changeStatements,
  countRows,
  POSTGRES,
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

/**
 * Every value as the text the server sent. The driver's own parsers turn a
 * timestamp into a `Date` in this machine's zone and a bigint into a string
 * anyway; a data browser should show what is stored, not a reading of it.
 */
const RAW = { getTypeParser: () => (value: string) => value }

type RawResult = {
  fields: { name: string; dataTypeID: number }[]
  rows: Cell[][]
  rowCount: number | null
  command: string | null
  /** Rows changed by every statement of a script, not only the last. */
  changed?: number
}

type TypeInfo = { name: string; kind: ColumnKind }

/** pg_constraint's one-letter actions. */
const PG_ACTION: Record<string, ForeignKeyAction> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
}

const PG_CONSTRAINT: Record<string, TableConstraint["kind"]> = {
  p: "primary",
  u: "unique",
  c: "check",
  f: "foreign",
  x: "exclusion",
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
const quoteText = (text: string) => `'${text.replace(/'/g, "''")}'`

/** A JSON array the catalogue was asked for, or none. */
const names = (json: Cell | undefined): string[] => {
  try {
    const parsed = JSON.parse(json ?? "[]")
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const sizeOf = (value: Cell | undefined): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value)

function kindOf(category: string, name: string): ColumnKind {
  if (name === "json" || name === "jsonb") return "json"
  if (name === "bytea") return "binary"
  if (category === "N") return "number"
  if (category === "B") return "boolean"
  if (category === "D" || category === "T") return "datetime"
  return "text"
}

/** `t`/`f` is how the wire spells a boolean; nobody types it that way. */
function spellBooleans(rows: Cell[][], columns: Column[]): void {
  const booleans = columns.flatMap((column, index) =>
    column.kind === "boolean" ? [index] : []
  )
  if (booleans.length === 0) return
  for (const row of rows) {
    for (const index of booleans) {
      if (row[index] === "t") row[index] = "true"
      else if (row[index] === "f") row[index] = "false"
    }
  }
}

function isMultiStatement(error: unknown): boolean {
  return (
    error instanceof Error &&
    /cannot insert multiple commands into a prepared statement/.test(
      error.message
    )
  )
}

export class PostgresDriver implements Driver {
  /** Built for a read-only connection: writes are refused here too. */
  private readonly locked: boolean
  private readonly pool: pg.Pool
  private typesOnce: Promise<Map<number, TypeInfo>> | null = null

  /** `overrides` is for a test or Cloud SQL, which hand the pool a stream of
   * their own. */
  constructor(config: ConnectionConfig, overrides: pg.PoolConfig = {}) {
    this.locked = config.access === "read_only"
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      ssl:
        config.ssl === "off"
          ? false
          : { rejectUnauthorized: config.ssl === "verify" },
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "veylens",
      // A read-only connection is read-only to the server as well: every
      // transaction a session starts, explicit or not, refuses to write. Set
      // as the session starts, so no query of the app's runs before it. The
      // app's own checks come first; this is what holds if one misses.
      ...(config.access === "read_only"
        ? { options: "-c default_transaction_read_only=on" }
        : {}),
      ...overrides,
    })
    // An idle client dropped by the server is not this process's to die over.
    this.pool.on("error", () => {})
  }

  private async run(
    client: pg.ClientBase | pg.Pool,
    statement: Statement | string
  ): Promise<RawResult> {
    const { text, values } =
      typeof statement === "string"
        ? { text: statement, values: [] as Cell[] }
        : statement
    const result = await client.query({
      text,
      values,
      rowMode: "array",
      types: RAW,
    })
    return {
      fields: result.fields,
      rows: result.rows as Cell[][],
      rowCount: result.rowCount,
      command: result.command,
    }
  }

  /** The server's own names for its types, asked for once. */
  private types(): Promise<Map<number, TypeInfo>> {
    this.typesOnce ??= this.run(
      this.pool,
      "SELECT oid, format_type(oid, NULL), typcategory FROM pg_type"
    ).then(
      (result) =>
        new Map(
          result.rows.map((row) => {
            const name = row[1] ?? "unknown"
            return [Number(row[0]), { name, kind: kindOf(row[2] ?? "", name) }]
          })
        ),
      (error) => {
        this.typesOnce = null
        throw error
      }
    )
    return this.typesOnce
  }

  private static describe(
    fields: RawResult["fields"],
    types: Map<number, TypeInfo>
  ): Column[] {
    return fields.map((field) => {
      const type = types.get(field.dataTypeID)
      return {
        name: field.name,
        type: type?.name ?? `oid ${field.dataTypeID}`,
        kind: type?.kind ?? "text",
      }
    })
  }

  async ping(): Promise<string> {
    const result = await this.run(this.pool, "SELECT version()")
    const version = result.rows[0]?.[0] ?? "PostgreSQL"
    return /^\S+ [\d.]+/.exec(version)?.[0] ?? version
  }

  async tree(): Promise<TreeSchema[]> {
    const result = await this.run(
      this.pool,
      `SELECT n.nspname, c.relname, c.relkind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname !~ '^pg_(toast|temp)'
        ORDER BY (n.nspname = 'public') DESC, n.nspname, c.relname`
    )
    const schemas = new Map<string, TreeSchema>()
    for (const [schema, name, kind] of result.rows) {
      if (!schema || !name) continue
      let entry = schemas.get(schema)
      if (!entry) schemas.set(schema, (entry = { name: schema, tables: [] }))
      entry.tables.push({
        name,
        kind: kind === "v" || kind === "m" ? "view" : "table",
      })
    }
    return [...schemas.values()]
  }

  /** From the rewrite rules' dependencies: what each view and materialized
   * view reads, whoever owns it. */
  async viewSources(): Promise<ViewSource[]> {
    const result = await this.run(
      this.pool,
      `SELECT DISTINCT vn.nspname, v.relname, tn.nspname, t.relname
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class v ON v.oid = r.ev_class
         JOIN pg_namespace vn ON vn.oid = v.relnamespace
         JOIN pg_class t ON t.oid = d.refobjid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE d.classid = 'pg_rewrite'::regclass
          AND d.refclassid = 'pg_class'::regclass
          AND v.relkind IN ('v', 'm')
          AND t.oid <> v.oid`
    )
    return result.rows.flatMap(([viewSchema, view, schema, table]) =>
      viewSchema && view && schema && table
        ? [{ view: { schema: viewSchema, table: view }, source: { schema, table } }]
        : []
    )
  }

  async table(ref: TableRef): Promise<TableInfo> {
    const key = { values: [ref.schema, ref.table] }
    const [columns, foreignKeys] = await Promise.all([
      this.run(this.pool, {
        // `to_jsonb(a)` so a server too old to have `attidentity` or
        // `attgenerated` answers with null rather than an error.
        text: `SELECT a.attname,
                      format_type(a.atttypid, a.atttypmod),
                      t.typcategory,
                      NOT a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid),
                      EXISTS (
                        SELECT 1 FROM pg_index i
                         WHERE i.indrelid = a.attrelid AND i.indisprimary
                           AND a.attnum = ANY (i.indkey)
                      ),
                      coalesce(to_jsonb(a) ->> 'attidentity', ''),
                      coalesce(to_jsonb(a) ->> 'attgenerated', ''),
                      c.relkind
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_type t ON t.oid = a.atttypid
                 LEFT JOIN pg_attrdef d
                   ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum`,
        ...key,
      }),
      this.run(this.pool, {
        text: `SELECT con.conname, pg_get_constraintdef(con.oid)
                 FROM pg_constraint con
                 JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
                ORDER BY con.conname`,
        ...key,
      }),
    ])

    if (columns.rows.length === 0) {
      throw new Error(`No table or view "${ref.schema}"."${ref.table}".`)
    }

    const relkind = columns.rows[0]?.[8]
    return {
      kind: relkind === "v" || relkind === "m" ? "view" : "table",
      columns: columns.rows.map((row): TableColumn => {
        const type = row[1] ?? "unknown"
        const base = type.replace(/\(.*\)/, "").replace(/\[\]$/, "")
        return {
          name: row[0] ?? "",
          type,
          kind: type.endsWith("[]") ? "text" : kindOf(row[2] ?? "", base),
          nullable: row[3] === "t",
          default: row[4] ?? null,
          primaryKey: row[5] === "t",
          extra: row[6] ? "identity" : row[7] ? "generated" : "",
        }
      }),
      foreignKeys: foreignKeys.rows.map((row) => `${row[0]}: ${row[1]}`),
    }
  }

  async details(ref: TableRef): Promise<TableDetails> {
    const key = { values: [ref.schema, ref.table] }
    const attnames = (keys: string, relation: string) =>
      `to_json(ARRAY(SELECT a.attname FROM unnest(${keys}) WITH ORDINALITY k(num, ord)
                       JOIN pg_attribute a ON a.attrelid = ${relation} AND a.attnum = k.num
                      ORDER BY k.ord))`
    const [relation, columns, constraints, indexes, incoming] = await Promise.all([
      this.run(this.pool, {
        text: `SELECT c.relkind, obj_description(c.oid, 'pg_class'), c.reltuples::int8,
                      CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_total_relation_size(c.oid) END,
                      CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_indexes_size(c.oid) END,
                      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2`,
        ...key,
      }),
      this.run(this.pool, {
        text: `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid),
                      coalesce(to_jsonb(a) ->> 'attidentity', ''),
                      coalesce(to_jsonb(a) ->> 'attgenerated', ''),
                      col_description(a.attrelid, a.attnum)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = $1 AND c.relname = $2
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum`,
        ...key,
      }),
      this.run(this.pool, {
        text: `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid, true),
                      ${attnames("con.conkey", "con.conrelid")},
                      fn.nspname, fc.relname,
                      ${attnames("con.confkey", "con.confrelid")},
                      con.confdeltype, con.confupdtype
                 FROM pg_constraint con
                 JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_class fc ON fc.oid = con.confrelid
                 LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                -- Postgres 18 keeps NOT NULL here too ('n'): the columns say it.
                WHERE n.nspname = $1 AND c.relname = $2
                  AND con.contype IN ('p', 'u', 'f', 'c', 'x')
                ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END,
                         con.conname`,
        ...key,
      }),
      this.run(this.pool, {
        text: `SELECT i.relname, ix.indisunique, ix.indisprimary, am.amname,
                      pg_relation_size(i.oid),
                      to_json(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                                      FROM generate_subscripts(ix.indkey, 1) k ORDER BY k)),
                      pg_get_indexdef(ix.indexrelid),
                      EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid
                                 AND con.conrelid = ix.indrelid)
                 FROM pg_index ix
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_class c ON c.oid = ix.indrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_am am ON am.oid = i.relam
                WHERE n.nspname = $1 AND c.relname = $2
                ORDER BY ix.indisprimary DESC, i.relname`,
        ...key,
      }),
      this.run(this.pool, {
        text: `SELECT con.conname, sn.nspname, sc.relname,
                      ${attnames("con.conkey", "con.conrelid")},
                      ${attnames("con.confkey", "con.confrelid")}
                 FROM pg_constraint con
                 JOIN pg_class sc ON sc.oid = con.conrelid
                 JOIN pg_namespace sn ON sn.oid = sc.relnamespace
                 JOIN pg_class c ON c.oid = con.confrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
                ORDER BY sc.relname, con.conname`,
        ...key,
      }),
    ])

    const rel = relation.rows[0]
    if (!rel) throw new Error(`No table or view "${ref.schema}"."${ref.table}".`)
    const relkind = rel[0]
    const kind: TableDetails["kind"] =
      relkind === "v" ? "view" : relkind === "m" ? "materialized view" : "table"
    const estimate = sizeOf(rel[2])

    const columnComments: Record<string, string> = {}
    for (const row of columns.rows) if (row[6]) columnComments[row[0] ?? ""] = row[6]

    const keys: TableConstraint[] = constraints.rows.map((row) => {
      const type = PG_CONSTRAINT[row[1] ?? ""] ?? "check"
      return {
        name: row[0] ?? "",
        kind: type,
        columns: names(row[3]),
        definition: row[2] ?? "",
        ...(type === "foreign"
          ? {
              references: {
                schema: row[4] ?? "",
                table: row[5] ?? "",
                columns: names(row[6]),
                onDelete: PG_ACTION[row[7] ?? ""] ?? null,
                onUpdate: PG_ACTION[row[8] ?? ""] ?? null,
              },
            }
          : {}),
      }
    })

    const table = `${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`
    let ddl: string
    if (kind !== "table") {
      const body = (rel[5] ?? "").trim().replace(/;\s*$/, "")
      ddl = `CREATE ${kind === "view" ? "VIEW" : "MATERIALIZED VIEW"} ${table} AS\n${body};`
    } else {
      const lines = columns.rows.map((row) => {
        const [name, type, notNull, expression, identity, generated] = row
        let line = `  ${quoteIdent(name ?? "")} ${type}`
        if (generated === "s") line += ` GENERATED ALWAYS AS (${expression}) STORED`
        else if (identity) line += ` GENERATED ${identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`
        else if (expression) line += ` DEFAULT ${expression}`
        if (notNull === "t" && !identity) line += " NOT NULL"
        return line
      })
      for (const key of keys) lines.push(`  CONSTRAINT ${quoteIdent(key.name)} ${key.definition}`)
      const parts = [`CREATE TABLE ${table} (\n${lines.join(",\n")}\n);`]
      // Indexes a constraint already makes are written by that constraint.
      for (const row of indexes.rows) if (row[7] !== "t" && row[6]) parts.push(`${row[6]};`)
      if (rel[1]) parts.push(`COMMENT ON TABLE ${table} IS ${quoteText(rel[1])};`)
      for (const [name, comment] of Object.entries(columnComments)) {
        parts.push(`COMMENT ON COLUMN ${table}.${quoteIdent(name)} IS ${quoteText(comment)};`)
      }
      ddl = parts.join("\n\n")
    }

    return {
      kind,
      comment: rel[1] || null,
      // -1 until the table is first analysed.
      rowEstimate: estimate !== null && estimate >= 0 ? estimate : null,
      totalBytes: sizeOf(rel[3]),
      indexBytes: sizeOf(rel[4]),
      engine: null,
      collation: null,
      columnComments,
      indexes: indexes.rows.map((row) => ({
        name: row[0] ?? "",
        unique: row[1] === "t",
        primary: row[2] === "t",
        method: row[3] ?? null,
        bytes: sizeOf(row[4]),
        columns: names(row[5]),
      })),
      constraints: keys,
      referencedBy: incoming.rows.map((row) => ({
        name: row[0] ?? "",
        schema: row[1] ?? "",
        table: row[2] ?? "",
        columns: names(row[3]),
        referencedColumns: names(row[4]),
      })),
      ddl,
    }
  }

  async rows(request: RowsRequest): Promise<RowsResult> {
    const info = await this.table(request)
    // Without an order the pages of a table are whatever the planner hands
    // back, and a row can show up on two of them.
    const order: Sort[] = request.sort
      ? [request.sort]
      : info.columns
          .filter((column) => column.primaryKey)
          .map((column) => ({ column: column.name, direction: "asc" }))

    const [rows, total] = await Promise.all([
      this.run(
        this.pool,
        selectRows(
          POSTGRES,
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

    spellBooleans(rows.rows, info.columns)
    return { columns: info.columns, rows: rows.rows, total }
  }

  /** Null rather than a wait: counting a very large table can take minutes. */
  private async count(request: RowsRequest): Promise<number | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SET LOCAL statement_timeout = ${COUNT_TIMEOUT_MS}`)
      const result = await this.run(
        client,
        countRows(POSTGRES, request, request.filters, request.match)
      )
      return Number(result.rows[0]?.[0] ?? 0)
    } catch {
      return null
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
  }

  async apply(changes: ChangeSet): Promise<number> {
    lockedOut(this.locked)
    const statements = changeStatements(POSTGRES, changes)
    if (statements.length === 0) return 0

    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      let affected = 0
      for (const statement of statements) {
        const result = await this.run(client, statement)
        const count = result.rowCount ?? 0
        if (statement.single && count !== 1) {
          throw new Error(
            count === 0
              ? "A row being changed no longer exists, or its key has changed. Nothing was saved."
              : `A change matched ${count} rows instead of one. Nothing was saved.`
          )
        }
        affected += count
      }
      await client.query("COMMIT")
      return affected
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * One statement through a cursor, so a `SELECT *` over a hundred million
   * rows costs `maxRows + 1` of them rather than this process's memory.
   */
  private cursor(
    client: pg.ClientBase,
    sql: string,
    maxRows: number,
    values: Cell[] = []
  ): Promise<RawResult & { truncated: boolean }> {
    const cursor = client.query(
      new Cursor<Cell[]>(sql, values, { rowMode: "array", types: RAW })
    )
    return new Promise((resolve, reject) => {
      cursor.read(maxRows + 1, (error, rows, result) => {
        if (error) return reject(error)
        const truncated = rows.length > maxRows
        cursor.close(() =>
          resolve({
            fields: result.fields,
            rows: truncated ? rows.slice(0, maxRows) : rows,
            truncated,
            rowCount: result.rowCount,
            // Unset while the portal is still open, which is exactly when
            // the rows were cut.
            command: result.command ?? null,
          })
        )
      })
    })
  }

  async query(sql: string, given: QueryOptions): Promise<QueryResult> {
    // On a read-only connection everything is a read, whoever asked.
    if (this.locked && !given.readOnly && !startsLikeRead(sql)) lockedOut(true)
    const options = this.locked ? { ...given, readOnly: true } : given
    if (options.readOnly) assertReadOnly(sql)

    // Asked for before a client is held: this goes through the pool, and a
    // query that waits on a second connection while holding the first is a
    // deadlock on a pool that has run out.
    const types = await this.types()
    const started = Date.now()
    const client = await this.pool.connect()
    let broken = false
    // A write under a limit runs in a transaction of its own, so a
    // statement past it can be taken back.
    const limited =
      !options.readOnly && (options.maxAffected !== undefined || !!options.timeoutMs)
    let open = false
    try {
      if (options.readOnly) {
        await client.query("BEGIN TRANSACTION READ ONLY")
      } else if (limited) {
        await client.query("BEGIN")
        open = true
      }
      if ((options.readOnly || limited) && options.timeoutMs) {
        await client.query(
          `SET LOCAL statement_timeout = ${Math.round(options.timeoutMs)}`
        )
      }

      let raw: RawResult & { truncated: boolean }
      try {
        raw = await this.cursor(client, sql, options.maxRows, options.values)
      } catch (error) {
        // A script of several statements cannot be a cursor. Somebody typing
        // into the SQL tab may well mean one; the agent's read never does.
        if (options.readOnly || options.values?.length || !isMultiStatement(error)) {
          throw error
        }
        if (open) {
          // The failed attempt aborted the transaction: start it again.
          await client.query("ROLLBACK")
          await client.query("BEGIN")
          if (options.timeoutMs) {
            await client.query(`SET LOCAL statement_timeout = ${Math.round(options.timeoutMs)}`)
          }
        }
        raw = await this.script(client, sql, options.maxRows)
      }

      if (open) {
        const changed = raw.changed ?? raw.rowCount ?? 0
        if (options.maxAffected !== undefined && changed > options.maxAffected) {
          throw tooMany(changed, options.maxAffected)
        }
        await client.query("COMMIT")
        open = false
      }

      const columns = PostgresDriver.describe(raw.fields, types)
      spellBooleans(raw.rows, columns)
      const returnsRows = columns.length > 0
      return {
        columns,
        rows: raw.rows,
        truncated: raw.truncated,
        affected: returnsRows ? null : raw.rowCount,
        command: raw.command,
        ms: Date.now() - started,
      }
    } catch (error) {
      // A cancelled or timed-out statement can leave the client mid-protocol.
      broken = !(error instanceof pg.DatabaseError)
      throw error
    } finally {
      if (options.readOnly || open) {
        await client.query("ROLLBACK").catch(() => {
          broken = true
        })
      }
      client.release(broken)
    }
  }

  /** Several statements at once, by the simple protocol. The last one that
   * returned rows is the answer; with none, the last one. */
  private async script(
    client: pg.ClientBase,
    sql: string,
    maxRows: number
  ): Promise<RawResult & { truncated: boolean }> {
    const answer = (await client.query({
      text: sql,
      rowMode: "array",
      types: RAW,
    })) as pg.QueryArrayResult | pg.QueryArrayResult[]
    const results = Array.isArray(answer) ? answer : [answer]
    const last =
      [...results].reverse().find((result) => result.fields.length > 0) ??
      results.at(-1)
    if (!last) throw new Error("The statement returned nothing.")
    const rows = last.rows as Cell[][]
    return {
      fields: last.fields,
      rows: rows.slice(0, maxRows),
      truncated: rows.length > maxRows,
      rowCount: last.rowCount,
      command: last.command,
      changed: results
        .filter((result) => !result.fields?.length)
        .reduce((sum, result) => sum + (result.rowCount ?? 0), 0),
    }
  }

  explain(sql: string): Promise<QueryResult> {
    // In a read-only transaction like any read, so an EXPLAIN ANALYZE of a
    // write — which would run it — is refused by the server.
    return this.query(explained(sql), {
      readOnly: true,
      maxRows: 1000,
      timeoutMs: 15_000,
    })
  }

  async runPlan(statements: string[], limits: PlanLimits = {}): Promise<PlanStepResult[]> {
    lockedOut(this.locked)
    const steps = statements.map(bare).filter(Boolean)
    if (steps.length === 0) throw new Error("The plan has no statements.")
    const client = await this.pool.connect()
    let broken = false
    try {
      await client.query("BEGIN")
      if (limits.timeoutMs) {
        await client.query(`SET LOCAL statement_timeout = ${Math.round(limits.timeoutMs)}`)
      }
      const results: PlanStepResult[] = []
      let changed = 0
      for (const [index, text] of steps.entries()) {
        try {
          const result = (await client.query(text)) as pg.QueryResult
          const affected = result.fields?.length ? null : (result.rowCount ?? null)
          results.push({ command: result.command ?? null, affected })
          changed += affected ?? 0
          if (limits.maxAffected !== undefined && changed > limits.maxAffected) {
            throw tooMany(changed, limits.maxAffected)
          }
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {
            broken = true
          })
          throw planFailure(error, index, steps.length, true)
        }
      }
      await client.query("COMMIT")
      return results
    } catch (error) {
      broken ||= !(error instanceof Error)
      throw error
    } finally {
      client.release(broken)
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}
