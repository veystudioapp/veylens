/**
 * Copying tables from one Postgres to another, both real Postgres (PGlite)
 * over the real wire protocol, in this process. `bun test/copy.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { PGlite } from "@electric-sql/pglite"

import { createSampleDb } from "../scripts/sample-db"
import type { CopyInput, CopyProgress } from "../src/shared/api"
import { Connections } from "../src/main/connections"
import { Copies } from "../src/main/copy"
import { PostgresDriver } from "../src/main/db/postgres"
import { servePostgres } from "./sample-postgres"

const sourceDb = await createSampleDb()
await sourceDb.exec(`
  CREATE TYPE mood AS ENUM ('happy', 'sad', 'it''s complicated');
  CREATE TABLE "Odd ""names""" (
    id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feeling mood NOT NULL DEFAULT 'happy',
    feelings mood[],
    blob bytea,
    at timestamptz,
    doubled int GENERATED ALWAYS AS (id * 2) STORED,
    note text COLLATE "C"
  );
  COMMENT ON TABLE "Odd ""names""" IS 'it''s odd';
  CREATE INDEX odd_feeling ON "Odd ""names""" (feeling) WHERE note IS NOT NULL;
  INSERT INTO "Odd ""names""" (feeling, feelings, blob, at, note) VALUES
    ('sad', ARRAY['happy', 'it''s complicated']::mood[], '\\x00ff10'::bytea, '2026-01-02 03:04:05.678+09', 'one'),
    ('it''s complicated', NULL, NULL, NULL, NULL);
  CREATE VIEW big_orders AS SELECT order_id, total FROM order_totals WHERE total > 100;
`)
const targetDb = await PGlite.create()
const source = servePostgres(sourceDb)
const target = servePostgres(targetDb)

const dir = mkdtempSync(path.join(tmpdir(), "veylens-copy-"))
const connections = new Connections(
  path.join(dir, "connections.json"),
  { encrypt: () => null, decrypt: () => null },
  (config) => new PostgresDriver(config, { stream: config.host === "source" ? source.stream : target.stream })
)
const server = (name: string) => ({
  name,
  engine: "postgres" as const,
  host: name,
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: "off" as const,
  access: "read_write" as const,
})
const from = connections.save(null, server("source"))
const to = connections.save(null, server("target"))

const events: CopyProgress[] = []
const copies = new Copies(connections, (event) => events.push(event))

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

const all = ["customers", "products", "orders", "order_items", "audit_log", "order_totals", "big_orders", 'Odd "names"']
const input = (over: Partial<CopyInput> = {}): CopyInput => ({
  source: { connectionId: from.id, schema: "public", tables: all },
  target: { connectionId: to.id, schema: "public" },
  content: "structure_and_data",
  existing: "fail",
  ...over,
})
const one = async (sql: string) => (await targetDb.query<Record<string, unknown>>(sql)).rows[0]!

await check("plan: everything is made, nothing is asked about", async () => {
  const plan = await copies.plan(input())
  assert.equal(plan.rule, "allow", plan.reasons.join(" "))
  assert.equal(plan.createsSchema, false)
  assert.deepEqual(new Set(plan.items.map((item) => item.action)), new Set(["create"]))
  assert.equal(plan.items.find((item) => item.name === "order_totals")?.data, false)
  assert.match(plan.script, /CREATE TYPE "public"\."mood" AS ENUM \('happy', 'sad', 'it''s complicated'\)/)
  assert.match(plan.script, /ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY/)
})

await check("structure and data: rows, keys, sequences, views", async () => {
  const result = await copies.run("one", input())
  assert.equal(result.items.every((item) => item.status === "copied"), true, JSON.stringify(result))
  for (const table of ["customers", "products", "orders", "order_items", "audit_log"]) {
    const [a, b] = await Promise.all([
      sourceDb.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`),
      targetDb.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`),
    ])
    assert.equal(b.rows[0]!.n, a.rows[0]!.n, table)
  }
  assert.equal(result.rows > 3000, true)
  // The serial counts on from the copied rows.
  assert.equal((await one("INSERT INTO customers (name, email, country) VALUES ('n', 'n@x', 'VN') RETURNING id")).id, 241)
  await assert.rejects(targetDb.query("INSERT INTO orders (customer_id, ordered_at) VALUES (99999, now())"), /foreign key/)
  const totals = await one("SELECT count(*)::int n FROM order_totals")
  assert.equal(totals.n, 1500)
  assert.ok((await one("SELECT count(*)::int n FROM big_orders")).n as number > 0)
  assert.ok(events.some((event) => event.copyId === "one" && event.table === "orders" && event.rows === 1500))
})

await check("odd names, enums, arrays, bytes, identity and generated columns", async () => {
  const row = await one(`SELECT feeling::text, feelings::text, encode(blob, 'hex') AS blob, at, doubled, note
                           FROM "Odd ""names""" WHERE id = 1`)
  assert.equal(row.feeling, "sad")
  assert.equal(row.feelings, `{happy,"it's complicated"}`)
  assert.equal(row.blob, "00ff10")
  assert.equal((row.at as Date).toISOString(), "2026-01-01T18:04:05.678Z")
  assert.equal(row.doubled, 2)
  assert.equal((await one(`INSERT INTO "Odd ""names""" DEFAULT VALUES RETURNING id`)).id, 3)
  assert.equal((await one(`SELECT obj_description('"Odd ""names"""'::regclass, 'pg_class') AS c`)).c, "it's odd")
  assert.equal((await one(`SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'odd_feeling'`)).n, 1)
})

await check("again: what is there already stops it, before anything changes", async () => {
  const plan = await copies.plan(input())
  assert.equal(plan.rule, "block")
  assert.match(plan.reasons[0]!, /Already in public: customers/)
  await assert.rejects(copies.run("two", input()), /Refused: Already in public/)
})

await check("skip leaves them; replace makes them again", async () => {
  const skipped = await copies.run("three", input({ existing: "skip" }))
  assert.equal(skipped.items.every((item) => item.status === "skipped"), true)
  const replaced = await copies.run("four", input({ existing: "replace" }))
  assert.equal(replaced.items.every((item) => item.status === "copied"), true, JSON.stringify(replaced))
  assert.equal((await one("SELECT count(*)::int n FROM customers")).n, 240)
})

await check("data only, emptied first", async () => {
  await targetDb.query("DELETE FROM order_items WHERE order_id < 10")
  const result = await copies.run(
    "five",
    input({
      source: { connectionId: from.id, schema: "public", tables: ["orders", "order_items", "customers", "products"] },
      content: "data",
      existing: "truncate",
    })
  )
  const expected = (await sourceDb.query<{ n: number }>("SELECT count(*)::int n FROM order_items")).rows[0]!.n
  assert.equal(result.items.find((item) => item.name === "order_items")?.rows, expected)
  assert.equal((await one("SELECT count(*)::int n FROM order_items")).n, expected)
})

await check("structure only, into a schema that is made for it", async () => {
  const result = await copies.run(
    "six",
    input({ target: { connectionId: to.id, schema: "Copy 2" }, content: "structure" })
  )
  assert.equal(result.rows, 0)
  assert.equal((await one(`SELECT count(*)::int n FROM "Copy 2".orders`)).n, 0)
  assert.equal((await one(`SELECT count(*)::int n FROM "Copy 2".order_totals`)).n, 0)
  // The serial's sequence was made in the new schema, not borrowed.
  assert.match(
    String((await one(`SELECT pg_get_serial_sequence('"Copy 2".orders', 'id') AS s`)).s),
    /^"Copy 2"\.orders_id_seq$/
  )
})

await check("a failure part-way changes nothing", async () => {
  // Rows of customers go into a table of that name with other columns.
  await targetDb.exec(`CREATE SCHEMA "Copy 3"; CREATE TABLE "Copy 3".customers (id int)`)
  await assert.rejects(
    copies.run(
      "seven",
      input({
        source: { connectionId: from.id, schema: "public", tables: ["orders", "customers"] },
        target: { connectionId: to.id, schema: "Copy 3" },
        existing: "append",
      })
    ),
    /Nothing was changed: the copy was rolled back/
  )
  assert.equal((await one(`SELECT to_regclass('"Copy 3".orders') IS NULL AS gone`)).gone, true)
})

await check("the target's permissions: read-only refuses, blocked DDL refuses", async () => {
  connections.save(to.id, { ...server("target"), access: "read_only" })
  assert.equal((await copies.plan(input({ existing: "replace" }))).rule, "block")
  connections.save(to.id, { ...server("target"), access: "confirm" })
  assert.equal((await copies.plan(input({ existing: "replace" }))).rule, "ask")
  connections.save(to.id, server("target"))
  connections.setPermissions(to.id, {
    ...to.permissions,
    statements: { ...to.permissions.statements, ddl: "block" },
  })
  const plan = await copies.plan(input({ existing: "replace" }))
  assert.equal(plan.rule, "block")
  assert.ok(plan.reasons.some((reason) => /Change the schema is blocked/.test(reason)))
  connections.setPermissions(to.id, to.permissions)
})

await check("the source's permissions: what is hidden cannot be copied", async () => {
  connections.setPermissions(from.id, {
    ...from.permissions,
    objects: [{ schema: "public", table: "audit_log", access: "hidden" }],
  })
  await assert.rejects(copies.plan(input({ existing: "replace" })), /hidden on "source": audit_log/)
  const tables = all.filter((name) => name !== "audit_log")
  const plan = await copies.plan(input({ existing: "replace", source: { connectionId: from.id, schema: "public", tables } }))
  assert.equal(plan.rule, "allow", plan.reasons.join(" "))
  connections.setPermissions(from.id, from.permissions)
})

await check("not into where they came from", async () => {
  await assert.rejects(
    copies.plan(input({ target: { connectionId: from.id, schema: "public" } })),
    /That is where they are already/
  )
})

// The databases go with the process: closing them under connections still
// hanging up crashes PGlite.
await connections.closeAll()
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
