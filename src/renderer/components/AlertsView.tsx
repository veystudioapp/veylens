import {
  Bell,
  BellOff,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sigma,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { alertFires, changePercent, describeCondition, describeInterval, readAlertValue } from "@shared/alerts"
import {
  ALERT_INTERVALS,
  type Alert,
  type AlertCondition,
  type AlertInput,
  type AlertStatus,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage, useStore, type AlertDraft, type Tab } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { formatNumber } from "./Chart"
import { confirm } from "./confirm"
import { IconButton } from "./icon-button"
import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"
import { SqlText, SqlTextarea } from "./sql-code"
import { Switch } from "./switch"

type AlertsTab = Extract<Tab, { kind: "alerts" }>

const CONDITION_LABEL: Record<AlertCondition, string> = {
  above: "Goes above",
  below: "Drops below",
  change: "Changes by (%)",
}

const INTERVAL_ITEMS = Object.fromEntries(
  ALERT_INTERVALS.map((minutes) => [String(minutes), describeInterval(minutes).replace(/^every /, "Every ")])
) as Record<string, string>

const STATUS_LOOK: Record<AlertStatus, { label: string; tone: Parameters<typeof toneColor>[0]; icon: ReactNode }> = {
  pending: { label: "Not checked yet", tone: "gray", icon: <CircleDashed /> },
  ok: { label: "Within bounds", tone: "green", icon: <CircleCheck /> },
  triggered: { label: "Fired", tone: "red", icon: <TriangleAlert /> },
  error: { label: "Could not check", tone: "amber", icon: <CircleAlert /> },
}

/** "just now", "4 min ago", "3 h ago", then the date. */
function ago(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const shown = (value: number | null) => (value === null ? "—" : formatNumber(value))

const blank = (connectionId: string, draft?: AlertDraft | null): AlertInput => ({
  id: null,
  connectionId,
  name: draft?.name ?? "",
  sql: draft?.sql ?? "",
  condition: "below",
  threshold: 0,
  everyMinutes: 15,
  enabled: true,
})

type Test = { state: "running" } | { state: "done"; value: number } | { state: "failed"; error: string }

/** An alert being written: what it reads, when it fires, how often. */
function AlertEditor({
  initial,
  previous,
  onSaved,
  onCancel,
}: {
  initial: AlertInput
  /** The number read last time, for saying whether a test would fire. */
  previous: number | null
  onSaved: () => void
  onCancel: () => void
}) {
  const saveAlert = useStore((state) => state.saveAlert)
  const [draft, setDraft] = useState(initial)
  const [threshold, setThreshold] = useState(String(initial.threshold))
  const [test, setTest] = useState<Test | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setTest(null), [draft.sql])

  const patch = (next: Partial<AlertInput>) => setDraft((current) => ({ ...current, ...next }))

  const run = async () => {
    setTest({ state: "running" })
    try {
      const result = await window.veylens.runQuery(draft.connectionId, draft.sql, true)
      setTest({ state: "done", value: readAlertValue(result) })
    } catch (failure) {
      setTest({ state: "failed", error: errorMessage(failure) })
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const value = Number(threshold.replace(/,/g, ""))
      if (threshold.trim() === "" || !Number.isFinite(value)) throw new Error("The threshold must be a number.")
      await saveAlert({ ...draft, threshold: value })
      onSaved()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const number = Number(threshold.replace(/,/g, ""))
  const verdict =
    test?.state === "done" && threshold.trim() !== "" && Number.isFinite(number)
      ? alertFires(draft.condition, number, test.value, previous)
      : null

  return (
    <div className="flex flex-col gap-3 border-t px-3.5 pt-3 pb-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Name</span>
        <Input
          autoFocus={!initial.name}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="Revenue today"
          aria-label="Alert name"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">The number to watch</span>
        <div className="relative overflow-hidden rounded-lg border focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <SqlTextarea
            value={draft.sql}
            onChange={(event) => patch({ sql: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                void run()
              }
            }}
            placeholder={"SELECT sum(total)\n  FROM orders\n WHERE created_at >= current_date"}
            aria-label="Alert SQL"
            spellCheck={false}
            className="block min-h-24 w-full resize-y bg-muted/30 px-3 py-2.5 font-mono text-xs leading-5 outline-none"
          />
          <div className="flex items-center gap-2 border-t bg-muted/40 px-2 py-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={!draft.sql.trim() || test?.state === "running"}
              title="Run it read-only (⌘↵)"
              onClick={() => void run()}
            >
              {test?.state === "running" ? <Spinner className="size-3" /> : <Play />}
              Test
            </Button>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {test?.state === "done"
                ? null
                : "A read-only query; the first column of its first row is the number."}
            </span>
            {test?.state === "done" && (
              <span className="flex items-baseline gap-1.5 text-xs">
                <span className="text-muted-foreground">=</span>
                <span className="font-semibold tabular-nums">{formatNumber(test.value)}</span>
                {verdict !== null && (
                  <span
                    className="text-[11px]"
                    style={{ color: toneColor(verdict ? "red" : "green") }}
                  >
                    {verdict ? "would fire" : "would not fire"}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        {test?.state === "failed" && <ErrorNote mono>{test.error}</ErrorNote>}
      </div>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Fire when it</span>
          <SimpleSelect
            value={draft.condition}
            items={CONDITION_LABEL}
            onChange={(condition) => patch({ condition })}
            label="Condition"
            size="default"
            className="w-full"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{draft.condition === "change" ? "Percent" : "Threshold"}</span>
          <Input
            inputMode="decimal"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            aria-label="Threshold"
            className="tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Check</span>
          <SimpleSelect
            value={String(draft.everyMinutes)}
            items={
              String(draft.everyMinutes) in INTERVAL_ITEMS
                ? INTERVAL_ITEMS
                : { ...INTERVAL_ITEMS, [String(draft.everyMinutes)]: describeInterval(draft.everyMinutes) }
            }
            onChange={(value) => patch({ everyMinutes: Number(value) })}
            label="How often"
            size="default"
            className="w-full"
          />
        </label>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner className="size-3.5" /> : <Bell />}
          {initial.id ? "Save" : "Create alert"}
        </Button>
      </div>
    </div>
  )
}

function AlertCard({ alert, editing, onEdit, now }: { alert: Alert; editing: boolean; onEdit: (on: boolean) => void; now: number }) {
  const saveAlert = useStore((state) => state.saveAlert)
  const deleteAlert = useStore((state) => state.deleteAlert)
  const checkAlert = useStore((state) => state.checkAlert)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { state } = alert
  const look = STATUS_LOOK[alert.enabled ? state.status : "pending"]
  const tone = alert.enabled ? look.tone : "gray"

  const checkNow = async () => {
    setChecking(true)
    setError(null)
    try {
      await checkAlert(alert.id)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setChecking(false)
    }
  }

  const toggle = async (enabled: boolean) => {
    setError(null)
    try {
      await saveAlert({ ...alert, enabled })
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${alert.name}"?`,
      description: "It stops being checked. The data it watched is not touched.",
      action: "Delete",
      destructive: true,
    })
    if (ok) void deleteAlert(alert.id)
  }

  const moved =
    alert.condition === "change" && state.value !== null && state.previous !== null
      ? changePercent(state.previous, state.value)
      : null

  return (
    <div
      className={cn(
        "rounded-lg border bg-card transition-shadow",
        editing && "shadow-sm",
        alert.enabled && state.status === "triggered" && "border-[color-mix(in_oklch,var(--tone-red)_45%,var(--border))]"
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <IconTile tone={tone} size="md" className="mt-0.5">
          {alert.enabled ? look.icon : <BellOff />}
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{alert.name}</span>
            <span
              className="shrink-0 rounded px-1.5 text-[10.5px] leading-[18px]"
              style={{
                color: toneColor(tone),
                background: `color-mix(in oklch, ${toneColor(tone)} 12%, transparent)`,
              }}
            >
              {alert.enabled ? look.label : "Off"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Fires when it {describeCondition(alert.condition, alert.threshold)} · {describeInterval(alert.everyMinutes)}
          </p>
          {!editing && (
            <code className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground/90">
              <SqlText text={alert.sql.split("\n")[0] ?? ""} />
            </code>
          )}
          {state.status === "error" && state.error && alert.enabled && (
            <p className="mt-1.5 line-clamp-2 text-[11px] text-[var(--tone-amber)]">{state.error}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {state.checkedAt ? `Checked ${ago(state.checkedAt, now)}` : "Not checked yet"}
            {state.triggeredAt ? ` · last fired ${ago(state.triggeredAt, now)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="text-right">
            <div
              className="text-lg leading-none font-semibold tabular-nums"
              style={state.status === "triggered" && alert.enabled ? { color: toneColor("red") } : undefined}
            >
              {shown(state.value)}
            </div>
            {moved !== null && (
              <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {Number.isFinite(moved) ? `${moved.toFixed(1)}%` : "from 0"} since {shown(state.previous)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton label="Check now" disabled={checking} onClick={() => void checkNow()}>
              <RefreshCw className={cn(checking && "animate-spin")} />
            </IconButton>
            <IconButton label="Edit" pressed={editing} onClick={() => onEdit(!editing)}>
              <Pencil />
            </IconButton>
            <IconButton label="Delete alert" onClick={() => void remove()}>
              <Trash2 />
            </IconButton>
            <span className="ml-1">
              <Switch
                checked={alert.enabled}
                label={alert.enabled ? "Turn the alert off" : "Turn the alert on"}
                onChange={(on) => void toggle(on)}
              />
            </span>
          </div>
        </div>
      </div>
      {error && <ErrorNote className="mx-3.5 mb-3">{error}</ErrorNote>}
      {editing && (
        <AlertEditor
          initial={{ ...alert }}
          previous={state.value}
          onSaved={() => onEdit(false)}
          onCancel={() => onEdit(false)}
        />
      )}
    </div>
  )
}

export function AlertsView({ tab }: { tab: AlertsTab; active: boolean }) {
  const connection = useStore((state) => state.connections.find((item) => item.id === tab.connectionId))
  const allAlerts = useStore((state) => state.alerts)
  const knowledge = useStore((state) => state.knowledge[tab.connectionId])
  const loadKnowledge = useStore((state) => state.loadKnowledge)
  const alerts = allAlerts.filter((item) => item.connectionId === tab.connectionId)
  /** The alert open for editing, or `new` for one being written. */
  const [editing, setEditing] = useState<string | null>(null)
  const [fresh, setFresh] = useState<AlertInput | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!knowledge) void loadKnowledge(tab.connectionId).catch(() => {})
  }, [knowledge, loadKnowledge, tab.connectionId])

  // "Alert on this" from elsewhere: a new alert, started from what was given.
  useEffect(() => {
    if (!tab.draft) return
    setFresh(blank(tab.connectionId, tab.draft))
    setEditing("new")
  }, [tab.draft, tab.connectionId])

  const startNew = (draft?: AlertDraft) => {
    setFresh(blank(tab.connectionId, draft))
    setEditing("new")
  }

  // Metrics that are whole queries can be watched as they are.
  const watchable = (knowledge?.metrics ?? []).filter(
    (metric) => /^\s*(select|with)\b/i.test(metric.sql) && !alerts.some((alert) => alert.sql.trim() === metric.sql.trim())
  )
  const name = connection?.name ?? "removed connection"
  const firing = alerts.filter((alert) => alert.enabled && alert.state.status === "triggered").length
  const on = alerts.filter((alert) => alert.enabled).length

  return (
    <div className="h-full overflow-y-auto bg-muted/30 dark:bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 pt-6 pb-10">
        <header className="flex items-start gap-3.5">
          <IconTile tone={KIND_TONE.alert} size="lg">
            <Bell />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">Alerts</h2>
              {connection && (
                <span className="flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]">
                  <span className="size-1.5 rounded-full" style={{ background: toneColor(connectionTone(connection)) }} />
                  {name}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Numbers on {name} checked in the background, read-only, while Vey Lens is open. When one
              goes out of bounds you get a system notification — once, until it is back within them.
            </p>
          </div>
          <div className="hidden shrink-0 gap-4 text-right sm:flex">
            <div>
              <div className="text-lg leading-none font-semibold tabular-nums">{on}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">on</div>
            </div>
            <div>
              <div
                className="text-lg leading-none font-semibold tabular-nums"
                style={firing ? { color: toneColor("red") } : undefined}
              >
                {firing}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">firing</div>
            </div>
          </div>
        </header>

        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">
            {alerts.length ? `${alerts.length} ${alerts.length === 1 ? "alert" : "alerts"}` : "No alerts yet"}
          </h3>
          <Button variant="outline" size="xs" disabled={!connection || editing === "new"} onClick={() => startNew()}>
            <Plus />
            New alert
          </Button>
        </div>

        {editing === "new" && fresh && (
          <div className="rounded-lg border bg-card shadow-sm">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <IconTile tone={KIND_TONE.alert} size="md">
                <Bell />
              </IconTile>
              <span className="text-[13px] font-semibold">New alert</span>
            </div>
            <AlertEditor
              key={JSON.stringify(fresh)}
              initial={fresh}
              previous={null}
              onSaved={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {alerts.length === 0 && editing !== "new" && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-4 py-7 text-center">
            <IconTile tone={KIND_TONE.alert} size="lg">
              <Bell />
            </IconTile>
            <div>
              <p className="text-[13px] font-medium">Watch a number</p>
              <p className="mt-0.5 max-w-sm text-xs text-muted-foreground">
                Revenue today below a floor, failed jobs above zero, sign-ups swinging by half — any
                query that returns one number.
              </p>
            </div>
            <Button size="sm" disabled={!connection} onClick={() => startNew()}>
              <Plus />
              New alert
            </Button>
          </div>
        )}

        {alerts.length > 0 && (
          <div className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                now={now}
                editing={editing === alert.id}
                onEdit={(open) => setEditing(open ? alert.id : null)}
              />
            ))}
          </div>
        )}

        {watchable.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Sigma className="size-3.5" />
              From your metrics
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {watchable.map((metric) => (
                <button
                  key={metric.id}
                  type="button"
                  onClick={() => startNew({ name: metric.name, sql: metric.sql })}
                  className="flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs hover:border-foreground/20 hover:bg-accent/50"
                >
                  <Bell className="size-3 text-muted-foreground" />
                  {metric.name}
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Notifications come from the system. If none appear, allow them for Vey Lens in System
          Settings › Notifications. Checks stop when the app quits.
        </p>
      </div>
    </div>
  )
}
