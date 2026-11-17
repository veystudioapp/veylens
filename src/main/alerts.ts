import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"

import { alertFires, readAlertValue } from "../shared/alerts"
import {
  ALERT_CONDITIONS,
  type Alert,
  type AlertInput,
  type AlertState,
  type ChatEvent,
} from "../shared/api"
import { startsLikeRead } from "../shared/statements"
import type { Connections } from "./connections"

/** How often the schedule is looked at; an alert runs on the first look
 * past its interval. */
const TICK_MS = 30_000

/** A check that takes longer than this is stopped and counted as failed. */
const CHECK_TIMEOUT_MS = 30_000

/** The longest interval: a week. */
const MAX_MINUTES = 7 * 24 * 60

const FRESH: AlertState = {
  status: "pending",
  value: null,
  previous: null,
  checkedAt: null,
  triggeredAt: null,
  error: null,
}

/** What a check depends on: when it changes, what was found before is not
 * about this alert any more. */
const basis = (alert: Pick<Alert, "connectionId" | "sql" | "condition" | "threshold">) =>
  JSON.stringify([alert.connectionId, alert.sql, alert.condition, alert.threshold])

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Numbers watched in the background. Each alert is a read-only query run on
 * its own schedule while the app is open; one that goes out of bounds — from
 * within them, so it is said once and not on every check — is handed to
 * `fired`, which shows the notification. Kept in `alerts.json` beside the
 * library, written whole.
 */
export class Alerts {
  private alerts: Alert[] = []
  private readonly running = new Map<string, Promise<Alert>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly file: string,
    private readonly connections: Pick<Connections, "list" | "driver">,
    private readonly emit: (event: ChatEvent) => void,
    private readonly fired: (alert: Alert) => void
  ) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { alerts?: Alert[] }
      this.alerts = (parsed.alerts ?? []).map((alert) => ({ ...alert, state: { ...FRESH, ...alert.state } }))
    } catch {
      // None yet, or unreadable: start with none rather than refuse to start.
    }
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify({ alerts: this.alerts }, null, 1))
    renameSync(temporary, this.file)
  }

  list(): Alert[] {
    return this.alerts
  }

  get(id: string): Alert {
    const found = this.alerts.find((alert) => alert.id === id)
    if (!found) throw new Error("That alert no longer exists.")
    return found
  }

  save(input: AlertInput): Alert {
    const name = String(input.name ?? "").trim()
    if (!name) throw new Error("An alert needs a name.")
    if (name.length > 200) throw new Error("Keep the name under 200 characters.")
    const sql = String(input.sql ?? "").trim()
    if (!sql) throw new Error(`"${name}" needs a query that returns its number.`)
    if (!startsLikeRead(sql)) throw new Error("An alert's query reads; it cannot change anything.")
    if (!this.connections.list().some((item) => item.id === input.connectionId)) {
      throw new Error("That connection no longer exists.")
    }
    if (!ALERT_CONDITIONS.includes(input.condition)) throw new Error("That is not a condition.")
    const threshold = Number(input.threshold)
    if (!Number.isFinite(threshold)) throw new Error("The threshold must be a number.")
    if (input.condition === "change" && threshold <= 0) {
      throw new Error("A change is a percentage above zero.")
    }
    const everyMinutes = Math.round(Number(input.everyMinutes))
    if (!(everyMinutes >= 1 && everyMinutes <= MAX_MINUTES)) {
      throw new Error("Check it at least every week, and at most every minute.")
    }

    const before = input.id ? this.get(input.id) : null
    const next: Omit<Alert, "state"> = {
      id: before?.id ?? randomUUID(),
      connectionId: input.connectionId,
      name,
      sql,
      condition: input.condition,
      threshold,
      everyMinutes,
      enabled: input.enabled !== false,
    }
    const alert: Alert = {
      ...next,
      state: before && basis(before) === basis(next) ? before.state : FRESH,
    }
    this.alerts = before
      ? this.alerts.map((item) => (item.id === alert.id ? alert : item))
      : [...this.alerts, alert]
    this.persist()
    this.emit({ type: "alert", alert })
    // A new one, or one asking something else, is checked straight away.
    if (alert.enabled && alert.state.status === "pending") void this.check(alert.id).catch(() => {})
    return alert
  }

  remove(id: string): void {
    if (!this.alerts.some((alert) => alert.id === id)) return
    this.alerts = this.alerts.filter((alert) => alert.id !== id)
    this.persist()
    this.emit({ type: "alert_deleted", alertId: id })
  }

  /** A removed connection's alerts go with it. */
  forget(connectionId: string): void {
    for (const alert of this.alerts.filter((item) => item.connectionId === connectionId)) {
      this.remove(alert.id)
    }
  }

  /** Runs it now. A check already under way is waited for, not doubled. */
  check(id: string): Promise<Alert> {
    const under = this.running.get(id)
    if (under) return under
    const run = this.run(this.get(id)).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async run(alert: Alert): Promise<Alert> {
    const asked = basis(alert)
    let state: AlertState
    const now = Date.now()
    try {
      const result = await this.connections.driver(alert.connectionId).query(alert.sql, {
        readOnly: true,
        maxRows: 1,
        timeoutMs: CHECK_TIMEOUT_MS,
      })
      const value = readAlertValue(result)
      // The number before: the last one read, whether or not that check fired.
      const previous = alert.state.value
      const out = alertFires(alert.condition, alert.threshold, value, previous)
      state = {
        status: out ? "triggered" : "ok",
        value,
        previous,
        checkedAt: now,
        triggeredAt: out && alert.state.status !== "triggered" ? now : alert.state.triggeredAt,
        error: null,
      }
    } catch (error) {
      state = { ...alert.state, status: "error", checkedAt: now, error: messageOf(error) }
    }

    // Edited or removed while it ran: what it found is about something else.
    const current = this.alerts.find((item) => item.id === alert.id)
    if (!current || basis(current) !== asked) return current ?? alert
    const updated: Alert = { ...current, state }
    this.alerts = this.alerts.map((item) => (item.id === updated.id ? updated : item))
    this.persist()
    this.emit({ type: "alert", alert: updated })
    if (state.status === "triggered" && current.state.status !== "triggered") this.fired(updated)
    return updated
  }

  /** The alerts whose interval has passed since they were last checked. */
  due(now = Date.now()): Alert[] {
    return this.alerts.filter(
      (alert) =>
        alert.enabled &&
        !this.running.has(alert.id) &&
        (alert.state.checkedAt === null || now - alert.state.checkedAt >= alert.everyMinutes * 60_000)
    )
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      for (const alert of this.due()) void this.check(alert.id).catch(() => {})
    }, TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
