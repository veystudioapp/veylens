import { randomUUID } from "node:crypto"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import {
  query,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import {
  EXTENSION,
  imageProblem,
  MAX_IMAGES,
  type ChatImage,
  type ChatImageType,
} from "../shared/chat-images"
import type {
  AgentStatus,
  Chat,
  ChatEffort,
  ChatEvent,
  ChatItem,
  ChatSummary,
  AuditAction,
  AuditStatus,
  SendInput,
  ToolStatus,
  ViewerContext,
} from "../shared/api"
import { readPartialJson, TOOL_CATALOG } from "../shared/agent"
import { defaultSchemaOf, describePermissions, forAssistant, judge } from "../shared/permissions"
import {
  APPROVAL_TOOLS,
  createDbTools,
  grantKey,
  TOOL_PREFIX,
  TOOL_SERVER,
  WRITE_TOOLS,
} from "./agent-tools"
import { claudeEnvironment, locateClaude } from "./claude-bin"
import { refusal, type AuditLog } from "./audit"
import type { Connections } from "./connections"
import type { Alerts } from "./alerts"
import type { Library } from "./library"

type ToolItem = Extract<ChatItem, { kind: "tool" }>

/** The assistant's calls kept in the audit log: what reads data or changes something. */
const AUDITED: Partial<Record<string, AuditAction>> = {
  run_query: "query",
  show_chart: "query",
  execute_sql: "write",
  execute_plan: "plan",
  save_metric: "context",
  append_note: "context",
  add_to_dashboard: "dashboard",
  add_dashboard_filter: "dashboard",
  edit_dashboard_tile: "dashboard",
  edit_dashboard: "dashboard",
  remove_from_dashboard: "dashboard",
  delete_dashboard: "dashboard",
  save_alert: "alert",
  delete_alert: "alert",
}

/** One line for the log, from what the call was given. */
function auditSummary(tool: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  const dashboard = text(input.dashboard)
  switch (tool) {
    case "run_query":
      return "Ran a query"
    case "show_chart":
      return `Drew a chart${text(input.title) ? `: ${text(input.title)}` : ""}`
    case "execute_sql":
      return "Ran a statement"
    case "execute_plan": {
      const steps = Array.isArray(input.statements) ? input.statements.length : 0
      return `Ran a plan${text(input.title) ? `: ${text(input.title)}` : ""} (${steps} ${steps === 1 ? "step" : "steps"})`
    }
    case "save_metric":
      return `Saved the metric "${text(input.name)}"`
    case "append_note":
      return "Added a note to the business context"
    case "add_to_dashboard":
      return `Added "${text(input.title) || "a text tile"}" to ${dashboard}`
    case "add_dashboard_filter":
      return `Added the filter "${text(input.label) || text(input.name)}" to ${dashboard}`
    case "edit_dashboard_tile":
      return `Edited tile ${text(input.tile)} on ${dashboard}`
    case "edit_dashboard":
      return text(input.title) ? `Renamed ${dashboard} to "${text(input.title)}"` : `Changed the refresh of ${dashboard}`
    case "remove_from_dashboard":
      return input.filter
        ? `Removed the filter "${text(input.filter)}" from ${dashboard}`
        : `Removed tile ${text(input.tile)} from ${dashboard}`
    case "delete_dashboard":
      return `Deleted the dashboard ${dashboard}`
    case "save_alert":
      return text(input.alert)
        ? `Changed the alert "${text(input.name) || text(input.alert)}"`
        : `Created the alert "${text(input.name)}"`
    case "delete_alert":
      return `Deleted the alert "${text(input.alert)}"`
    default:
      return tool
  }
}

/** The tools that make or change a dashboard, for a chat's marks. */
const DASHBOARD_TOOLS = new Set([
  "add_to_dashboard",
  "add_dashboard_filter",
  "edit_dashboard_tile",
  "edit_dashboard",
  "remove_from_dashboard",
  "delete_dashboard",
])

const NOT_INSTALLED =
  "Claude Code was not found on this machine. Install it (https://claude.com/claude-code), sign in with `claude`, then restart Vey Lens."

/** A `claude` nobody has written to for this long is closed; the next message
 * resumes the conversation in a new one. */
const IDLE_MS = 10 * 60_000

const TITLE_LENGTH = 60

/** A file `keepImages` names: an id and the extension it chose. */
const PICTURE_NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/

const SYSTEM_PROMPT = `You are the data assistant inside Vey Lens, a desktop database explorer. The user asks questions about their databases in plain language; you answer by inspecting the schema and running SQL through your tools.

The window has three parts: an explorer listing connections, tables and dashboards, a viewer showing the table, query or dashboard the user has open, and this chat. Each user message starts with a <viewer> block saying which connection and tab they are looking at — that is what "this table", "here" or an unqualified table name refers to. Use it as the default connection. If it names none and several connections exist, ask which one.

When the user writes @name — @orders, @"Sales overview" — they picked that table, view, dashboard, metric or connection from a menu. The <viewer> block lists each one under "mentioned with @" with exactly what it is: use that schema, id or connection rather than searching for the name, and leave the @ out when you answer.

How to work:
- Know the business before the data. The first time a conversation touches a connection, call get_business_context: it holds the user's notes on what tables and codes mean, and the metrics they defined. When a question involves a defined metric, compute it with that metric's SQL — never with your own variant — and say which definition you used.
- Follow the skills. The <viewer> block lists the skills that are switched on — instructions for a kind of task (building a dashboard, diagnosing a change, choosing a chart, and any the user wrote), each with when to use it. When a request matches one, call get_skill for its instructions before doing the task and follow them: the user may have rewritten them to how they want it done. Once read in a conversation, a skill need not be read again unless the user says it changed. Skills do not override the rules on changing data below, a read-only connection, or what the user asks in the message itself.
- The <viewer> block also says which tools the user turned off in Settings. Do not call those; if a request needs one, say that it is turned off and that it can be switched on in Settings › Tools.
- Look before you query. Use list_tables and describe_table to learn the real table and column names; never guess them. Check a connection's engine and write that dialect (PostgreSQL, MySQL, or DuckDB for a files connection).
- A connection whose engine is duckdb is files — Excel workbooks, CSV, Parquet, JSON, Google Sheets — loaded into DuckDB, and read-only. A workbook or Google Sheet is a schema with a table per sheet; any other file is a table in main. describe_table says which file and sheet a table came from and which row was its header. Columns were typed from the cells: one mixing numbers with text ("-", "N/A", a unit) is VARCHAR, so convert with TRY_CAST and say what was left out. Sheets often carry subtotal or total rows; check before summing a whole column.
- Answer questions with run_query. It is read-only. Prefer aggregates and explicit LIMITs over pulling whole tables; if a result comes back truncated, say so or refine the query rather than treating the rows as complete.
- Every value arrives as text exactly as the database prints it. Do not invent, round or reformat figures beyond what the user asked for, and never present a number you did not get from a query.
- If a query fails, read the error, fix the SQL and try again. If the data cannot answer the question, say that plainly.

Showing results:
- A trend, a comparison or a breakdown is shown with show_chart, not described in a table. Aggregate in SQL first.
- Small results that are not worth a chart read well as a Markdown table; long ones belong in the viewer (open_in_viewer) with a one-line summary here.
- To change or talk about an existing dashboard, read it with get_dashboard first. Change a tile in place with edit_dashboard_tile (not by adding a copy), rename or set its refresh with edit_dashboard, take a tile or filter off with remove_from_dashboard, and delete_dashboard only when asked to delete the whole thing.

Changing things:
- Changes (INSERT, UPDATE, DELETE, DDL) happen only when the user asked for a change. A single statement goes through execute_sql; anything that takes two or more statements goes through execute_plan as one plan, so the user reviews and approves it once. The user sees exactly what will run. Before a destructive change, check with a SELECT how many rows it will touch and say so. If they decline, do not retry.
- When the user wants to be told when a figure crosses a line or swings — "let me know if…", "warn me when…", "watch…" — set up an alert with save_alert: a query returning one number, a condition and how often to check. Try the query with run_query first if unsure. To change, pause (enabled false) or delete one, read list_alerts first and pass its id; delete_alert only when asked to delete.
- When the two of you settle how a figure is computed, offer to save it with save_metric. When you learn something about the data that will matter again — what a status code means, which table is authoritative — offer to keep it with append_note. The user may be asked to approve either first.

How to answer:
- Lead with the answer, in the language the user wrote in — or, when the <viewer> block names an answer language, in that one. Keep it short.
- Show the SQL only when it helps or when asked — the user can already expand each tool call to see it.
- Never ask for or repeat passwords or connection credentials.`

type Stored = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** The CLI's own id for this conversation, which is what a resume names. */
  sessionId: string | null
  items: ChatItem[]
}

/** The queue behind a session's prompt: messages wait here until the CLI
 * asks for the next one, and the session stays open for as long as it does. */
export class Inbox {
  private readonly waiting: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  /** Words, or words with pictures after them in the order they are
   * numbered — each one stands where its `[Image #n]` is in `text`. */
  push(text: string, images: ChatImage[] = []): void {
    if (this.closed) return
    this.waiting.push({
      type: "user",
      message: {
        role: "user",
        content:
          images.length === 0
            ? text
            : [
                { type: "text", text },
                ...images.map((image) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mediaType,
                    data: image.data,
                  },
                })),
              ],
      },
      parent_tool_use_id: null,
    })
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null
          resolve()
        }
      })
    }
  }
}

/** One running `claude` and what this process remembers about it. */
type Live = {
  inbox: Inbox
  query: Query
  model: string | null
  effort: ChatEffort | null
  idle: NodeJS.Timeout | null
  closed: boolean
  /** Set by Stop, so the result that follows is not drawn as a failure. */
  interrupted: boolean
  /** API message ids whose text already arrived as it was written. */
  streamed: Set<string>
  streamingMessage: string | null
  streamingItem: string | null
  /** A tool call whose input the model is still writing: shown as it comes. */
  writingTool: { id: string; json: string; shownAt: number } | null
  /** Approval cards on screen: tool id → what answers the CLI. */
  approvals: Map<string, (allow: boolean) => void>
  /** Calls the user approved that the tool has not yet made. */
  grants: Set<string>
  stderr: string
}

export function describeContext(
  context: ViewerContext,
  connections: Connections,
  library: Library
): string {
  const all = connections.list()
  const active = all.find((item) => item.id === context.connectionId)
  const lines = [
    active
      ? `connection: ${active.name} (id ${active.id}, ${active.engine})`
      : `connection: none selected (${all.length} set up)`,
  ]
  if (active?.access === "read_only") {
    lines.push(
      "access: READ-ONLY in Vey Lens — no INSERT, UPDATE, DELETE or DDL. Do not propose or attempt changes; explain that the connection is read-only if one is asked for."
    )
  }
  if (active) {
    const rules = describePermissions(active.permissions, active.access)
    if (rules.length && active.access !== "read_only") {
      lines.push(`permissions in Vey Lens (refused if broken): ${rules.join("; ")}`)
    }
    const knowledge = library.knowledge(active.id)
    const metrics = knowledge.metrics.length
    lines.push(
      `business context: ${knowledge.notes.trim() ? "notes written" : "no notes"}, ${metrics} ${metrics === 1 ? "metric" : "metrics"} defined`
    )
  }
  const ai = library.aiSettings()
  if (ai.language) {
    lines.push(
      `answer language (set in Settings): ${ai.language} — write every answer in it, whatever language the message is in; SQL, names and values stay as they are`
    )
  }
  if (ai.keywordCase !== "keep") {
    lines.push(`SQL style (set in Settings): keywords in ${ai.keywordCase === "upper" ? "UPPER" : "lower"} case`)
  }
  const off = TOOL_CATALOG.filter((item) => library.toolMode(item.name) === "off")
  if (off.length) {
    lines.push(
      `tools turned off in Settings: ${off.map((item) => item.name).join(", ")}`
    )
  }
  const skills = library.skills().filter((item) => item.enabled)
  if (skills.length) {
    lines.push(
      `skills (read one with get_skill before using it):\n${skills
        .map((item) => `- ${item.name}: ${item.description}`)
        .join("\n")}`
    )
  }
  const tab = context.tab
  if (tab?.kind === "table") {
    lines.push(`tab: table ${tab.schema}.${tab.table}`)
  } else if (tab?.kind === "query") {
    lines.push(`tab: SQL editor containing:\n${tab.sql.slice(0, 4000)}`)
  } else if (tab?.kind === "dashboard") {
    lines.push(
      `tab: dashboard "${tab.title}" with tiles: ${tab.tiles.join(", ") || "none"}`
    )
  } else if (tab?.kind === "knowledge") {
    lines.push("tab: the business context editor (notes and metrics)")
  } else if (tab?.kind === "diagram") {
    lines.push(`tab: the diagram of schema ${tab.schema} (its tables and the foreign keys between them)`)
  } else if (tab?.kind === "queries") {
    lines.push(`tab: the query inspector of the gateway "${tab.gateway}" (statements an app under development ran through it)`)
  } else if (tab?.kind === "alerts") {
    lines.push("tab: the alerts page (numbers checked in the background, with a notification when out of bounds)")
  } else {
    lines.push("tab: none open")
  }
  const mentioned = describeMentions(context.mentions ?? [], connections, library)
  if (mentioned.length) {
    lines.push(`mentioned with @ in this message:\n${mentioned.join("\n")}`)
  }
  return `<viewer>\n${lines.join("\n")}\n</viewer>`
}

/**
 * What each `@` in the message names, looked up again here rather than taken
 * on the renderer's word: a dashboard renamed or a connection deleted since
 * the menu was drawn is said to be gone, not described from a stale copy.
 */
export function describeMentions(
  mentions: NonNullable<ViewerContext["mentions"]>,
  connections: Connections,
  library: Library
): string[] {
  const all = connections.list()
  const lines: string[] = []
  for (const { token, ref } of mentions.slice(0, 20)) {
    const connection = all.find((item) => item.id === ref.connectionId)
    const on = connection ? ` on connection ${connection.name} (id ${connection.id})` : ""
    if (!connection) {
      lines.push(`- ${token} → a ${ref.kind} on a connection that no longer exists`)
      continue
    }
    switch (ref.kind) {
      case "table":
      case "view":
        lines.push(`- ${token} → ${ref.kind} ${ref.schema ? `${ref.schema}.` : ""}${ref.name}${on}`)
        break
      case "dashboard": {
        const dashboard = library.dashboards().find((item) => item.id === ref.id)
        lines.push(
          dashboard
            ? `- ${token} → dashboard "${dashboard.title}" (id ${dashboard.id})${on}, tiles: ${
                dashboard.tiles.map((tile) => tile.title).join(", ") || "none"
              }`
            : `- ${token} → a dashboard that has since been deleted`
        )
        break
      }
      case "metric": {
        const metric = library
          .knowledge(connection.id)
          .metrics.find((item) => item.id === ref.id)
        lines.push(
          metric
            ? `- ${token} → metric "${metric.name}"${on}${
                metric.description ? `: ${metric.description}` : ""
              }\n  computed as: ${metric.sql.slice(0, 1500)}`
            : `- ${token} → a metric that has since been removed`
        )
        break
      }
      case "connection":
        lines.push(
          `- ${token} → connection ${connection.name} (id ${connection.id}, ${connection.engine}${
            connection.access === "read_only" ? ", read-only" : ""
          }) — use it for this request instead of the default`
        )
        break
    }
  }
  return lines
}

/** The start of an answer as one line of plain text: no Markdown marks. */
export function plainPreview(markdown: string, length = 140): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === "text" ? (block.text ?? "") : ""
    )
    .join("")
}

/**
 * The conversations: what was said, kept on disk, and the `claude` behind
 * each one that is currently open.
 *
 * A session, not a process per message: `query()` is given a prompt that
 * never ends, so the CLI and its in-process tools stay up between turns and a
 * follow-up question does not pay for a start. The tools are served from this
 * process — the CLI itself is given none of its own, so the agent can reach
 * the databases and nothing else on this machine.
 */
export class Chats {
  private readonly chats = new Map<string, Stored>()
  private readonly live = new Map<string, Live>()
  private readonly busy = new Set<string>()
  private readonly directory: string
  private readonly workspace: string
  /** The pictures sent in any chat, one file each — see `ChatItem`. */
  private readonly pictures: string

  constructor(
    dataDir: string,
    private readonly connections: Connections,
    private readonly library: Library,
    private readonly emit: (event: ChatEvent) => void,
    private readonly audit?: AuditLog,
    private readonly alerts?: Alerts
  ) {
    this.directory = path.join(dataDir, "chats")
    // Where each `claude` runs: an empty directory of this app's own, so the
    // session finds no project files, no CLAUDE.md and no `.mcp.json`.
    this.workspace = path.join(dataDir, "agent")
    this.pictures = path.join(dataDir, "chat-images")
    mkdirSync(this.directory, { recursive: true })
    mkdirSync(this.workspace, { recursive: true })

    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue
      try {
        const chat = JSON.parse(
          readFileSync(path.join(this.directory, name), "utf8")
        ) as Stored
        // A call that was mid-flight when the app closed will never finish.
        for (const item of chat.items) {
          if (
            item.kind === "tool" &&
            (item.status === "running" || item.status === "awaiting")
          ) {
            item.status = "error"
            item.output ??= "Interrupted."
            item.writing = false
          }
        }
        this.chats.set(chat.id, chat)
      } catch {
        // A file that cannot be read is skipped, not fatal.
      }
    }
  }

  // ── Records ──────────────────────────────────────────────────────────────

  private summary(chat: Stored): ChatSummary {
    let preview = ""
    let turns = 0
    const did = { chart: false, dashboard: false, change: false }
    for (const item of chat.items) {
      if (item.kind === "user") turns++
      else if (item.kind === "assistant" && item.text.trim()) preview = item.text
      else if (item.kind === "chart") did.chart = true
      else if (item.kind === "tool" && item.status === "done") {
        if (DASHBOARD_TOOLS.has(item.tool)) {
          did.dashboard = true
        } else if (item.tool === "execute_sql" || item.tool === "execute_plan") {
          did.change = true
        } else if (item.tool === "show_chart") {
          did.chart = true
        }
      }
    }
    return {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      busy: this.busy.has(chat.id),
      preview: plainPreview(preview),
      turns,
      did,
    }
  }

  private persist(chat: Stored): void {
    writeFileSync(
      path.join(this.directory, `${chat.id}.json`),
      JSON.stringify(chat)
    )
  }

  private find(chatId: string): Stored {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error("That chat no longer exists.")
    return chat
  }

  list(): ChatSummary[] {
    return [...this.chats.values()]
      .filter((chat) => chat.items.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat) => this.summary(chat))
  }

  create(): Chat {
    const now = Date.now()
    const chat: Stored = {
      id: randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      items: [],
    }
    // Not written until something is said in it.
    this.chats.set(chat.id, chat)
    return { ...this.summary(chat), items: [] }
  }

  get(chatId: string): Chat | null {
    const chat = this.chats.get(chatId)
    return chat ? { ...this.summary(chat), items: chat.items } : null
  }

  delete(chatId: string): void {
    this.closeLive(chatId)
    const chat = this.chats.get(chatId)
    this.chats.delete(chatId)
    this.busy.delete(chatId)
    rmSync(path.join(this.directory, `${chatId}.json`), { force: true })
    for (const item of chat?.items ?? []) {
      if (item.kind !== "user") continue
      for (const name of item.images ?? []) {
        rmSync(path.join(this.pictures, name), { force: true })
      }
    }
  }

  /** A sent picture, for the transcript to draw. Only a name this class gave
   * out is read: the renderer does not get to name a path. */
  image(name: string): string | null {
    const match = PICTURE_NAME.exec(name)
    if (!match) return null
    const type = (Object.keys(EXTENSION) as ChatImageType[]).find(
      (key) => EXTENSION[key] === match[1]
    )
    try {
      const data = readFileSync(path.join(this.pictures, name)).toString("base64")
      return `data:${type};base64,${data}`
    } catch {
      return null
    }
  }

  /** Each picture written to a file of its own, by the name the user line
   * keeps. A write that fails costs the transcript that thumbnail and nothing
   * else: the bytes still go to the model. */
  private keepImages(images: ChatImage[]): string[] {
    mkdirSync(this.pictures, { recursive: true })
    return images.flatMap((image) => {
      const name = `${randomUUID()}.${EXTENSION[image.mediaType]}`
      try {
        writeFileSync(path.join(this.pictures, name), Buffer.from(image.data, "base64"))
        return [name]
      } catch {
        return []
      }
    })
  }

  private put(chat: Stored, item: ChatItem): void {
    const index = chat.items.findIndex((existing) => existing.id === item.id)
    if (index === -1) chat.items.push(item)
    else chat.items[index] = item
    this.emit({ type: "item", chatId: chat.id, item })
  }

  private setBusy(chat: Stored, busy: boolean): void {
    if (busy) this.busy.add(chat.id)
    else this.busy.delete(chat.id)
    chat.updatedAt = Date.now()
    this.emit({ type: "summary", chat: this.summary(chat) })
    if (!busy) this.persist(chat)
  }

  private fail(chat: Stored, text: string): void {
    this.put(chat, { kind: "error", id: randomUUID(), text })
  }

  private tool(chat: Stored, id: string) {
    const item = chat.items.find((existing) => existing.id === id)
    return item?.kind === "tool" ? item : null
  }

  private setToolStatus(chat: Stored, id: string, status: ToolStatus): void {
    const item = this.tool(chat, id)
    if (item) this.put(chat, { ...item, status })
  }

  // ── Talking ──────────────────────────────────────────────────────────────

  async status(): Promise<AgentStatus> {
    const binary = await locateClaude()
    return binary
      ? { ok: true, path: binary.path }
      : { ok: false, error: NOT_INSTALLED }
  }

  async send(input: SendInput): Promise<void> {
    const chat = this.find(input.chatId)
    const text = input.text.trim()
    if (!text) return
    if (this.busy.has(chat.id)) {
      throw new Error("Wait for the current answer, or stop it first.")
    }
    const images = input.images ?? []
    if (images.length > MAX_IMAGES) {
      throw new Error(`At most ${MAX_IMAGES} pictures go in one message.`)
    }
    for (const [index, image] of images.entries()) {
      const problem = imageProblem(image)
      if (problem) throw new Error(`Image #${index + 1}: ${problem}.`)
    }

    if (!chat.items.some((item) => item.kind === "user")) {
      const line = text.split("\n")[0] ?? text
      chat.title =
        line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line
    }
    const kept = images.length ? this.keepImages(images) : []
    this.put(chat, {
      kind: "user",
      id: randomUUID(),
      text,
      ...(kept.length === images.length && kept.length > 0 && { images: kept }),
    })
    this.setBusy(chat, true)

    try {
      const live = await this.open(chat, input.model, input.effort)
      live.interrupted = false
      live.inbox.push(
        `${describeContext(input.context, this.connections, this.library)}\n\n${text}`,
        images
      )
    } catch (error) {
      this.fail(chat, error instanceof Error ? error.message : String(error))
      this.setBusy(chat, false)
    }
  }

  async stop(chatId: string): Promise<void> {
    const live = this.live.get(chatId)
    if (!live) return
    live.interrupted = true
    for (const answer of [...live.approvals.values()]) answer(false)
    await live.query.interrupt().catch(() => {})
  }

  answerApproval(chatId: string, toolId: string, allow: boolean): void {
    this.live.get(chatId)?.approvals.get(toolId)?.(allow)
  }

  closeAll(): void {
    for (const chatId of [...this.live.keys()]) this.closeLive(chatId)
  }

  private closeLive(chatId: string): void {
    const live = this.live.get(chatId)
    if (!live) return
    this.live.delete(chatId)
    live.closed = true
    if (live.idle) clearTimeout(live.idle)
    for (const answer of [...live.approvals.values()]) answer(false)
    live.inbox.close()
    try {
      live.query.close()
    } catch {
      // Already gone.
    }
  }

  /** The chat's running session, started (or resumed) if there is none. */
  private async open(
    chat: Stored,
    model: string | null,
    effort: ChatEffort | null
  ): Promise<Live> {
    const existing = this.live.get(chat.id)
    if (existing) {
      if (existing.idle) clearTimeout(existing.idle)
      existing.idle = null
      // Both change on the running session, as Vey's do: no new process.
      if (existing.model !== model) {
        await existing.query.setModel(model ?? undefined)
        existing.model = model
      }
      if (existing.effort !== effort) {
        await existing.query.applyFlagSettings({ effortLevel: effort })
        existing.effort = effort
      }
      return existing
    }

    const binary = await locateClaude()
    if (!binary) throw new Error(NOT_INSTALLED)

    const inbox = new Inbox()
    const live: Live = {
      inbox,
      // Assigned just below; the callbacks that read it only run later.
      query: undefined as unknown as Query,
      model,
      effort,
      idle: null,
      closed: false,
      interrupted: false,
      streamed: new Set(),
      streamingMessage: null,
      streamingItem: null,
      writingTool: null,
      approvals: new Map(),
      grants: new Set(),
      stderr: "",
    }

    const tools = createDbTools({
      connections: this.connections,
      library: this.library,
      ...(this.alerts ? { alerts: this.alerts } : {}),
      takeGrant: (tool, args) => live.grants.delete(grantKey(tool, args)),
      open: (target) => this.emit({ type: "open", chatId: chat.id, target }),
      changed: (connectionId) =>
        this.emit({ type: "changed", chatId: chat.id, connectionId }),
      chart: (item) =>
        this.put(chat, { kind: "chart", id: randomUUID(), ...item }),
    })

    live.query = query({
      prompt: inbox.stream(),
      options: {
        cwd: this.workspace,
        pathToClaudeCodeExecutable: binary.path,
        env: claudeEnvironment(binary),
        ...(chat.sessionId ? { resume: chat.sessionId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        systemPrompt: SYSTEM_PROMPT,
        // None of the CLI's own tools: no shell, no files, no web. What is
        // left is the database tools served from this process.
        tools: [],
        mcpServers: { [TOOL_SERVER]: tools },
        strictMcpConfig: true,
        // The user's own settings, for their login and endpoint; not a
        // project's, since there is no project. The mode is said out loud so
        // a `defaultMode` in those settings cannot skip the approval card.
        settingSources: ["user"],
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool: this.deciding(chat, live),
        stderr: (data) => {
          live.stderr = (live.stderr + data).slice(-4000)
        },
      },
    })

    this.live.set(chat.id, live)
    void this.pump(chat, live)
    return live
  }

  /**
   * What the CLI asks before every tool call. Reads are let through; a tool
   * that changes something puts a card in the chat and waits for the answer.
   */
  private deciding(chat: Stored, live: Live): CanUseTool {
    return async (toolName, input, { toolUseID, signal }) => {
      if (!toolName.startsWith(TOOL_PREFIX)) {
        return {
          behavior: "deny",
          message: "Only the database tools are available here.",
        }
      }
      const name = toolName.slice(TOOL_PREFIX.length)
      const mode = this.library.toolMode(name)
      if (mode === "off") {
        return {
          behavior: "deny",
          message: `The user turned ${name} off in Settings › Tools. Do not try another way to do the same; tell them it is off.`,
        }
      }
      if (!APPROVAL_TOOLS.has(name)) {
        return { behavior: "allow", updatedInput: input }
      }
      // Allowed outright in Settings. Never a change to the database: those
      // tools cannot be given "allow", and the catalogue is checked on save.
      if (mode === "allow" && !WRITE_TOOLS.has(name)) {
        live.grants.add(grantKey(name, input))
        return { behavior: "allow", updatedInput: input }
      }

      // A write to a read-only connection is refused here, before a card is
      // put up for something that could not run anyway.
      if (name === "execute_sql" || name === "execute_plan") {
        const reference = String(input.connection ?? "")
        const target = this.connections
          .list()
          .find(
            (item) =>
              item.id === reference ||
              item.name.toLowerCase() === reference.trim().toLowerCase()
          )
        if (target?.access === "read_only") {
          return {
            behavior: "deny",
            message: `"${target.name}" is read-only in Vey Lens: nothing can be changed through it. Tell the user, and do not try another way.`,
          }
        }
        // And one its permissions block: a kind of statement, a table
        // hidden or read-only, an UPDATE without WHERE.
        if (target) {
          const statements =
            name === "execute_plan" && Array.isArray(input.statements)
              ? input.statements.map(String)
              : [String(input.sql ?? "")]
          const context = {
            permissions: forAssistant(target.permissions),
            access: target.access,
            engine: target.engine,
            defaultSchema: defaultSchemaOf(target),
          }
          const reasons = [
            ...new Set(
              statements.flatMap((sql) => {
                const verdict = judge(sql, context)
                return verdict.rule === "block" ? verdict.reasons : []
              })
            ),
          ]
          if (reasons.length) {
            return {
              behavior: "deny",
              message: `Refused by the permissions of "${target.name}": ${reasons.join(" ")} Tell the user what was refused and why; they set these in Settings › Permissions. Do not try another way to do the same.`,
            }
          }
        }
      }

      const existing = this.tool(chat, toolUseID)
      this.put(chat, {
        kind: "tool",
        id: toolUseID,
        tool: name,
        output: null,
        ...existing,
        // The input as the CLI hands it over, not what was read while it was written.
        input,
        writing: false,
        status: "awaiting",
      })

      const allow = await new Promise<boolean>((resolve) => {
        live.approvals.set(toolUseID, resolve)
        signal.addEventListener("abort", () => resolve(false), { once: true })
      })
      live.approvals.delete(toolUseID)

      if (!allow) {
        this.setToolStatus(chat, toolUseID, "denied")
        return {
          behavior: "deny",
          message:
            "The user declined this. Do not retry it; ask what they would like instead.",
        }
      }

      live.grants.add(grantKey(name, input))
      this.setToolStatus(chat, toolUseID, "running")
      return { behavior: "allow", updatedInput: input }
    }
  }

  /** A tool call's input as far as it has been written. */
  private showWriting(chat: Stored, id: string, json: string): void {
    const item = this.tool(chat, id)
    if (!item?.writing) return
    const input = readPartialJson(json)
    if (input) this.put(chat, { ...item, input })
  }

  /** A call that read data or changed something, into the audit log. */
  private keep(chat: Stored, item: ToolItem): void {
    if (!this.audit) return
    const action = AUDITED[item.tool]
    if (!action) return
    const input = item.input
    const reference = String(input.connection ?? "").trim()
    const target = this.connections
      .list()
      .find((entry) => entry.id === reference || entry.name.toLowerCase() === reference.toLowerCase())
    const output = item.output ?? ""
    const status: AuditStatus =
      item.status === "denied"
        ? "declined"
        : item.status === "error"
          ? refusal(output)
            ? "refused"
            : "failed"
          : "ok"
    const sql = Array.isArray(input.statements)
      ? input.statements.map(String).join(";\n\n")
      : typeof input.sql === "string"
        ? input.sql
        : typeof input.options_sql === "string"
          ? input.options_sql
          : undefined
    this.audit.record({
      actor: "assistant",
      action,
      tool: item.tool,
      connectionId: target?.id ?? null,
      connectionName: target?.name ?? (reference || null),
      summary: auditSummary(item.tool, input),
      ...(sql ? { sql } : {}),
      status,
      ...(output ? { detail: output } : {}),
      chatId: chat.id,
    })
  }

  /** Reads the session until it ends, turning its messages into chat items. */
  private async pump(chat: Stored, live: Live): Promise<void> {
    try {
      for await (const message of live.query) {
        this.read(chat, live, message)
      }
      if (!live.closed && this.busy.has(chat.id)) {
        this.fail(chat, "Claude stopped before answering.")
      }
    } catch (error) {
      if (!live.closed) {
        const text = [
          error instanceof Error ? error.message : String(error),
          live.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n\n")
        // A turn that ended in an error is followed by the process exiting
        // with the same words; once is enough.
        const last = chat.items.at(-1)
        if (!(last?.kind === "error" && text.includes(last.text))) {
          this.fail(chat, text)
        }
        // A conversation the CLI no longer has cannot be resumed again.
        if (/no conversation found/i.test(text)) chat.sessionId = null
      }
    } finally {
      if (this.live.get(chat.id) === live) this.closeLive(chat.id)
      if (this.chats.has(chat.id) && this.busy.has(chat.id)) {
        this.setBusy(chat, false)
      }
    }
  }

  private read(chat: Stored, live: Live, message: SDKMessage): void {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") chat.sessionId = message.session_id
        return
      }

      // The reply as it is written. The complete message follows and is
      // where tool calls are read from; its text is skipped as already drawn.
      case "stream_event": {
        if (message.parent_tool_use_id) return
        const event = message.event
        if (event.type === "message_start") {
          live.streamingMessage = event.message.id
        } else if (
          event.type === "content_block_start" &&
          event.content_block.type === "text"
        ) {
          if (live.streamingMessage) live.streamed.add(live.streamingMessage)
          live.streamingItem = randomUUID()
          this.put(chat, {
            kind: "assistant",
            id: live.streamingItem,
            text: event.content_block.text ?? "",
          })
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          live.streamingItem
        ) {
          const item = chat.items.find(
            (existing) => existing.id === live.streamingItem
          )
          if (item?.kind === "assistant") {
            item.text += event.delta.text
            this.emit({
              type: "delta",
              chatId: chat.id,
              itemId: item.id,
              text: event.delta.text,
            })
          }
        } else if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use" &&
          event.content_block.name.startsWith(TOOL_PREFIX)
        ) {
          // Writing a long statement takes the model a second or more: the
          // call is on screen from its first word, not once it is whole.
          const block = event.content_block
          live.writingTool = { id: block.id, json: "", shownAt: 0 }
          if (!this.tool(chat, block.id)) {
            this.put(chat, {
              kind: "tool",
              id: block.id,
              tool: block.name.slice(TOOL_PREFIX.length),
              input: {},
              status: "running",
              output: null,
              writing: true,
            })
          }
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta" &&
          live.writingTool
        ) {
          const writing = live.writingTool
          writing.json += event.delta.partial_json
          const now = Date.now()
          if (now - writing.shownAt > 80) {
            writing.shownAt = now
            this.showWriting(chat, writing.id, writing.json)
          }
        } else if (event.type === "content_block_stop") {
          if (live.writingTool) {
            this.showWriting(chat, live.writingTool.id, live.writingTool.json)
            live.writingTool = null
          }
          live.streamingItem = null
        }
        return
      }

      case "assistant": {
        if (message.parent_tool_use_id) return
        const streamed = live.streamed.has(message.message.id)
        for (const block of message.message.content) {
          if (block.type === "text" && !streamed && block.text.trim()) {
            this.put(chat, {
              kind: "assistant",
              id: randomUUID(),
              text: block.text,
            })
          } else if (block.type === "tool_use") {
            // The approval card may have got here first; it knows more.
            const existing = this.tool(chat, block.id)
            if (existing) {
              // Written in full now: the input as sent, not as read mid-way.
              if (existing.writing) {
                this.put(chat, {
                  ...existing,
                  input: (block.input ?? {}) as Record<string, unknown>,
                  writing: false,
                })
              }
              continue
            }
            this.put(chat, {
              kind: "tool",
              id: block.id,
              tool: block.name.startsWith(TOOL_PREFIX)
                ? block.name.slice(TOOL_PREFIX.length)
                : block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
              status: "running",
              output: null,
            })
          }
        }
        return
      }

      case "user": {
        const content = message.message.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (block.type !== "tool_result") continue
          const item = this.tool(chat, block.tool_use_id)
          if (!item) continue
          const done: ToolItem = {
            ...item,
            writing: false,
            output: textOf(block.content),
            status:
              item.status === "denied"
                ? "denied"
                : block.is_error
                  ? "error"
                  : "done",
          }
          this.put(chat, done)
          this.keep(chat, done)
        }
        return
      }

      case "result": {
        const failed = message.subtype !== "success" || message.is_error
        if (failed && !live.interrupted) {
          const text =
            message.subtype === "success"
              ? message.result
              : message.errors.join("\n")
          this.fail(chat, text || "The turn ended with an error.")
          if (/no conversation found/i.test(text)) chat.sessionId = null
        }
        // Whatever was still drawn as running did not finish.
        for (const item of chat.items) {
          if (
            item.kind === "tool" &&
            (item.status === "running" || item.status === "awaiting")
          ) {
            this.put(chat, {
              ...item,
              status: "error",
              output: item.output ?? "Stopped.",
              writing: false,
            })
          }
        }
        live.interrupted = false
        live.streamed.clear()
        live.streamingItem = null
        live.writingTool = null
        this.setBusy(chat, false)
        live.idle = setTimeout(() => this.closeLive(chat.id), IDLE_MS)
        live.idle.unref?.()
        return
      }
    }
  }
}
