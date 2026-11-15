import {
  ArrowUpRight,
  BookOpen,
  Languages,
  MessageSquare,
  Sparkles,
  BookMarked,
  ChartColumn,
  ChevronRight,
  Database,
  Eye,
  Layers,
  LayoutDashboard,
  PencilLine,
  Plus,
  RotateCcw,
  History,
  ScrollText,
  SearchCheck,
  ShieldCheck,
  Table2,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { addressOf } from "@shared/address"
import {
  TOOL_CATALOG,
  effectiveToolMode,
  type ToolGroup,
  type ToolInfo,
  type ToolMode,
} from "@shared/agent"
import {
  AI_LANGUAGES,
  SQL_INSTRUCTIONS_MAX,
  SQL_KEYWORD_CASES,
  type AiSettings,
  type AiTask,
  type ChatEffort,
  type SqlKeywordCase,
  ACCESS_MODES,
  OBJECT_ACCESS,
  RULES,
  STATEMENT_KINDS,
  type AccessMode,
  type Connection,
  type Guards,
  type ObjectAccess,
  type ObjectRule,
  type Permissions,
  type Rule,
  type Skill,
  type SkillInput,
  type Tone,
  type ToolModes,
  type TreeSchema,
} from "@shared/api"
import {
  OBJECT_LABEL,
  RULE_LABEL,
  STATEMENT_HINT,
  STATEMENT_LABEL,
  ruleFor,
} from "@shared/permissions"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ACCESS_DETAIL, ACCESS_ICON, ACCESS_LABEL } from "@/lib/access"
import { useAgentModels } from "@/lib/models"
import { errorMessage, useStore, type SettingsSection } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { AuditLogPage } from "./AuditLogPage"
import { confirm } from "./confirm"
import { IconButton } from "./icon-button"
import { Markdown } from "./Markdown"
import { ModelMenu, type NoModelRow } from "./model-menu"
import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"
import { Switch } from "./switch"

// ── Pieces ─────────────────────────────────────────────────────────────────

/** A word in a box, for state that is not an action. */
function Tag({ children, tone }: { children: ReactNode; tone?: "amber" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 text-[10.5px] leading-[18px] font-medium",
        tone === "amber"
          ? "bg-[color-mix(in_oklch,var(--tone-amber)_16%,transparent)] text-[var(--tone-amber)]"
          : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  )
}

function PageHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="shrink-0 border-b py-4 pr-14 pl-6">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  aside,
  children,
  className,
}: {
  id: string
  label: string
  hint?: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-6 items-center gap-2">
        <Label htmlFor={id} className="flex-1 text-xs font-medium text-foreground">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function GroupLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-8 items-center px-4 pt-2 text-[11px] font-medium text-muted-foreground">
      <span className="flex-1">{children}</span>
      {action}
    </div>
  )
}

/** One choice of a few, side by side, the chosen one raised. */
function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: Value
  options: { value: Value; label: ReactNode; className?: string }[]
  onChange: (value: Value) => void
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex shrink-0 rounded-md bg-muted p-0.5", className)}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-6 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-xs whitespace-nowrap transition-colors [&_svg]:size-3.5",
              on
                ? cn("bg-background font-medium text-foreground shadow-xs", option.className)
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Skills ─────────────────────────────────────────────────────────────────

const BLANK: SkillInput = {
  id: null,
  name: "",
  description: "",
  instructions: "",
  enabled: true,
}

const toInput = (skill: Skill): SkillInput => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  enabled: skill.enabled,
})

const same = (a: SkillInput, b: SkillInput) =>
  a.name === b.name &&
  a.description === b.description &&
  a.instructions === b.instructions &&
  a.enabled === b.enabled

/** A built-in skill is drawn as what it does; one of yours as a skill. */
const SKILL_LOOK: Record<string, { icon: LucideIcon; tone: Tone }> = {
  "builtin:dashboard": { icon: LayoutDashboard, tone: KIND_TONE.dashboard },
  "builtin:diagnose": { icon: SearchCheck, tone: "red" },
  "builtin:chart": { icon: ChartColumn, tone: KIND_TONE.chart },
}
const skillLook = (id: string | null) =>
  (id && SKILL_LOOK[id]) || { icon: ScrollText, tone: KIND_TONE.skill as Tone }

function SkillRow({
  skill,
  selected,
  onPick,
}: {
  skill: Skill
  selected: boolean
  onPick: () => void
}) {
  const look = skillLook(skill.id)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key === "Enter") onPick()
      }}
      className={cn(
        "mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 outline-offset-[-2px]",
        selected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <IconTile tone={look.tone} size="md" className={cn(!skill.enabled && "opacity-45 grayscale")}>
        <look.icon />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[13px] font-medium",
              !skill.enabled && "text-muted-foreground"
            )}
          >
            {skill.name}
          </span>
          {!skill.enabled ? <Tag>Off</Tag> : skill.modified ? <Tag tone="amber">Edited</Tag> : null}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{skill.description}</div>
      </div>
    </div>
  )
}

/**
 * The skills: the app's own, which can be rewritten, switched off and reset,
 * and the user's, which can also be deleted. A list on the left, the one being
 * edited on the right, saved on Save.
 */
function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [selected, setSelected] = useState<string | "new" | null>(null)
  const [form, setForm] = useState<SkillInput>(BLANK)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<"write" | "preview">("write")

  useEffect(() => {
    void window.veydata.listSkills().then(
      (list) => {
        setSkills(list)
        if (list[0]) {
          setSelected(list[0].id)
          setForm(toInput(list[0]))
        }
      },
      (failure) => setError(errorMessage(failure))
    )
  }, [])

  const current = skills?.find((item) => item.id === selected) ?? null
  const baseline = current ? toInput(current) : BLANK
  const dirty = selected !== null && !same(form, baseline)
  const builtin = skills?.filter((item) => item.builtin) ?? []
  const own = skills?.filter((item) => !item.builtin) ?? []
  const look = skillLook(current?.id ?? null)

  const show = (skill: Skill | undefined) => {
    setSelected(skill?.id ?? null)
    setForm(skill ? toInput(skill) : BLANK)
    setView("write")
  }

  const pick = async (id: string | "new") => {
    if (id === selected) return
    if (
      dirty &&
      !(await confirm({
        title: "Discard changes?",
        description: "The skill being edited has changes that were not saved.",
        action: "Discard",
        destructive: true,
      }))
    ) {
      return
    }
    setError(null)
    if (id === "new") {
      setSelected("new")
      setForm(BLANK)
      setView("write")
    } else show(skills?.find((item) => item.id === id))
  }

  const store = (skill: Skill) =>
    setSkills((list) => {
      const rest = list ?? []
      return rest.some((item) => item.id === skill.id)
        ? rest.map((item) => (item.id === skill.id ? skill : item))
        : [...rest, skill]
    })

  const attempt = async (work: () => Promise<void>) => {
    setError(null)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const save = async () => {
    setSaving(true)
    await attempt(async () => {
      const skill = await window.veydata.saveSkill(form)
      store(skill)
      show(skill)
    })
    setSaving(false)
  }

  const reset = () =>
    attempt(async () => {
      if (!current) return
      const skill = await window.veydata.resetSkill(current.id)
      store(skill)
      show(skill)
    })

  const remove = async () => {
    if (!current) return
    const ok = await confirm({
      title: `Delete "${current.name}"?`,
      description: "The assistant stops seeing it in every chat.",
      action: "Delete",
      destructive: true,
    })
    if (!ok) return
    await attempt(async () => {
      await window.veydata.deleteSkill(current.id)
      const rest = (skills ?? []).filter((item) => item.id !== current.id)
      setSkills(rest)
      show(rest[0])
    })
  }

  const set = <K extends keyof SkillInput>(key: K, value: SkillInput[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Skills">
        How the assistant does a kind of task. It sees each skill's name and
        when to use it in every chat, and reads the instructions when a request
        matches.
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r pb-3">
          {skills === null && !error && (
            <div className="flex justify-center py-6">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          )}
          {builtin.length > 0 && <GroupLabel>Built-in</GroupLabel>}
          {builtin.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              selected={skill.id === selected}
              onPick={() => void pick(skill.id)}
            />
          ))}
          {skills !== null && (
            <GroupLabel
              action={
                <IconButton label="New skill" onClick={() => void pick("new")}>
                  <Plus />
                </IconButton>
              }
            >
              Yours
            </GroupLabel>
          )}
          {own.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              selected={skill.id === selected}
              onPick={() => void pick(skill.id)}
            />
          ))}
          {selected === "new" && (
            <div className="mx-2 flex items-center gap-2.5 rounded-md bg-accent px-2 py-2">
              <IconTile tone={KIND_TONE.skill} size="md">
                <ScrollText />
              </IconTile>
              <span className="truncate text-[13px] font-medium">
                {form.name.trim() || "New skill"}
              </span>
            </div>
          )}
          {skills !== null && own.length === 0 && selected !== "new" && (
            <button
              type="button"
              onClick={() => void pick("new")}
              className="mx-2 flex items-center gap-2.5 rounded-md border border-dashed px-2 py-2 text-left hover:bg-accent/50"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Write your own…</span>
                <span className="block text-[11px] text-muted-foreground">
                  A report, a house style for SQL
                </span>
              </span>
            </button>
          )}
        </div>

        {selected === null ? (
          <div className="flex flex-1 items-center justify-center p-6">
            {error && <ErrorNote className="w-full max-w-sm">{error}</ErrorNote>}
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              {/* What it is and whether it is on, together at the top. */}
              <div className="flex items-center gap-3">
                <IconTile tone={look.tone} size="lg" className={cn(!form.enabled && "opacity-45 grayscale")}>
                  <look.icon />
                </IconTile>
                <div className="min-w-0 flex-1">
                  {current?.builtin ? (
                    <h3 className="truncate text-[15px] font-semibold">{current.name}</h3>
                  ) : (
                    <input
                      id="skill-name"
                      aria-label="Name"
                      autoFocus={selected === "new"}
                      value={form.name}
                      placeholder="Name it — Weekly sales report"
                      onChange={(event) => set("name", event.target.value)}
                      className="-ml-1 h-7 w-full rounded-md bg-transparent px-1 text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground hover:bg-muted/60 focus:bg-muted/60"
                    />
                  )}
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <Tag>{current?.builtin ? "Built-in" : "Yours"}</Tag>
                    {current?.modified && <Tag tone="amber">Edited</Tag>}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {form.enabled ? "On" : "Off"}
                  <Switch
                    checked={form.enabled}
                    label="On"
                    onChange={(enabled) => set("enabled", enabled)}
                  />
                </label>
              </div>

              <Field
                id="skill-description"
                label="When to use it"
                hint="Sent with every message, so keep it to a line: the assistant decides by it."
              >
                <Input
                  id="skill-description"
                  value={form.description}
                  placeholder="When asked for a weekly or month-to-date sales summary"
                  onChange={(event) => set("description", event.target.value)}
                />
              </Field>

              <Field
                id="skill-instructions"
                label="Instructions"
                className="min-h-72 flex-1"
                aside={
                  <Segmented
                    label="Instructions view"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "write", label: "Write" },
                      { value: "preview", label: "Preview" },
                    ]}
                  />
                }
              >
                {view === "write" ? (
                  <textarea
                    id="skill-instructions"
                    value={form.instructions}
                    spellCheck={false}
                    placeholder={
                      "1. Revenue is net of refunds: use the Net revenue metric.\n2. Compare with the same week last year.\n3. A line chart by day, then a table by channel."
                    }
                    onChange={(event) => set("instructions", event.target.value)}
                    className="min-h-0 flex-1 resize-none rounded-lg border bg-muted/30 px-3.5 py-3 font-mono text-xs leading-[1.7] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-3 focus-visible:ring-ring/30"
                  />
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border px-4 py-3">
                    <Markdown text={form.instructions || "*Nothing written yet.*"} />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Markdown, read whole when the skill is used.
                </p>
              </Field>

              {error && <ErrorNote>{error}</ErrorNote>}
            </div>

            <div className="flex h-14 shrink-0 items-center gap-2 border-t bg-muted/30 px-6">
              {current?.builtin && current.modified && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void reset()}>
                  <RotateCcw />
                  Reset to default
                </Button>
              )}
              {current && !current.builtin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void remove()}
                >
                  <Trash2 />
                  Delete
                </Button>
              )}
              <div className="flex-1" />
              {dirty && current && (
                <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
              )}
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null)
                    if (current) setForm(toInput(current))
                    else show(skills?.[0])
                  }}
                >
                  {current ? "Revert" : "Cancel"}
                </Button>
              )}
              <Button type="submit" size="sm" disabled={saving || !dirty}>
                {saving && <Spinner className="size-3.5" />}
                {current ? "Save" : "Add skill"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Tools ──────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<ToolMode, string> = {
  allow: "Allow",
  ask: "Ask",
  off: "Off",
}

/** The chosen mode, in the colour of what it means. */
const MODE_TONE: Record<ToolMode, string> = {
  allow: "text-[var(--tone-green)]",
  ask: "text-[var(--tone-amber)]",
  off: "text-muted-foreground",
}

const GROUPS: { group: ToolGroup; icon: LucideIcon; tone: Tone }[] = [
  { group: "Read", icon: Eye, tone: "blue" },
  { group: "Show", icon: ChartColumn, tone: KIND_TONE.chart },
  { group: "Dashboards", icon: LayoutDashboard, tone: KIND_TONE.dashboard },
  { group: "Remember", icon: BookMarked, tone: "teal" },
  { group: "Change data", icon: PencilLine, tone: "red" },
]

function ModePicker({
  tool,
  mode,
  onChange,
}: {
  tool: ToolInfo
  mode: ToolMode
  onChange: (mode: ToolMode) => void
}) {
  if (tool.modes.length === 1) {
    return <span className="pr-2 text-xs text-muted-foreground">Always on</span>
  }
  return (
    <Segmented
      label={tool.label}
      value={mode}
      onChange={onChange}
      className="w-44"
      options={tool.modes.map((item) => ({
        value: item,
        label: MODE_LABEL[item],
        className: MODE_TONE[item],
      }))}
    />
  )
}

function ToolsPage() {
  const [modes, setModes] = useState<ToolModes | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.veydata
      .getToolModes()
      .then(setModes, (failure) => setError(errorMessage(failure)))
  }, [])

  const change = async (tool: string, mode: ToolMode) => {
    setError(null)
    try {
      setModes(await window.veydata.setToolMode(tool, mode))
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Tools">
        What the assistant may do in a chat. <b className="font-medium text-[var(--tone-amber)]">Ask</b>{" "}
        puts a card in the chat to approve first;{" "}
        <b className="font-medium text-foreground">Off</b> refuses it and tells the
        assistant why. A change to the database is always shown to you before it
        runs, whatever is set here.
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
        {modes === null && !error ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        ) : (
          GROUPS.map(({ group, icon: Icon, tone }) => (
            <section key={group} className="pt-5">
              <h3 className="flex items-center gap-2 pb-2 text-xs font-semibold">
                <IconTile tone={tone} size="xs">
                  <Icon />
                </IconTile>
                {group}
              </h3>
              <div className="divide-y rounded-lg border bg-card">
                {TOOL_CATALOG.filter((tool) => tool.group === group).map((tool) => (
                  <div key={tool.name} className="flex items-center gap-4 px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium">{tool.label}</span>
                        <code className="font-mono text-[10.5px] text-muted-foreground/80">
                          {tool.name}
                        </code>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {tool.description}
                      </p>
                    </div>
                    <ModePicker
                      tool={tool}
                      mode={effectiveToolMode(tool.name, modes ?? {})}
                      onChange={(mode) => void change(tool.name, mode)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

// ── Permissions ────────────────────────────────────────────────────────────

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL" } as const

const ACCESS_TONE: Record<AccessMode, string> = {
  read_write: "",
  confirm: "text-[var(--tone-amber)]",
  read_only: "text-[var(--tone-blue)]",
}

const RULE_TONE: Record<Rule, string> = {
  allow: "text-[var(--tone-green)]",
  ask: "text-[var(--tone-amber)]",
  block: "text-[var(--tone-red)]",
}

const OBJECT_TONE: Record<ObjectAccess, string> = {
  hidden: "text-[var(--tone-red)]",
  read: "text-[var(--tone-blue)]",
  write: "text-[var(--tone-green)]",
}

const ALL_TABLES = "\u0000all"

/** What is set beyond the access mode, in a few words for the closed card. */
function permissionSummary(permissions: Permissions, access: AccessMode): string[] {
  const out: string[] = []
  if (access !== "read_only") {
    for (const kind of STATEMENT_KINDS) {
      const rule = permissions.statements[kind]
      if (rule !== "allow") out.push(`${STATEMENT_LABEL[kind]}: ${RULE_LABEL[rule]}`)
    }
  }
  const hidden = permissions.objects.filter((rule) => rule.access === "hidden").length
  const read = permissions.objects.filter((rule) => rule.access === "read").length
  if (hidden) out.push(`${hidden} hidden`)
  if (read) out.push(`${read} read only`)
  const { guards } = permissions
  if (guards.requireWhere) out.push("WHERE required")
  if (guards.maxAffected !== null) out.push(`≤ ${guards.maxAffected.toLocaleString()} rows changed`)
  if (guards.timeoutSeconds !== null) out.push(`${guards.timeoutSeconds}s timeout`)
  if (guards.maxRows !== null) out.push(`≤ ${guards.maxRows.toLocaleString()} rows returned`)
  return out
}

/** A number or nothing, saved when it is left or Enter is pressed. */
function LimitInput({
  id,
  value,
  unit,
  onChange,
}: {
  id: string
  value: number | null
  unit: string
  onChange: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? "" : String(value))
  useEffect(() => setText(value === null ? "" : String(value)), [value])
  const commit = () => {
    const parsed = text.trim() === "" ? null : Math.floor(Number(text))
    const next = parsed !== null && Number.isFinite(parsed) && parsed >= 1 ? parsed : null
    setText(next === null ? "" : String(next))
    if (next !== value) onChange(next)
  }
  return (
    <div className="flex h-7 w-40 shrink-0 items-center rounded-md border bg-background text-xs shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
      <input
        id={id}
        inputMode="numeric"
        value={text}
        placeholder="No limit"
        onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ""))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit()
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-right tabular-nums outline-none placeholder:text-muted-foreground"
      />
      <span className="pr-2 pl-1 text-muted-foreground">{unit}</span>
    </div>
  )
}

function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </label>
        {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function SubHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-4 pb-1">
      <h4 className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {children}
      </h4>
      {aside}
    </div>
  )
}

/** The schemas and tables, hidden ones too, and the rules on them. */
function ObjectRules({
  connection,
  permissions,
  onChange,
}: {
  connection: Connection
  permissions: Permissions
  onChange: (objects: ObjectRule[]) => void
}) {
  const [tree, setTree] = useState<TreeSchema[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [schema, setSchema] = useState("")
  const [table, setTable] = useState(ALL_TABLES)

  useEffect(() => {
    void window.veydata.listObjects(connection.id).then(
      (found) => {
        setTree(found)
        setSchema((current) => current || found[0]?.name || "")
      },
      (failure) => setError(errorMessage(failure))
    )
  }, [connection.id])

  const tables = tree?.find((item) => item.name === schema)?.tables ?? []
  const exists = permissions.objects.some(
    (rule) =>
      rule.schema === schema && (rule.table ?? ALL_TABLES) === table
  )
  const add = () => {
    if (!schema || exists) return
    onChange([
      ...permissions.objects,
      { schema, table: table === ALL_TABLES ? null : table, access: "read" },
    ])
  }
  // Schemas first, then their tables, as the explorer lists them.
  const rules = [...permissions.objects].sort(
    (a, b) =>
      a.schema.localeCompare(b.schema) ||
      (a.table === null ? -1 : b.table === null ? 1 : a.table.localeCompare(b.table))
  )

  return (
    <>
      {rules.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          Every schema and table as the connection allows.
        </p>
      ) : (
        <div className="divide-y rounded-md border bg-background">
          {rules.map((rule) => (
            <div key={`${rule.schema}.${rule.table ?? ""}`} className="flex items-center gap-2.5 px-2.5 py-1.5">
              <IconTile tone={rule.table ? KIND_TONE.table : KIND_TONE.schema} size="xs">
                {rule.table ? <Table2 /> : <Layers />}
              </IconTile>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {rule.schema}
                <span className="text-muted-foreground">.{rule.table ?? "*"}</span>
              </span>
              <Segmented
                label={`Access to ${rule.schema}.${rule.table ?? "*"}`}
                value={rule.access}
                onChange={(access) =>
                  onChange(permissions.objects.map((item) => (item === rule ? { ...item, access } : item)))
                }
                options={OBJECT_ACCESS.map((access) => ({
                  value: access,
                  label: OBJECT_LABEL[access],
                  className: OBJECT_TONE[access],
                }))}
              />
              <IconButton
                label={`Remove the rule on ${rule.schema}.${rule.table ?? "*"}`}
                onClick={() => onChange(permissions.objects.filter((item) => item !== rule))}
              >
                <X />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        {error ? (
          <ErrorNote className="flex-1 py-1">Could not list its tables: {error}</ErrorNote>
        ) : tree === null ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : (
          <>
            <SimpleSelect
              label="Schema"
              heading="Schema"
              value={schema}
              items={Object.fromEntries(tree.map((item) => [item.name, item.name]))}
              onChange={(next) => {
                setSchema(next)
                setTable(ALL_TABLES)
              }}
              className="h-7 max-w-44 bg-background"
            />
            <SimpleSelect
              label="Table"
              heading="Table"
              value={table}
              items={{
                [ALL_TABLES]: "All tables",
                ...Object.fromEntries(tables.map((item) => [item.name, item.name])),
              }}
              onChange={setTable}
              className="h-7 max-w-52 bg-background"
            />
            <Button size="sm" variant="outline" className="h-7" disabled={!schema || exists} onClick={add}>
              <Plus />
              Add rule
            </Button>
          </>
        )}
      </div>
    </>
  )
}

function ConnectionPermissions({ connection }: { connection: Connection }) {
  const setAccess = useStore((state) => state.setAccess)
  const setPermissions = useStore((state) => state.setPermissions)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { permissions, access } = connection
  const summary = permissionSummary(permissions, access)

  const attempt = async (work: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const save = (next: Partial<Permissions>) =>
    void attempt(() => setPermissions(connection.id, { ...permissions, ...next }))
  const guard = (next: Partial<Guards>) => save({ guards: { ...permissions.guards, ...next } })

  return (
    <div className={cn("rounded-lg border bg-card", open && "shadow-xs")}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} the permissions of ${connection.name}`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-offset-2"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <IconTile tone={connectionTone(connection)} size="md">
            <Database />
          </IconTile>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{connection.name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {ENGINE_LABEL[connection.engine]} · {connection.user}@{addressOf(connection)}
              {connection.database ? `/${connection.database}` : ""}
            </span>
          </span>
        </button>
        {busy && <Spinner className="size-3.5 text-muted-foreground" />}
        <Segmented
          label={`Access for ${connection.name}`}
          value={access}
          onChange={(next) => void attempt(() => setAccess(connection.id, next))}
          options={ACCESS_MODES.map((mode) => ({
            value: mode,
            className: ACCESS_TONE[mode],
            label: (
              <>
                {ACCESS_ICON[mode]}
                {ACCESS_LABEL[mode]}
              </>
            ),
          }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3 pl-[4.25rem] text-[11px] text-muted-foreground">
        <span className="mr-1 leading-relaxed">{ACCESS_DETAIL[access]}</span>
        {summary.map((item) => (
          <span key={item} className="rounded bg-muted px-1.5 leading-[18px] text-foreground/80">
            {item}
          </span>
        ))}
      </div>

      {error && <ErrorNote className="mx-3.5 mb-3">{error}</ErrorNote>}

      {open && (
        <div className="border-t bg-muted/30 px-3.5 pb-4 pl-[4.25rem]">
          <SubHeading>Statements</SubHeading>
          {access === "read_only" ? (
            <p className="py-2 text-xs text-muted-foreground">
              Read only blocks every write; switch the access to set them one by one.
            </p>
          ) : (
            <div className="divide-y">
              {STATEMENT_KINDS.map((kind) => {
                const own = permissions.statements[kind]
                const effective = ruleFor(permissions, access, kind)
                return (
                  <SettingRow
                    key={kind}
                    label={
                      <>
                        {STATEMENT_LABEL[kind]}
                        {effective !== own && (
                          <span className="ml-2 font-normal text-[var(--tone-amber)]">
                            asks — Confirm writes
                          </span>
                        )}
                      </>
                    }
                    hint={<code className="font-mono text-[10.5px]">{STATEMENT_HINT[kind]}</code>}
                  >
                    <Segmented
                      label={STATEMENT_LABEL[kind]}
                      value={own}
                      className="w-48"
                      onChange={(rule) => save({ statements: { ...permissions.statements, [kind]: rule } })}
                      options={RULES.map((rule) => ({
                        value: rule,
                        label: RULE_LABEL[rule],
                        className: RULE_TONE[rule],
                      }))}
                    />
                  </SettingRow>
                )
              })}
            </div>
          )}

          <SubHeading>Schemas and tables</SubHeading>
          <ObjectRules
            connection={connection}
            permissions={permissions}
            onChange={(objects) => save({ objects })}
          />

          <SubHeading>Guards</SubHeading>
          <div className="divide-y">
            <SettingRow
              label="Refuse UPDATE and DELETE without WHERE"
              hint="One that would change every row of a table."
            >
              <Switch
                checked={permissions.guards.requireWhere}
                label="Refuse UPDATE and DELETE without WHERE"
                onChange={(requireWhere) => guard({ requireWhere })}
              />
            </SettingRow>
            <SettingRow
              label="Most rows one write may change"
              hint="Past it, the statement or plan is rolled back."
              htmlFor={`${connection.id}-affected`}
            >
              <LimitInput
                id={`${connection.id}-affected`}
                unit="rows"
                value={permissions.guards.maxAffected}
                onChange={(maxAffected) => guard({ maxAffected })}
              />
            </SettingRow>
            <SettingRow
              label="Stop a statement after"
              hint={
                connection.engine === "mysql"
                  ? "Reads, writes and the SQL tab; not the steps of a plan, on MySQL."
                  : "Reads, writes and plans alike."
              }
              htmlFor={`${connection.id}-timeout`}
            >
              <LimitInput
                id={`${connection.id}-timeout`}
                unit="seconds"
                value={permissions.guards.timeoutSeconds}
                onChange={(timeoutSeconds) => guard({ timeoutSeconds })}
              />
            </SettingRow>
            <SettingRow
              label="Most rows a query returns"
              hint="The SQL tab, a table tab's page, a tile, and what the assistant reads."
              htmlFor={`${connection.id}-rows`}
            >
              <LimitInput
                id={`${connection.id}-rows`}
                unit="rows"
                value={permissions.guards.maxRows}
                onChange={(maxRows) => guard({ maxRows })}
              />
            </SettingRow>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * What may be done through each connection in this app — by you and by the
 * assistant — on top of whatever the database user may do.
 */
function PermissionsPage({ onTools }: { onTools: () => void }) {
  const connections = useStore((state) => state.connections)
  const openDialog = useStore((state) => state.openDialog)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Permissions">
        What can be done through each connection in Vey Data, by you and by the
        assistant alike: its access, then — opened — each kind of statement,
        schemas and tables, and guards. Read off the SQL by this app, on top of
        the database user's own grants, which remain the hard boundary.
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <section className="pt-5">
          <h3 className="flex items-center gap-2 pb-2 text-xs font-semibold">
            <IconTile tone="blue" size="xs">
              <Database />
            </IconTile>
            Connections
          </h3>
          {connections.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
              No connections yet.{" "}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => openDialog({ mode: "new" })}
              >
                Add one
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {connections.map((connection) => (
                <ConnectionPermissions key={connection.id} connection={connection} />
              ))}
            </div>
          )}
        </section>

        <section className="pt-6">
          <h3 className="flex items-center gap-2 pb-2 text-xs font-semibold">
            <IconTile tone={KIND_TONE.tool} size="xs">
              <ShieldCheck />
            </IconTile>
            The assistant
          </h3>
          <div className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              It asks before every change, on every connection, and is told
              these permissions: what they block is refused before a card is
              shown. Which of its other tools need approval is set in Tools.
            </p>
            <Button variant="outline" size="sm" onClick={onTools}>
              Tools
              <ArrowUpRight />
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}

// ── Models & language ──────────────────────────────────────────────────────

const LANGUAGE_LABEL: Record<(typeof AI_LANGUAGES)[number], string> = {
  English: "English",
  Vietnamese: "Tiếng Việt",
  Japanese: "日本語",
  Korean: "한국어",
  "Chinese (Simplified)": "简体中文",
  "Chinese (Traditional)": "繁體中文",
  Thai: "ไทย",
  Indonesian: "Bahasa Indonesia",
  French: "Français",
  German: "Deutsch",
  Spanish: "Español",
  Portuguese: "Português",
}

/** The select's value for "the language of the request". */
const AUTO = "auto"
/** The row for a task that runs on whatever the chat's picker shows. */
const FOLLOW_CHAT: NoModelRow = {
  label: "Same as the chat",
  description: "The model and effort picked under the chat box",
}

const TASKS: { task: AiTask; label: string; description: string; icon: LucideIcon; tone: Tone }[] = [
  {
    task: "chat",
    label: "Chat",
    description: "What a new chat starts on. The picker under the chat box still changes it for one session.",
    icon: MessageSquare,
    tone: "blue",
  },
  {
    task: "generate",
    label: "Generate SQL",
    description: "Writes a statement from a description, in the SQL editor.",
    icon: Sparkles,
    tone: KIND_TONE.query,
  },
  {
    task: "explain",
    label: "Explain SQL",
    description: "Says what the statement in the editor — or the selected part — does. A fast model is usually enough.",
    icon: BookOpen,
    tone: KIND_TONE.query,
  },
  {
    task: "fix",
    label: "Fix SQL",
    description: "Corrects a statement that failed, from the server's error.",
    icon: Wrench,
    tone: KIND_TONE.query,
  },
]

const KEYWORD_CASE_LABEL: Record<SqlKeywordCase, string> = {
  keep: "As in the editor",
  upper: "UPPER",
  lower: "lower",
}

/** One setting: what it is and what it does on the left, the control on the right. */
function AiRow({
  icon,
  label,
  description,
  children,
}: {
  icon?: ReactNode
  label: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-4 px-3.5 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  )
}

function AiPage() {
  const ai = useStore((state) => state.ai)
  const save = useStore((state) => state.setAiSettings)
  const models = useAgentModels()
  const [error, setError] = useState<string | null>(null)
  const [instructions, setInstructions] = useState(ai.sqlInstructions)

  const change = async (next: AiSettings) => {
    setError(null)
    try {
      await save(next)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  // Typed instructions are kept a moment after the last key, and on leaving.
  useEffect(() => {
    if (instructions === ai.sqlInstructions) return
    const timer = setTimeout(() => void change({ ...ai, sqlInstructions: instructions }), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructions])

  const pick = (task: AiTask, model: string | null, effort: ChatEffort | null) =>
    void change({ ...ai, models: { ...ai.models, [task]: { model, effort } } })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Models & language">
        Which model answers where, how much it thinks before it does, and in what
        language. It runs on your own <code className="font-mono text-[11px]">claude</code>,
        so the models are the ones your account offers.
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {error && <ErrorNote className="mt-4">{error}</ErrorNote>}

        <section className="pt-5">
          <h3 className="pb-2 text-xs font-semibold">Language</h3>
          <div className="rounded-lg border bg-card">
            <AiRow
              icon={
                <IconTile tone="green" size="sm">
                  <Languages />
                </IconTile>
              }
              label="Answer in"
              description="Chat answers, explanations and what Generate and Fix say about their SQL. SQL, table names and values stay as they are."
            >
              <SimpleSelect
                label="Answer in"
                heading="Answer in"
                size="default"
                className="w-52 justify-between"
                value={ai.language ?? AUTO}
                items={{
                  [AUTO]: "The language you write in",
                  ...Object.fromEntries(
                    AI_LANGUAGES.map((language) => [language, LANGUAGE_LABEL[language]])
                  ),
                }}
                onChange={(value) =>
                  void change({ ...ai, language: value === AUTO ? null : value })
                }
              />
            </AiRow>
          </div>
        </section>

        <section className="pt-5">
          <h3 className="pb-2 text-xs font-semibold">Models</h3>
          <div className="divide-y rounded-lg border bg-card">
            {TASKS.map(({ task, label, description, icon: Icon, tone }) => {
              const choice = ai.models[task]
              return (
                <AiRow
                  key={task}
                  icon={
                    <IconTile tone={tone} size="sm">
                      <Icon />
                    </IconTile>
                  }
                  label={label}
                  description={description}
                >
                  {/* The chat's own menu: models, their efforts, reload. */}
                  <ModelMenu
                    variant="field"
                    label={`${label} model`}
                    className="w-60"
                    models={models}
                    model={choice.model}
                    effort={choice.effort}
                    none={task === "chat" ? undefined : FOLLOW_CHAT}
                    onPick={(model, effort) => pick(task, model, effort)}
                  />
                </AiRow>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            More effort thinks longer before answering: better on a hard query, slower and
            costlier on an easy one.
          </p>
        </section>

        <section className="pt-5">
          <h3 className="pb-2 text-xs font-semibold">SQL the assistant writes</h3>
          <div className="divide-y rounded-lg border bg-card">
            <AiRow
              label="Keywords"
              description="How SELECT, FROM and the like are written, in the chat and in the editor."
            >
              <Segmented
                label="Keywords"
                value={ai.keywordCase}
                onChange={(keywordCase) => void change({ ...ai, keywordCase })}
                options={SQL_KEYWORD_CASES.map((value) => ({
                  value,
                  label: KEYWORD_CASE_LABEL[value],
                }))}
              />
            </AiRow>
            <div className="flex flex-col gap-2 px-3.5 py-3">
              <div>
                <label htmlFor="sql-instructions" className="text-[13px] font-medium">
                  Instructions for Generate, Explain and Fix
                </label>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Said to the SQL editor&apos;s helper every time. For the chat, write a skill
                  instead.
                </p>
              </div>
              <textarea
                id="sql-instructions"
                value={instructions}
                maxLength={SQL_INSTRUCTIONS_MAX}
                onChange={(event) => setInstructions(event.target.value)}
                onBlur={() => {
                  if (instructions !== ai.sqlInstructions) {
                    void change({ ...ai, sqlInstructions: instructions })
                  }
                }}
                placeholder={"Always end a SELECT with LIMIT 100.\nUse CTEs rather than nested subqueries.\nOur weeks start on Monday."}
                className="min-h-24 resize-y rounded-md border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
              <div className="flex text-[11px] text-muted-foreground">
                <span className="flex-1">
                  {instructions === ai.sqlInstructions ? (instructions ? "Saved." : "") : "Saving…"}
                </span>
                <span className="tabular-nums">
                  {instructions.length.toLocaleString()} / {SQL_INSTRUCTIONS_MAX.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

// ── The dialog ─────────────────────────────────────────────────────────────

const NAV: {
  heading: string
  items: { id: SettingsSection; label: string; icon: LucideIcon; tone: Tone }[]
}[] = [
  {
    heading: "Assistant",
    items: [
      { id: "ai", label: "Models & language", icon: Sparkles, tone: "pink" },
      { id: "skills", label: "Skills", icon: ScrollText, tone: KIND_TONE.skill },
      { id: "tools", label: "Tools", icon: Wrench, tone: KIND_TONE.tool },
    ],
  },
  {
    heading: "Data",
    items: [
      { id: "permissions", label: "Permissions", icon: ShieldCheck, tone: "green" },
      { id: "audit", label: "Audit log", icon: History, tone: "teal" },
    ],
  },
]

/** The app's settings, as one dialog with a section per subject. */
export function SettingsDialog({
  section,
  onSection,
  onClose,
}: {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(700px,calc(100%-4rem))] max-w-[calc(100%-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[1000px]">
        <nav className="flex w-52 shrink-0 flex-col border-r bg-sidebar px-2 py-3">
          <DialogTitle className="px-2.5 pb-2 text-[13px] font-semibold">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            The assistant's models, language, skills and tools, what each connection allows, and the audit log
          </DialogDescription>
          {NAV.map((group) => (
            <div key={group.heading} className="flex flex-col gap-px pt-3">
              <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.heading}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={section === item.id ? "page" : undefined}
                  onClick={() => onSection(item.id)}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px]",
                    section === item.id
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                  )}
                >
                  <IconTile tone={item.tone} size="sm">
                    <item.icon />
                  </IconTile>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {section === "ai" ? (
          <AiPage />
        ) : section === "skills" ? (
          <SkillsPage />
        ) : section === "tools" ? (
          <ToolsPage />
        ) : section === "audit" ? (
          <AuditLogPage />
        ) : (
          <PermissionsPage onTools={() => onSection("tools")} />
        )}
      </DialogContent>
    </Dialog>
  )
}
