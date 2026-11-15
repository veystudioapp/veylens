/**
 * The analysis features end to end below the UI: dry runs and plans in the
 * Postgres driver, the agent's tools as the CLI would call them, the library
 * that keeps metrics, notes and dashboards, and the chart rules the agent and
 * the viewer share. Against the in-process sample Postgres, no network:
 * `bun test/features.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { tileText, type ChatEvent, type ChatItem as ChatItemT, type ViewerTarget } from "../src/shared/api"
import { chartProblem, inferChart, isNumeric, widen } from "../src/shared/chart"
import {
  bindParameters,
  dateRange,
  filterValues,
  inlineParameters,
  likePattern,
  numberOrNull,
  quoteLiteral,
} from "../src/shared/params"
import { readAnswer } from "../src/main/assist"
import { AUDIT_KEEP, AuditLog, describeChanges, refusal } from "../src/main/audit"
import { Chats, plainPreview } from "../src/main/chats"
import {
  APPROVAL_TOOLS,
  dbToolDefinitions,
  grantKey,
  type ChartItem,
} from "../src/main/agent-tools"
import { Connections } from "../src/main/connections"
import { GuardedDriver } from "../src/main/db/guarded"
import type { Driver } from "../src/main/db/types"
import {
  checkPermissions,
  classify,
  DEFAULT_PERMISSIONS,
  judge,
  judgeChanges,
  referencesIn,
  tokenize,
  visibleTree,
} from "../src/shared/permissions"
import { PostgresDriver } from "../src/main/db/postgres"
import { checkFieldDisplay, Library } from "../src/main/library"
import { TOOL_CATALOG } from "../src/shared/agent"
import {
  cssColour,
  detectFormat,
  formatCurrency,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  splitValues,
  groupDigits,
  referencesOf,
  tagTone,
} from "../src/renderer/lib/cell-format"
import { applyUserChanges, runUserQuery } from "../src/main/user-queries"
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

const dir = mkdtempSync(path.join(tmpdir(), "veydata-features-"))
const events: ChatEvent[] = []
const library = new Library(dir, (event) => events.push(event))
const connections = new Connections(
  path.join(dir, "connections.json"),
  { encrypt: () => null, decrypt: () => null },
  // The one driver, shared: saving a connection closes the driver it had,
  // and that must not be this one.
  () => Object.assign(Object.create(driver) as PostgresDriver, { close: async () => {} })
)
const shop = connections.save(null, {
  name: "Shop",
  engine: "postgres",
  host: "in-process",
  port: 5432,
  user: "postgres",
  database: "postgres",
  ssl: "off",
  password: "",
})

const charts: ChartItem[] = []
const opened: ViewerTarget[] = []
const grants = new Set<string>()
const tools = dbToolDefinitions({
  connections,
  library,
  takeGrant: (tool, args) => grants.delete(grantKey(tool, args)),
  open: (target) => opened.push(target),
  changed: () => {},
  chart: (item) => charts.push(item),
})

type Answer = { content: { type: string; text: string }[]; isError?: boolean }
async function call(name: string, args: Record<string, unknown>): Promise<Answer> {
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return (await found.handler(args as never, {} as never)) as Answer
}
const text = (answer: Answer) => answer.content.map((part) => part.text).join("")

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

const num = (name: string) => ({ name, type: "numeric", kind: "number" as const })
const txt = (name: string) => ({ name, type: "text", kind: "text" as const })

const count = async (sql: string) =>
  Number((await driver.query(sql, { readOnly: true, maxRows: 1 })).rows[0]![0])

// ── Driver ─────────────────────────────────────────────────────────────────

await check("dry run: a plan comes back, nothing runs", async () => {
  const before = await count("select count(*) from audit_log")
  const plan = await driver.explain("DELETE FROM audit_log;")
  assert.ok(plan.rows.length > 0)
  assert.match(plan.rows.map((row) => row[0]).join("\n"), /Delete on audit_log/)
  assert.equal(await count("select count(*) from audit_log"), before)
})

await check("dry run: EXPLAIN ANALYZE of a write is refused", async () => {
  const before = await count("select count(*) from audit_log")
  await assert.rejects(
    driver.explain("EXPLAIN ANALYZE DELETE FROM audit_log"),
    /read-only/
  )
  assert.equal(await count("select count(*) from audit_log"), before)
})

await check("plan: every step commits together", async () => {
  const steps = await driver.runPlan([
    "CREATE TABLE plan_a (id int PRIMARY KEY, label text)",
    "INSERT INTO plan_a VALUES (1, 'one'), (2, 'two');",
    "UPDATE plan_a SET label = 'uno' WHERE id = 1",
  ])
  assert.equal(steps.length, 3)
  assert.equal(steps[1]!.affected, 2)
  assert.equal(steps[2]!.affected, 1)
  assert.equal(await count("select count(*) from plan_a"), 2)
})

await check("plan: a failing step rolls back the ones before it", async () => {
  await assert.rejects(
    driver.runPlan([
      "CREATE TABLE plan_b (id int PRIMARY KEY)",
      "INSERT INTO plan_b VALUES (1)",
      "INSERT INTO plan_b VALUES (1)",
    ]),
    /Step 3 of 3 failed: .*duplicate key[\s\S]*nothing was changed/
  )
  assert.equal(
    await count("select count(*) from information_schema.tables where table_name = 'plan_b'"),
    0
  )
  // The connection it failed on is usable again.
  assert.equal(await count("select 1"), 1)
})

// ── Chart rules ────────────────────────────────────────────────────────────

const monthly = await driver.query(
  "select date_trunc('month', ordered_at)::date as month, count(*) as orders, sum(id) as ids from orders group by 1 order by 1",
  { readOnly: true, maxRows: 100 }
)
const byStatus = await driver.query(
  "select status, count(*) as orders from orders group by 1 order by 2 desc",
  { readOnly: true, maxRows: 100 }
)

await check("chart: a first chart is guessed from the result", () => {
  assert.deepEqual(inferChart(monthly), { type: "line", x: "month", y: ["orders", "ids"] })
  assert.deepEqual(inferChart(byStatus), { type: "bar", x: "status", y: ["orders"] })
  assert.deepEqual(
    inferChart({ columns: [{ name: "total", type: "numeric", kind: "number" }], rows: [["12.50"]] }),
    { type: "stat", x: null, y: ["total"] }
  )
  assert.equal(
    inferChart({ columns: [{ name: "name", type: "text", kind: "text" }], rows: [["a"]] }),
    null
  )
})

await check("chart: numbers a driver calls text still count", () => {
  const data = {
    columns: [
      { name: "k", type: "text", kind: "text" as const },
      { name: "v", type: "decimal", kind: "text" as const },
    ],
    rows: [["a", "1.5"], ["b", null], ["c", "-2"]],
  }
  assert.equal(isNumeric(data, 1), true)
  assert.equal(isNumeric(data, 0), false)
})

await check("chart: a spec that does not fit says why", () => {
  assert.match(chartProblem({ type: "bar", x: "nope", y: ["orders"] }, byStatus)!, /No column named "nope"/)
  assert.match(chartProblem({ type: "bar", x: "orders", y: ["status"] }, byStatus)!, /not numeric/)
  assert.match(chartProblem({ type: "line", x: null, y: ["orders"] }, byStatus)!, /needs x/)
  assert.equal(chartProblem({ type: "hbar", x: "status", y: ["orders"] }, byStatus), null)
})

// ── Agent tools ────────────────────────────────────────────────────────────

await check("show_chart: draws the chart in the chat and returns its data", async () => {
  const answer = await call("show_chart", {
    connection: "Shop",
    sql: "select status, count(*) as orders from orders group by 1 order by 2 desc",
    title: "Orders by status",
    type: "hbar",
    x: "status",
    y: ["orders"],
  })
  assert.equal(answer.isError, undefined, text(answer))
  assert.match(text(answer), /"columns":\["status","orders"\]/)
  assert.equal(charts.length, 1)
  assert.equal(charts[0]!.connectionId, shop.id)
  assert.deepEqual(charts[0]!.spec, { type: "hbar", x: "status", y: ["orders"] })
  assert.equal(charts[0]!.result.rows.length, 4)
})

await check("show_chart: refuses what cannot be drawn, and writes", async () => {
  const bad = await call("show_chart", {
    connection: "Shop",
    sql: "select status, count(*) as orders from orders group by 1",
    title: "x",
    type: "bar",
    x: "status",
    y: ["status"],
  })
  assert.equal(bad.isError, true)
  assert.match(text(bad), /not numeric/)
  const write = await call("show_chart", {
    connection: "Shop",
    sql: "delete from audit_log",
    title: "x",
    type: "stat",
    y: ["n"],
  })
  assert.equal(write.isError, true)
  assert.equal(charts.length, 1)
})

await check("tools that change things need the user's approval", async () => {
  assert.deepEqual(
    [...APPROVAL_TOOLS].sort(),
    ["append_note", "delete_dashboard", "execute_plan", "execute_sql", "remove_from_dashboard", "save_metric"]
  )
  const args = {
    connection: "Shop",
    title: "Seed",
    statements: ["CREATE TABLE plan_c (id int)", "INSERT INTO plan_c VALUES (1)"],
  }
  const refused = await call("execute_plan", args)
  assert.equal(refused.isError, true)
  assert.match(text(refused), /not approved/)
  assert.equal(
    await count("select count(*) from information_schema.tables where table_name = 'plan_c'"),
    0
  )

  // As `deciding` grants it: the CLI's copy of the input, keys in any order.
  grants.add(
    grantKey("execute_plan", {
      statements: args.statements,
      title: "Seed",
      connection: "Shop",
    })
  )
  const ran = await call("execute_plan", args)
  assert.equal(ran.isError, undefined, text(ran))
  assert.match(text(ran), /"committed":true/)
  assert.equal(await count("select count(*) from plan_c"), 1)
  // Used up: the same call again is refused.
  assert.equal((await call("execute_plan", args)).isError, true)
})

await check("metrics and notes: approved, kept, and read back as context", async () => {
  const metric = {
    connection: "Shop",
    name: "Paid orders",
    description: "Orders whose status is paid or shipped.",
    sql: "SELECT count(*) FROM orders WHERE status IN ('paid', 'shipped')",
  }
  assert.equal((await call("save_metric", metric)).isError, true)
  grants.add(grantKey("save_metric", metric))
  assert.equal((await call("save_metric", metric)).isError, undefined)

  const note = { connection: "Shop", text: "- `status` is one of pending, paid, shipped, cancelled" }
  grants.add(grantKey("append_note", note))
  assert.equal((await call("append_note", note)).isError, undefined)

  const knowledge = library.knowledge(shop.id)
  assert.equal(knowledge.metrics.length, 1)
  assert.match(knowledge.notes, /pending, paid/)
  assert.ok(events.some((event) => event.type === "knowledge"))

  const context = text(await call("get_business_context", { connection: "Shop" }))
  assert.match(context, /### Paid orders/)
  assert.match(context, /status IN \('paid', 'shipped'\)/)
  assert.match(context, /pending, paid, shipped/)

  // The same name again replaces rather than duplicates.
  const changed = { ...metric, sql: "SELECT count(*) FROM orders WHERE status = 'paid'" }
  grants.add(grantKey("save_metric", changed))
  await call("save_metric", changed)
  assert.equal(library.knowledge(shop.id).metrics.length, 1)
  assert.match(library.knowledge(shop.id).metrics[0]!.sql, /status = 'paid'/)
})

await check("add_to_dashboard: creates, appends, checks, and opens", async () => {
  const first = await call("add_to_dashboard", {
    connection: "Shop",
    dashboard: "Sales",
    title: "Orders by status",
    sql: "select status, count(*) as orders from orders group by 1",
    chart: { type: "hbar", x: "status", y: ["orders"] },
  })
  assert.match(text(first), /Created dashboard "Sales"/)
  const second = await call("add_to_dashboard", {
    connection: "Shop",
    dashboard: "sales",
    title: "All orders",
    sql: "select count(*) as orders from orders",
    chart: { type: "stat", y: ["orders"] },
  })
  assert.match(text(second), /Added to dashboard "Sales".*2 tiles/)
  const broken = await call("add_to_dashboard", {
    connection: "Shop",
    dashboard: "Sales",
    title: "Broken",
    sql: "select * from nowhere",
  })
  assert.equal(broken.isError, true)

  const dashboards = library.dashboards()
  assert.equal(dashboards.length, 1)
  assert.deepEqual(dashboards[0]!.tiles.map((tile) => tile.title), ["Orders by status", "All orders"])

  await call("open_in_viewer", { connection: "Shop", dashboard: "Sales" })
  assert.deepEqual(opened.at(-1), {
    kind: "dashboard",
    connectionId: shop.id,
    dashboardId: dashboards[0]!.id,
  })
  assert.match(text(await call("get_business_context", { connection: "Shop" })), /- Sales \(id .*Orders by status, All orders/)
})

await check("the editor's helper gets the reading tools only", () => {
  const names = dbToolDefinitions(
    {
      connections,
      library,
      takeGrant: () => false,
      open: () => {},
      changed: () => {},
      chart: () => {},
    },
    "assist"
  ).map((item) => item.name)
  assert.deepEqual(names.sort(), [
    "describe_table",
    "get_business_context",
    "list_connections",
    "list_tables",
    "run_query",
  ])
})

// ── Dashboard filters as parameters ────────────────────────────────────────

await check("params: bound, never spliced; [[ … ]] dropped on All", () => {
  const sql =
    "SELECT * FROM orders WHERE true [[AND ordered_at >= {{date_start}}]] [[AND status = {{status}}]] AND note <> {{status}}"
  const bound = bindParameters(sql, { date_start: "2026-01-01", status: "paid" }, "postgres")
  assert.equal(
    bound.text,
    "SELECT * FROM orders WHERE true AND ordered_at >= $1 AND status = $2 AND note <> $2"
  )
  assert.deepEqual(bound.values, ["2026-01-01", "paid"])
  const mysql = bindParameters(sql, { date_start: null, status: "paid" }, "mysql")
  assert.equal(mysql.text, "SELECT * FROM orders WHERE true  AND status = ? AND note <> ?")
  assert.deepEqual(mysql.values, ["paid", "paid"])
  assert.throws(
    () => bindParameters("SELECT {{status}}", { status: null }, "postgres"),
    /has no value.*\[\[ … \]\]/
  )
  assert.throws(
    () => bindParameters("SELECT {{nope}}", { status: "x" }, "postgres"),
    /no filter for \{\{nope\}\}/
  )
})

await check("params: written in for a person, quoted per engine", () => {
  const evil = "x' OR '1'='1"
  assert.equal(
    inlineParameters("WHERE a = {{v}} [[AND b = {{w}}]]", { v: evil, w: null }, "postgres"),
    "WHERE a = 'x'' OR ''1''=''1' "
  )
  assert.equal(quoteLiteral("a\\' b", "mysql"), "'a\\\\'' b'")
})

await check("params: date presets in local time, end exclusive", () => {
  const today = new Date(2026, 10, 14) // 14 Nov 2026
  assert.deepEqual(dateRange("7d", null, null, today), { start: "2026-11-08", end: "2026-11-15" })
  assert.deepEqual(dateRange("12m", null, null, today), { start: "2025-12-01", end: "2026-11-15" })
  assert.deepEqual(dateRange("qtd", null, null, today), { start: "2026-10-01", end: "2026-11-15" })
  assert.deepEqual(dateRange("ytd", null, null, today), { start: "2026-01-01", end: "2026-11-15" })
  assert.deepEqual(dateRange("custom", "2026-02-01", "2026-02-28", today), { start: "2026-02-01", end: "2026-03-01" })
  assert.deepEqual(dateRange("all", null, null, today), { start: null, end: null })
  assert.deepEqual(
    filterValues(
      [
        { id: "a", kind: "date_range", name: "date", label: "Date", preset: "mtd", from: null, to: null },
        { id: "b", kind: "select", name: "status", label: "Status", optionsSql: "x", value: null },
      ],
      today
    ),
    { date_start: "2026-11-01", date_end: "2026-11-15", status: null }
  )
})

await check("driver: bound values reach the server as values", async () => {
  const bound = bindParameters(
    "SELECT count(*) FROM orders WHERE status = {{status}} [[AND ordered_at < {{date_end}}]]",
    { status: "paid' OR 'x'='x", date_end: null },
    "postgres"
  )
  const injected = await driver.query(bound.text, { readOnly: true, maxRows: 1, values: bound.values })
  assert.equal(injected.rows[0]![0], "0")
  const real = bindParameters("SELECT count(*) FROM orders WHERE status = {{status}}", { status: "paid" }, "postgres")
  const paid = await driver.query(real.text, { readOnly: true, maxRows: 1, values: real.values })
  assert.equal(paid.rows[0]![0], "375")
})

await check("params: lists, text, number ranges and toggles bound, never spliced", async () => {
  // A list, one placeholder per value; a name used twice bound once.
  const sql = "SELECT 1 WHERE a IN ({{s}}) AND b IN ({{s}}) [[AND c IN ({{none}})]]"
  assert.deepEqual(bindParameters(sql, { s: ["x", "y"], none: [] }, "postgres"), {
    text: "SELECT 1 WHERE a IN ($1, $2) AND b IN ($1, $2) ",
    values: ["x", "y"],
  })
  assert.deepEqual(bindParameters(sql, { s: ["x", "y"], none: [] }, "mysql").values, ["x", "y", "x", "y"])
  assert.equal(inlineParameters("a IN ({{s}})", { s: ["it's", "b"] }, "postgres"), "a IN ('it''s', 'b')")
  assert.equal(likePattern("50%_off", "contains"), "%50\\%\\_off%")
  assert.equal(likePattern("Ng", "starts"), "Ng%")
  assert.equal(likePattern("a%", "exact"), "a%")
  assert.equal(numberOrNull(" 1,200.5 "), "1200.5")
  assert.equal(numberOrNull("12abc"), null)
  const values = filterValues([
    { id: "1", kind: "multi_select", name: "st", label: "", optionsSql: "x", values: ["paid", "shipped"] },
    { id: "2", kind: "text", name: "q", label: "", match: "contains", value: " ann " },
    { id: "3", kind: "number_range", name: "qty", label: "", min: "2", max: "x" },
    { id: "4", kind: "toggle", name: "vip", label: "", value: true },
  ])
  assert.deepEqual(values, { st: ["paid", "shipped"], q: "%ann%", qty_min: "2", qty_max: null, vip: "1" })

  // And on a real server: each reaches it as a value of the right type.
  const run = async (text: string, params: Record<string, string | string[] | null>) => {
    const bound = bindParameters(text, params, "postgres")
    return Number((await driver.query(bound.text, { readOnly: true, maxRows: 1, values: bound.values })).rows[0]![0])
  }
  assert.equal(
    await run("SELECT count(*) FROM orders WHERE true [[AND status IN ({{st}})]]", { st: values.st! }),
    await count("SELECT count(*) FROM orders WHERE status IN ('paid', 'shipped')")
  )
  assert.equal(
    await run("SELECT count(*) FROM customers WHERE true [[AND name ILIKE {{q}}]]", { q: likePattern("an", "contains") }),
    await count("SELECT count(*) FROM customers WHERE name ILIKE '%an%'")
  )
  assert.equal(
    await run("SELECT count(*) FROM order_items WHERE true [[AND quantity >= {{qty_min}}]] [[AND quantity <= {{qty_max}}]]", { qty_min: "2", qty_max: null }),
    await count("SELECT count(*) FROM order_items WHERE quantity >= 2")
  )
  assert.equal(
    await run("SELECT count(*) FROM customers WHERE true [[AND vip = {{vip}}]]", { vip: "1" }),
    await count("SELECT count(*) FROM customers WHERE vip")
  )
  assert.equal(await run("SELECT count(*) FROM customers WHERE true [[AND vip = {{vip}}]]", { vip: null }), await count("SELECT count(*) FROM customers"))
})

// ── New chart forms ────────────────────────────────────────────────────────

await check("chart: long results widen into series, in a stable order", () => {
  const long = {
    columns: [txt("month"), txt("channel"), num("revenue")],
    rows: [
      ["2026-01", "web", "10"],
      ["2026-01", "store", "5"],
      ["2026-02", "web", "12"],
      ["2026-02", "app", "1"],
    ],
  }
  assert.deepEqual(inferChart(long), { type: "line", x: "month", y: ["revenue"], series: "channel" })
  const wide = widen(long, "month", "channel", "revenue")
  assert.deepEqual(wide.labels, ["2026-01", "2026-02"])
  assert.deepEqual(wide.names, ["app", "store", "web"])
  assert.deepEqual(wide.values, [[null, 1], [5, null], [10, 12]])
  const many = {
    columns: [txt("x"), txt("s"), num("v")],
    rows: Array.from({ length: 10 }, (_, i) => ["a", `s${i}`, String(i + 1)]),
  }
  const folded = widen(many, "x", "s", "v")
  assert.equal(folded.names.length, 8)
  assert.equal(folded.names.at(-1), "Other")
  assert.deepEqual(folded.values.at(-1), [1 + 2 + 3])
})

await check("chart: KPI, pivot, table and stacking are checked", () => {
  const one = { columns: [num("now"), num("before")], rows: [["120", "100"]] }
  assert.equal(chartProblem({ type: "kpi", x: null, y: ["now"], compare: "before" }, one), null)
  assert.match(chartProblem({ type: "kpi", x: null, y: ["now"] }, { ...one, rows: [["1", "2"], ["3", "4"]] })!, /reads one row/)
  assert.match(chartProblem({ type: "pivot", x: "status", y: ["orders"] }, byStatus)!, /needs x .* and series/)
  assert.equal(chartProblem({ type: "table", x: null, y: [] }, byStatus), null)
  assert.match(chartProblem({ type: "line", x: "status", y: ["orders"], stacked: true }, byStatus)!, /cannot be stacked/)
  assert.match(chartProblem({ type: "bar", x: "month", y: ["orders", "ids"], series: "month" }, monthly)!, /one value/)
})

// ── Dashboard tools ────────────────────────────────────────────────────────

await check("dashboard tools: filters first, then tiles that use them", async () => {
  await call("add_to_dashboard", { connection: "Shop", dashboard: "Ops", title: "Intro", text: "## Orders" })
  const noOptions = await call("add_dashboard_filter", {
    connection: "Shop", dashboard: "Ops", kind: "select", name: "status", label: "Status",
  })
  assert.equal(noOptions.isError, true)
  const date = await call("add_dashboard_filter", {
    connection: "Shop", dashboard: "Ops", kind: "date_range", name: "date", label: "Ordered", preset: "all",
  })
  assert.match(text(date), /\{\{date_start\}\} and \{\{date_end\}\}/)
  await call("add_dashboard_filter", {
    connection: "Shop", dashboard: "Ops", kind: "select", name: "status", label: "Status",
    options_sql: "SELECT DISTINCT status FROM orders ORDER BY 1",
  })

  // The other kinds: checked and kept by the library as it saves them.
  for (const [kind, extra] of [
    ["multi_select", { options_sql: "SELECT DISTINCT status FROM orders" }],
    ["text", { match: "starts" }],
    ["number_range", {}],
    ["toggle", {}],
  ] as const) {
    const added = await call("add_dashboard_filter", {
      connection: "Shop", dashboard: "Ops", kind, name: `k_${kind}`, label: kind, ...extra,
    })
    assert.equal(added.isError, undefined, text(added))
  }
  const opsNow = library.dashboards().find((item) => item.title === "Ops")!
  const kinds = Object.fromEntries(opsNow.filters.map((filter) => [filter.kind, filter]))
  assert.deepEqual((kinds.multi_select as { values: string[] }).values, [])
  assert.equal((kinds.text as { match: string }).match, "starts")
  assert.match(text(await call("add_dashboard_filter", { connection: "Shop", dashboard: "Ops", kind: "number_range", name: "k_number_range", label: "x" })), /k_number_range_min\}\} and \{\{k_number_range_max/)
  assert.throws(
    () => library.saveDashboard({ ...opsNow, filters: [...opsNow.filters, { id: "", kind: "multi_select", name: "z", label: "", optionsSql: " ", values: [] }] }),
    /needs a query/
  )
  library.saveDashboard({ ...opsNow, filters: opsNow.filters.filter((filter) => !filter.name.startsWith("k_")) })

  const unguarded = await call("add_to_dashboard", {
    connection: "Shop", dashboard: "Ops", title: "Bad",
    sql: "SELECT count(*) AS n FROM orders WHERE status = {{status}}",
  })
  assert.equal(unguarded.isError, true)
  assert.match(text(unguarded), /has no value/)

  const tile = await call("add_to_dashboard", {
    connection: "Shop", dashboard: "Ops", title: "Orders", width: 1, height: "s",
    sql: "SELECT count(*) AS orders FROM orders WHERE true [[AND status = {{status}}]] [[AND ordered_at >= {{date_start}}]]",
    chart: { type: "kpi", y: ["orders"] },
    drill_sql: "SELECT * FROM orders WHERE status = {{value}} LIMIT 50",
  })
  assert.equal(tile.isError, undefined, text(tile))
  const shown = await call("show_chart", {
    connection: "Shop", sql: "SELECT count(*) AS n FROM orders [[WHERE status = {{status}}]]",
    title: "x", type: "stat", y: ["n"],
  })
  assert.match(text(shown), /only work in a dashboard tile/)

  const ops = library.dashboards().find((item) => item.title === "Ops")!
  assert.deepEqual(ops.filters.map((filter) => filter.name), ["date", "status"])
  assert.equal(ops.tiles[0]!.text, "## Orders")
  assert.equal(ops.tiles[1]!.width, 1)
  assert.equal(ops.tiles[1]!.height, "s")
  // Unsaid, a heading is short rather than a 320px block of nothing.
  assert.equal(ops.tiles[0]!.height, "s")
  assert.match(ops.tiles[1]!.drillSql!, /\{\{value\}\}/)

  const read = text(await call("get_dashboard", { connection: "Shop", dashboard: "ops" }))
  assert.match(read, /Status \(select, \{\{status\}\}\), now: All/)
  assert.match(read, /"type":"kpi"/)
  assert.match(read, /drill-down: SELECT \* FROM orders WHERE status = \{\{value\}\}/)
})

await check("library: filter names are parameters, and unique", () => {
  const ops = library.dashboards().find((item) => item.title === "Ops")!
  assert.throws(
    () => library.saveDashboard({ ...ops, filters: [...ops.filters, { ...ops.filters[0]!, id: "", name: "date" }] }),
    /Two filters would both be \{\{date_start\}\}/
  )
  assert.throws(
    () => library.saveDashboard({ ...ops, filters: [{ ...ops.filters[0]!, name: "bad name" }] }),
    /cannot be a filter name/
  )
  assert.throws(
    () => library.saveDashboard({ ...ops, tiles: [{ id: "", title: "x", sql: " ", chart: null }] }),
    /needs SQL, or text/
  )
})

await check("dashboard tools: a tile edited in place and moved; removals and deletion wait for a yes", async () => {
  const add = (args: Record<string, unknown>) =>
    call("add_to_dashboard", { connection: "Shop", dashboard: "Scratch", ...args })
  await add({ title: "", text: "## Head" })
  await add({ title: "Orders", sql: "SELECT count(*) AS orders FROM orders", chart: { type: "stat", y: ["orders"] } })
  await add({ title: "By status", sql: "SELECT status, count(*) AS n FROM orders GROUP BY 1", chart: { type: "bar", x: "status", y: ["n"] } })
  await call("add_dashboard_filter", {
    connection: "Shop", dashboard: "Scratch", kind: "select", name: "status", label: "Status",
    options_sql: "SELECT DISTINCT status FROM orders",
  })
  const scratch = () => library.dashboards().find((item) => item.title === "Scratch")!
  const id = scratch().tiles[2]!.id

  // By number, as get_dashboard lists them: chart dropped, made wide, moved first.
  const edited = await call("edit_dashboard_tile", {
    connection: "Shop", dashboard: "Scratch", tile: "3",
    title: "Orders by status", as_table: true, width: 4, move_to: 1,
    sql: "SELECT status, count(*) AS n FROM orders WHERE true [[AND status = {{status}}]] GROUP BY 1",
  })
  assert.equal(edited.isError, undefined, text(edited))
  assert.match(text(edited), /now tile 1/)
  const first = scratch().tiles[0]!
  assert.equal(first.id, id)
  assert.equal(first.title, "Orders by status")
  assert.equal(first.chart, null)
  assert.equal(first.width, 4)
  assert.equal(scratch().tiles.length, 3)

  // By title; a chart that does not fit the rows is refused and nothing changes.
  const misfit = await call("edit_dashboard_tile", {
    connection: "Shop", dashboard: "Scratch", tile: "orders", chart: { type: "line", x: "nope", y: ["orders"] },
  })
  assert.equal(misfit.isError, true)
  assert.equal(scratch().tiles[2]!.chart?.type, "stat")
  const textTile = await call("edit_dashboard_tile", { connection: "Shop", dashboard: "Scratch", tile: "2", sql: "SELECT 1" })
  assert.match(text(textTile), /text tile/)
  const missing = await call("edit_dashboard_tile", { connection: "Shop", dashboard: "Scratch", tile: "Revenue", title: "x" })
  assert.match(text(missing), /No tile "Revenue".*1\. "Orders by status"/)

  const renamed = await call("edit_dashboard", { connection: "Shop", dashboard: "Scratch", title: "Scratchpad", refresh_seconds: 300 })
  assert.match(text(renamed), /every 5 min/)
  const pad = () => library.dashboards().find((item) => item.title === "Scratchpad")!
  assert.equal(pad().refreshSeconds, 300)
  assert.match(text(await call("edit_dashboard", { connection: "Shop", dashboard: "Scratchpad", title: "ops" })), /already a dashboard "Ops"/)

  // Not approved: nothing is removed.
  const unasked = { connection: "Shop", dashboard: "Scratchpad", filter: "status" }
  assert.match(text(await call("remove_from_dashboard", unasked)), /not approved/)
  assert.equal(pad().filters.length, 1)
  grants.add(grantKey("remove_from_dashboard", unasked))
  const gone = text(await call("remove_from_dashboard", unasked))
  assert.match(gone, /still read \{\{status\}\}.*"Orders by status"/)
  assert.equal(pad().filters.length, 0)

  const tileArgs = { connection: "Shop", dashboard: "Scratchpad", tile: "Orders" }
  grants.add(grantKey("remove_from_dashboard", tileArgs))
  assert.match(text(await call("remove_from_dashboard", tileArgs)), /Removed "Orders".*2 tiles/)

  const del = { connection: "Shop", dashboard: "Scratchpad" }
  assert.match(text(await call("delete_dashboard", del)), /not approved/)
  grants.add(grantKey("delete_dashboard", del))
  const before = events.length
  assert.match(text(await call("delete_dashboard", del)), /Deleted the dashboard "Scratchpad"/)
  assert.equal(library.dashboards().some((item) => item.title === "Scratchpad"), false)
  assert.ok(events.slice(before).some((event) => event.type === "dashboard_deleted"))
})

await check("structure: indexes, constraints, keys pointing in, size, comments and DDL", async () => {
  const write = (sql: string) => driver.query(sql, { readOnly: false, maxRows: 1 })
  await write(`CREATE TABLE shelf (
    id serial PRIMARY KEY,
    code text NOT NULL UNIQUE,
    price numeric CONSTRAINT price_positive CHECK (price >= 0),
    note text
  )`)
  await write(`CREATE TABLE shelf_item (
    id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shelf_id int CONSTRAINT item_shelf REFERENCES shelf(id) ON DELETE CASCADE,
    qty int DEFAULT 1
  )`)
  await write("CREATE INDEX shelf_item_qty ON shelf_item (qty)")
  await write("COMMENT ON TABLE shelf IS 'Where things sit'")
  await write("COMMENT ON COLUMN shelf.code IS 'Printed on the label'")

  const shelf = await driver.details({ schema: "public", table: "shelf" })
  assert.equal(shelf.kind, "table")
  assert.equal(shelf.comment, "Where things sit")
  assert.deepEqual(shelf.columnComments, { code: "Printed on the label" })
  assert.ok((shelf.totalBytes ?? 0) > 0)
  assert.deepEqual(
    shelf.constraints.map((key) => [key.kind, key.name, key.columns.join(",")]),
    [["primary", "shelf_pkey", "id"], ["unique", "shelf_code_key", "code"], ["check", "price_positive", "price"]]
  )
  assert.match(shelf.constraints[2]!.definition, /CHECK \(price >= 0/)
  assert.deepEqual(shelf.indexes.map((index) => [index.name, index.primary, index.unique, index.columns.join(",")]), [
    ["shelf_pkey", true, true, "id"],
    ["shelf_code_key", false, true, "code"],
  ])
  assert.deepEqual(shelf.referencedBy, [
    { name: "item_shelf", schema: "public", table: "shelf_item", columns: ["shelf_id"], referencedColumns: ["id"] },
  ])
  assert.match(shelf.ddl, /CREATE TABLE "public"."shelf" \(/)
  assert.match(shelf.ddl, /"id" integer DEFAULT nextval\('shelf_id_seq'::regclass\) NOT NULL/)
  assert.match(shelf.ddl, /CONSTRAINT "price_positive" CHECK/)
  assert.match(shelf.ddl, /COMMENT ON COLUMN "public"."shelf"."code" IS 'Printed on the label';/)
  // The unique constraint's index is the constraint's: not written twice.
  assert.doesNotMatch(shelf.ddl, /CREATE UNIQUE INDEX/)

  const item = await driver.details({ schema: "public", table: "shelf_item" })
  const fk = item.constraints.find((key) => key.kind === "foreign")!
  assert.deepEqual(fk.references, {
    schema: "public", table: "shelf", columns: ["id"], onDelete: "cascade", onUpdate: "no action",
  })
  assert.match(item.ddl, /"id" integer GENERATED ALWAYS AS IDENTITY,/)
  assert.match(item.ddl, /CREATE INDEX shelf_item_qty ON public.shelf_item USING btree \(qty\);/)
  assert.deepEqual(item.indexes.find((index) => index.name === "shelf_item_qty")?.method, "btree")

  await write("CREATE VIEW cheap_shelf AS SELECT id, code FROM shelf WHERE price < 10")
  const view = await driver.details({ schema: "public", table: "cheap_shelf" })
  assert.equal(view.kind, "view")
  assert.match(view.ddl, /^CREATE VIEW "public"."cheap_shelf" AS\n[\s\S]*price < /)
  assert.equal(view.totalBytes, null)

  await assert.rejects(driver.details({ schema: "public", table: "nope" }), /No table or view/)
  await write("DROP VIEW cheap_shelf")
  await write("DROP TABLE shelf_item")
  await write("DROP TABLE shelf")
})

await check("audit log: kept as lines, read back after a restart, trimmed, cleared", () => {
  const where = mkdtempSync(path.join(tmpdir(), "veydata-audit-"))
  const heard: ChatEvent[] = []
  const log = new AuditLog(where, (event) => heard.push(event))
  log.record({ actor: "you", action: "write", connectionId: "c1", connectionName: "Shop", summary: "Ran a statement", sql: "DELETE FROM t WHERE id = 1", status: "ok", rows: 1 })
  log.record({ actor: "assistant", action: "query", connectionId: "c1", connectionName: "Shop", summary: "Ran a query", status: "refused", detail: "x".repeat(5000) })
  assert.equal(heard.filter((event) => event.type === "audit").length, 2)
  const again = new AuditLog(where).list()
  assert.deepEqual(again.map((entry) => entry.summary), ["Ran a query", "Ran a statement"])
  assert.ok(again[0]!.detail!.length <= 2001)
  // A line cut short by a crash is skipped, not fatal.
  writeFileSync(path.join(where, "audit.jsonl"), `${JSON.stringify(again[1])}\n{"id":"half`)
  assert.equal(new AuditLog(where).list().length, 1)
  const many = new AuditLog(where)
  for (let i = 0; i < AUDIT_KEEP * 1.1 + 5; i++) {
    many.record({ actor: "you", action: "query", connectionId: null, connectionName: null, summary: `q${i}`, status: "ok" })
  }
  const kept = new AuditLog(where).list()
  assert.ok(kept.length <= AUDIT_KEEP * 1.1 && kept.length >= AUDIT_KEEP, String(kept.length))
  assert.equal(kept[0]!.summary, `q${Math.floor(AUDIT_KEEP * 1.1 + 4)}`)
  many.clear()
  assert.equal(new AuditLog(where).list().length, 0)
  rmSync(where, { recursive: true, force: true })

  assert.equal(describeChanges({ schema: "public", table: "orders", updates: [{ key: { id: "1" }, values: {} }], inserts: [], deletes: [{ id: "2" }, { id: "3" }] }), "1 updated, 2 deleted in public.orders")
  assert.ok(refusal('Refused by the permissions of "Shop": DELETE is blocked.'))
  assert.ok(refusal("The user turned execute_sql off in Settings › Tools."))
  assert.ok(!refusal('relation "nope" does not exist'))
})

await check("audit log: the assistant's calls are kept with how they ended", () => {
  const where = mkdtempSync(path.join(tmpdir(), "veydata-audit-chat-"))
  const log = new AuditLog(where)
  const chats = new Chats(where, connections, library, () => {}, log)
  const keep = (item: Record<string, unknown>) =>
    (chats as unknown as { keep(chat: { id: string }, item: unknown): void }).keep({ id: "chat-1" }, { kind: "tool", id: "t", output: null, ...item })
  keep({ tool: "list_tables", input: { connection: "Shop" }, status: "done", output: "orders" })
  keep({ tool: "execute_sql", input: { connection: "Shop", sql: "DELETE FROM orders WHERE id = 1" }, status: "done", output: "1 row affected" })
  keep({ tool: "execute_sql", input: { connection: "shop", sql: "DELETE FROM orders" }, status: "error", output: 'Refused by the permissions of "Shop": no WHERE.' })
  keep({ tool: "execute_plan", input: { connection: "Shop", title: "Seed", statements: ["INSERT 1", "INSERT 2"] }, status: "denied", output: "The user declined this." })
  keep({ tool: "run_query", input: { connection: "Shop", sql: "SELECT nope" }, status: "error", output: "column does not exist" })
  const entries = log.list().reverse()
  // Reading the schema is not kept; the rest is, each as it ended.
  assert.deepEqual(entries.map((entry) => [entry.tool, entry.action, entry.status]), [
    ["execute_sql", "write", "ok"],
    ["execute_sql", "write", "refused"],
    ["execute_plan", "plan", "declined"],
    ["run_query", "query", "failed"],
  ])
  assert.ok(entries.every((entry) => entry.actor === "assistant" && entry.chatId === "chat-1" && entry.connectionId === shop.id))
  assert.equal(entries[2]!.summary, "Ran a plan: Seed (2 steps)")
  assert.equal(entries[2]!.sql, "INSERT 1;\n\nINSERT 2")
  rmSync(where, { recursive: true, force: true })
})

await check("chat: a tool call is on screen while its input is written, then whole", async () => {
  const { readPartialJson } = await import("../src/shared/agent")
  assert.deepEqual(readPartialJson('{"connection": "Shop", "sql": "INSERT INTO t VALUES\\n(1, \'Wire'), {
    connection: "Shop",
    sql: "INSERT INTO t VALUES\n(1, 'Wire",
  })
  assert.deepEqual(readPartialJson('{"connection": "Shop", "sq'), { connection: "Shop" })
  assert.deepEqual(readPartialJson('{"statements": ["A", "B'), { statements: ["A", "B"] })
  assert.deepEqual(readPartialJson('{"sql": "a \\u00'), { sql: "a " })

  const where = mkdtempSync(path.join(tmpdir(), "veydata-writing-"))
  const seen: ChatEvent[] = []
  const chats = new Chats(where, connections, library, (event) => seen.push(event))
  const chat = { id: "c-w", title: "", items: [] as ChatItemT[], sessionId: null, updatedAt: 0 }
  const live = { streamed: new Set(), streamingMessage: null, streamingItem: null, writingTool: null, approvals: new Map(), grants: new Set() }
  const read = (message: unknown) =>
    (chats as unknown as { read(chat: unknown, live: unknown, message: unknown): void }).read(chat, live, message)
  const stream = (event: unknown) => read({ type: "stream_event", parent_tool_use_id: null, event })
  stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "mcp__db__execute_sql", input: {} } })
  assert.equal(chat.items.length, 1)
  assert.deepEqual([chat.items[0]!.kind, (chat.items[0] as { writing?: boolean }).writing], ["tool", true])
  stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"connection": "Shop", "sql": "INSERT INTO t' } })
  assert.equal((chat.items[0] as { input: { sql?: string } }).input.sql, "INSERT INTO t")
  stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' VALUES (1)"}' } })
  stream({ type: "content_block_stop", index: 1 })
  assert.equal((chat.items[0] as { input: { sql?: string } }).input.sql, "INSERT INTO t VALUES (1)")
  // The whole message: the input as sent, and no longer being written.
  read({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "mcp__db__execute_sql", input: { connection: "Shop", sql: "INSERT INTO t VALUES (1)" } }] },
  })
  assert.equal(chat.items.length, 1)
  assert.equal((chat.items[0] as { writing?: boolean }).writing, false)
  assert.ok(seen.filter((event) => event.type === "item").length >= 3)
  rmSync(where, { recursive: true, force: true })
})

// ── Access modes ───────────────────────────────────────────────────────────

await check("access: saved per connection, read & write when never set", () => {
  assert.equal(shop.access, "read_write")
  const careful = connections.save(shop.id, { ...shop, access: "confirm" })
  assert.equal(careful.access, "confirm")
  // An edit that does not mention access keeps it.
  const { access: _unsaid, ...input } = careful
  assert.equal(connections.save(shop.id, input).access, "confirm")
  connections.save(shop.id, { ...shop, access: "read_write" })
})

await check("connections: a colour is kept, cleared, and never invented", () => {
  assert.equal(shop.color, null)
  assert.equal(connections.save(shop.id, { ...shop, color: "red" }).color, "red")
  // An edit that does not mention it keeps it.
  const { color: _unsaid, ...input } = connections.get(shop.id)
  assert.equal(connections.save(shop.id, input).color, "red")
  assert.equal(connections.save(shop.id, { ...shop, color: "plaid" as never }).color, null)
  assert.equal(connections.save(shop.id, { ...shop, color: null }).color, null)
})

await check("access: a read-only connection refuses every write from the UI", async () => {
  connections.save(shop.id, { ...shop, access: "read_only" })
  try {
    await assert.rejects(
      runUserQuery(connections, shop.id, "DELETE FROM audit_log", false),
      /"Shop" is read-only in Vey Data/
    )
    await assert.rejects(
      runUserQuery(connections, shop.id, "/* sneaky */ set default_transaction_read_only = off", false),
      /read-only in Vey Data/
    )
    await assert.rejects(
      applyUserChanges(connections, shop.id, {
        schema: "public", table: "audit_log", updates: [], inserts: [{ message: "x" }], deletes: [],
      }),
      /read-only in Vey Data/
    )
    // A write hidden in a CTE starts like a read, and meets the read-only transaction.
    await assert.rejects(
      runUserQuery(connections, shop.id, "WITH gone AS (DELETE FROM audit_log RETURNING 1) SELECT count(*) FROM gone", false),
      /read-only transaction/
    )
    const read = await runUserQuery(connections, shop.id, "select count(*) from audit_log", false)
    assert.equal(read.rows[0]![0], "2")
  } finally {
    connections.save(shop.id, { ...shop, access: "read_write" })
  }
})

await check("access: confirm and read & write let the UI write", async () => {
  connections.save(shop.id, { ...shop, access: "confirm" })
  try {
    const made = await runUserQuery(connections, shop.id, "CREATE TABLE access_ok (id int)", false)
    assert.equal(made.columns.length, 0)
  } finally {
    connections.save(shop.id, { ...shop, access: "read_write" })
  }
})

await check("access: the assistant cannot write to a read-only connection", async () => {
  connections.save(shop.id, { ...shop, access: "read_only" })
  try {
    assert.match(text(await call("list_connections", {})), /Shop .*READ-ONLY/)
    const args = { connection: "Shop", sql: "DELETE FROM audit_log" }
    grants.add(grantKey("execute_sql", args))
    const refused = await call("execute_sql", args)
    assert.equal(refused.isError, true)
    assert.match(text(refused), /read-only in Vey Data/)
    const plan = { connection: "Shop", title: "x", statements: ["DELETE FROM audit_log"] }
    grants.add(grantKey("execute_plan", plan))
    assert.match(text(await call("execute_plan", plan)), /read-only in Vey Data/)
    assert.equal(await count("select count(*) from audit_log"), 2)
    // Reads are untouched.
    assert.equal((await call("run_query", { connection: "Shop", sql: "select 1 as one" })).isError, undefined)
  } finally {
    connections.save(shop.id, { ...shop, access: "read_write" })
  }
})

// ── Permissions ────────────────────────────────────────────────────────────

const pg = { engine: "postgres" as const, defaultSchema: "public" }
const allow = checkPermissions(undefined)

await check("permissions: statements read for what they do and which tables they touch", () => {
  const refs = (sql: string) =>
    tokenize(sql, "postgres").flatMap((tokens) =>
      referencesIn(tokens, "public").map((ref) => `${ref.schema}.${ref.table}${ref.written ? "*" : ""}`)
    )
  const kinds = (sql: string) => tokenize(sql, "postgres").map(classify)
  assert.deepEqual(refs('SELECT * FROM orders o JOIN "Shop".customers c ON true, items i'), ["public.orders", "Shop.customers", "public.items"])
  assert.deepEqual(kinds("WITH gone AS (DELETE FROM audit_log RETURNING 1) SELECT * FROM gone"), ["delete"])
  assert.deepEqual(refs("WITH gone AS (DELETE FROM audit_log RETURNING 1) SELECT * FROM gone"), ["public.audit_log*"])
  assert.deepEqual(kinds("SELECT * FROM orders FOR UPDATE; INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 1"), ["read", "insert"])
  assert.deepEqual(kinds("EXPLAIN ANALYZE DELETE FROM orders; EXPLAIN DELETE FROM orders"), ["delete", "read"])
  assert.deepEqual(kinds("COPY orders FROM stdin; COPY (SELECT 1) TO stdout; CALL refresh(); BEGIN"), ["insert", "read", "other", "session"])
  assert.deepEqual(refs("SELECT extract(year FROM ordered_at) FROM orders WHERE note = 'from secrets'"), ["public.orders"])
  assert.deepEqual(refs("DROP TABLE IF EXISTS a, b; TRUNCATE logs; ALTER TABLE x.y ADD c int"), ["public.a*", "public.b*", "public.logs*", "x.y*"])
  // A ';' in a string is not the end of a statement.
  assert.deepEqual(kinds("INSERT INTO t VALUES ('a;b'); SELECT 1"), ["insert", "read"])
})

await check("permissions: blocked, asked and allowed, the access mode the floor", () => {
  const strict = checkPermissions({
    statements: { ddl: "block", delete: "ask" },
    objects: [
      { schema: "public", table: null, access: "read" },
      { schema: "public", table: "notes", access: "write" },
      { schema: "public", table: "secrets", access: "hidden" },
    ],
    guards: { requireWhere: true },
  })
  const on = (sql: string, access: "read_write" | "confirm" | "read_only" = "read_write") =>
    judge(sql, { permissions: strict, access, ...pg })
  assert.equal(on("DROP TABLE x.y").rule, "block")
  assert.match(on("DROP TABLE x.y").reasons[0]!, /Change the schema is blocked/)
  assert.equal(on("DELETE FROM x.y WHERE id = 1").rule, "ask")
  assert.equal(on("INSERT INTO x.y VALUES (1)").rule, "allow")
  assert.equal(on("INSERT INTO x.y VALUES (1)", "confirm").rule, "ask")
  assert.equal(on("INSERT INTO x.y VALUES (1)", "read_only").rule, "block")
  // The schema is read-only; the table set writable inside it is not.
  assert.match(on("UPDATE orders SET note = '' WHERE id = 1").reasons.join(), /public.orders is read-only/)
  assert.equal(on("UPDATE notes SET body = '' WHERE id = 1").rule, "allow")
  assert.match(on("SELECT * FROM secrets").reasons.join(), /public.secrets is hidden/)
  assert.match(on("UPDATE x.y SET a = 1").reasons.join(), /without WHERE/)
  // Something it cannot read the effect of takes the strictest rule.
  assert.equal(on("CALL do_things()").rule, "block")
  assert.equal(on("SELECT 1; BEGIN; SET search_path = x").rule, "allow")
  const edits = judgeChanges(
    { schema: "public", table: "orders", updates: [], inserts: [{}], deletes: [] },
    { permissions: strict, access: "read_write" }
  )
  assert.equal(edits.rule, "block")
  assert.deepEqual(visibleTree(strict, [{ name: "public", tables: [{ name: "secrets", kind: "table" }, { name: "orders", kind: "table" }] }]), [
    { name: "public", tables: [{ name: "orders", kind: "table" }] },
  ])
  // Junk is dropped, numbers made whole and positive, duplicates kept once.
  const odd = checkPermissions({
    statements: { insert: "maybe" },
    objects: [{ schema: "a", table: "", access: "read" }, { schema: "A", table: null, access: "hidden" }, { schema: "", access: "read" }],
    guards: { maxAffected: 2.7, timeoutSeconds: -1, maxRows: "5" },
  })
  assert.equal(odd.statements.insert, "allow")
  assert.deepEqual(odd.objects, [{ schema: "a", table: null, access: "read" }])
  assert.deepEqual(odd.guards, { requireWhere: false, maxAffected: 2, timeoutSeconds: null, maxRows: null })
  assert.deepEqual(allow, DEFAULT_PERMISSIONS)
})

await check("permissions: kept per connection, and through an edit of it", () => {
  assert.deepEqual(connections.get(shop.id).permissions, DEFAULT_PERMISSIONS)
  const set = connections.setPermissions(shop.id, { ...allow, statements: { ...allow.statements, ddl: "block" } })
  assert.equal(set.permissions.statements.ddl, "block")
  assert.equal(connections.save(shop.id, { ...shop, name: "Shop" }).permissions.statements.ddl, "block")
  const again = new Connections(path.join(dir, "connections.json"), { encrypt: () => null, decrypt: () => null })
  assert.equal(again.get(shop.id).permissions.statements.ddl, "block")
  connections.setPermissions(shop.id, allow)
})

await check("permissions: a hidden table is gone from the tree and refused everywhere", async () => {
  connections.setPermissions(shop.id, { ...allow, objects: [{ schema: "public", table: "audit_log", access: "hidden" }] })
  try {
    const guarded = connections.driver(shop.id)
    const names = (await guarded.tree()).flatMap((schema) => schema.tables.map((table) => `${schema.name}.${table.name}`))
    assert.ok(!names.includes("public.audit_log") && names.includes("public.orders"), names.join())
    assert.ok((await guarded.allObjects()).some((schema) => schema.tables.some((table) => table.name === "audit_log")))
    await assert.rejects(runUserQuery(connections, shop.id, "select * from audit_log", true), /audit_log is hidden/)
    await assert.rejects(guarded.table({ schema: "public", table: "audit_log" }), /hidden/)
    await assert.rejects(guarded.rows({ schema: "public", table: "audit_log", filters: [], sort: null, limit: 10, offset: 0 }), /hidden/)
    await assert.rejects(guarded.explain("select * from audit_log"), /hidden/)
    assert.match(text(await call("run_query", { connection: "Shop", sql: "SELECT count(*) FROM public.audit_log" })), /hidden/)
    assert.match(text(await call("describe_table", { connection: "Shop", tables: ["audit_log"] })), /hidden|not found|No table/i)
    assert.doesNotMatch(text(await call("list_tables", { connection: "Shop" })), /audit_log/)
  } finally {
    connections.setPermissions(shop.id, allow)
  }
})

await check("permissions: a blocked kind, a read-only table and a missing WHERE are refused", async () => {
  await driver.query("CREATE TABLE perm_rows (id int PRIMARY KEY, n int)", { readOnly: false, maxRows: 1 })
  await driver.query("INSERT INTO perm_rows SELECT g, 0 FROM generate_series(1, 5) g", { readOnly: false, maxRows: 1 })
  connections.setPermissions(shop.id, {
    statements: { ...allow.statements, ddl: "block" },
    objects: [{ schema: "public", table: "orders", access: "read" }],
    guards: { ...allow.guards, requireWhere: true },
  })
  try {
    await assert.rejects(runUserQuery(connections, shop.id, "CREATE TABLE nope (id int)", false), /Change the schema is blocked.*Settings › Permissions/)
    await assert.rejects(runUserQuery(connections, shop.id, "UPDATE orders SET note = 'x' WHERE id = 1", false), /orders is read-only/)
    await assert.rejects(
      applyUserChanges(connections, shop.id, { schema: "public", table: "orders", updates: [], inserts: [], deletes: [{ id: "1" }] }),
      /orders is read-only/
    )
    await assert.rejects(runUserQuery(connections, shop.id, "UPDATE perm_rows SET n = 1", false), /without WHERE/)
    const one = await runUserQuery(connections, shop.id, "UPDATE perm_rows SET n = 1 WHERE id = 1", false)
    assert.equal(one.affected, 1)
    // The assistant meets the same, with its approval in hand.
    const args = { connection: "Shop", sql: "DROP TABLE perm_rows" }
    grants.add(grantKey("execute_sql", args))
    assert.match(text(await call("execute_sql", args)), /Change the schema is blocked/)
    const plan = { connection: "Shop", title: "x", statements: ["UPDATE perm_rows SET n = 2 WHERE id = 2", "DELETE FROM perm_rows"] }
    grants.add(grantKey("execute_plan", plan))
    assert.match(text(await call("execute_plan", plan)), /without WHERE/)
    assert.equal(await count("select count(*) from perm_rows where n = 2"), 0)
  } finally {
    connections.setPermissions(shop.id, allow)
  }
})

await check("permissions: a write past the row limit is rolled back; reads are capped", async () => {
  connections.setPermissions(shop.id, { ...allow, guards: { ...allow.guards, maxAffected: 2, maxRows: 3 } })
  try {
    await assert.rejects(runUserQuery(connections, shop.id, "UPDATE perm_rows SET n = 9", false), /change 5 rows, more than the 2.*rolled back/)
    // A script: counted across its statements, and taken back whole.
    await assert.rejects(
      runUserQuery(connections, shop.id, "UPDATE perm_rows SET n = 9 WHERE id = 1; UPDATE perm_rows SET n = 9 WHERE id IN (2, 3)", false),
      /more than the 2/
    )
    assert.equal(await count("select count(*) from perm_rows where n = 9"), 0)
    const plan = { connection: "Shop", title: "x", statements: ["UPDATE perm_rows SET n = 9 WHERE id <= 2", "UPDATE perm_rows SET n = 9 WHERE id = 3"] }
    grants.add(grantKey("execute_plan", plan))
    assert.match(text(await call("execute_plan", plan)), /more than the 2/)
    assert.equal(await count("select count(*) from perm_rows where n = 9"), 0)
    const two = await runUserQuery(connections, shop.id, "UPDATE perm_rows SET n = 9 WHERE id <= 2", false)
    assert.equal(two.affected, 2)
    await assert.rejects(
      applyUserChanges(connections, shop.id, { schema: "public", table: "perm_rows", updates: [], inserts: [], deletes: [{ id: "3" }, { id: "4" }, { id: "5" }] }),
      /3 rows would change, more than the 2/
    )
    const capped = await runUserQuery(connections, shop.id, "select * from perm_rows", true)
    assert.equal(capped.rows.length, 3)
    assert.equal(capped.truncated, true)
  } finally {
    connections.setPermissions(shop.id, allow)
  }
})

await check("permissions: the guard hands its limits to the driver", async () => {
  const seen: unknown[] = []
  const inner = {
    query: async (_sql: string, options: unknown) => (seen.push(options), { columns: [], rows: [], truncated: false, affected: 0, command: null, ms: 0 }),
    runPlan: async (_statements: string[], limits: unknown) => (seen.push(limits), []),
  } as unknown as Driver
  const permissions = checkPermissions({ guards: { timeoutSeconds: 3, maxAffected: 10, maxRows: 50 } })
  const guarded = new GuardedDriver(inner, () => ({ name: "x", engine: "postgres", database: "", access: "read_write", permissions }))
  await guarded.query("select 1", { readOnly: true, maxRows: 2000, timeoutMs: 60_000 })
  await guarded.query("update t set a = 1 where b", { readOnly: false, maxRows: 20 })
  await guarded.runPlan(["delete from t where a"])
  assert.deepEqual(seen, [
    { readOnly: true, maxRows: 50, timeoutMs: 3000 },
    { readOnly: false, maxRows: 20, timeoutMs: 3000, maxAffected: 10 },
    { maxAffected: 10, timeoutMs: 3000 },
  ])
})

// ── Library ────────────────────────────────────────────────────────────────

await check("library: survives a restart and refuses bad metrics", () => {
  const again = new Library(dir, () => {})
  assert.equal(again.knowledge(shop.id).metrics.length, 1)
  assert.equal(again.dashboards().length, 2)
  assert.throws(
    () =>
      again.saveKnowledge(shop.id, {
        notes: "",
        metrics: [
          { id: "", name: "A", description: "", sql: "select 1" },
          { id: "", name: "a", description: "", sql: "select 2" },
        ],
        updatedAt: 0,
      }),
    /two metrics named/
  )
  assert.throws(
    () =>
      again.saveKnowledge(shop.id, {
        notes: "",
        metrics: [{ id: "", name: "B", description: "", sql: " " }],
        updatedAt: 0,
      }),
    /needs its SQL/
  )
  again.forget(shop.id)
  assert.equal(new Library(dir, () => {}).dashboards().length, 0)
})

await check("skills: saved, unique, and only enabled ones reach the agent", async () => {
  const report = library.saveSkill({
    id: null,
    name: "Weekly report",
    description: "When asked for a weekly sales summary",
    instructions: "Use Net revenue. Compare with last year.",
    enabled: true,
  })
  assert.throws(
    () => library.saveSkill({ ...report, id: null, name: "weekly REPORT" }),
    /already a skill named/
  )
  assert.throws(
    () => library.saveSkill({ ...report, id: null, name: "X", description: " " }),
    /when to use it/
  )
  assert.match(
    text(await call("get_skill", { name: "weekly report" })),
    /Compare with last year/
  )

  library.saveSkill({ ...report, enabled: false })
  const off = await call("get_skill", { name: "Weekly report" })
  assert.equal(off.isError, true)
  assert.match(text(off), /Enabled: Build a dashboard/)
  const own = () => new Library(dir, () => {}).skills().filter((item) => !item.builtin)
  assert.equal(own()[0]?.enabled, false)

  library.deleteSkill(report.id)
  assert.equal(own().length, 0)
})

await check("skills: built-in ones are listed, edited, reset, never deleted", async () => {
  const dashboard = library.skills().find((item) => item.id === "builtin:dashboard")!
  assert.equal(dashboard.builtin, true)
  assert.equal(dashboard.modified, false)
  assert.match(text(await call("get_skill", { name: "build a dashboard" })), /Filters first/)

  const edited = library.saveSkill({
    ...dashboard,
    name: "Renamed",
    instructions: "Only KPI tiles.",
    enabled: false,
  })
  assert.equal(edited.name, "Build a dashboard")
  assert.equal(edited.modified, true)
  assert.equal((await call("get_skill", { name: "Build a dashboard" })).isError, true)
  assert.throws(
    () => library.saveSkill({ ...dashboard, id: null, name: "build a DASHBOARD" }),
    /already a skill named/
  )
  assert.throws(() => library.deleteSkill(dashboard.id), /not deleted/)

  const reset = new Library(dir, () => {}).resetSkill(dashboard.id)
  assert.equal(reset.modified, false)
  assert.equal(reset.enabled, false)
  assert.match(reset.instructions, /Filters first/)
  library.saveSkill({ ...reset, enabled: true })
})

await check("tools: modes are checked, and a write can never be allowed", () => {
  assert.equal(library.toolMode("execute_sql"), "ask")
  assert.throws(() => library.setToolMode("execute_sql", "allow"), /cannot be set/)
  assert.throws(() => library.setToolMode("list_tables", "off"), /cannot be set/)
  assert.throws(() => library.setToolMode("drop_everything", "off"), /no tool/)
  library.setToolMode("show_chart", "off")
  library.setToolMode("save_metric", "allow")
  const again = new Library(dir, () => {})
  assert.equal(again.toolMode("show_chart"), "off")
  assert.equal(again.toolMode("save_metric"), "allow")
  // Back to the default is not stored at all.
  assert.deepEqual(library.setToolMode("show_chart", "allow"), { save_metric: "allow" })
  library.setToolMode("save_metric", "ask")
})

await check("tools: every tool the agent has is in the catalogue", () => {
  const names = tools.map((item) => item.name).sort()
  assert.deepEqual(TOOL_CATALOG.map((item) => item.name).sort(), names)
})

await check("grid formats: tags, links, references, digits — and nothing guessed", () => {
  const text = (name: string, type = "text") => ({ name, type, kind: "text" as const })
  const statuses = ["paid", "paid", "refunded", "pending", "paid", "pending", null]
  assert.equal(detectFormat(text("status"), statuses).kind, "tag")
  // Every value different: not a set of labels.
  assert.equal(detectFormat(text("name"), ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"]).kind, "plain")
  // A code column repeats too, but is an identifier.
  assert.equal(detectFormat(text("country_code"), ["VN", "VN", "JP", "JP", "VN", "JP"]).kind, "plain")
  assert.equal(detectFormat(text("contact"), ["a@x.io", "b@y.com", "c@z.vn"]).kind, "email")
  assert.equal(detectFormat(text("site"), ["https://a.io", "http://b.com/x"]).kind, "url")
  assert.equal(detectFormat(text("state", "enum('on','off')"), []).kind, "tag")
  assert.equal(
    detectFormat({ name: "total", type: "numeric(10,2)", kind: "number" }, ["1.5"]).kind,
    "decimal"
  )
  assert.equal(detectFormat({ name: "qty", type: "integer", kind: "number" }, ["1"]).kind, "plain")
  assert.equal(detectFormat({ name: "active", type: "tinyint(1)", kind: "number" }, ["1"]).kind, "bool")
  assert.deepEqual(
    detectFormat({ name: "customer_id", type: "int", kind: "number", references: "customers" }, ["1"]),
    { kind: "reference", table: "customers" }
  )

  assert.deepEqual(
    referencesOf([
      "orders_customer_id_fkey: FOREIGN KEY (customer_id) REFERENCES public.customers(id)",
      "fk_item: FOREIGN KEY (order_id) REFERENCES shop.orders(id)",
      "fk_pair: FOREIGN KEY (a, b) REFERENCES t(a, b)",
    ]),
    { customer_id: "customers", order_id: "orders" }
  )

  assert.equal(groupDigits("1234567.8900"), "1,234,567.8900")
  assert.equal(groupDigits("-1000"), "-1,000")
  assert.equal(groupDigits("12.5"), "12.5")
  assert.equal(groupDigits("1e10"), "1e10")
  assert.equal(tagTone("paid"), tagTone("paid"))
})

await check("field settings: checked, kept per table, migrated, and cleared", () => {
  const ref = { schema: "public", table: "orders" }
  assert.deepEqual(library.tableFields(shop.id, ref), { fields: {}, displayColumn: null })
  library.setFieldSettings(shop.id, ref, "total", {
    display: { type: "currency", code: "vnd", locale: "vi-vn", decimals: 0, abbreviate: "auto" },
    description: "  Net of refunds  ",
  })
  library.setFieldSettings(shop.id, ref, "status", {
    display: { type: "select", colors: { paid: "green", odd: "plaid" as never } },
  })
  library.setDisplayColumn(shop.id, ref, "status")
  const again = new Library(dir, () => {})
  assert.deepEqual(again.tableFields(shop.id, ref), {
    fields: {
      total: {
        display: { type: "currency", code: "VND", locale: "vi-VN", decimals: 0, abbreviate: "auto" },
        description: "Net of refunds",
      },
      status: { display: { type: "select", colors: { paid: "green" } } },
    },
    displayColumn: "status",
  })
  assert.throws(
    () => library.setFieldSettings(shop.id, ref, "x", { display: { type: "rating", max: 99, icon: "star", color: "amber" } }),
    /from 1 to 10/
  )
  assert.throws(
    () => library.setFieldSettings(shop.id, ref, "x", { display: { type: "date", format: "YYYY-MM-DD", time: "none", hour12: false, timezone: "Mars/Olympus" } }),
    /not a time zone/
  )
  assert.throws(
    () => library.setFieldSettings(shop.id, ref, "x", { display: { type: "script" } as never }),
    /not a way/
  )
  // Unknown options fall back to NocoDB's defaults rather than being stored.
  assert.deepEqual(
    checkFieldDisplay({ type: "checkbox", icon: "skull", color: "plaid" } as never),
    { type: "checkbox", icon: "check", color: "blue" }
  )
  // Shapes an earlier version saved are read into the current ones.
  assert.deepEqual(checkFieldDisplay({ type: "number", decimals: 2, thousands: false } as never), {
    type: "number", decimals: 2, separator: "none-period", abbreviate: "none",
  })
  assert.deepEqual(checkFieldDisplay({ type: "date", style: "datetime" } as never), {
    type: "date", format: "locale", time: "HH:mm", hour12: false, timezone: "local",
  })
  library.setFieldSettings(shop.id, ref, "total", null)
  library.setFieldSettings(shop.id, ref, "status", { description: "" })
  library.setDisplayColumn(shop.id, ref, null)
  assert.deepEqual(new Library(dir, () => {}).tableFields(shop.id, ref), { fields: {}, displayColumn: null })
})

await check("field settings: library.json from the earlier shape is migrated", () => {
  const old = mkdtempSync(path.join(tmpdir(), "veydata-old-"))
  writeFileSync(
    path.join(old, "library.json"),
    JSON.stringify({ fieldDisplays: { c1: { '["public","t"]': { amount: { type: "number", decimals: null, thousands: true } } } } })
  )
  assert.deepEqual(new Library(old, () => {}).tableFields("c1", { schema: "public", table: "t" }), {
    fields: { amount: { display: { type: "number", decimals: null, separator: "locale", abbreviate: "none" } } },
    displayColumn: null,
  })
  rmSync(old, { recursive: true, force: true })
})

await check("field settings: numbers, money, percent, dates and durations as NocoDB writes them", () => {
  assert.equal(formatNumber("1234567.891", 2, "comma-period"), "1,234,567.89")
  assert.equal(formatNumber("1234567.891", 2, "period-comma"), "1.234.567,89")
  assert.equal(formatNumber("1234567.891", 1, "space-comma"), "1\u00a0234\u00a0567,9")
  assert.equal(formatNumber("1234567", null, "none-period"), "1234567")
  assert.equal(formatNumber("1234567", 1, "comma-period", "auto"), "1.2M")
  assert.equal(formatNumber("1500", 1, "comma-period", "thousand"), "1.5K")
  assert.equal(formatNumber("999", 1, "comma-period", "auto"), "999.0")
  // Past a float's precision: grouped as text, never rounded.
  assert.equal(formatNumber("12345678901234567890", 0, "comma-period"), "12,345,678,901,234,567,890")
  assert.equal(formatCurrency("1234.5", "USD", "en-US", 2), "$1,234.50")
  assert.equal(formatCurrency("1250000", "USD", "en-US", 2, "auto"), "$1.25M")
  assert.match(formatCurrency("1234", "VND", "vi-VN", 0), /^1\.234\s?₫$/)
  assert.equal(formatCurrency("n/a", "USD", "en-US", 2), "n/a")
  assert.match(formatPercent("75", 0, "whole"), /^75\s?%$/)
  assert.match(formatPercent("0.75", 1, "fraction"), /^75\.0\s?%$/)
  assert.equal(formatDate("2026-11-14 09:05:07", "DD/MM/YYYY", "HH:mm"), "14/11/2026 09:05")
  assert.equal(formatDate("2026-11-14", "dddd YYYY-MM-DD"), "Saturday 2026-11-14")
  assert.equal(formatDate("2026-11-14 21:05:07", "DD MMM YY", "HH:mm:ss", true), "14 Nov 26 9:05:07 PM")
  // With a zone, moved into the one picked; without, shown as stored.
  assert.equal(formatDate("2026-11-14 23:30:00+00", "YYYY-MM-DD", "HH:mm", false, "Asia/Ho_Chi_Minh"), "2026-11-15 06:30")
  assert.equal(formatDate("2026-11-14 23:30:00", "YYYY-MM-DD", "HH:mm", false, "Asia/Ho_Chi_Minh"), "2026-11-14 23:30")
  assert.equal(formatDate("2026-11-14 10:20:00", "iso"), "2026-11-14 10:20:00")
  const now = Date.parse("2026-11-17T10:20:00Z")
  assert.match(formatDate("2026-11-14T10:20:00Z", "relative", "none", false, "local", now), /3 days ago/)
  assert.equal(formatDate("garbage", "YYYY-MM-DD"), "garbage")
  assert.equal(formatDuration("3725", "seconds", "h:mm:ss"), "1:02:05")
  assert.equal(formatDuration("3725", "seconds", "h:mm"), "1:02")
  assert.equal(formatDuration("90", "minutes", "h:mm"), "1:30")
  assert.equal(formatDuration("3725.25", "seconds", "h:mm:ss.ss"), "1:02:05.25")
  assert.deepEqual(splitValues("{red,\"dark blue\"}"), ["red", "dark blue"])
  assert.deepEqual(splitValues('["a","b"]'), ["a", "b"])
  assert.deepEqual(splitValues("a, b ,c"), ["a", "b", "c"])
  assert.equal(cssColour("ff0000"), "#ff0000")
  assert.equal(cssColour("red; background: url(x)"), null)
})

await check("chat history: an answer's start as one plain line", () => {
  assert.equal(
    plainPreview("Doanh thu **tăng** từ `12,000`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [Xem](https://x.io)"),
    "Doanh thu tăng từ 12,000. Xem"
  )
  assert.equal(plainPreview("```sql\nselect 1\n```\nDone."), "Done.")
  assert.equal(plainPreview("x".repeat(200), 20).length, 20)
})

await check("dashboard: a text tile's \\n written as two characters is a line break", () => {
  assert.equal(tileText("Key Figures\\nOverview of orders."), "Key Figures\nOverview of orders.")
  // Real breaks present: the text means what it says, `\\n` in code included.
  assert.equal(tileText("## Notes\nUse `\\n` to split."), "## Notes\nUse `\\n` to split.")
  assert.equal(tileText("Plain"), "Plain")
})

await check("assist: the structured answer, or the reply's SQL block", () => {
  assert.deepEqual(readAnswer({ sql: " select 1 ", text: "One." }, ""), {
    sql: "select 1",
    text: "One.",
  })
  assert.deepEqual(readAnswer({ sql: null, text: "Explained." }, ""), {
    sql: null,
    text: "Explained.",
  })
  assert.deepEqual(readAnswer(undefined, "Here:\n```sql\nselect 2;\n```\nDone."), {
    sql: "select 2;",
    text: "Here:\n```sql\nselect 2;\n```\nDone.",
  })
})

await driver.close()

// The server's own lock, apart from the app's: a driver for a read-only
// connection opens sessions that refuse to write even when asked plainly.
// Last, on its own, since the sample database serves one session at a time.
const lockedDriver = new PostgresDriver(
  {
    engine: "postgres", host: "in-process", port: 5432, user: "postgres",
    password: "postgres", database: "postgres", ssl: "off", access: "read_only",
  },
  { stream: sample.stream }
)
await check("access: a read-only connection's driver refuses writes, and asks the server to", async () => {
  await assert.rejects(
    lockedDriver.query("CREATE TABLE server_lock (id int)", { readOnly: false, maxRows: 1 }),
    /read-only in Vey Data/
  )
  // A write that starts like a read meets a read-only transaction instead.
  await assert.rejects(
    lockedDriver.query("WITH gone AS (DELETE FROM audit_log RETURNING 1) SELECT 1", { readOnly: false, maxRows: 1 }),
    /read-only transaction/
  )
  await assert.rejects(lockedDriver.runPlan(["DELETE FROM audit_log"]), /read-only in Vey Data/)
  await assert.rejects(
    lockedDriver.apply({ schema: "public", table: "audit_log", updates: [], inserts: [{ message: "x" }], deletes: [] }),
    /read-only in Vey Data/
  )
  // And the session itself is asked to be read-only by the server. PGlite
  // ignores startup parameters, so here it is the request that is checked.
  assert.equal(
    (lockedDriver as unknown as { pool: { options: { options?: string } } }).pool.options.options,
    "-c default_transaction_read_only=on"
  )
  const read = await lockedDriver.query("select count(*) from audit_log", { readOnly: false, maxRows: 1 })
  assert.equal(read.rows[0]![0], "2")
})
await check("mentions: @ finds tables, dashboards, metrics and connections, and says what each is", async () => {
  const m = await import("../src/shared/mentions")
  const { describeMentions } = await import("../src/main/chats")
  const sources = {
    connection: { id: "c1", name: "Shop", engine: "postgres" },
    connections: [
      { id: "c1", name: "Shop", engine: "postgres" },
      { id: "c2", name: "warehouse", engine: "mysql" },
    ],
    schemas: [
      { name: "public", tables: [{ name: "orders", kind: "table" as const }, { name: "items", kind: "table" as const }, { name: "daily", kind: "view" as const }] },
      { name: "archive", tables: [{ name: "items", kind: "table" as const }] },
    ],
    dashboards: [
      { id: "d1", connectionId: "c1", title: "Sales overview", tiles: [1, 2] },
      { id: "d2", connectionId: "c9", title: "Elsewhere", tiles: [] },
    ],
    metrics: [{ id: "m1", name: "revenue", description: "Paid orders\nmore", sql: "sum(total)" }],
  }
  const targets = m.mentionTargets(sources)
  // A unique table goes by its name; two that share one go by schema.
  assert.deepEqual(
    targets.map((t) => `${t.kind}:${t.token}`),
    ["table:orders", "table:public.items", "table:archive.items", "view:daily", 'dashboard:"Sales overview"', "metric:revenue", "connection:warehouse"]
  )
  assert.equal(targets[0]!.detail, "public · table")
  assert.equal(targets.find((t) => t.kind === "metric")!.detail, "Paid orders")

  // Typing: where the @ starts, through a quote.
  assert.deepEqual(m.mentionQuery("look at @ord", 12), { from: 8, filter: "ord" })
  assert.deepEqual(m.mentionQuery('see @"Sales ov', 14), { from: 4, filter: "Sales ov" })
  assert.equal(m.mentionQuery("mail me@example.com", 19), null)
  assert.equal(m.mentionQuery("@orders and", 11), null)
  assert.deepEqual(m.mentionQuery("@", 1), { from: 0, filter: "" })

  // Picking: the name goes in with a space after it, not two.
  assert.deepEqual(m.insertMention("look at @ord", { from: 8, filter: "ord" }, 12, "orders"), { text: "look at @orders ", caret: 16 })
  assert.deepEqual(m.insertMention("@ord now", { from: 0, filter: "ord" }, 4, "orders"), { text: "@orders now", caret: 7 })
  assert.deepEqual(m.insertMention('@"Sal"', { from: 0, filter: "Sal" }, 5, '"Sales overview"'), { text: '@"Sales overview" ', caret: 18 })

  // Ranking: starts-with first; nothing typed shows some of each kind.
  assert.equal(m.rankMentions(targets, "sal")[0]!.kind, "dashboard")
  assert.deepEqual(m.rankMentions(targets, "rev").map((t) => t.name), ["revenue"])
  assert.equal(m.rankMentions(targets, "ware")[0]!.kind, "connection")
  assert.deepEqual(new Set(m.rankMentions(targets, "").map((t) => t.kind)), new Set(["table", "view", "dashboard", "metric", "connection"]))

  // Reading a message: case and a full stop do not matter; an email does not count.
  const text = 'Compare @Orders with @"Sales overview", @public.orders and @archive.items. Mail a@b.com @nothing'
  const found = m.findMentions(text, targets)
  assert.deepEqual(found.map((f) => `${f.token}→${f.ref.kind}:${f.ref.schema ?? ""}.${f.ref.name}`), [
    "@Orders→table:public.orders",
    '@"Sales overview"→dashboard:.Sales overview',
    "@archive.items→table:archive.items",
  ])
  const segments = m.markMentions("x @orders.", targets)
  assert.deepEqual(segments.map((s) => [s.text, s.target?.kind ?? null]), [["x ", null], ["@orders", "table"], [".", null]])
  assert.deepEqual(m.markMentions("", targets), [{ text: "", target: null }])

  // And main says what each one is, looked up again.
  library.saveKnowledge(shop.id, { notes: "", metrics: [{ id: "", name: "revenue", description: "Paid orders", sql: "sum(total)" }], updatedAt: 0 })
  const metric = library.knowledge(shop.id).metrics[0]!
  const board = library.saveDashboard({ id: "", connectionId: shop.id, title: "Sales overview", tiles: [{ id: "", title: "Orders", sql: "select 1", chart: null }], filters: [], refreshSeconds: 0, updatedAt: 0 })
  const lines = describeMentions(
    [
      { token: "@orders", ref: { kind: "table", connectionId: shop.id, name: "orders", schema: "public" } },
      { token: '@"Sales overview"', ref: { kind: "dashboard", connectionId: shop.id, name: "Sales overview", id: board.id } },
      { token: "@revenue", ref: { kind: "metric", connectionId: shop.id, name: "revenue", id: metric.id } },
      { token: "@Shop", ref: { kind: "connection", connectionId: shop.id, name: "Shop" } },
      { token: "@old", ref: { kind: "dashboard", connectionId: shop.id, name: "old", id: "gone" } },
      { token: "@x", ref: { kind: "table", connectionId: "nope", name: "x" } },
    ],
    connections,
    library
  )
  assert.equal(lines[0], `- @orders → table public.orders on connection Shop (id ${shop.id})`)
  assert.match(lines[1]!, new RegExp(`dashboard "Sales overview" \\(id ${board.id}\\).*tiles: Orders`))
  assert.match(lines[2]!, /metric "revenue".*: Paid orders\n  computed as: sum\(total\)/)
  assert.match(lines[3]!, /connection Shop .*use it for this request/)
  assert.match(lines[4]!, /deleted/)
  assert.match(lines[5]!, /no longer exists/)
  library.deleteDashboard(board.id)
  library.saveKnowledge(shop.id, { notes: "", metrics: [], updatedAt: 0 })
})
await check("chat images: [Image #n] tags, kept as files, sent as image blocks", async () => {
  const ci = await import("../src/shared/chat-images")
  const { Inbox } = await import("../src/main/chats")
  const a = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" }
  const b = { mediaType: "image/jpeg" as const, data: "/9j/4AAQ" }

  // Renumbered in the order the text names them; a tag naming nothing is text.
  assert.deepEqual(ci.attachedIn("see [Image #2] and [Image #1] [Image #2] [Image #9]", [a, b]), {
    text: "see [Image #1] and [Image #2] [Image #1] [Image #9]",
    images: [b, a],
  })
  // The first one deleted: the second goes alone, as #1.
  assert.deepEqual(ci.attachedIn("only [Image #2]", [a, b]), { text: "only [Image #1]", images: [b] })
  assert.deepEqual(ci.namedIn("x [Image #2]", [a, b]), [{ n: 2, image: b }])
  assert.equal(ci.withoutTag("look [Image #1] here [Image #2]", 1), "look here [Image #2]")
  assert.equal(ci.imageProblem(a), null)
  assert.match(ci.imageProblem({ mediaType: "image/tiff", data: "AAAA" })!, /not a picture/)
  assert.match(ci.imageProblem({ mediaType: "image/png", data: "not base64!" })!, /base64/)
  assert.match(ci.imageProblem({ mediaType: "image/png", data: "A".repeat(ci.MAX_IMAGE_BASE64 + 4) })!, /5 MB/)

  // What the CLI is handed: the words, then each picture in order.
  const inbox = new Inbox()
  inbox.push("plain")
  inbox.push("two [Image #1] [Image #2]", [a, b])
  inbox.close()
  const sent = []
  for await (const message of inbox.stream()) sent.push(message.message.content)
  assert.equal(sent[0], "plain")
  assert.deepEqual(sent[1], [
    { type: "text", text: "two [Image #1] [Image #2]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: a.data } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.data } },
  ])

  // Through `send`, with the session stubbed: the line keeps file names, the
  // files hold the bytes, and deleting the chat takes them too.
  const where = mkdtempSync(path.join(tmpdir(), "veydata-images-"))
  const chats = new Chats(where, connections, library, () => {})
  const pushed: { text: string; images: unknown[] }[] = []
  ;(chats as unknown as { open: () => Promise<unknown> }).open = async () => ({
    interrupted: false,
    inbox: { push: (text: string, images: unknown[] = []) => pushed.push({ text, images }) },
  })
  const chat = chats.create()
  const context = { connectionId: null, tab: null }
  await chats.send({ chatId: chat.id, text: "what is this? [Image #1]", images: [a], context, model: null, effort: null })
  assert.deepEqual(pushed[0]!.images, [a])
  assert.match(pushed[0]!.text, /what is this\? \[Image #1\]$/)
  const line = chats.get(chat.id)!.items[0]!
  assert.equal(line.kind, "user")
  const names = (line as { images?: string[] }).images!
  assert.equal(names.length, 1)
  assert.match(names[0]!, /^[0-9a-f-]{36}\.png$/)
  assert.equal(chats.image(names[0]!), `data:image/png;base64,${a.data}`)
  // Only a name it gave out is read.
  assert.equal(chats.image("../connections.json"), null)
  assert.equal(chats.image(`../chats/${chat.id}.json`), null)

  // A picture that cannot go is refused before anything is said.
  ;(chats as unknown as { busy: Set<string> }).busy.clear()
  const other = chats.create()
  await assert.rejects(
    chats.send({ chatId: other.id, text: "[Image #1]", images: [{ mediaType: "image/tiff", data: "AAAA" } as never], context, model: null, effort: null }),
    /Image #1: .*not a picture/
  )
  assert.equal(chats.get(other.id)!.items.length, 0)

  chats.delete(chat.id)
  assert.equal(chats.image(names[0]!), null)
  rmSync(where, { recursive: true, force: true })
})

await lockedDriver.close()
await sample.close()
rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
