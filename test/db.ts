/**
 * Drives the Postgres driver against a real Postgres speaking the real wire
 * protocol (PGlite, in this process). Plain script, no framework:
 * `bun test/db.ts`.
 */
import assert from "node:assert/strict"

import { EventEmitter } from "node:events"

import { MysqlDriver } from "../src/main/db/mysql"
import { PostgresDriver } from "../src/main/db/postgres"
import { assertReadOnly } from "../src/main/db/sql"
import { openSamplePostgres } from "./sample-postgres"

const sample = await openSamplePostgres()
const driver = new PostgresDriver(
  {
    engine: "postgres",
    host: "in-process",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "postgres",
    ssl: "off",
  },
  { stream: sample.stream }
)

let failed = 0
async function check(name: string, body: () => Promise<void> | void) {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${(error as Error).stack}`)
  }
}

const orders = { schema: "public", table: "orders" }

await check("ping", async () => {
  assert.match(await driver.ping(), /^PostgreSQL \d+/)
})

await check("tree lists schemas, tables and views", async () => {
  const tree = await driver.tree()
  assert.deepEqual(
    tree.map((schema) => schema.name),
    ["public", "analytics"]
  )
  const names = tree[0]!.tables.map((table) => `${table.kind}:${table.name}`)
  assert.ok(names.includes("table:orders"))
  assert.ok(names.includes("view:order_totals"))
})

await check("table structure", async () => {
  const info = await driver.table({ schema: "public", table: "customers" })
  assert.equal(info.kind, "table")
  const byName = Object.fromEntries(info.columns.map((c) => [c.name, c]))
  assert.equal(byName.id!.primaryKey, true)
  assert.equal(byName.id!.kind, "number")
  assert.equal(byName.vip!.kind, "boolean")
  assert.equal(byName.profile!.kind, "json")
  assert.equal(byName.profile!.nullable, true)
  assert.equal(byName.created_at!.kind, "datetime")
  assert.equal(byName.vip!.default, "false")
  const fks = (await driver.table(orders)).foreignKeys
  assert.equal(fks.length, 1)
  assert.match(fks[0]!, /REFERENCES customers\(id\)/)
  assert.equal(
    (await driver.table({ schema: "public", table: "order_totals" })).kind,
    "view"
  )
})

await check("rows: paging, total, default order by key", async () => {
  const page = await driver.rows({
    ...orders,
    filters: [],
    sort: null,
    limit: 50,
    offset: 100,
  })
  assert.equal(page.total, 1500)
  assert.equal(page.rows.length, 50)
  assert.equal(page.rows[0]![0], "101")
})

await check("rows: filters and sort", async () => {
  const page = await driver.rows({
    ...orders,
    filters: [
      { column: "status", op: "=", value: "paid" },
      { column: "id", op: "<=", value: "100" },
      { column: "note", op: "is_null", value: "" },
    ],
    sort: { column: "id", direction: "desc" },
    limit: 10,
    offset: 0,
  })
  assert.equal(page.rows[0]![0], "97")
  assert.ok(page.rows.every((row) => row[2] === "paid" && row[4] === null))

  const contains = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [{ column: "email", op: "contains", value: "R24" }],
    sort: null,
    limit: 100,
    offset: 0,
  })
  // customer24 and customer240, case-insensitively.
  assert.equal(contains.total, 2)

  const literal = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [{ column: "email", op: "contains", value: "%" }],
    sort: null,
    limit: 100,
    offset: 0,
  })
  assert.equal(literal.total, 0)

  const numeric = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [{ column: "id", op: "starts_with", value: "23" }],
    sort: null,
    limit: 100,
    offset: 0,
  })
  // 23 and 230..239.
  assert.equal(numeric.total, 11)

  // Any of them: the two sets together, and a condition's own OR-free words
  // kept in brackets — AND would find none.
  const either = (match: "all" | "any") =>
    driver.rows({
      schema: "public",
      table: "customers",
      filters: [
        { column: "id", op: "=", value: "5" },
        { column: "email", op: "contains", value: "R24" },
      ],
      match,
      sort: { column: "id", direction: "asc" },
      limit: 100,
      offset: 0,
    })
  const any = await either("any")
  assert.equal(any.total, 3)
  assert.deepEqual(any.rows.map((row) => row[0]), ["5", "24", "240"])
  assert.equal((await either("all")).total, 0)

  // id ≤ 30 and (email has R24 or id = 5): a group's or inside the and.
  const grouped = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [
      { column: "id", op: "<=", value: "30" },
      {
        match: "any",
        filters: [
          { column: "email", op: "contains", value: "R24" },
          { column: "id", op: "=", value: "5" },
        ],
      },
      // An empty group says nothing, and is left out.
      { match: "all", filters: [] },
    ],
    sort: { column: "id", direction: "asc" },
    limit: 100,
    offset: 0,
  })
  assert.deepEqual(grouped.rows.map((row) => row[0]), ["5", "24"])
  assert.equal(grouped.total, 2)

  // A word per row, and before or: id = 5 or id ≤ 30 and email has R24
  // is 5, or 24 — not every id up to 30.
  const mixed = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [
      { column: "id", op: "=", value: "5" },
      { column: "id", op: "<=", value: "30", join: "or" },
      { column: "email", op: "contains", value: "R24", join: "and" },
    ],
    sort: { column: "id", direction: "asc" },
    limit: 100,
    offset: 0,
  })
  assert.deepEqual(mixed.rows.map((row) => row[0]), ["5", "24"])
  // And a group's inner words of its own.
  const inner = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [
      { column: "id", op: "<=", value: "30" },
      {
        join: "and",
        filters: [
          { column: "id", op: "=", value: "5" },
          { column: "id", op: "=", value: "7", join: "or" },
        ],
      },
    ],
    sort: { column: "id", direction: "asc" },
    limit: 100,
    offset: 0,
  })
  assert.deepEqual(inner.rows.map((row) => row[0]), ["5", "7"])
})

await check("rows: values arrive as the database prints them", async () => {
  const page = await driver.rows({
    schema: "public",
    table: "customers",
    filters: [{ column: "id", op: "=", value: "7" }],
    sort: null,
    limit: 1,
    offset: 0,
  })
  const row = Object.fromEntries(
    page.columns.map((column, index) => [column.name, page.rows[0]![index]])
  )
  assert.equal(row.vip, "true")
  assert.equal(row.profile, '{"tier": "pro", "seats": 7}')
  assert.match(row.created_at!, /^2025-01-08 /)
})

await check("apply: update, insert, delete in one transaction", async () => {
  const affected = await driver.apply({
    ...orders,
    updates: [
      { key: { id: "1" }, values: { status: "refunded", note: null } },
    ],
    inserts: [{ customer_id: "3", ordered_at: "2026-06-01 10:00+00" }],
    deletes: [],
  })
  assert.equal(affected, 2)
  const check = await driver.query(
    "select status, note from orders where id = 1",
    { readOnly: true, maxRows: 10 }
  )
  assert.deepEqual(check.rows, [["refunded", null]])
  const added = await driver.query(
    "select id, status from orders order by id desc limit 1",
    { readOnly: true, maxRows: 10 }
  )
  // The default filled in what the insert left out.
  assert.deepEqual(added.rows, [["1501", "pending"]])

  await driver.apply({
    schema: "public",
    table: "order_items",
    updates: [],
    inserts: [],
    deletes: [{ order_id: "2", product_id: "3" }],
  })
})

await check("apply: all or nothing", async () => {
  await assert.rejects(
    driver.apply({
      ...orders,
      updates: [
        { key: { id: "2" }, values: { status: "changed" } },
        { key: { id: "999999" }, values: { status: "ghost" } },
      ],
      inserts: [],
      deletes: [],
    }),
    /no longer exists/
  )
  const after = await driver.query("select status from orders where id = 2", {
    readOnly: true,
    maxRows: 1,
  })
  assert.notEqual(after.rows[0]![0], "changed")
})

await check("apply: refuses a change without a key", async () => {
  await assert.rejects(
    driver.apply({
      ...orders,
      updates: [{ key: {}, values: { status: "everything" } }],
      inserts: [],
      deletes: [],
    }),
    /primary key/
  )
  await assert.rejects(
    driver.apply({ ...orders, updates: [], inserts: [], deletes: [{}] }),
    /primary key/
  )
})

await check("query: columns, kinds and the row cap", async () => {
  const result = await driver.query(
    "select id, ordered_at, status = 'paid' as paid from orders order by id",
    { readOnly: true, maxRows: 25 }
  )
  assert.equal(result.rows.length, 25)
  assert.equal(result.truncated, true)
  assert.deepEqual(
    result.columns.map((column) => `${column.name}:${column.kind}`),
    ["id:number", "ordered_at:datetime", "paid:boolean"]
  )
  assert.equal(result.columns[1]!.type, "timestamp with time zone")
  assert.ok(["true", "false"].includes(result.rows[0]![2]!))

  const small = await driver.query("select 1 as one", {
    readOnly: true,
    maxRows: 25,
  })
  assert.equal(small.truncated, false)
  assert.deepEqual(small.rows, [["1"]])
})

await check("query: read-only is enforced twice", async () => {
  const ro = { readOnly: true, maxRows: 10 }
  await assert.rejects(driver.query("delete from orders", ro), /read-only/)
  await assert.rejects(
    driver.query("/* hi */ -- there\n update orders set note = 'x'", ro),
    /read-only/
  )
  // Starts like a read, so only the transaction stops it.
  await assert.rejects(
    driver.query(
      "with gone as (delete from orders returning id) select count(*) from gone",
      ro
    ),
    /read-only transaction/
  )
  await assert.rejects(
    driver.query("select 1; delete from orders", ro),
    /multiple commands/
  )
  const count = await driver.query("select count(*) from orders", ro)
  assert.equal(count.rows[0]![0], "1501")
  assert.throws(() => assertReadOnly("select 1 into outfile '/tmp/x'"))
  assertReadOnly("  (select 1)")
  assertReadOnly("EXPLAIN select 1")
})

await check("query: writes and scripts when not read-only", async () => {
  const update = await driver.query(
    "update orders set note = 'bulk' where id between 10 and 12",
    { readOnly: false, maxRows: 10 }
  )
  assert.equal(update.affected, 3)
  assert.equal(update.command, "UPDATE")
  assert.equal(update.columns.length, 0)

  const script = await driver.query(
    "create temp table t (n int); insert into t values (1), (2); select * from t",
    { readOnly: false, maxRows: 10 }
  )
  assert.deepEqual(script.rows, [["1"], ["2"]])
})

await check("query: an error leaves the pool usable", async () => {
  await assert.rejects(
    driver.query("select * from nowhere", { readOnly: true, maxRows: 10 }),
    /nowhere/
  )
  // `statement_timeout` is not asserted here: PGlite has no timer to
  // interrupt a statement with, so only a real server can show it.
  const again = await driver.query("select 2", { readOnly: true, maxRows: 1 })
  assert.deepEqual(again.rows, [["2"]])
})

await driver.close()
await sample.close()

// MySQL has no in-process server to run against, so these replay what mysql2
// emits for a statement, in its order, on a connection that is only a stand-in.
function fakeMysql(script: (query: EventEmitter) => void) {
  const mysql = new MysqlDriver({
    engine: "mysql", host: "127.0.0.1", port: 1, user: "x", password: "",
    database: "demo", ssl: "off",
  } as never)
  const seen = { released: 0, destroyed: 0 }
  const connection = {
    connection: {
      query() {
        const query = new EventEmitter()
        setTimeout(() => script(query), 0)
        return query
      },
    },
    query: async () => [],
    release: () => void seen.released++,
    destroy: () => void seen.destroyed++,
  }
  ;(mysql as unknown as { pool: unknown }).pool = {
    getConnection: async () => connection,
    end: async () => {},
  }
  return { mysql, seen }
}

/** Fails instead of hanging, which is what the bug looked like. */
const within = <T>(promise: Promise<T>, ms = 1000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)
    ),
  ])

await check("mysql: a statement without rows (DDL, INSERT) settles", async () => {
  const { mysql, seen } = fakeMysql((query) => {
    // mysql2: `fields` is undefined when the server sends an OK packet.
    query.emit("fields", undefined)
    query.emit("result", { affectedRows: 3 })
    query.emit("end")
  })
  const result = await within(
    mysql.query("CREATE TABLE customers (id INT)", { readOnly: false, maxRows: 10 })
  )
  assert.deepEqual(result.columns, [])
  assert.deepEqual(result.rows, [])
  assert.equal(result.affected, 3)
  assert.deepEqual(seen, { released: 1, destroyed: 0 })
})

await check("mysql: rows arrive with their columns", async () => {
  const { mysql } = fakeMysql((query) => {
    query.emit("fields", [{ name: "n", columnType: 3, type: 3 }])
    query.emit("result", [1])
    query.emit("result", [2])
    query.emit("end")
  })
  const result = await within(
    mysql.query("SELECT n FROM t", { readOnly: false, maxRows: 10 })
  )
  assert.deepEqual(result.columns.map((column) => column.name), ["n"])
  assert.equal(result.rows.length, 2)
  assert.equal(result.affected, null)
})

await check("mysql: a throw while reading rejects instead of hanging", async () => {
  const { mysql, seen } = fakeMysql((query) => {
    query.emit("fields", null)
    // A row with no fields announced: decoding it reads past what is known.
    query.emit("result", { get affectedRows(): number { throw new Error("boom") } })
    query.emit("end")
  })
  await assert.rejects(
    within(mysql.query("DO 1", { readOnly: false, maxRows: 10 })),
    /boom/
  )
  assert.deepEqual(seen, { released: 0, destroyed: 1 })
})

console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
