/**
 * What the assistant can do, as the Settings dialog shows it and the main
 * process enforces it: the skills that ship with the app, and its tools with
 * the permission each one may be given. Shared so that both sides read one
 * list — the renderer to draw it, the main process to check what it is sent.
 */

// ── Built-in skills ────────────────────────────────────────────────────────

export type BuiltinSkill = {
  /** `builtin:` and a slug, so it can never collide with a saved skill's id. */
  id: string
  name: string
  description: string
  instructions: string
}

export const isBuiltinSkillId = (id: string | null) =>
  !!id && id.startsWith("builtin:")

/**
 * The methods the system prompt used to carry whole. As skills they can be
 * read, rewritten to a team's own way, switched off, and reset; the agent
 * reads one with `get_skill` when a request matches its description.
 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: "builtin:dashboard",
    name: "Build a dashboard",
    description:
      "When asked to build a dashboard, or to keep a chart or figure to look at again.",
    instructions: `Build it like an analyst would:

1. **Filters first** (add_dashboard_filter): almost always a date range named "date", plus a select for the one or two dimensions people slice by.
2. **Then tiles** (add_to_dashboard), each written to respect the filters with [[ … ]] clauses so it still runs on All:
   - a row of kpi tiles (width 1, height s) for the headline figures;
   - the main trend wide (width 4);
   - breakdowns beside each other (width 2);
   - a detail table last.
   Give charts of categories a drill_sql that lists the rows behind a category.
3. A text tile only where a heading helps.
4. Then open it with open_in_viewer.`,
  },
  {
    id: "builtin:diagnose",
    name: "Diagnose a change",
    description:
      'When asked why a figure changed or what is driving it ("why did revenue drop in June?", "what is driving churn?").',
    instructions: `1. **Confirm the change.** Compute the figure for the period in question and for the comparison period (the previous period, and the same period a year earlier when there is data), and state both and the difference.
2. **Decompose it.** Break the figure down by each dimension the data offers — product or category, region, channel, customer segment, new vs returning — and for each, how much of the total change it accounts for. Also split it into its drivers where it is a product (revenue = orders × average order value; orders = visitors × conversion).
3. **Follow the biggest contributors** one level deeper. Check for data problems too: missing days, a status that changed meaning, duplicates.
4. **Conclude:** the main causes, each with its numbers and share of the change, shown with charts where they help; what the data cannot tell; and concrete next steps. Separate what the data shows from what you infer.`,
  },
  {
    id: "builtin:chart",
    name: "Choose a chart",
    description:
      "Before drawing a chart with show_chart or adding a chart tile, to pick its form.",
    instructions: `- **line** for change over time; **bar** for a few categories; **hbar** for ranked or part-to-whole (there is no pie); **stat** for a single figure.
- A headline figure with its change is a **kpi**; against a goal or a budget, a **progress** (with target); a figure by two dimensions is a **pivot**.
- Ordered steps people drop out of (visit → signup → order) are a **funnel**; a figure going from one value to another through its parts (last month + new − churn = this month) is a **waterfall**.
- Whether two measures move together (price and quantity, per customer or per product) is a **scatter**.
- A result in long form (GROUP BY month, channel) is drawn with **series** rather than reshaped in SQL.
- One unit per chart: two measures of different scale are two charts.
- Aggregate in SQL first.`,
  },
]

// ── Tools ──────────────────────────────────────────────────────────────────

/**
 * `allow` runs it without asking, `ask` puts a card in the chat first, `off`
 * refuses it and tells the assistant so.
 */
export const TOOL_MODES = ["allow", "ask", "off"] as const

export type ToolMode = (typeof TOOL_MODES)[number]

export type ToolGroup = "Read" | "Show" | "Dashboards" | "Remember" | "Change data"

export type ToolInfo = {
  /** As the agent calls it, without the MCP prefix. */
  name: string
  label: string
  description: string
  group: ToolGroup
  /**
   * The modes it may be given. One mode is a tool the assistant cannot work
   * without. A tool that changes the database never takes `allow`: whatever
   * is set here, every change is shown before it runs.
   */
  modes: readonly ToolMode[]
  default: ToolMode
}

const ALWAYS = ["allow"] as const
const OPTIONAL = ["allow", "off"] as const
const APPROVED = ["allow", "ask", "off"] as const
const WRITES = ["ask", "off"] as const

export const TOOL_CATALOG: ToolInfo[] = [
  {
    name: "list_connections",
    label: "List connections",
    description: "The connections you set up, with their engine and access.",
    group: "Read",
    modes: ALWAYS,
    default: "allow",
  },
  {
    name: "list_tables",
    label: "List tables",
    description: "The tables and views of a connection.",
    group: "Read",
    modes: ALWAYS,
    default: "allow",
  },
  {
    name: "describe_table",
    label: "Describe tables",
    description: "Columns, types, keys and foreign keys.",
    group: "Read",
    modes: ALWAYS,
    default: "allow",
  },
  {
    name: "get_skill",
    label: "Read skills",
    description: "The instructions of a skill that is switched on.",
    group: "Read",
    modes: ALWAYS,
    default: "allow",
  },
  {
    name: "run_query",
    label: "Run queries",
    description:
      "Read-only SELECTs, in a read-only transaction. Off, the assistant can only look at the schema.",
    group: "Read",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "get_business_context",
    label: "Read business context",
    description: "Your notes and metrics for a connection.",
    group: "Read",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "get_dashboard",
    label: "Read dashboards",
    description: "A dashboard's tiles, filters and SQL.",
    group: "Read",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "show_chart",
    label: "Draw charts",
    description: "Charts in the chat, from a read-only query.",
    group: "Show",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "open_in_viewer",
    label: "Open in the viewer",
    description: "Opens a table, a query or a dashboard in a tab beside the chat.",
    group: "Show",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "add_to_dashboard",
    label: "Add dashboard tiles",
    description: "Creates a dashboard, or adds tiles to one.",
    group: "Dashboards",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "add_dashboard_filter",
    label: "Add dashboard filters",
    description: "Date ranges and choices above a dashboard's tiles.",
    group: "Dashboards",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "edit_dashboard_tile",
    label: "Edit dashboard tiles",
    description: "Changes a tile's title, SQL, chart, size, drill-down or place.",
    group: "Dashboards",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "edit_dashboard",
    label: "Rename dashboards",
    description: "A dashboard's title, and how often it refreshes.",
    group: "Dashboards",
    modes: OPTIONAL,
    default: "allow",
  },
  {
    name: "remove_from_dashboard",
    label: "Remove tiles and filters",
    description: "Takes a tile or a filter off a dashboard.",
    group: "Dashboards",
    modes: APPROVED,
    default: "ask",
  },
  {
    name: "delete_dashboard",
    label: "Delete dashboards",
    description: "Deletes a whole dashboard with its tiles and filters.",
    group: "Dashboards",
    modes: APPROVED,
    default: "ask",
  },
  {
    name: "save_metric",
    label: "Save metrics",
    description: "Adds or replaces a metric in a connection's business context.",
    group: "Remember",
    modes: APPROVED,
    default: "ask",
  },
  {
    name: "append_note",
    label: "Add notes",
    description: "Appends to a connection's business-context notes.",
    group: "Remember",
    modes: APPROVED,
    default: "ask",
  },
  {
    name: "execute_sql",
    label: "Run a statement",
    description:
      "One INSERT, UPDATE, DELETE or DDL statement. Always shown to you before it runs; refused on a read-only connection.",
    group: "Change data",
    modes: WRITES,
    default: "ask",
  },
  {
    name: "execute_plan",
    label: "Run a plan",
    description:
      "Several statements in one transaction, approved once as a whole. Refused on a read-only connection.",
    group: "Change data",
    modes: WRITES,
    default: "ask",
  },
]

export const toolInfo = (name: string) =>
  TOOL_CATALOG.find((item) => item.name === name)

/** The mode a tool runs in: what was set, if that is still one it may take. */
export function effectiveToolMode(
  name: string,
  saved: Partial<Record<string, ToolMode>>
): ToolMode {
  const info = toolInfo(name)
  if (!info) return "allow"
  const mode = saved[name]
  return mode && info.modes.includes(mode) ? mode : info.default
}

/**
 * JSON cut off mid-way — a tool's input as the model is still writing it —
 * read as far as it goes: an open string is closed, a key with no value yet
 * is dropped, open arrays and objects are closed. Null when it cannot be.
 */
export function readPartialJson(text: string): Record<string, unknown> | null {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") stack.push(char)
    else if (char === "}" || char === "]") stack.pop()
  }
  let body = text
  if (inString) {
    // A half-written escape (`\` or `\u00`) is left off, then the string closed.
    body = body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "") + '"'
  }
  body = body.trimEnd()
  // In an object, a last string after `{` or `,` is a key with no value yet.
  if (stack.at(-1) === "{") {
    body = body.replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, "$1")
  }
  body = body.replace(/,\s*$/, "")
  if (/:\s*$/.test(body)) body += "null"
  for (const open of [...stack].reverse()) body += open === "{" ? "}" : "]"
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
