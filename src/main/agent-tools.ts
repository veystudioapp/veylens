import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import {
  CHART_TYPES,
  DATE_PRESETS,
  FILTER_KINDS,
  isTextTile,
  MAX_SERIES,
  TEXT_MATCHES,
  tileText,
  type Dashboard,
  type DashboardFilter,
  type ParamValues,
  type ChartSpec,
  type ChatItem,
  type Connection,
  type TreeSchema,
  type ViewerTarget,
} from "../shared/api"
import { addressOf } from "../shared/address"
import { chartProblem } from "../shared/chart"
import {
  bindParameters,
  filterParams,
  filterValueLabel,
  filterValues,
  hasParameters,
} from "../shared/params"
import type { Connections } from "./connections"
import { assertReadOnly } from "./db/sql"
import type { Library } from "./library"

/** The name the tools are served under: `mcp__db__run_query`, and so on. */
export const TOOL_SERVER = "db"
export const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`

/**
 * The tools that change something the user owns — the database, or what they
 * wrote down about it — and so wait for the user's yes first.
 */
export const APPROVAL_TOOLS = new Set([
  "execute_sql",
  "execute_plan",
  "save_metric",
  "append_note",
  "remove_from_dashboard",
  "delete_dashboard",
])

/**
 * The approval tools that change the database. Whatever Settings says, these
 * are always put to the user first: `allow` is not a mode they can take.
 */
export const WRITE_TOOLS = new Set(["execute_sql", "execute_plan"])

/** JSON with its keys in order, so the same call reads the same both times. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** What an approval is for: this tool, with exactly these arguments. */
export const grantKey = (tool: string, args: unknown) =>
  `${tool}:${stable(args)}`

export type ChartItem = Omit<Extract<ChatItem, { kind: "chart" }>, "id" | "kind">

/** What the tools need from whoever is serving them. */
export type ToolHost = {
  connections: Connections
  library: Library
  /**
   * Whether the user approved exactly this call, used up by asking. The
   * approval card is raised by the CLI's permission prompt; this is the lock
   * that holds whatever the CLI has been configured to skip.
   */
  takeGrant(tool: string, args: unknown): boolean
  open(target: ViewerTarget): void
  changed(connectionId: string): void
  chart(item: ChartItem): void
}

/**
 * `chat` is everything; `assist` — the one-shot helper behind the SQL editor
 * — is the reading half: it looks, it does not show, change or remember.
 */
export type ToolScope = "chat" | "assist"

/** How a connection's access reads to the model, after its description. */
const ACCESS_NOTE: Record<Connection["access"], string> = {
  read_write: "",
  confirm: " — every change is confirmed by the user",
  read_only: " — READ-ONLY: no changes of any kind",
}

const DEFAULT_ROWS = 100
const MAX_ROWS = 500
/** One cell, as the model sees it. The viewer shows the whole value. */
const CELL_LIMIT = 400
/** A result past this many characters loses rows from the end until it fits. */
const RESULT_LIMIT = 60_000
const QUERY_TIMEOUT_MS = 30_000
const TABLE_LIST_LIMIT = 500
/** Rows a chart is drawn from. Past it, the SQL should aggregate. */
const CHART_ROWS = 500

type ToolResult = {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })

const fail = (error: unknown): ToolResult => ({
  content: [
    { type: "text", text: error instanceof Error ? error.message : String(error) },
  ],
  isError: true,
})

const clip = (value: string | null): string | null =>
  value !== null && value.length > CELL_LIMIT
    ? `${value.slice(0, CELL_LIMIT)}…`
    : value

/** A result as the JSON both the model and the chat's result table read. */
function resultJson(result: {
  columns: { name: string }[]
  rows: (string | null)[][]
  truncated: boolean
}): string {
  const rows = result.rows.map((row) => row.map(clip))
  let truncated = result.truncated
  const render = () =>
    JSON.stringify({
      columns: result.columns.map((column) => column.name),
      rows,
      row_count: rows.length,
      truncated,
    })
  let text = render()
  while (text.length > RESULT_LIMIT && rows.length > 1) {
    rows.length = Math.max(1, Math.floor(rows.length / 2))
    truncated = true
    text = render()
  }
  return text
}

export function createDbTools(host: ToolHost, scope: ToolScope = "chat") {
  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: dbToolDefinitions(host, scope),
  })
}

/** The tools themselves, apart from the server that serves them: what the
 * tests call directly. */
export function dbToolDefinitions(host: ToolHost, scope: ToolScope = "chat") {
  /** By id, or by name — the model is shown both and uses either. */
  const resolve = (reference: string): Connection => {
    const all = host.connections.list()
    const found =
      all.find((connection) => connection.id === reference) ??
      all.find(
        (connection) =>
          connection.name.toLowerCase() === reference.trim().toLowerCase()
      )
    if (found) return found
    throw new Error(
      all.length
        ? `No connection "${reference}". Available: ${all.map((connection) => `${connection.name} (id ${connection.id})`).join(", ")}.`
        : "No connections are set up yet. Ask the user to add one in the Explorer."
    )
  }

  /** The schema a bare table name lives in, when only one has it. */
  const locate = (tree: TreeSchema[], table: string, schema?: string) => {
    if (schema) return { schema, table }
    const holders = tree.filter((entry) =>
      entry.tables.some((item) => item.name === table)
    )
    if (holders.length === 1) return { schema: holders[0]!.name, table }
    throw new Error(
      holders.length === 0
        ? `No table or view named "${table}". Call list_tables to see what exists.`
        : `"${table}" exists in several schemas (${holders.map((entry) => entry.name).join(", ")}). Pass schema.`
    )
  }

  const connection = z
    .string()
    .describe("The connection's id or name, from list_connections.")

  const chartFields = {
    type: z
      .enum(CHART_TYPES)
      .describe(
        "bar: columns per category or period. hbar: ranked horizontal bars — use it for part-to-whole or many/long categories (there is no pie). line: change over time. area: one series over time. stat: the single number a one-row result is. kpi: a headline figure with its change — either one row with the value and the previous period's value (compare), or rows per period (x) whose last row is now, drawn with a sparkline. pivot: a matrix of y[0] with x as rows and series as columns, shaded by size. table: the rows, with the y columns shaded by size. scatter: one measure (y[0]) against another (x, numeric), a dot per row, optionally coloured by series — for how two measures relate. funnel: ordered steps (x, one row per step, in order) with y[0] the count reaching each — for conversion. waterfall: a bridge — the first row is the starting figure, each row after it a signed change (x names it), and the end total is drawn after them; do not include the total row yourself. progress: y[0] against its target column (target) — one row for a headline, or a row per category (x) each against its own target."
      ),
    x: z
      .string()
      .optional()
      .describe("The category or time column (a pivot's rows; a kpi's period; a funnel's or waterfall's steps; a scatter's horizontal measure). Omit for stat, table, a one-row kpi and a one-row progress."),
    y: z
      .array(z.string())
      .max(MAX_SERIES)
      .describe(
        "Numeric columns, one series each, all in the same unit — never two scales on one chart; make two charts instead. With series, exactly one."
      ),
    series: z
      .string()
      .optional()
      .describe("For a result in long form (GROUP BY month, channel): the column whose values become the series — one line or bar per channel. A pivot's columns. The column colouring a scatter's dots."),
    stacked: z
      .boolean()
      .optional()
      .describe("bar, hbar, area: stack the series, for parts of a whole."),
    compare: z
      .string()
      .optional()
      .describe("kpi with one row: the column with the previous period's value."),
    target: z
      .string()
      .optional()
      .describe("progress: the column holding the goal y[0] is measured against (a fixed goal is a literal in the SQL: 50000 AS target)."),
    up_is_good: z
      .boolean()
      .optional()
      .describe("kpi, progress, waterfall: false when a rise is bad news (costs, churn, refunds) — a progress then reads as a budget, a waterfall colours rises as bad."),
  }

  type ChartArgs = {
    type: ChartSpec["type"]
    x?: string
    y: string[]
    series?: string
    stacked?: boolean
    compare?: string
    target?: string
    up_is_good?: boolean
  }

  const specOf = (args: ChartArgs): ChartSpec => ({
    type: args.type,
    x: args.x ?? null,
    y: args.y,
    ...(args.series ? { series: args.series } : {}),
    ...(args.stacked ? { stacked: true } : {}),
    ...(args.compare ? { compare: args.compare } : {}),
    ...(args.target ? { target: args.target } : {}),
    ...(args.up_is_good === false ? { upIsGood: false } : {}),
  })

  const engineOf = (connectionId: string) =>
    host.connections.list().find((item) => item.id === connectionId)?.engine ??
    "postgres"

  /**
   * The query a chart or a tile is drawn from, run and checked against it —
   * with a dashboard's filters at their current values, for a tile.
   */
  const chartData = async (
    connectionId: string,
    sql: string,
    spec: ChartSpec | null,
    params?: ParamValues
  ) => {
    if (!params && hasParameters(sql)) {
      throw new Error(
        "{{parameters}} and [[ … ]] only work in a dashboard tile, where the dashboard's filters fill them in."
      )
    }
    const bound = params
      ? bindParameters(sql, params, engineOf(connectionId))
      : { text: sql, values: [] }
    const result = await host.connections.driver(connectionId).query(bound.text, {
      readOnly: true,
      maxRows: CHART_ROWS,
      timeoutMs: QUERY_TIMEOUT_MS,
      values: bound.values,
    })
    const problem = spec && chartProblem(spec, result)
    if (problem) throw new Error(problem)
    return result
  }

  /** A dashboard of this connection, by id or title, or why there is none. */
  const dashboardOf = (target: Connection, reference: string): Dashboard => {
    const found = host.library.findDashboard(target.id, reference)
    if (!found) throw new Error(`No dashboard "${reference}" on ${target.name}.`)
    if (found.connectionId !== target.id) {
      throw new Error(`"${found.title}" belongs to another connection.`)
    }
    return found
  }

  /** A tile of a dashboard by its number in get_dashboard, its id or its title. */
  const tileIndexOf = (dashboard: Dashboard, reference: string): number => {
    const needle = reference.trim().replace(/^#/, "")
    const byId = dashboard.tiles.findIndex((tile) => tile.id === needle)
    if (byId >= 0) return byId
    if (/^\d+$/.test(needle)) {
      const number = Number(needle)
      if (number >= 1 && number <= dashboard.tiles.length) return number - 1
    }
    const titled = dashboard.tiles.flatMap((tile, index) =>
      tile.title.trim().toLowerCase() === needle.toLowerCase() ? [index] : []
    )
    if (titled.length === 1) return titled[0]!
    if (titled.length > 1) {
      throw new Error(`Several tiles are titled "${reference}"; pass its number from get_dashboard.`)
    }
    const listed = dashboard.tiles
      .map((tile, index) => `${index + 1}. ${tileName(tile)}`)
      .join("; ")
    throw new Error(
      `No tile "${reference}" on "${dashboard.title}". Its tiles: ${listed || "none"}.`
    )
  }

  const tileName = (tile: Dashboard["tiles"][number]) =>
    isTextTile(tile)
      ? `text "${(tile.text ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`
      : `"${tile.title}"`

  /** The tiles whose SQL reads one of these parameters. */
  const tilesUsing = (dashboard: Dashboard, names: string[]) =>
    dashboard.tiles.filter(
      (tile) =>
        !isTextTile(tile) &&
        names.some((name) =>
          new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(`${tile.sql}\n${tile.drillSql ?? ""}`)
        )
    )

  const describeFilter = (filter: DashboardFilter) => {
    const params = filterParams(filter).map((name) => `{{${name}}}`).join(", ")
    const value =
      filter.kind === "date_range" && filter.preset !== "custom" ? filter.preset : filterValueLabel(filter)
    const extra =
      filter.kind === "select" || filter.kind === "multi_select"
        ? `\n  choices from: ${filter.optionsSql}`
        : ""
    return `- ${filter.label} (${filter.kind}, ${params}), now: ${value}${extra}`
  }

  const describeKnowledge = (target: Connection) => {
    const knowledge = host.library.knowledge(target.id)
    const dashboards = host.library
      .dashboards()
      .filter((item) => item.connectionId === target.id)
    const parts = [
      `# Business context for ${target.name}`,
      "## Notes",
      knowledge.notes.trim() || "(none written yet)",
      "## Metrics",
      knowledge.metrics.length
        ? knowledge.metrics
            .map(
              (metric) =>
                `### ${metric.name}\n${metric.description || "(no description)"}\n\`\`\`sql\n${metric.sql}\n\`\`\``
            )
            .join("\n\n")
        : "(none defined yet)",
    ]
    if (scope === "chat") {
      parts.push(
        "## Dashboards",
        dashboards.length
          ? dashboards
              .map(
                (item) =>
                  `- ${item.title} (id ${item.id}): ${item.tiles.map((tile) => tile.title).join(", ") || "empty"}`
              )
              .join("\n")
          : "(none yet)"
      )
    }
    return parts.join("\n\n")
  }

  /** Refuses a call the user did not approve; see `ToolHost.takeGrant`. */
  const approved = (tool: string, args: unknown) => {
    if (!host.takeGrant(tool, args)) {
      throw new Error(
        "This was not approved by the user, so nothing was done."
      )
    }
  }

  const reading = [
      tool(
        "list_connections",
        "List the database connections the user has set up: id, name, engine (postgres or mysql) and default database.",
        {},
        async () => {
          const all = host.connections.list()
          if (all.length === 0) {
            return ok(
              "No connections are set up yet. Ask the user to add one in the Explorer."
            )
          }
          return ok(
            all
              .map(
                (item) =>
                  `- ${item.name} (id ${item.id}): ${item.engine}, database "${item.database}" on ${addressOf(item)}${ACCESS_NOTE[item.access]}`
              )
              .join("\n")
          )
        },
        { alwaysLoad: true }
      ),

      tool(
        "list_tables",
        "List the tables and views of a connection, grouped by schema (for MySQL a schema is a database).",
        {
          connection,
          schema: z.string().optional().describe("Only this schema."),
          search: z
            .string()
            .optional()
            .describe("Only names containing this text."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const tree = await host.connections.driver(target.id).tree()
            const needle = args.search?.toLowerCase()
            const lines: string[] = []
            let listed = 0
            let skipped = 0
            for (const schema of tree) {
              if (args.schema && schema.name !== args.schema) continue
              const tables = schema.tables.filter(
                (table) => !needle || table.name.toLowerCase().includes(needle)
              )
              if (tables.length === 0) continue
              lines.push(`${schema.name}:`)
              for (const table of tables) {
                if (listed >= TABLE_LIST_LIMIT) {
                  skipped++
                  continue
                }
                listed++
                lines.push(`  ${table.kind} ${table.name}`)
              }
            }
            if (skipped) {
              lines.push(
                `… and ${skipped} more. Narrow it with schema or search.`
              )
            }
            return ok(lines.length ? lines.join("\n") : "Nothing matched.")
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "describe_table",
        "Show the columns (type, nullability, default, primary key) and foreign keys of one or more tables. Call this before writing a query against a table you have not seen.",
        {
          connection,
          tables: z
            .array(z.string())
            .min(1)
            .max(12)
            .describe("Table or view names."),
          schema: z
            .string()
            .optional()
            .describe("Needed only when the name exists in several schemas."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const driver = host.connections.driver(target.id)
            const tree = await driver.tree()
            const parts = await Promise.all(
              args.tables.map(async (name) => {
                try {
                  const ref = locate(tree, name, args.schema)
                  const info = await driver.table(ref)
                  const columns = info.columns.map((column) =>
                    [
                      `  ${column.name} ${column.type}`,
                      column.nullable ? "" : "NOT NULL",
                      column.primaryKey ? "PRIMARY KEY" : "",
                      column.default !== null ? `DEFAULT ${column.default}` : "",
                      column.extra,
                    ]
                      .filter(Boolean)
                      .join(" ")
                  )
                  const keys = info.foreignKeys.length
                    ? ["  foreign keys:", ...info.foreignKeys.map((key) => `    ${key}`)]
                    : []
                  return [
                    `${ref.schema}.${ref.table} (${info.kind})`,
                    ...columns,
                    ...keys,
                  ].join("\n")
                } catch (error) {
                  return `${name}: ${error instanceof Error ? error.message : String(error)}`
                }
              })
            )
            return ok(parts.join("\n\n"))
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "run_query",
        `Run one read-only SQL statement (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE) and get the rows back as JSON: {columns, rows, row_count, truncated}. Every value is the text the database prints, or null. It runs inside a read-only transaction, so it cannot change anything. At most max_rows rows come back (default ${DEFAULT_ROWS}, limit ${MAX_ROWS}); "truncated": true means there were more — aggregate or add a LIMIT rather than reading a table whole.`,
        {
          connection,
          sql: z.string().describe("A single statement in the connection's dialect."),
          max_rows: z.number().int().min(1).max(MAX_ROWS).optional(),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const result = await host.connections.driver(target.id).query(args.sql, {
              readOnly: true,
              maxRows: args.max_rows ?? DEFAULT_ROWS,
              timeoutMs: QUERY_TIMEOUT_MS,
            })
            return ok(resultJson(result))
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "get_business_context",
        "What the user has written down about a connection's data: notes on what tables and codes mean, and the metrics they defined (name, meaning, the SQL that computes it). Read it before the first query on a connection in a conversation, and compute a defined metric with its SQL rather than your own.",
        { connection },
        async (args) => {
          try {
            return ok(describeKnowledge(resolve(args.connection)))
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),
  ]

  const acting = [
      tool(
        "get_skill",
        "Read the instructions of one of the user's skills, by the name the <viewer> block lists it under. Call it when a request matches a skill's description, before doing the task, and follow what it says.",
        {
          name: z.string().describe("The skill's name, as listed."),
        },
        async (args) => {
          const skill = host.library.findSkill(args.name)
          if (!skill) {
            const names = host.library
              .skills()
              .filter((item) => item.enabled)
              .map((item) => item.name)
            return fail(
              `No enabled skill named "${args.name}". ${names.length ? `Enabled: ${names.join(", ")}.` : "None are enabled."}`
            )
          }
          return ok(`# Skill: ${skill.name}\n\n${skill.instructions}`)
        },
        { alwaysLoad: true }
      ),

      tool(
        "execute_sql",
        "Run one SQL statement that changes data or schema (INSERT, UPDATE, DELETE, DDL). The user is shown the exact statement and must approve it before it runs; if they decline, do not try again by other means. Only use it when the user asked for a change.",
        {
          connection,
          sql: z.string().describe("A single statement in the connection's dialect."),
        },
        async (args) => {
          try {
            // Not reached without the user's approval when everything is as
            // it should be. Checked here all the same, so that a CLI
            // configured to skip its permission prompt fails closed.
            const target = resolve(args.connection)
            host.connections.assertWritable(target.id)
            approved("execute_sql", args)
            const result = await host.connections.driver(target.id).query(args.sql, {
              readOnly: false,
              maxRows: DEFAULT_ROWS,
            })
            host.changed(target.id)
            return ok(
              result.columns.length
                ? resultJson(result)
                : JSON.stringify({
                    command: result.command,
                    rows_affected: result.affected,
                  })
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "execute_plan",
        "Run several changing statements as one plan, in a single transaction: the user reviews the whole list once and approves or declines it. Use it instead of execute_sql whenever a change takes more than one statement (creating related tables, seeding data, a migration). On PostgreSQL the plan is all or nothing; on MySQL, DDL commits as it runs, so say so in the summary when the plan has any.",
        {
          connection,
          title: z.string().describe("What the plan does, in a few words."),
          summary: z
            .string()
            .optional()
            .describe("One or two sentences on what changes and why."),
          statements: z
            .array(z.string())
            .min(1)
            .max(60)
            .describe("One statement per entry, in the order they run."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            host.connections.assertWritable(target.id)
            approved("execute_plan", args)
            const steps = await host.connections
              .driver(target.id)
              .runPlan(args.statements)
            host.changed(target.id)
            return ok(
              JSON.stringify({
                committed: true,
                steps: steps.map((step, index) => ({
                  step: index + 1,
                  ...(step.command ? { command: step.command } : {}),
                  rows_affected: step.affected,
                })),
              })
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "show_chart",
        `Draw a query's result as a chart in this conversation. Use it whenever the answer is a trend, a comparison or a breakdown — it reads faster than a table. The query is read-only and should already aggregate: at most ${CHART_ROWS} rows are drawn. Order the rows as they should appear (time ascending; ranked bars largest first). Fold a long tail into an "Other" row in the SQL rather than drawing dozens of bars. You get the rows back; describe what the chart shows in a sentence, without repeating every number.`,
        {
          connection,
          sql: z.string().describe("A single read-only statement."),
          title: z.string().describe("What the chart shows, in a few words."),
          ...chartFields,
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const spec = specOf(args)
            const result = await chartData(target.id, args.sql, spec)
            host.chart({
              connectionId: target.id,
              title: args.title.trim() || "Chart",
              sql: args.sql,
              spec,
              result,
            })
            return ok(`The chart is on screen. Its data:\n${resultJson(result)}`)
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "add_to_dashboard",
        "Add a tile — a chart, or a table when chart is omitted — to one of the user's dashboards, creating the dashboard when none has that title. A tile is a saved read-only query that is run again each time the dashboard is opened or refreshed, so write it to stay correct over time (relative dates such as the last 30 days, not fixed ones). Build a dashboard from several tiles when the user asks for one, then open it with open_in_viewer.",
        {
          connection,
          dashboard: z
            .string()
            .describe("An existing dashboard's id or title, or the title of a new one."),
          title: z.string().describe("The tile's title; may be empty for a text tile."),
          sql: z
            .string()
            .optional()
            .describe(
              "A single read-only statement. It may use the dashboard's filters: {{name}} for a value, and [[ … ]] around a clause to drop while the filter is on All — e.g. WHERE true [[AND ordered_at >= {{date_start}}]] [[AND ordered_at < {{date_end}}]] [[AND country = {{country}}]]."
            ),
          text: z
            .string()
            .optional()
            .describe(
              "Instead of sql: Markdown, for a heading or a note between tiles — e.g. \"## Sales\" and a line under it. Do not repeat the dashboard's own title."
            ),
          chart: z.object(chartFields).optional(),
          width: z
            .number()
            .int()
            .min(1)
            .max(4)
            .optional()
            .describe("Columns spanned, out of 4: 1 for a KPI, 2 for most charts (default), 4 for a wide trend or a table."),
          height: z.enum(["s", "m", "l"]).optional().describe("s for a KPI or a heading, m (default), l for a long table or ranking."),
          drill_sql: z
            .string()
            .optional()
            .describe("The rows behind one category of this chart: SQL using {{value}} for the category clicked (and the dashboard's filters), e.g. SELECT * FROM orders WHERE status = {{value}} [[AND ordered_at >= {{date_start}}]] LIMIT 500."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const sql = args.sql?.trim() ?? ""
            const text = tileText(args.text?.trim() ?? "")
            if (!sql === !text) throw new Error("Pass either sql or text.")
            const existing = host.library.findDashboard(target.id, args.dashboard)
            if (existing && existing.connectionId !== target.id) {
              throw new Error(
                `"${existing.title}" belongs to another connection.`
              )
            }
            const spec = args.chart && sql ? specOf(args.chart) : null
            const params = filterValues(existing?.filters ?? [])
            if (sql) await chartData(target.id, sql, spec, params)
            if (args.drill_sql) {
              // Checked with a value that matches nothing, for its syntax.
              bindParameters(args.drill_sql, { ...params, value: "\u0000" }, engineOf(target.id))
            }
            const dashboard = host.library.pin({
              connectionId: target.id,
              dashboardId: existing?.id ?? null,
              dashboardTitle: args.dashboard,
              tile: {
                title: args.title.trim(),
                sql,
                chart: spec,
                ...(text ? { text } : {}),
                ...(args.width ? { width: args.width as 1 | 2 | 3 | 4 } : {}),
                ...(args.height ? { height: args.height } : {}),
                ...(args.drill_sql ? { drillSql: args.drill_sql } : {}),
              },
            })
            return ok(
              `${existing ? "Added to" : "Created"} dashboard "${dashboard.title}" (id ${dashboard.id}); it has ${dashboard.tiles.length} ${dashboard.tiles.length === 1 ? "tile" : "tiles"}.`
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "add_dashboard_filter",
        "Add a filter to a dashboard — a control above its tiles that scopes all of them. Kinds, named e.g. \"date\", \"country\", \"q\", \"amount\", \"vip\":\n- date_range gives {{date_start}} (inclusive) and {{date_end}} (exclusive): [[AND ordered_at >= {{date_start}}]] [[AND ordered_at < {{date_end}}]].\n- select gives one value: [[AND country = {{country}}]]; choices from options_sql.\n- multi_select gives several, bound one by one: [[AND status IN ({{status}})]]; choices from options_sql.\n- text gives a LIKE pattern of what is typed (match: contains, starts or exact): [[AND name ILIKE {{q}}]] on Postgres, [[AND name LIKE {{q}}]] on MySQL.\n- number_range gives {{amount_min}} and {{amount_max}}, both included, either open: [[AND total >= {{amount_min}}]] [[AND total <= {{amount_max}}]].\n- toggle gives 1 for Yes and 0 for No: [[AND vip = {{vip}}]].\nAdd filters before the tiles that use them, and write every tile's SQL so it still runs with the filter on All, by wrapping the clause in [[ … ]]. A filter of the same name is replaced.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
          kind: z.enum(FILTER_KINDS),
          name: z
            .string()
            .describe("The parameter name: letters, digits, underscores — date, country, channel."),
          label: z.string().describe("What the control is called on screen."),
          options_sql: z
            .string()
            .optional()
            .describe("select and multi_select: a read-only query whose first column is the choices, e.g. SELECT DISTINCT country FROM customers ORDER BY 1."),
          match: z
            .enum(TEXT_MATCHES)
            .optional()
            .describe("text: how the words meet the column — contains (default), starts, exact."),
          preset: z
            .enum(DATE_PRESETS)
            .optional()
            .describe("date_range: what it starts on (default 90d). 7d, 30d, 90d, 12m, mtd, qtd, ytd or all."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            let filter: DashboardFilter
            if (args.kind === "date_range") {
              filter = {
                id: "",
                kind: "date_range",
                name: args.name.trim(),
                label: args.label.trim(),
                preset: args.preset && args.preset !== "custom" ? args.preset : "90d",
                from: null,
                to: null,
              }
            } else if (args.kind === "select" || args.kind === "multi_select") {
              if (!args.options_sql?.trim()) throw new Error(`A ${args.kind} needs options_sql.`)
              const choices = await host.connections.driver(target.id).query(args.options_sql, {
                readOnly: true,
                maxRows: 1000,
                timeoutMs: QUERY_TIMEOUT_MS,
              })
              if (choices.columns.length === 0) throw new Error("options_sql returned no columns.")
              const base = {
                id: "",
                name: args.name.trim(),
                label: args.label.trim(),
                optionsSql: args.options_sql.trim(),
              }
              filter =
                args.kind === "select"
                  ? { ...base, kind: "select", value: null }
                  : { ...base, kind: "multi_select", values: [] }
            } else {
              const base = { id: "", name: args.name.trim(), label: args.label.trim() }
              filter =
                args.kind === "text"
                  ? { ...base, kind: "text", match: args.match ?? "contains", value: null }
                  : args.kind === "number_range"
                    ? { ...base, kind: "number_range", min: null, max: null }
                    : { ...base, kind: "toggle", value: null }
            }
            const others = dashboard.filters.filter((item) => item.name !== filter.name)
            const saved = host.library.saveDashboard({
              ...dashboard,
              filters: [...others, filter],
            })
            return ok(
              `Added the filter "${filter.label}" to "${saved.title}". Tiles read it as ${filterParams(filter).map((name) => `{{${name}}}`).join(" and ")}.`
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "get_dashboard",
        "A dashboard as it is: its filters with their current values, and every tile — numbered, as edit_dashboard_tile and remove_from_dashboard refer to them — with its title, SQL, chart, size and drill-down. Read it before changing a dashboard or answering about one — to summarise it, run its tiles' SQL yourself with the filters' current values.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            const values = filterValues(dashboard.filters)
            const lines = [
              `# ${dashboard.title} (id ${dashboard.id})`,
              "## Filters",
              dashboard.filters.length
                ? dashboard.filters.map(describeFilter).join("\n")
                : "(none)",
              `Current parameter values: ${JSON.stringify(values)}`,
              "## Tiles",
              ...dashboard.tiles.map((tile, index) =>
                isTextTile(tile)
                  ? `${index + 1}. Text: ${tile.text}`
                  : [
                      `${index + 1}. ${tile.title} — ${tile.chart ? JSON.stringify(tile.chart) : "table"}, width ${tile.width ?? 2}, height ${tile.height ?? "m"}`,
                      "```sql",
                      tile.sql,
                      "```",
                      ...(tile.drillSql ? [`drill-down: ${tile.drillSql}`] : []),
                    ].join("\n")
              ),
            ]
            return ok(lines.join("\n"))
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "edit_dashboard_tile",
        "Change one tile of a dashboard in place: its title, SQL or text, chart, size, drill-down, or its position. Pass only what changes; the rest is kept. Read the dashboard with get_dashboard first, and refer to the tile by its number there (numbers shift after a move or a removal — read it again). A tile's SQL is checked against the dashboard's filters before it is saved.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
          tile: z.string().describe("The tile's number in get_dashboard (1, 2, …), its id, or its title."),
          title: z.string().optional(),
          sql: z.string().optional().describe("A query tile's new SQL; same rules as add_to_dashboard."),
          text: z.string().optional().describe("A text tile's new Markdown."),
          chart: z.object(chartFields).optional().describe("Draw it as this chart instead."),
          as_table: z.boolean().optional().describe("true: drop the chart and show the rows."),
          width: z.number().int().min(1).max(4).optional(),
          height: z.enum(["s", "m", "l"]).optional(),
          drill_sql: z.string().optional().describe("The new drill-down SQL; an empty string removes it."),
          move_to: z.number().int().min(1).optional().describe("Its new position, 1 for first."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            const index = tileIndexOf(dashboard, args.tile)
            const before = dashboard.tiles[index]!
            const text = isTextTile(before)
            if (text && (args.sql !== undefined || args.chart || args.as_table || args.drill_sql)) {
              throw new Error("That is a text tile: it has text, not SQL or a chart. Remove it and add a query tile instead.")
            }
            if (!text && args.text !== undefined) {
              throw new Error("That is a query tile: change its sql, not text.")
            }
            if (args.chart && args.as_table) throw new Error("Pass chart or as_table, not both.")
            const tile = { ...before }
            if (args.title !== undefined) tile.title = args.title.trim()
            if (args.text !== undefined) {
              const next = tileText(args.text.trim())
              if (!next) throw new Error("A text tile needs text; remove it instead.")
              tile.text = next
            }
            if (args.sql !== undefined) tile.sql = args.sql.trim()
            if (args.chart) tile.chart = specOf(args.chart)
            if (args.as_table) tile.chart = null
            if (args.width) tile.width = args.width as 1 | 2 | 3 | 4
            if (args.height) tile.height = args.height
            if (args.drill_sql !== undefined) {
              const drill = args.drill_sql.trim()
              if (drill) tile.drillSql = drill
              else delete tile.drillSql
            }
            const params = filterValues(dashboard.filters)
            if (!text && (args.sql !== undefined || args.chart)) {
              await chartData(target.id, tile.sql, tile.chart ?? null, params)
            }
            if (tile.drillSql && args.drill_sql) {
              bindParameters(tile.drillSql, { ...params, value: "\u0000" }, engineOf(target.id))
            }
            const tiles = [...dashboard.tiles]
            tiles.splice(index, 1)
            const at = args.move_to ? Math.min(args.move_to, tiles.length + 1) - 1 : index
            tiles.splice(at, 0, tile)
            const saved = host.library.saveDashboard({ ...dashboard, tiles })
            return ok(
              `Updated ${tileName(tile)} on "${saved.title}"${at !== index ? `; it is now tile ${at + 1}` : ""}.`
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "edit_dashboard",
        "Rename a dashboard, or set how often it refreshes itself while it is open.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
          title: z.string().optional().describe("Its new title."),
          refresh_seconds: z
            .union([z.literal(0), z.literal(60), z.literal(300), z.literal(900)])
            .optional()
            .describe("0 for off, 60, 300 or 900."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            const title = args.title?.trim()
            if (title) {
              const taken = host.library.findDashboard(target.id, title)
              if (taken && taken.id !== dashboard.id) {
                throw new Error(`There is already a dashboard "${taken.title}" on ${target.name}.`)
              }
            }
            const saved = host.library.saveDashboard({
              ...dashboard,
              ...(title ? { title } : {}),
              ...(args.refresh_seconds !== undefined ? { refreshSeconds: args.refresh_seconds } : {}),
            })
            return ok(
              `"${saved.title}" (id ${saved.id}) refreshes ${saved.refreshSeconds ? `every ${saved.refreshSeconds / 60} min` : "only when asked"}.`
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "remove_from_dashboard",
        "Remove one tile, or one filter, from a dashboard. The user approves it first. Read the dashboard with get_dashboard first and pass the tile's number there. A filter that tiles still read must be taken out of their SQL too (edit_dashboard_tile), or those tiles fail.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
          tile: z.string().optional().describe("The tile's number in get_dashboard, its id, or its title."),
          filter: z.string().optional().describe("Or: the filter's name, e.g. date."),
        },
        async (args) => {
          try {
            if (!args.tile === !args.filter) throw new Error("Pass either tile or filter.")
            approved("remove_from_dashboard", args)
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            if (args.tile) {
              const index = tileIndexOf(dashboard, args.tile)
              const removed = dashboard.tiles[index]!
              const saved = host.library.saveDashboard({
                ...dashboard,
                tiles: dashboard.tiles.filter((_, at) => at !== index),
              })
              return ok(
                `Removed ${tileName(removed)} from "${saved.title}"; it has ${saved.tiles.length} ${saved.tiles.length === 1 ? "tile" : "tiles"}.`
              )
            }
            const name = args.filter!.trim()
            const filter = dashboard.filters.find(
              (item) => item.name === name || item.label.toLowerCase() === name.toLowerCase()
            )
            if (!filter) {
              throw new Error(
                `No filter "${name}" on "${dashboard.title}". Its filters: ${dashboard.filters.map((item) => item.name).join(", ") || "none"}.`
              )
            }
            const saved = host.library.saveDashboard({
              ...dashboard,
              filters: dashboard.filters.filter((item) => item !== filter),
            })
            const using = tilesUsing(saved, filterParams(filter))
            return ok(
              `Removed the filter "${filter.label}" from "${saved.title}".` +
                (using.length
                  ? ` These tiles still read ${filterParams(filter).map((param) => `{{${param}}}`).join(" / ")} and will fail until their SQL is changed: ${using.map(tileName).join(", ")}.`
                  : "")
            )
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "delete_dashboard",
        "Delete a whole dashboard, its tiles and filters. The user approves it first. Only when they ask for it.",
        {
          connection,
          dashboard: z.string().describe("The dashboard's id or title."),
        },
        async (args) => {
          try {
            approved("delete_dashboard", args)
            const target = resolve(args.connection)
            const dashboard = dashboardOf(target, args.dashboard)
            host.library.deleteDashboard(dashboard.id)
            return ok(`Deleted the dashboard "${dashboard.title}".`)
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "save_metric",
        "Save a business metric to the connection's definitions, so it is computed the same way from now on (an existing metric of the same name is replaced). The user approves it first. Offer this when the two of you settled how a figure is computed — what counts as revenue, which statuses are excluded — or when they ask you to remember a definition.",
        {
          connection,
          name: z.string().describe('Short and recognisable: "Net revenue", "AOV".'),
          description: z
            .string()
            .describe("What it means and what it includes or excludes, in a sentence or two."),
          sql: z
            .string()
            .describe("The SQL that computes it: a full query, or an aggregate expression with its FROM and WHERE."),
        },
        async (args) => {
          try {
            approved("save_metric", args)
            const target = resolve(args.connection)
            host.library.putMetric(target.id, {
              name: args.name.trim(),
              description: args.description.trim(),
              sql: args.sql.trim(),
            })
            return ok(`Saved the metric "${args.name.trim()}".`)
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "append_note",
        "Add a note to the connection's business context — something learned about the data that will matter again: what a status code means, which table is the source of truth, a column that is deprecated. The user approves it first. Keep it to a few lines of Markdown.",
        {
          connection,
          text: z.string().describe("The note, in Markdown."),
        },
        async (args) => {
          try {
            approved("append_note", args)
            const target = resolve(args.connection)
            host.library.appendNote(target.id, args.text)
            return ok("Added to the notes.")
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),

      tool(
        "open_in_viewer",
        "Open something in the user's viewer, the large panel beside this chat: a table (browsable, filterable, editable by the user), a read-only query whose full result they can scroll, or a dashboard. Use it when the user asks to see or open something, or when a result is too large to be worth pasting into the reply.",
        {
          connection,
          table: z.string().optional().describe("Open this table or view."),
          schema: z.string().optional(),
          sql: z
            .string()
            .optional()
            .describe("Or: open this read-only query and run it."),
          title: z
            .string()
            .optional()
            .describe("A short tab title for a query."),
          dashboard: z
            .string()
            .optional()
            .describe("Or: open this dashboard, by id or title."),
        },
        async (args) => {
          try {
            const target = resolve(args.connection)
            if (args.table) {
              const tree = await host.connections.driver(target.id).tree()
              const ref = locate(tree, args.table, args.schema)
              host.open({ kind: "table", connectionId: target.id, ...ref })
              return ok(`Opened ${ref.schema}.${ref.table} in the viewer.`)
            }
            if (args.sql) {
              assertReadOnly(args.sql)
              host.open({
                kind: "query",
                connectionId: target.id,
                sql: args.sql,
                title: args.title?.trim() || "Query",
              })
              return ok("Opened the query in the viewer.")
            }
            if (args.dashboard) {
              const dashboard = host.library.findDashboard(target.id, args.dashboard)
              if (!dashboard) throw new Error(`No dashboard "${args.dashboard}".`)
              host.open({
                kind: "dashboard",
                connectionId: dashboard.connectionId,
                dashboardId: dashboard.id,
              })
              return ok(`Opened the dashboard "${dashboard.title}".`)
            }
            return fail("Pass table, sql or dashboard.")
          } catch (error) {
            return fail(error)
          }
        },
        { alwaysLoad: true }
      ),
  ]

  return scope === "chat" ? [...reading, ...acting] : reading
}
