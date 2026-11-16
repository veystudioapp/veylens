import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  AI_TASKS,
  CHAT_EFFORTS,
  DEFAULT_AI_SETTINGS,
  SQL_INSTRUCTIONS_MAX,
  SQL_KEYWORD_CASES,
  type AiModelChoice,
  type AiSettings,
  type ChatEffort,
  DATE_PRESETS,
  TEXT_MATCHES,
  isTextTile,
  type ChatEvent,
  type Dashboard,
  type DashboardFilter,
  type DashboardTile,
  type Knowledge,
  type Metric,
  type PinInput,
  ABBREVIATIONS,
  CHECK_ICONS,
  DATE_FORMATS,
  DURATION_FORMATS,
  RATING_ICONS,
  SEPARATORS,
  TIME_FORMATS,
  TONES,
  type FieldDisplay,
  type FieldSettings,
  type TableFields,
  type Tone,
  type Skill,
  type SkillInput,
  type TableRef,
  type ToolModes,
} from "../shared/api"
import {
  BUILTIN_SKILLS,
  effectiveToolMode,
  isBuiltinSkillId,
  toolInfo,
  type ToolMode,
} from "../shared/agent"
import { filterParams, numberOrNull, validParamName } from "../shared/params"

/** A skill of the user's own, as written to disk. */
type StoredSkill = Omit<Skill, "builtin" | "modified">

/** What the user changed of a built-in skill. */
type SkillOverride = Pick<Skill, "description" | "instructions" | "enabled" | "updatedAt">

type Stored = {
  knowledge: Record<string, Knowledge>
  dashboards: Dashboard[]
  skills: StoredSkill[]
  skillOverrides: Record<string, SkillOverride>
  toolModes: ToolModes
  /** Written before there were AI settings: none, the defaults. */
  ai?: AiSettings
  /** Connection → `["schema","table"]` as JSON → the table's field settings. */
  tableFields: Record<string, Record<string, TableFields>>
}

const tableKey = (ref: TableRef) => JSON.stringify([ref.schema, ref.table])

const wholeIn = (value: unknown, low: number, high: number, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new Error(`${what} must be a whole number from ${low} to ${high}.`)
  }
  return value
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback

const toneOr = (value: unknown, fallback: Tone): Tone => oneOf(TONES, value, fallback)

function locale(value: unknown): string {
  try {
    return Intl.getCanonicalLocales(String(value || "en-US"))[0] ?? "en-US"
  } catch {
    throw new Error(`"${String(value)}" is not a locale; try en-US or vi-VN.`)
  }
}

function timezone(value: unknown): string {
  const zone = String(value || "local")
  if (zone === "local") return zone
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    throw new Error(`"${zone}" is not a time zone; try UTC or Asia/Ho_Chi_Minh.`)
  }
}

function colours(value: unknown): Record<string, Tone> {
  const out: Record<string, Tone> = {}
  const entries = Object.entries((value ?? {}) as Record<string, unknown>)
  if (entries.length > 200) throw new Error("Colour at most 200 values.")
  for (const [key, tone] of entries) {
    if (key.length <= 200 && TONES.includes(tone as Tone)) out[key] = tone as Tone
  }
  return out
}

/** A select's values in their order: text, each once. */
function selectOptions(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("A select's options are a list.")
  const out = [...new Set(value.filter((item): item is string => typeof item === "string" && item !== ""))]
  if (out.length > 500) throw new Error("A select has at most 500 options.")
  if (out.some((item) => item.length > 200)) throw new Error("Keep each option under 200 characters.")
  return out
}

/**
 * A display as the renderer sent it, checked field by field and rebuilt, so
 * nothing but these shapes is ever written to the library. Shapes saved by
 * an earlier version (a `thousands` flag, a date `style`) are read into the
 * current ones.
 */
export function checkFieldDisplay(input: FieldDisplay): FieldDisplay {
  const raw = input as unknown as Record<string, unknown>
  switch (input?.type) {
    case "text":
    case "email":
    case "phone":
    case "url":
    case "image":
    case "colour":
      return { type: input.type }
    case "number":
      return {
        type: "number",
        decimals:
          raw.decimals === null || raw.decimals === undefined
            ? null
            : wholeIn(raw.decimals, 0, 8, "Decimals"),
        separator:
          "thousands" in raw && !("separator" in raw)
            ? raw.thousands
              ? "locale"
              : "none-period"
            : oneOf(SEPARATORS, raw.separator, "locale"),
        abbreviate: oneOf(ABBREVIATIONS, raw.abbreviate, "none"),
      }
    case "currency": {
      const code = String(raw.code ?? "").toUpperCase()
      if (!/^[A-Z]{3}$/.test(code)) throw new Error("A currency is a three-letter code, like USD.")
      return {
        type: "currency",
        code,
        locale: locale(raw.locale),
        decimals: wholeIn(raw.decimals ?? 2, 0, 8, "Decimals"),
        abbreviate: oneOf(ABBREVIATIONS, raw.abbreviate, "none"),
      }
    }
    case "percent":
      return {
        type: "percent",
        decimals: wholeIn(raw.decimals ?? 0, 0, 8, "Decimals"),
        scale: raw.scale === "fraction" ? "fraction" : "whole",
        progress: oneOf(["none", "bar", "circle"] as const, raw.progress, "none"),
      }
    case "date": {
      // An earlier version saved only a style.
      const style = raw.style as string | undefined
      const format = style
        ? style === "relative" || style === "iso"
          ? style
          : "locale"
        : oneOf(DATE_FORMATS, raw.format, "locale")
      return {
        type: "date",
        format,
        time: style
          ? style === "datetime"
            ? "HH:mm"
            : "none"
          : oneOf(TIME_FORMATS, raw.time, "none"),
        hour12: raw.hour12 === true,
        timezone: timezone(raw.timezone),
      }
    }
    case "duration":
      return {
        type: "duration",
        unit: raw.unit === "minutes" ? "minutes" : "seconds",
        format: oneOf(DURATION_FORMATS, raw.format, "h:mm:ss"),
      }
    case "select":
    case "multiselect": {
      const known = selectOptions(raw.options)
      return {
        type: input.type,
        colors: colours(raw.colors),
        ...(known.length ? { options: known } : {}),
        ...(raw.plain === true ? { plain: true } : {}),
        ...(raw.alphabetize === true ? { alphabetize: true } : {}),
      }
    }
    case "checkbox":
      return {
        type: "checkbox",
        icon: oneOf(CHECK_ICONS, raw.icon, "check"),
        color: toneOr(raw.color, "blue"),
      }
    case "rating":
      return {
        type: "rating",
        max: wholeIn(raw.max ?? 5, 1, 10, "The highest rating"),
        icon: oneOf(RATING_ICONS, raw.icon, "star"),
        color: toneOr(raw.color, "amber"),
      }
    case "progress": {
      const max = raw.max
      if (typeof max !== "number" || !(max > 0) || !Number.isFinite(max)) {
        throw new Error("A progress bar needs a maximum above zero.")
      }
      return { type: "progress", max }
    }
    default:
      throw new Error("That is not a way to show a field.")
  }
}

/** A field's settings, checked; null when nothing is left to keep. */
function checkFieldSettings(input: FieldSettings): FieldSettings | null {
  const out: FieldSettings = {}
  if (input.display) out.display = checkFieldDisplay(input.display)
  const description = (input.description ?? "").trim()
  if (description.length > 1000) throw new Error("Keep the description under 1,000 characters.")
  if (description) out.description = description
  return out.display || out.description ? out : null
}

const NO_FIELDS: TableFields = { fields: {}, displayColumn: null }

const EMPTY_KNOWLEDGE: Knowledge = { notes: "", metrics: [], updatedAt: 0 }

/** Past this, the notes stop being something the agent can read whole. */
export const NOTES_LIMIT = 20_000

/** One skill's instructions, read whole by the agent when it is used. */
export const SKILL_LIMIT = 20_000
/** A description goes out with every message, so it is kept to a line or two. */
export const SKILL_DESCRIPTION_LIMIT = 300

/**
 * Field settings as saved, including the shape an earlier version wrote —
 * `fieldDisplays`, a bare column → display map per table.
 */
function migrateFields(parsed: Record<string, unknown>): Record<string, Record<string, TableFields>> {
  const out: Record<string, Record<string, TableFields>> = {}
  const current = (parsed.tableFields ?? {}) as Record<string, Record<string, TableFields>>
  const legacy = (parsed.fieldDisplays ?? {}) as Record<string, Record<string, Record<string, FieldDisplay>>>
  for (const [connection, tables] of Object.entries(legacy)) {
    for (const [table, displays] of Object.entries(tables)) {
      const fields: Record<string, FieldSettings> = {}
      for (const [column, display] of Object.entries(displays)) {
        try {
          fields[column] = { display: checkFieldDisplay(display) }
        } catch {
          // A display that no longer reads is dropped, not fatal.
        }
      }
      ;(out[connection] ??= {})[table] = { fields, displayColumn: null }
    }
  }
  for (const [connection, tables] of Object.entries(current)) {
    out[connection] = { ...(out[connection] ?? {}), ...tables }
  }
  return out
}

/**
 * What the user has written down about their data — per connection, the
 * notes and the metrics — and the dashboards they built. One JSON file,
 * written whole: it is small, and a half-written file is worse than a lost
 * second.
 *
 * Both the renderer and the agent's tools change it, so every change is
 * announced: a dashboard the agent adds a tile to redraws where it is open.
 */
/** One task's model and effort, as saved: a name of reasonable length, an
 * effort the CLI knows. */
function checkChoice(choice: unknown, chat: boolean): AiModelChoice {
  const given = (choice ?? {}) as Partial<AiModelChoice>
  // Null: the chat inherits the CLI's own model; a task follows the chat.
  const model =
    typeof given.model === "string" && given.model.trim() && given.model.length <= 200
      ? given.model.trim()
      : chat && given.model !== null
        ? DEFAULT_AI_SETTINGS.models.chat.model
        : null
  const effort = CHAT_EFFORTS.includes(given.effort as ChatEffort)
    ? (given.effort as ChatEffort)
    : null
  // Following the chat, the chat's effort comes with it.
  return { model, effort: model === null ? null : effort }
}

/** AI settings as given, made sound: whatever is missing or wrong is the
 * default rather than a refusal — they are preferences, not data. */
export function checkAiSettings(settings: unknown): AiSettings {
  const given = (settings ?? {}) as Partial<AiSettings>
  const language =
    typeof given.language === "string" && given.language.trim() && given.language.length <= 60
      ? given.language.trim()
      : null
  const models = Object.fromEntries(
    AI_TASKS.map((task) => [task, checkChoice(given.models?.[task], task === "chat")])
  ) as AiSettings["models"]
  return {
    language,
    models,
    keywordCase: SQL_KEYWORD_CASES.includes(given.keywordCase as never)
      ? given.keywordCase!
      : "keep",
    sqlInstructions:
      typeof given.sqlInstructions === "string"
        ? given.sqlInstructions.slice(0, SQL_INSTRUCTIONS_MAX)
        : "",
  }
}

export class Library {
  private data: Stored = {
    knowledge: {},
    dashboards: [],
    skills: [],
    skillOverrides: {},
    toolModes: {},
    tableFields: {},
  }
  private readonly file: string

  constructor(
    dataDir: string,
    private readonly emit: (event: ChatEvent) => void
  ) {
    this.file = path.join(dataDir, "library.json")
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>
      this.data = {
        knowledge: parsed.knowledge ?? {},
        // Written before dashboards had filters and a refresh interval.
        dashboards: (parsed.dashboards ?? []).map((item) => ({
          ...item,
          filters: item.filters ?? [],
          refreshSeconds: item.refreshSeconds ?? 0,
        })),
        // Written before there were skills and tool settings.
        skills: parsed.skills ?? [],
        skillOverrides: parsed.skillOverrides ?? {},
        toolModes: parsed.toolModes ?? {},
        ...(parsed.ai ? { ai: checkAiSettings(parsed.ai) } : {}),
        tableFields: migrateFields(parsed),
      }
    } catch {
      // None yet, or unreadable: start empty rather than refuse to start.
    }
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data, null, 1))
    renameSync(temporary, this.file)
  }

  // ── Knowledge ────────────────────────────────────────────────────────────

  knowledge(connectionId: string): Knowledge {
    return this.data.knowledge[connectionId] ?? EMPTY_KNOWLEDGE
  }

  saveKnowledge(connectionId: string, input: Knowledge): Knowledge {
    const names = new Set<string>()
    const metrics: Metric[] = []
    for (const metric of input.metrics) {
      const name = metric.name.trim()
      if (!name) throw new Error("Every metric needs a name.")
      if (!metric.sql.trim()) throw new Error(`"${name}" needs its SQL.`)
      const key = name.toLowerCase()
      if (names.has(key)) throw new Error(`There are two metrics named "${name}".`)
      names.add(key)
      metrics.push({
        id: metric.id || randomUUID(),
        name,
        description: metric.description.trim(),
        sql: metric.sql.trim(),
      })
    }
    if (input.notes.length > NOTES_LIMIT) {
      throw new Error(
        `The notes are ${input.notes.length.toLocaleString()} characters; keep them under ${NOTES_LIMIT.toLocaleString()}.`
      )
    }
    const knowledge: Knowledge = {
      notes: input.notes,
      metrics,
      updatedAt: Date.now(),
    }
    this.data.knowledge[connectionId] = knowledge
    this.persist()
    this.emit({ type: "knowledge", connectionId, knowledge })
    return knowledge
  }

  /** A metric added, or the one of the same name replaced. */
  putMetric(connectionId: string, metric: Omit<Metric, "id">): Knowledge {
    const current = this.knowledge(connectionId)
    const existing = current.metrics.find(
      (item) => item.name.toLowerCase() === metric.name.trim().toLowerCase()
    )
    const next = existing
      ? current.metrics.map((item) =>
          item === existing ? { ...metric, id: existing.id } : item
        )
      : [...current.metrics, { ...metric, id: randomUUID() }]
    return this.saveKnowledge(connectionId, { ...current, metrics: next })
  }

  appendNote(connectionId: string, text: string): Knowledge {
    const current = this.knowledge(connectionId)
    const notes = current.notes.trim()
      ? `${current.notes.trimEnd()}\n\n${text.trim()}\n`
      : `${text.trim()}\n`
    return this.saveKnowledge(connectionId, { ...current, notes })
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  /** The built-in ones first, as overridden, then the user's own. */
  skills(): Skill[] {
    const builtin = BUILTIN_SKILLS.map((item): Skill => {
      const override = this.data.skillOverrides[item.id]
      return {
        id: item.id,
        name: item.name,
        description: override?.description ?? item.description,
        instructions: override?.instructions ?? item.instructions,
        enabled: override?.enabled ?? true,
        updatedAt: override?.updatedAt ?? 0,
        builtin: true,
        modified:
          !!override &&
          (override.description !== item.description ||
            override.instructions !== item.instructions),
      }
    })
    const own = this.data.skills.map(
      (item): Skill => ({ ...item, builtin: false, modified: false })
    )
    return [...builtin, ...own]
  }

  private skill(id: string): Skill {
    const found = this.skills().find((item) => item.id === id)
    if (!found) throw new Error("That skill no longer exists.")
    return found
  }

  /** An enabled skill by its name, as the agent refers to it. */
  findSkill(name: string): Skill | undefined {
    const key = name.trim().toLowerCase()
    return this.skills().find(
      (item) => item.enabled && item.name.toLowerCase() === key
    )
  }

  saveSkill(input: SkillInput): Skill {
    const builtin = BUILTIN_SKILLS.find((item) => item.id === input.id)
    const name = builtin ? builtin.name : input.name.trim()
    if (!name) throw new Error("A skill needs a name.")
    const description = input.description.trim()
    if (!description) {
      throw new Error("Say when to use it: the assistant decides by the description.")
    }
    if (description.length > SKILL_DESCRIPTION_LIMIT) {
      throw new Error(
        `Keep the description under ${SKILL_DESCRIPTION_LIMIT} characters; the details go in the instructions.`
      )
    }
    const instructions = input.instructions.trim()
    if (!instructions) throw new Error("A skill needs its instructions.")
    if (instructions.length > SKILL_LIMIT) {
      throw new Error(
        `The instructions are ${instructions.length.toLocaleString()} characters; keep them under ${SKILL_LIMIT.toLocaleString()}.`
      )
    }

    if (builtin) {
      this.data.skillOverrides[builtin.id] = {
        description,
        instructions,
        enabled: input.enabled,
        updatedAt: Date.now(),
      }
      this.persist()
      return this.skill(builtin.id)
    }
    if (isBuiltinSkillId(input.id)) throw new Error("That skill no longer exists.")

    const clash = this.skills().find(
      (item) => item.id !== input.id && item.name.toLowerCase() === name.toLowerCase()
    )
    if (clash) throw new Error(`There is already a skill named "${clash.name}".`)

    const stored: StoredSkill = {
      id: input.id ?? randomUUID(),
      name,
      description,
      instructions,
      enabled: input.enabled,
      updatedAt: Date.now(),
    }
    const index = this.data.skills.findIndex((item) => item.id === stored.id)
    if (input.id !== null && index === -1) {
      throw new Error("That skill no longer exists.")
    }
    this.data.skills =
      index === -1
        ? [...this.data.skills, stored]
        : this.data.skills.map((item, at) => (at === index ? stored : item))
    this.persist()
    return this.skill(stored.id)
  }

  deleteSkill(id: string): void {
    if (isBuiltinSkillId(id)) {
      throw new Error("A built-in skill can be switched off or reset, not deleted.")
    }
    this.data.skills = this.data.skills.filter((item) => item.id !== id)
    this.persist()
  }

  /** A built-in skill's text as it shipped; whether it is on is kept. */
  resetSkill(id: string): Skill {
    const builtin = BUILTIN_SKILLS.find((item) => item.id === id)
    if (!builtin) throw new Error("Only a built-in skill can be reset.")
    const enabled = this.data.skillOverrides[id]?.enabled ?? true
    if (enabled) delete this.data.skillOverrides[id]
    else {
      this.data.skillOverrides[id] = {
        description: builtin.description,
        instructions: builtin.instructions,
        enabled,
        updatedAt: Date.now(),
      }
    }
    this.persist()
    return this.skill(id)
  }

  // ── Field settings ───────────────────────────────────────────────────────

  tableFields(connectionId: string, ref: TableRef): TableFields {
    return this.data.tableFields[connectionId]?.[tableKey(ref)] ?? NO_FIELDS
  }

  private putTable(connectionId: string, ref: TableRef, next: TableFields): TableFields {
    const tables = { ...(this.data.tableFields[connectionId] ?? {}) }
    const key = tableKey(ref)
    if (Object.keys(next.fields).length || next.displayColumn !== null) tables[key] = next
    else delete tables[key]
    this.data.tableFields = { ...this.data.tableFields, [connectionId]: tables }
    this.persist()
    return next
  }

  setFieldSettings(
    connectionId: string,
    ref: TableRef,
    column: string,
    settings: FieldSettings | null
  ): TableFields {
    if (!column) throw new Error("Which column?")
    const current = this.tableFields(connectionId, ref)
    const fields = { ...current.fields }
    const checked = settings === null ? null : checkFieldSettings(settings)
    if (checked) fields[column] = checked
    else delete fields[column]
    return this.putTable(connectionId, ref, { ...current, fields })
  }

  setDisplayColumn(connectionId: string, ref: TableRef, column: string | null): TableFields {
    const current = this.tableFields(connectionId, ref)
    return this.putTable(connectionId, ref, {
      ...current,
      displayColumn: column ? String(column) : null,
    })
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  toolModes(): ToolModes {
    return this.data.toolModes
  }

  toolMode(name: string): ToolMode {
    return effectiveToolMode(name, this.data.toolModes)
  }

  setToolMode(name: string, mode: ToolMode): ToolModes {
    const info = toolInfo(name)
    if (!info) throw new Error(`There is no tool "${name}".`)
    if (!info.modes.includes(mode)) {
      throw new Error(`"${info.label}" cannot be set to ${mode}.`)
    }
    const next = { ...this.data.toolModes }
    if (mode === info.default) delete next[name]
    else next[name] = mode
    this.data.toolModes = next
    this.persist()
    return next
  }

  // ── AI settings ──────────────────────────────────────────────────────────

  aiSettings(): AiSettings {
    return this.data.ai ?? DEFAULT_AI_SETTINGS
  }

  setAiSettings(settings: AiSettings): AiSettings {
    this.data.ai = checkAiSettings(settings)
    this.persist()
    return this.data.ai
  }

  // ── Dashboards ───────────────────────────────────────────────────────────

  dashboards(): Dashboard[] {
    return this.data.dashboards
  }

  dashboard(id: string): Dashboard {
    const found = this.data.dashboards.find((item) => item.id === id)
    if (!found) throw new Error("That dashboard no longer exists.")
    return found
  }

  /** By id, or by title within a connection. */
  findDashboard(connectionId: string, reference: string): Dashboard | null {
    const needle = reference.trim().toLowerCase()
    return (
      this.data.dashboards.find((item) => item.id === reference) ??
      this.data.dashboards.find(
        (item) =>
          item.connectionId === connectionId &&
          item.title.trim().toLowerCase() === needle
      ) ??
      null
    )
  }

  saveDashboard(input: Dashboard): Dashboard {
    const title = input.title.trim()
    if (!title) throw new Error("A dashboard needs a title.")
    const dashboard: Dashboard = {
      ...input,
      id: input.id || randomUUID(),
      title,
      tiles: input.tiles.map(checkTile),
      filters: checkFilters(input.filters ?? []),
      refreshSeconds: Math.max(0, Math.round(input.refreshSeconds ?? 0)),
      updatedAt: Date.now(),
    }
    const index = this.data.dashboards.findIndex(
      (item) => item.id === dashboard.id
    )
    if (index === -1) this.data.dashboards.push(dashboard)
    else this.data.dashboards[index] = dashboard
    this.persist()
    this.emit({ type: "dashboard", dashboard })
    return dashboard
  }

  deleteDashboard(id: string): void {
    this.data.dashboards = this.data.dashboards.filter((item) => item.id !== id)
    this.persist()
    this.emit({ type: "dashboard_deleted", dashboardId: id })
  }

  pin(input: PinInput): Dashboard {
    const tile: DashboardTile = { ...input.tile, id: randomUUID() }
    if (input.dashboardId) {
      const dashboard = this.dashboard(input.dashboardId)
      return this.saveDashboard({
        ...dashboard,
        tiles: [...dashboard.tiles, tile],
      })
    }
    return this.saveDashboard({
      id: "",
      connectionId: input.connectionId,
      title: input.dashboardTitle?.trim() || "Dashboard",
      tiles: [tile],
      filters: [],
      refreshSeconds: 0,
      updatedAt: 0,
    })
  }

  /** What a removed connection leaves behind goes with it. */
  forget(connectionId: string): void {
    delete this.data.knowledge[connectionId]
    delete this.data.tableFields[connectionId]
    this.data.dashboards = this.data.dashboards.filter(
      (item) => item.connectionId !== connectionId
    )
    this.persist()
  }
}

function checkTile(tile: DashboardTile): DashboardTile {
  const text = isTextTile(tile)
  if (!text && !tile.sql.trim()) {
    throw new Error(`"${tile.title || "A tile"}" needs SQL, or text.`)
  }
  return {
    ...tile,
    id: tile.id || randomUUID(),
    title: tile.title.trim() || (text ? "" : "Untitled"),
    width: ([1, 2, 3, 4] as const).includes(tile.width ?? 2) ? (tile.width ?? 2) : 2,
    height:
      tile.height === "s" || tile.height === "m" || tile.height === "l"
        ? tile.height
        : // Unsaid: short for words and figures, which size to their content.
          text || tile.chart?.type === "kpi" || tile.chart?.type === "stat"
          ? "s"
          : "m",
  }
}

function checkFilters(filters: DashboardFilter[]): DashboardFilter[] {
  const taken = new Set<string>()
  return filters.map((filter) => {
    const name = filter.name.trim()
    if (!validParamName(name)) {
      throw new Error(
        `"${name}" cannot be a filter name: use letters, digits and underscores, starting with a letter.`
      )
    }
    for (const param of filterParams({ kind: filter.kind, name })) {
      if (taken.has(param) || param === "value") {
        throw new Error(`Two filters would both be {{${param}}}.`)
      }
      taken.add(param)
    }
    const label = filter.label.trim() || name
    if (filter.kind === "date_range") {
      return {
        ...filter,
        id: filter.id || randomUUID(),
        name,
        label,
        preset: DATE_PRESETS.includes(filter.preset) ? filter.preset : "all",
      }
    }
    const id = filter.id || randomUUID()
    switch (filter.kind) {
      case "select":
      case "multi_select":
        if (!filter.optionsSql?.trim()) {
          throw new Error(`The filter "${label}" needs a query for its choices.`)
        }
        return filter.kind === "select"
          ? { ...filter, id, name, label, value: typeof filter.value === "string" ? filter.value : null }
          : {
              ...filter,
              id,
              name,
              label,
              values: Array.isArray(filter.values)
                ? [...new Set(filter.values.filter((value) => typeof value === "string"))]
                : [],
            }
      case "text":
        return {
          ...filter,
          id,
          name,
          label,
          match: TEXT_MATCHES.includes(filter.match) ? filter.match : "contains",
          value: typeof filter.value === "string" && filter.value.trim() ? filter.value : null,
        }
      case "number_range":
        return { ...filter, id, name, label, min: numberOrNull(filter.min), max: numberOrNull(filter.max) }
      case "toggle":
        return { ...filter, id, name, label, value: typeof filter.value === "boolean" ? filter.value : null }
      default:
        throw new Error(`"${(filter as { kind: string }).kind}" is not a kind of filter.`)
    }
  })
}
