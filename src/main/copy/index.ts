import {
  COPY_CONTENTS,
  COPY_EXISTING_FOR,
  type Connection,
  type CopyInput,
  type CopyPlan,
  type CopyPlanItem,
  type CopyProgress,
  type CopyResult,
  type Rule,
} from "../../shared/api"
import { dataReadable, defaultSchemaOf, judge } from "../../shared/permissions"
import type { Connections } from "../connections"
import type { RawSession, RawValue } from "../db/types"
import type { CopyEngine, SourceObject } from "./engine"
import { mysqlCopy } from "./mysql"
import { postgresCopy } from "./postgres"

/** Rows read from the source at a time. */
const READ_BATCH = 1000

const ENGINES: Partial<Record<Connection["engine"], CopyEngine>> = {
  postgres: postgresCopy,
  mysql: mysqlCopy,
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a copy will run, worked out with both ends open. */
type Prepared = {
  plan: CopyPlan
  engine: CopyEngine
  from: string
  to: string
  /** Before any table: the schema, drops, emptying, types. */
  setup: string[]
  /** Made before rows go in, in order. */
  tables: SourceObject[]
  /** Filled, parents before children where keys say so. */
  fill: SourceObject[]
  views: SourceObject[]
  /** The source's cap on rows a read brings back, and the target's on rows
   * written at once: a copy past either stops. */
  limits: { maxRows: number | null; maxAffected: number | null }
}

class Cancelled extends Error {
  constructor() {
    super("The copy was stopped.")
  }
}

/** Tables in an order where what a key points at comes first; a cycle's are
 * left in the order they came. */
function parentsFirst(objects: SourceObject[]): SourceObject[] {
  const byName = new Map(objects.map((item) => [item.name, item]))
  const placed = new Set<string>()
  const visiting = new Set<string>()
  const ordered: SourceObject[] = []
  const visit = (item: SourceObject) => {
    if (placed.has(item.name) || visiting.has(item.name)) return
    visiting.add(item.name)
    for (const parent of item.dependsOn) {
      const found = byName.get(parent)
      if (found) visit(found)
    }
    visiting.delete(item.name)
    placed.add(item.name)
    ordered.push(item)
  }
  objects.forEach(visit)
  return ordered
}

/** Roughly how many bytes a row takes on the wire. */
const rowBytes = (row: RawValue[]) =>
  row.reduce((sum, value) => sum + (value === null ? 4 : Buffer.isBuffer(value) ? value.length * 2 : value.length * 2), 8)

/**
 * Copies tables and views from one connection to another of the same
 * engine: their structure, their rows, or both.
 *
 * What it reads goes by the source's permissions as anything else does —
 * hidden tables cannot be named, structure-only ones give no rows — and
 * what it writes is judged by the target's, statement by statement, before
 * anything runs: blocked is refused here, and what the target asks about is
 * asked in the dialog that shows the plan. Both ends are read and written
 * through sessions of their own, outside the guards, for that reason.
 */
export class Copies {
  private readonly running = new Map<string, { cancelled: boolean }>()

  constructor(
    private readonly connections: Connections,
    private readonly progress: (event: CopyProgress) => void
  ) {}

  async plan(input: CopyInput): Promise<CopyPlan> {
    return this.open(input, async (prepared) => prepared.plan)
  }

  cancel(copyId: string): void {
    const state = this.running.get(copyId)
    if (state) state.cancelled = true
  }

  async run(copyId: string, input: CopyInput): Promise<CopyResult> {
    const state = { cancelled: false }
    this.running.set(copyId, state)
    try {
      return await this.open(input, (prepared, source, target) => this.execute(copyId, state, prepared, source, target))
    } finally {
      this.running.delete(copyId)
    }
  }

  /** Both ends open, the input checked and the plan made, for `work`. */
  private async open<T>(
    input: CopyInput,
    work: (prepared: Prepared, source: RawSession, target: RawSession) => Promise<T>
  ): Promise<T> {
    const sourceConnection = this.connections.get(input.source.connectionId)
    const targetConnection = this.connections.get(input.target.connectionId)
    const engine = ENGINES[sourceConnection.engine]
    if (!engine) throw new Error(`Tables cannot be copied out of a ${sourceConnection.engine === "duckdb" ? "files" : sourceConnection.engine} connection yet.`)
    if (targetConnection.engine !== sourceConnection.engine) {
      throw new Error(
        `"${sourceConnection.name}" and "${targetConnection.name}" are different kinds of database: tables are copied between two PostgreSQL or two MySQL connections.`
      )
    }
    if (!COPY_CONTENTS.includes(input.content)) throw new Error("Pick what to copy.")
    if (!COPY_EXISTING_FOR[input.content].includes(input.existing)) {
      throw new Error("Pick what to do with tables the target already has.")
    }
    const from = input.source.schema
    const to = input.target.schema.trim()
    if (!to) throw new Error("Name the schema to copy into.")
    if (to.length > 63) throw new Error("That schema name is too long.")
    if (input.source.connectionId === input.target.connectionId && from === to) {
      throw new Error("That is where they are already: pick another schema, or another connection.")
    }
    const names = [...new Set(input.source.tables)]
    if (names.length === 0) throw new Error("Pick at least one table to copy.")

    // Only what the source shows may be copied out of it.
    const sourceGuard = this.connections.driver(input.source.connectionId)
    const tree = await sourceGuard.tree()
    const visible = new Map(tree.find((schema) => schema.name === from)?.tables.map((table) => [table.name, table.kind]) ?? [])
    const unseen = names.filter((name) => !visible.has(name))
    if (unseen.length) throw new Error(`Not in ${from}, or hidden on "${sourceConnection.name}": ${unseen.join(", ")}.`)
    // Tables whose rows stay where they are: asked before the source's
    // session opens, as it holds a snapshot until the copy is done.
    const closed: string[] = []
    if (input.content !== "structure") {
      for (const name of names) {
        if (visible.get(name) !== "table") continue
        if (!dataReadable(await sourceGuard.accessOf({ schema: from, table: name }))) closed.push(name)
      }
    }

    const targetGuard = this.connections.driver(input.target.connectionId)
    return sourceGuard.unguardedSession((source) =>
      targetGuard.unguardedSession(async (target) => {
        const prepared = await this.prepare(input, engine, source, target, sourceConnection, targetConnection, from, to, names, closed)
        return work(prepared, source, target)
      })
    )
  }

  private async prepare(
    input: CopyInput,
    engine: CopyEngine,
    source: RawSession,
    target: RawSession,
    sourceConnection: Connection,
    targetConnection: Connection,
    from: string,
    to: string,
    names: string[],
    closed: string[]
  ): Promise<Prepared> {
    const structure = input.content !== "data"
    const data = input.content !== "structure"
    await engine.beginSource(source, from)
    const state = await engine.inspectTarget(target, to)
    const described = await engine.describe(source, target, from, to, names, state, { data })
    const warnings = [...described.warnings]
    const blocks: string[] = []

    if (data && closed.length) {
      blocks.push(
        `${closed.join(", ")} ${closed.length === 1 ? "shows" : "show"} structure only on "${sourceConnection.name}": ${closed.length === 1 ? "its" : "their"} rows cannot be copied. Copy the structure only, or leave ${closed.length === 1 ? "it" : "them"} out.`
      )
    }

    const items: CopyPlanItem[] = []
    const conflicts: string[] = []
    const absent: string[] = []
    const make: SourceObject[] = []
    const fill: SourceObject[] = []
    const replaced: { name: string; kind: SourceObject["kind"] }[] = []
    const truncated: string[] = []
    for (const object of described.objects) {
      const existing = state.existing.get(object.name)
      const exists = existing !== undefined
      let action: CopyPlanItem["action"]
      if (!structure) {
        if (object.kind !== "table") action = "skip"
        else if (!exists || existing !== "table") {
          absent.push(object.name)
          action = "skip"
        } else action = input.existing === "truncate" ? "truncate" : "append"
      } else if (!exists) action = "create"
      else if (input.existing === "fail") {
        conflicts.push(object.name)
        action = "skip"
      } else if (input.existing === "replace") action = "replace"
      else if (input.existing === "append" && object.kind === "table" && existing === "table") action = "append"
      else action = "skip"

      const copiesRows = data && object.kind === "table" && object.readsData && action !== "skip" && object.columns.length > 0
      items.push({
        name: object.name,
        kind: object.kind,
        exists,
        action,
        data: copiesRows,
        rowEstimate: object.rowEstimate,
      })
      if (action === "create" || action === "replace") make.push(object)
      if (action === "replace") replaced.push({ name: object.name, kind: existing ?? object.kind })
      if (action === "truncate") truncated.push(object.name)
      if (copiesRows) fill.push(object)
    }
    if (conflicts.length) {
      blocks.push(
        `Already in ${to}: ${conflicts.join(", ")}. Choose to skip ${conflicts.length === 1 ? "it" : "them"}, replace ${conflicts.length === 1 ? "it" : "them"}${data ? ", or add the rows to " + (conflicts.length === 1 ? "it" : "them") : ""}.`
      )
    }
    if (!structure && !state.schemaExists) {
      blocks.push(`"${targetConnection.name}" has no schema ${to}: copy the structure too.`)
    } else if (absent.length) {
      blocks.push(`Not in ${to} on "${targetConnection.name}": ${absent.join(", ")}. Copy the structure too, or leave ${absent.length === 1 ? "it" : "them"} out.`)
    }

    const setup: string[] = []
    if (!state.schemaExists && structure) setup.push(await engine.createSchema(source, from, to))
    setup.push(...engine.drop(to, replaced))
    setup.push(...engine.truncate(to, truncated))
    if (make.length) setup.push(...described.prelude)
    const tables = make.filter((item) => item.kind === "table")
    const views = make.filter((item) => item.kind !== "table")
    const ordered = parentsFirst(fill)

    // What the target is asked to run, rows aside, as one script to read.
    const script: string[] = [...setup]
    for (const table of tables) script.push(...table.create)
    for (const table of ordered) {
      script.push(
        `-- The rows of ${table.name}${table.rowEstimate !== null ? ` (about ${table.rowEstimate.toLocaleString("en-US")})` : ""}`
      )
      script.push(...table.afterData)
    }
    for (const table of tables) script.push(...table.after)
    for (const view of views) script.push(...view.create, ...view.after)

    // Judged as the target's own SQL tab would be.
    const context = {
      permissions: targetConnection.permissions,
      access: targetConnection.access,
      engine: targetConnection.engine,
      defaultSchema: defaultSchemaOf(targetConnection),
    }
    const judged = [
      ...script.filter((line) => !line.startsWith("--")),
      ...ordered.map((table) => engine.insert(to, table.name, table.columns, 1, table.overriding)),
    ]
    let rule: Rule = blocks.length ? "block" : "allow"
    const reasons = [...blocks]
    for (const statement of judged) {
      const verdict = judge(statement, context)
      if (verdict.rule === "block") rule = "block"
      else if (verdict.rule === "ask" && rule === "allow") rule = "ask"
      for (const reason of verdict.reasons) if (!reasons.includes(reason)) reasons.push(reason)
    }

    if (!engine.transactional && (replaced.length || truncated.length)) {
      warnings.push("MySQL commits each table as it is made or emptied: if the copy fails part-way, what was done before stays.")
    }

    return {
      plan: {
        engine: engine.engine,
        createsSchema: !state.schemaExists && structure,
        items,
        script: script.map((line) => (line.startsWith("--") ? line : `${line};`)).join("\n\n"),
        warnings,
        rule,
        reasons,
      },
      engine,
      from,
      to,
      setup,
      tables,
      fill: ordered,
      views,
      limits: {
        maxRows: sourceConnection.permissions.guards.maxRows,
        maxAffected: targetConnection.permissions.guards.maxAffected,
      },
    }
  }

  private async execute(
    copyId: string,
    state: { cancelled: boolean },
    prepared: Prepared,
    source: RawSession,
    target: RawSession
  ): Promise<CopyResult> {
    const { plan, engine, from, to } = prepared
    if (plan.rule === "block") throw new Error(`Refused: ${plan.reasons.join(" ")}`)

    const started = Date.now()
    const counts = new Map<string, number>()
    const warnings = [...plan.warnings]
    let total = 0
    let done = 0
    const emit = (step: string, table: string | null, rows = 0) =>
      this.progress({ copyId, step, table, rows, done, total: prepared.fill.length })
    const check = () => {
      if (state.cancelled) throw new Cancelled()
    }

    const { limits } = prepared
    try {
      emit("Preparing the target", null)
      await engine.beginTarget(target, to)
      for (const statement of prepared.setup.slice(0, plan.createsSchema ? 1 : 0)) await target.query(statement)
      await engine.enterSchema(target, to)
      for (const statement of prepared.setup.slice(plan.createsSchema ? 1 : 0)) {
        check()
        await target.query(statement)
      }
      for (const table of prepared.tables) {
        check()
        emit(`Making ${table.name}`, table.name)
        for (const statement of table.create) await target.query(statement)
      }

      for (const table of prepared.fill) {
        check()
        let rows = 0
        emit(`Copying the rows of ${table.name}`, table.name, 0)
        await engine.beginTable(target)
        const perInsert = engine.rowsPerInsert(table.columns.length)
        await source.stream(engine.select(from, table.name, table.columns), READ_BATCH, async (batch) => {
          check()
          if (limits.maxRows !== null && rows + batch.length > limits.maxRows) {
            throw new Error(
              `${table.name} has more than the ${limits.maxRows.toLocaleString("en-US")} rows a read may bring back from this source (Settings › Permissions).`
            )
          }
          let start = 0
          while (start < batch.length) {
            let end = start
            let bytes = 0
            while (end < batch.length && end - start < perInsert) {
              bytes += rowBytes(batch[end]!)
              if (end > start && bytes > engine.insertBytes) break
              end++
            }
            const slice = batch.slice(start, end)
            await target.query(
              engine.insert(to, table.name, table.columns, slice.length, table.overriding),
              slice.flat()
            )
            start = end
          }
          rows += batch.length
          total += batch.length
          if (limits.maxAffected !== null && total > limits.maxAffected) {
            throw new Error(
              `This would write more than the ${limits.maxAffected.toLocaleString("en-US")} rows the target allows at once (Settings › Permissions).`
            )
          }
          emit(`Copying the rows of ${table.name}`, table.name, rows)
        })
        for (const statement of table.afterData) await target.query(statement)
        await engine.commitTable(target)
        counts.set(table.name, rows)
        done++
      }

      if (prepared.tables.some((table) => table.after.length)) emit("Adding indexes and keys", null)
      for (const table of prepared.tables) {
        for (const statement of table.after) {
          check()
          await target.query(statement)
        }
      }

      // A view may read another: what fails is tried again once the rest
      // is made, until a round makes nothing new.
      let pending = prepared.views
      const failures = new Map<string, Error>()
      while (pending.length) {
        check()
        emit("Making views", null)
        const next: SourceObject[] = []
        for (const view of pending) {
          const error = await engine.attempt(target, [...view.create, ...view.after])
          if (error) {
            failures.set(view.name, error)
            next.push(view)
          } else failures.delete(view.name)
        }
        if (next.length === pending.length) break
        pending = next
      }
      for (const [name, error] of failures) {
        warnings.push(`The view ${name} could not be made: ${error.message}`)
      }

      check()
      await engine.finishTarget(target)
      const failed = new Set(failures.keys())
      return {
        items: plan.items.map((item) => ({
          name: item.name,
          status: failed.has(item.name) ? "failed" : item.action === "skip" ? "skipped" : "copied",
          rows: counts.get(item.name) ?? 0,
        })),
        rows: total,
        ms: Date.now() - started,
        warnings,
      }
    } catch (error) {
      await target.query("ROLLBACK").catch(() => {})
      throw new Error(
        `${messageOf(error)}\n` +
          (engine.transactional
            ? "Nothing was changed: the copy was rolled back."
            : "The table being filled was rolled back; what was made or filled before it stays.")
      )
    }
  }
}
