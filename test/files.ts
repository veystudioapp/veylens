/**
 * Drives the files driver — Excel, CSV, Parquet, JSON and Google Sheets in
 * an in-process DuckDB — against files made here, and Google answered by a
 * stand-in. Plain script, no framework: `bun test/files.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { DuckDBInstance } from "@duckdb/node-api"
import * as XLSX from "xlsx"
import * as cptable from "xlsx/dist/cpexcel.full"

import { Connections } from "../src/main/connections"
import { FilesDriver } from "../src/main/db/files/driver"
import type { SheetFetcher, SheetsApiSpreadsheet } from "../src/main/db/files/google-sheets"
import { shapeSheet } from "../src/main/db/files/grid"

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

const dir = mkdtempSync(path.join(os.tmpdir(), "veylens-files-test-"))
const file = (name: string) => path.join(dir, name)

// ── The files ──────────────────────────────────────────────────────────────

/** A report as people keep one: a title, a blank line, then the header;
 * a customer merged over two orders, codes with leading zeros, a "-". */
function writeWorkbook(target: string): void {
  const orders = XLSX.utils.aoa_to_sheet([
    ["売上報告 2025年"],
    [],
    ["注文ID", "Customer", "Amount", "Ordered", "Paid", "Code", "Mixed", null, "Note"],
    [1, "Acme", 120.5, 45658, true, "00123", 10, null, "first"],
    [2, null, 80, 45659, false, "00456", "-", null, null],
    [3, "Globex", 50, 45660, true, "00789", 30, null, "50% off"],
  ])
  for (const row of [4, 5, 6]) orders[`D${row}`]!.z = "yyyy/mm/dd"
  orders["!merges"] = [{ s: { r: 3, c: 1 }, e: { r: 4, c: 1 } }]
  const numbers = XLSX.utils.aoa_to_sheet([
    [1, 2, 3],
    [4, 5, 6],
  ])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, orders, "Orders")
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), "Empty")
  XLSX.utils.book_append_sheet(book, numbers, "Numbers")
  writeFileSync(target, XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
}

writeWorkbook(file("sales.xlsx"))
// Excel in Japan saves CSV as Shift_JIS.
writeFileSync(
  file("people.csv"),
  Buffer.from(cptable.utils.encode(932, "id,名前,city\n1,山田,東京\n2,佐藤,大阪\n") as number[])
)
writeFileSync(file("events.jsonl"), '{"kind":"view","n":1}\n{"kind":"buy","n":2}\n')
writeFileSync(file("secret.txt"), "do not read me\n")
{
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  await connection.run(
    `COPY (SELECT range AS id, range * 2 AS doubled FROM range(5000)) TO '${file("big.parquet")}' (FORMAT parquet)`
  )
  connection.closeSync()
  instance.closeSync()
}

/** Google, answered here: one sheet by its export, one by the API. */
const sheetsApi: SheetsApiSpreadsheet = {
  properties: { title: "Budget" },
  sheets: [
    {
      properties: { title: "2025", sheetType: "GRID" },
      merges: [{ startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 }],
      data: [
        {
          rowData: [
            { values: [{ effectiveValue: { stringValue: "Team" } }, { effectiveValue: { stringValue: "Month" } }, { effectiveValue: { stringValue: "Budget" } }] },
            {
              values: [
                { effectiveValue: { stringValue: "Sales" } },
                { effectiveValue: { numberValue: 45658 }, effectiveFormat: { numberFormat: { type: "DATE" } } },
                { effectiveValue: { numberValue: 1000 } },
              ],
            },
            {
              values: [
                {},
                { effectiveValue: { numberValue: 45689 }, effectiveFormat: { numberFormat: { type: "DATE" } } },
                { effectiveValue: { numberValue: 1200 } },
              ],
            },
          ],
        },
      ],
    },
    { properties: { title: "Chart", sheetType: "OBJECT" } },
  ],
}
const exported = (() => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["sku", "stock"], ["A-1", 4], ["B-2", 0]]), "Stock")
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
})()
const fetched: string[] = []
const fakeGoogle: SheetFetcher = {
  async exportXlsx(id) {
    fetched.push(`export:${id}`)
    return { data: exported, title: "Inventory" }
  },
  async gridData(id) {
    fetched.push(`api:${id}`)
    return sheetsApi
  },
}

const LINKED = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0"
const PRIVATE = "https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit"

const driver = new FilesDriver({
  cacheRoot: file("cache"),
  sheets: fakeGoogle,
  sources: [
    { kind: "file", path: file("sales.xlsx") },
    { kind: "file", path: file("people.csv") },
    { kind: "file", path: file("events.jsonl") },
    { kind: "file", path: file("big.parquet") },
    { kind: "google_sheet", url: LINKED, access: "link" },
    { kind: "google_sheet", url: PRIVATE, access: "google" },
  ],
})

const read = (sql: string, maxRows = 100) => driver.query(sql, { readOnly: true, maxRows })

// ── The checks ─────────────────────────────────────────────────────────────

await check("ping reads every source", async () => {
  assert.match(await driver.ping(), /^DuckDB [\d.]+ · 7 tables from 6 sources$/)
})

await check("tree: files in main, a schema per workbook and per Google Sheet", async () => {
  const tree = await driver.tree()
  assert.deepEqual(
    tree.map((schema) => [schema.name, schema.tables.map((table) => table.name)]),
    [
      ["main", ["big", "events", "people"]],
      ["Budget", ["2025"]],
      ["Inventory", ["Stock"]],
      ["sales", ["Numbers", "Orders"]],
    ]
  )
})

await check("a sheet's header is found under its title, its columns typed", async () => {
  const info = await driver.table({ schema: "sales", table: "Orders" })
  assert.deepEqual(
    info.columns.map((column) => `${column.name}:${column.type}:${column.kind}`),
    [
      "注文ID:BIGINT:number",
      "Customer:VARCHAR:text",
      "Amount:DOUBLE:number",
      "Ordered:DATE:datetime",
      "Paid:BOOLEAN:boolean",
      "Code:VARCHAR:text",
      "Mixed:VARCHAR:text",
      "Note:VARCHAR:text",
    ]
  )
  const details = await driver.details({ schema: "sales", table: "Orders" })
  assert.match(details.comment ?? "", /Sheet "Orders" of .*sales\.xlsx \(header on row 3\)/)
  assert.match(details.ddl, /^CREATE TABLE/)
})

await check("merged cells repeat, dates are dates, codes keep their zeros", async () => {
  const result = await read(`SELECT "注文ID", Customer, Ordered, Code, Mixed FROM sales."Orders" ORDER BY 1`)
  assert.deepEqual(result.rows, [
    ["1", "Acme", "2025-01-01", "00123", "10"],
    ["2", "Acme", "2025-01-02", "00456", "-"],
    ["3", "Globex", "2025-01-03", "00789", "30"],
  ])
})

await check("a sheet that starts with numbers has lettered columns", async () => {
  const info = await driver.table({ schema: "sales", table: "Numbers" })
  assert.deepEqual(info.columns.map((column) => column.name), ["A", "B", "C"])
  assert.equal((await driver.rows({ schema: "sales", table: "Numbers", filters: [], sort: null, limit: 10, offset: 0 })).total, 2)
})

await check("a Shift_JIS CSV reads as Japanese", async () => {
  const result = await read(`SELECT "名前", city FROM people ORDER BY id`)
  assert.deepEqual(result.rows, [
    ["山田", "東京"],
    ["佐藤", "大阪"],
  ])
  assert.match((await driver.details({ schema: "main", table: "people" })).comment ?? "", /read as Shift_JIS/)
})

await check("JSON lines and Parquet", async () => {
  assert.deepEqual((await read("SELECT kind, n FROM events ORDER BY n")).rows, [
    ["view", "1"],
    ["buy", "2"],
  ])
  assert.deepEqual((await read("SELECT count(*), max(doubled) FROM big")).rows, [["5000", "9998"]])
})

await check("Google Sheets, by link and by the API", async () => {
  assert.deepEqual((await read(`SELECT sku, stock FROM "Inventory"."Stock" ORDER BY sku`)).rows, [
    ["A-1", "4"],
    ["B-2", "0"],
  ])
  assert.deepEqual((await read(`SELECT Team, Month, Budget FROM "Budget"."2025" ORDER BY Month`)).rows, [
    ["Sales", "2025-01-01", "1000"],
    ["Sales", "2025-02-01", "1200"],
  ])
  assert.deepEqual(fetched.sort(), [
    "api:1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210",
    "export:1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ])
})

await check("rows: filters, a literal % and _, sorting, paging", async () => {
  const ref = { schema: "sales", table: "Orders" }
  const percent = await driver.rows({ ...ref, filters: [{ column: "Note", op: "contains", value: "50%" }], sort: null, limit: 10, offset: 0 })
  assert.deepEqual(percent.rows.map((row) => row[0]), ["3"])
  const underscore = await driver.rows({ ...ref, filters: [{ column: "Note", op: "contains", value: "_" }], sort: null, limit: 10, offset: 0 })
  assert.equal(underscore.total, 0)
  const numeric = await driver.rows({ ...ref, filters: [{ column: "Amount", op: ">", value: "60" }], sort: { column: "Amount", direction: "desc" }, limit: 10, offset: 0 })
  assert.deepEqual(numeric.rows.map((row) => row[0]), ["1", "2"])
  const page = await driver.rows({ schema: "main", table: "big", filters: [], sort: { column: "id", direction: "desc" }, limit: 3, offset: 10 })
  assert.equal(page.total, 5000)
  assert.deepEqual(page.rows.map((row) => row[0]), ["4989", "4988", "4987"])
})

await check("query: bound values, a cut result, a script of reads, PIVOT", async () => {
  const bound = await driver.query("SELECT count(*) FROM big WHERE id < $1", { readOnly: true, maxRows: 10, values: ["10"] })
  assert.deepEqual(bound.rows, [["10"]])
  const cut = await read("SELECT * FROM big", 2500)
  assert.equal(cut.rows.length, 2500)
  assert.equal(cut.truncated, true)
  const script = await read("SELECT 1; SELECT 2 AS two")
  assert.deepEqual(script.rows, [["2"]])
  const pivot = await read("PIVOT events ON kind USING sum(n)")
  assert.deepEqual(pivot.columns.map((column) => column.name).sort(), ["buy", "view"])
  const explain = await driver.explain("SELECT * FROM big")
  assert.ok(explain.rows.length > 0)
})

await check("nothing outside the given files can be read, written or loaded", async () => {
  for (const sql of [
    `SELECT * FROM read_text('${file("secret.txt")}')`,
    `SELECT * FROM read_csv('${file("secret.txt")}')`,
    `SELECT * FROM glob('${dir}/*')`,
    `SELECT * FROM read_csv('https://example.com/x.csv')`,
  ]) {
    await assert.rejects(read(sql), /Permission Error|disabled by configuration/, sql)
  }
  for (const sql of [
    `COPY big TO '${file("out.csv")}'`,
    `COPY big TO '${file("cache")}/out.csv'`,
    `INSERT INTO people VALUES (3, 'x', 'y')`,
    `CREATE TABLE x AS SELECT 1`,
    `ATTACH '${file("other.db")}'`,
    `SET enable_external_access = true`,
    `INSTALL httpfs`,
    `LOAD httpfs`,
    `SELECT 1; DELETE FROM people`,
  ]) {
    await assert.rejects(read(sql), /read-only|Permission Error|disabled by configuration|locked/, sql)
  }
  await assert.rejects(driver.apply({ schema: "main", table: "people", updates: [], inserts: [], deletes: [] }), /read-only/)
  assert.deepEqual((await read("SELECT count(*) FROM people")).rows, [["2"]])
})

await check("a statement past its time is stopped", async () => {
  await assert.rejects(
    driver.query("SELECT count(*) FROM range(1000000000000) a, range(10) b", { readOnly: true, maxRows: 10, timeoutMs: 300 }),
    /stopped after/
  )
  assert.deepEqual((await read("SELECT 1")).rows, [["1"]])
})

await check("a changed file is read again; a missing one is reported, its tables kept", async () => {
  writeFileSync(file("events.jsonl"), '{"kind":"view","n":1}\n{"kind":"buy","n":2}\n{"kind":"buy","n":5}\n')
  await new Promise((resolve) => setTimeout(resolve, 2100))
  assert.deepEqual((await read("SELECT sum(n) FROM events")).rows, [["8"]])
  rmSync(file("events.jsonl"))
  await new Promise((resolve) => setTimeout(resolve, 2100))
  await assert.rejects(driver.ping(), /events\.jsonl: /)
  assert.deepEqual((await read("SELECT sum(n) FROM events")).rows, [["8"]])
})

await check("a sheet with nothing but a title row is still a table", () => {
  const shaped = shapeSheet([["Report"], [], ["name", "n"], ["a", 1]])
  assert.equal(shaped?.headerRow, 3)
  assert.deepEqual(shaped?.columns.map((column) => column.type), ["VARCHAR", "BIGINT"])
})

await driver.close()

await check("a files connection is saved read-only; its permissions hold in DuckDB's SQL", async () => {
  const connections = new Connections(file("app/connections.json"), {
    encrypt: () => null,
    decrypt: () => null,
  })
  const saved = connections.save(null, {
    name: "Sales files",
    engine: "duckdb",
    host: "",
    port: 0,
    user: "",
    database: "",
    ssl: "off",
    access: "read_write",
    sources: [{ kind: "file", path: file("sales.xlsx") }, { kind: "file", path: file("people.csv") }],
  })
  assert.equal(saved.access, "read_only")
  assert.equal(saved.sources.length, 2)
  assert.match(await connections.test(saved.id, { ...saved, password: undefined }), /2 sources/)
  connections.setPermissions(saved.id, {
    ...saved.permissions,
    objects: [{ schema: "sales", table: "Orders", access: "hidden" }],
  })
  const guarded = connections.driver(saved.id)
  const tree = await guarded.tree()
  assert.deepEqual(tree.find((schema) => schema.name === "sales")?.tables.map((table) => table.name), ["Numbers"])
  for (const sql of [
    `SELECT * FROM sales."Orders"`,
    `FROM sales.Orders`,
    `SUMMARIZE sales.Orders`,
    `SELECT * FROM query_table('sales.Orders')`,
  ]) {
    await assert.rejects(guarded.query(sql, { readOnly: true, maxRows: 10 }), /Refused by the permissions/, sql)
  }
  assert.throws(
    () => connections.save(null, { ...saved, name: "x", sources: [{ kind: "file", path: "relative.xlsx" }] }),
    /full path/
  )
  assert.throws(
    () => connections.save(null, { ...saved, name: "x", sources: [{ kind: "google_sheet", url: "https://example.com", access: "link" }] }),
    /Google Sheet/
  )
  await connections.closeAll()
})

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
