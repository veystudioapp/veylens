import { mkdirSync } from "node:fs"
import path from "node:path"

import { query } from "@anthropic-ai/claude-agent-sdk"

import {
  isTextTile,
  tileText,
  type AiSettings,
  type AssistInput,
  type AssistResult,
  type Cell,
  type ChatEffort,
  type Connection,
  type Dashboard,
  type DashboardSummaryInput,
} from "../shared/api"
import { filterValueLabel, filterValues, inlineParameters } from "../shared/params"
import { createDbTools, TOOL_PREFIX, TOOL_SERVER } from "./agent-tools"
import { claudeEnvironment, locateClaude } from "./claude-bin"
import type { Connections } from "./connections"
import type { Library } from "./library"

const ASSIST_PROMPT_BASE = `You are the SQL assistant built into the query editor of Vey Lens, a desktop database explorer. You are asked one thing about the SQL in the editor — write it, explain it, or fix it — and you answer once; there is no conversation.

Use your tools to look before you write: list_tables and describe_table for the real names, get_business_context for what the data means and the metrics the user defined (use a defined metric's SQL when the request involves it), run_query to check that a statement you propose runs and returns what was meant. Every tool is read-only.

Write the connection's dialect. Keep a statement the user wrote as close to theirs as the request allows — same aliases, same layout — and change only what has to change. Never propose a statement that changes data unless the request explicitly asks for one.

Reply with:
- sql: the complete statement for the editor, or null when the request was only to explain.
- text: a short Markdown answer in LANGUAGE: for an explanation, what the statement does, step by step, and anything surprising or slow about it; for a fix, what was wrong and what you changed; for a new statement, what it returns and any assumption you made.`

const KEYWORD_RULE: Record<AiSettings["keywordCase"], string | null> = {
  keep: null,
  upper: "Write SQL keywords and built-in function names in UPPER CASE (SELECT, FROM, COUNT). Leave table and column names as the database has them.",
  lower: "Write SQL keywords and built-in function names in lower case (select, from, count). Leave table and column names as the database has them.",
}

/** The helper's instructions, with what the user set in Settings › Models &
 * language: the language of its answers, how its SQL is spelt, and their own
 * words. */
export function assistPrompt(ai: AiSettings): string {
  const parts = [
    ASSIST_PROMPT_BASE.replace(
      "LANGUAGE",
      ai.language
        ? `${ai.language}, whatever language the request is in (the user chose it in Settings); SQL, names and values stay as they are`
        : "the language of the request (or English if there is none)"
    ),
  ]
  const keywords = KEYWORD_RULE[ai.keywordCase]
  if (keywords) parts.push(keywords)
  if (ai.sqlInstructions.trim()) {
    parts.push(
      `The user's own instructions for this helper — follow them unless they ask for a change to data or contradict the rules above:\n${ai.sqlInstructions.trim()}`
    )
  }
  return parts.join("\n\n")
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: ["string", "null"] },
    text: { type: "string" },
  },
  required: ["sql", "text"],
  additionalProperties: false,
}

const READ_TOOLS = new Set([
  "list_connections",
  "list_tables",
  "describe_table",
  "run_query",
  "get_business_context",
])

function request(input: AssistInput, connection: string): string {
  const editor = input.sql.trim()
    ? `The editor holds:\n\`\`\`sql\n${input.sql}\n\`\`\``
    : "The editor is empty."
  switch (input.mode) {
    case "generate":
      return `Connection: ${connection}\n${editor}\n\nWrite SQL for this request: ${input.instruction?.trim() || "(no request given)"}`
    case "explain":
      return `Connection: ${connection}\n${editor}\n\nExplain this statement.`
    case "fix":
      return `Connection: ${connection}\n${editor}\n\nRunning it failed with:\n${input.error ?? "(no message)"}\n\nFix the statement.`
  }
}

const SUMMARY_PROMPT_BASE = `You are the analyst built into the dashboards of Vey Lens, a desktop database explorer. The user pressed Summarise on a dashboard; your answer is shown on the dashboard itself, above its tiles. There is no conversation: answer once.

Run the tiles' SQL with run_query — it is given with the filters' current values already in it — and read get_business_context for what the data means. To say what changed, run the same queries for the previous period of the same length (shift the dates in them); say so when there is no date to compare on. Every tool is read-only.

Write in LANGUAGE, in short Markdown, with no heading for the whole answer and no preamble:
- What stands out: 3–5 bullets, each with the figure that shows it.
- What changed against the previous period, with the change as a number and a percentage.
- What needs attention, if anything: a tile that failed, an outlier, a figure going the wrong way.
Name the tile each point comes from. Do not repeat the SQL, and do not describe how you worked.`

/** The summariser's instructions, in the language the user chose. */
export function summaryPrompt(ai: AiSettings): string {
  return SUMMARY_PROMPT_BASE.replace(
    "LANGUAGE",
    ai.language
      ? `${ai.language} (the user chose it in Settings); names and values stay as they are`
      : "English, unless the dashboard's titles are in another language — then that one"
  )
}

/** The dashboard as the summariser is told it: its scope and each tile's SQL
 * with the filters' current values written in. */
export function summaryRequest(
  dashboard: Dashboard,
  target: Pick<Connection, "id" | "name" | "engine" | "database">,
  cross: { column: string; value: Cell } | null
): string {
  const values = filterValues(dashboard.filters)
  const scope = dashboard.filters.map(
    (filter) => `- ${filter.label}: ${filterValueLabel(filter)}`
  )
  const tiles = dashboard.tiles.map((tile, index) => {
    if (isTextTile(tile)) return `${index + 1}. Text: ${tileText(tile.text ?? "").trim()}`
    let sql: string
    try {
      sql = inlineParameters(tile.sql, values, target.engine)
    } catch (error) {
      return `${index + 1}. ${tile.title} — cannot run with the current filters: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
    const chart = tile.chart ? `${tile.chart.type} chart` : "table"
    return `${index + 1}. ${tile.title} (${chart})\n\`\`\`sql\n${sql}\n\`\`\``
  })
  return [
    `Connection: ${target.name} (id ${target.id}, ${target.engine}, database "${target.database}")`,
    `Dashboard: "${dashboard.title}"`,
    `Filters:\n${scope.length ? scope.join("\n") : "(none)"}`,
    ...(cross
      ? [
          `The user clicked ${cross.column} = ${cross.value ?? "NULL"} on a tile, narrowing the tiles that have a "${cross.column}" column to it. Summarise with that in mind.`,
        ]
      : []),
    `Tiles:\n${tiles.join("\n\n")}`,
    "Summarise this dashboard.",
  ].join("\n\n")
}

/**
 * The one-shot helper behind the SQL editor's Generate, Explain and Fix, and
 * a dashboard's Summarise.
 *
 * A fresh `claude` each time, not the chat's session: the editor's question
 * stands alone, and answering it should not put words in the conversation.
 * Read-only tools only, and no session written to disk.
 */
export class Assist {
  private readonly running = new Map<string, AbortController>()
  private readonly workspace: string

  constructor(
    dataDir: string,
    private readonly connections: Connections,
    private readonly library: Library
  ) {
    this.workspace = path.join(dataDir, "agent")
    mkdirSync(this.workspace, { recursive: true })
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort()
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
  }

  async run(input: AssistInput): Promise<AssistResult> {
    const target = this.connections
      .list()
      .find((item) => item.id === input.connectionId)
    if (!target) throw new Error("That connection no longer exists.")
    if (input.mode === "generate" && !input.instruction?.trim()) {
      throw new Error("Say what the query should return.")
    }

    // What Settings › Models & language says for this task; a task left to
    // follow the chat runs on what the chat's picker shows.
    const ai = this.library.aiSettings()
    const choice = ai.models[input.mode]
    const result = await this.ask({
      requestId: input.requestId,
      prompt: request(
        input,
        `${target.name} (id ${target.id}, ${target.engine}, database "${target.database}")`
      ),
      systemPrompt: assistPrompt(ai),
      model: choice.model ?? input.model,
      effort: choice.model ? choice.effort : input.effort,
      schema: OUTPUT_SCHEMA,
      maxTurns: 20,
    })
    return readAnswer(result.structured, result.text)
  }

  /**
   * A dashboard's Summarise: the same one-shot, read-only helper, told the
   * dashboard's tiles with the filters' current values already in their SQL,
   * so the answer is shown on the dashboard and the chat is left as it was.
   */
  async summarize(input: DashboardSummaryInput): Promise<string> {
    const dashboard = this.library.dashboard(input.dashboardId)
    const target = this.connections
      .list()
      .find((item) => item.id === dashboard.connectionId)
    if (!target) throw new Error("That dashboard's connection no longer exists.")
    if (!dashboard.tiles.some((tile) => !isTextTile(tile))) {
      throw new Error("This dashboard has no queries to summarise.")
    }
    const ai = this.library.aiSettings()
    const result = await this.ask({
      requestId: input.requestId,
      prompt: summaryRequest(dashboard, target, input.cross ?? null),
      systemPrompt: summaryPrompt(ai),
      model: input.model,
      effort: input.effort,
      schema: null,
      maxTurns: 40,
    })
    const text = result.text.trim()
    if (!text) throw new Error("The assistant ended without a summary.")
    return text
  }

  private async ask(job: {
    requestId: string
    prompt: string
    systemPrompt: string
    model: string | null
    effort: ChatEffort | null
    schema: Record<string, unknown> | null
    maxTurns: number
  }): Promise<{ structured: unknown; text: string }> {
    const binary = await locateClaude()
    if (!binary) {
      throw new Error(
        "Claude Code was not found on this machine. Install it and sign in with `claude`."
      )
    }
    const { model, effort } = job

    const controller = new AbortController()
    this.running.set(job.requestId, controller)
    const tools = createDbTools(
      {
        connections: this.connections,
        library: this.library,
        takeGrant: () => false,
        open: () => {},
        changed: () => {},
        chart: () => {},
      },
      "assist"
    )

    let stderr = ""
    try {
      const conversation = query({
        prompt: job.prompt,
        options: {
          cwd: this.workspace,
          pathToClaudeCodeExecutable: binary.path,
          env: claudeEnvironment(binary),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          systemPrompt: job.systemPrompt,
          tools: [],
          mcpServers: { [TOOL_SERVER]: tools },
          strictMcpConfig: true,
          settingSources: ["user"],
          permissionMode: "default",
          canUseTool: async (toolName, toolInput) => {
            const name = toolName.slice(TOOL_PREFIX.length)
            if (!toolName.startsWith(TOOL_PREFIX) || !READ_TOOLS.has(name)) {
              return { behavior: "deny", message: "Only reading is allowed here." }
            }
            // Settings › Tools applies here too: a query turned off for the
            // chat is not run by the editor's helper either.
            if (this.library.toolMode(name) === "off") {
              return {
                behavior: "deny",
                message: `The user turned ${name} off in Settings. Work without it.`,
              }
            }
            return { behavior: "allow", updatedInput: toolInput }
          },
          ...(job.schema
            ? { outputFormat: { type: "json_schema" as const, schema: job.schema } }
            : {}),
          persistSession: false,
          maxTurns: job.maxTurns,
          abortController: controller,
          stderr: (data) => {
            stderr = (stderr + data).slice(-4000)
          },
        },
      })

      for await (const message of conversation) {
        if (message.type !== "result") continue
        if (message.subtype !== "success" || message.is_error) {
          const errors =
            message.subtype === "success" ? [message.result] : message.errors
          throw new Error(errors.join("\n") || "The assistant could not answer.")
        }
        return { structured: message.structured_output, text: message.result }
      }
      throw new Error(
        controller.signal.aborted
          ? "Cancelled."
          : stderr.trim() || "The assistant ended without an answer."
      )
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Cancelled.")
      throw error
    } finally {
      this.running.delete(job.requestId)
    }
  }
}

/** The structured answer, or — from a CLI that ignored the schema — the
 * reply's first SQL block and its text. */
export function readAnswer(structured: unknown, text: string): AssistResult {
  if (structured && typeof structured === "object") {
    const answer = structured as { sql?: unknown; text?: unknown }
    if (typeof answer.text === "string") {
      return {
        sql:
          typeof answer.sql === "string" && answer.sql.trim()
            ? answer.sql.trim()
            : null,
        text: answer.text,
      }
    }
  }
  const block = /```sql\s*\n([\s\S]*?)```/i.exec(text)
  return { sql: block?.[1]?.trim() || null, text }
}
