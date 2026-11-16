import type {
  AccessMode,
  ChangeSet,
  Engine,
  Permissions,
  QueryResult,
  RowsRequest,
  TableRef,
  TreeSchema,
} from "../../shared/api"
import {
  defaultSchemaOf,
  hiddenIn,
  dataReadable,
  hideDependentViews,
  judge,
  judgeChanges,
  objectAccess,
  visibleTree,
  type Context,
} from "../../shared/permissions"
import type { Driver, PlanLimits, QueryOptions, ViewSource } from "./types"

/** What a guard reads, fresh on every call: permissions change while a
 * driver stays open. */
export type Policy = {
  name: string
  engine: Engine
  database: string
  access: AccessMode
  permissions: Permissions
}

/** How long what the views read is trusted before the catalog is asked again:
 * a view made outside this app is caught by then, and by the next tree. */
const VIEW_SOURCES_TTL_MS = 10_000

function refused(name: string, reasons: string[]): Error {
  return new Error(
    `Refused by the permissions of "${name}": ${reasons.join(" ")} They are set in Settings › Permissions.`
  )
}

/**
 * What each view reads, from the server's catalog: one per connection, shared
 * by its guards so a view made through one is seen by the other. Asked again
 * after a few seconds, when fresh is asked for, and after anything that may
 * have made or changed a view. A failure is not kept, and refuses rather than
 * lets a view through unchecked.
 */
export class ViewSourceCache {
  private cached: { at: number; sources: Promise<ViewSource[]> } | null = null

  constructor(private readonly inner: Driver) {}

  get(fresh = false): Promise<ViewSource[]> {
    const inner = this.inner
    if (!inner.viewSources) return Promise.resolve([])
    const cached = this.cached
    if (!fresh && cached && Date.now() - cached.at < VIEW_SOURCES_TTL_MS) return cached.sources
    const sources: Promise<ViewSource[]> = inner.viewSources().catch((error: unknown) => {
      if (this.cached?.sources === sources) this.cached = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not read which tables the views use, so hidden tables cannot be kept hidden: ${message}`)
    })
    this.cached = { at: Date.now(), sources }
    return sources
  }

  forget(): void {
    this.cached = null
  }
}

/**
 * A driver with a connection's permissions in front of it. Every way in —
 * the explorer, a table tab, the SQL tab, a dashboard tile, the assistant —
 * goes through one, so a hidden table is hidden from all of them and a
 * blocked statement is blocked for all of them. The assistant's guard sees
 * the permissions through `forAssistant`: what is marked structure only is
 * listed and described to it, and its rows refused. A view that reads a
 * hidden or structure-only table is kept so with it, from the server's own
 * record of what it reads.
 *
 * It refuses what is blocked. What is to be asked about is asked by whoever
 * started it: the renderer before it sends a statement or an edit, and the
 * assistant's approval card, which every write already has.
 */
export class GuardedDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly policy: () => Policy,
    private readonly views: ViewSourceCache = new ViewSourceCache(inner)
  ) {}

  /** The policy as it stands, with views over hidden and structure-only
   * tables kept so too. */
  private async context(fresh = false): Promise<Context & { name: string }> {
    const policy = this.policy()
    const base = policy.permissions
    const permissions = base.objects.some((rule) => rule.access === "hidden" || rule.access === "schema")
      ? hideDependentViews(base, await this.views.get(fresh))
      : base
    return {
      name: policy.name,
      permissions,
      access: policy.access,
      engine: policy.engine,
      defaultSchema: defaultSchemaOf(policy),
    }
  }

  /** Refuses what is hidden; structure only may be seen. */
  private async see(ref: TableRef): Promise<Context & { name: string }> {
    const context = await this.context()
    if (objectAccess(context.permissions, ref) === "hidden") {
      throw refused(context.name, [`${ref.schema}.${ref.table} is hidden on this connection.`])
    }
    return context
  }

  /** Refuses what is hidden, and what shows its structure only. */
  private async read(ref: TableRef): Promise<Context & { name: string }> {
    const context = await this.see(ref)
    if (!dataReadable(objectAccess(context.permissions, ref))) {
      throw refused(context.name, [
        `${ref.schema}.${ref.table} shows the assistant its structure only: its data cannot be read.`,
      ])
    }
    return context
  }

  private limits(
    permissions: Permissions,
    readOnly: boolean
  ): { timeoutMs?: number; maxAffected?: number; maxRows?: number } {
    const { guards } = permissions
    return {
      ...(guards.timeoutSeconds !== null ? { timeoutMs: guards.timeoutSeconds * 1000 } : {}),
      ...(!readOnly && guards.maxAffected !== null ? { maxAffected: guards.maxAffected } : {}),
      ...(guards.maxRows !== null ? { maxRows: guards.maxRows } : {}),
    }
  }

  ping(): Promise<string> {
    return this.inner.ping()
  }

  async tree(): Promise<TreeSchema[]> {
    // Fresh: the tree is where a view made since is first seen.
    const [context, tree] = await Promise.all([this.context(true), this.inner.tree()])
    return visibleTree(context.permissions, tree)
  }

  /** Everything, hidden or not: for the screen that sets what is hidden. */
  allObjects(): Promise<TreeSchema[]> {
    return this.inner.tree()
  }

  async table(ref: TableRef) {
    await this.see(ref)
    return this.inner.table(ref)
  }

  /** A table's details; keys from tables hidden here are left out. */
  async details(ref: TableRef) {
    const { permissions } = await this.see(ref)
    const details = await this.inner.details(ref)
    return {
      ...details,
      referencedBy: details.referencedBy.filter(
        (key) => objectAccess(permissions, { schema: key.schema, table: key.table }) !== "hidden"
      ),
    }
  }

  async rows(request: RowsRequest) {
    const { permissions } = await this.read(request)
    const { maxRows } = this.limits(permissions, true)
    return this.inner.rows(
      maxRows !== undefined ? { ...request, limit: Math.min(request.limit, maxRows) } : request
    )
  }

  async apply(changes: ChangeSet): Promise<number> {
    const context = await this.context()
    const verdict = judgeChanges(changes, context)
    if (verdict.rule === "block") throw refused(context.name, verdict.reasons)
    return this.inner.apply(changes)
  }

  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const context = await this.context()
    const verdict = judge(sql, context)
    // A read asked for as one is refused by the driver if it writes; here
    // only what it may not see stops it.
    const reasons = options.readOnly ? hiddenIn(sql, context) : verdict.rule === "block" ? verdict.reasons : []
    if (reasons.length) throw refused(context.name, reasons)
    const limits = this.limits(context.permissions, options.readOnly)
    try {
      return await this.inner.query(sql, {
        ...options,
        maxRows: Math.min(options.maxRows, limits.maxRows ?? Infinity),
        ...(limits.timeoutMs !== undefined
          ? { timeoutMs: Math.min(options.timeoutMs ?? Infinity, limits.timeoutMs) }
          : {}),
        ...(limits.maxAffected !== undefined ? { maxAffected: limits.maxAffected } : {}),
      })
    } finally {
      if (!options.readOnly) this.views.forget()
    }
  }

  async explain(sql: string): Promise<QueryResult> {
    const context = await this.context()
    const reasons = hiddenIn(sql, context)
    if (reasons.length) throw refused(context.name, reasons)
    return this.inner.explain(sql)
  }

  async runPlan(statements: string[], given: PlanLimits = {}) {
    const context = await this.context()
    const reasons = statements.flatMap((statement) => {
      const verdict = judge(statement, context)
      return verdict.rule === "block" ? verdict.reasons : []
    })
    if (reasons.length) throw refused(context.name, [...new Set(reasons)])
    const limits = this.limits(context.permissions, false)
    try {
      return await this.inner.runPlan(statements, {
        ...given,
        ...(limits.maxAffected !== undefined ? { maxAffected: limits.maxAffected } : {}),
        ...(limits.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : {}),
      })
    } finally {
      this.views.forget()
    }
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
