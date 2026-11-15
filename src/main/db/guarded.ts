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
  judge,
  judgeChanges,
  objectAccess,
  visibleTree,
  type Context,
} from "../../shared/permissions"
import type { Driver, PlanLimits, QueryOptions } from "./types"

/** What a guard reads, fresh on every call: permissions change while a
 * driver stays open. */
export type Policy = {
  name: string
  engine: Engine
  database: string
  access: AccessMode
  permissions: Permissions
}

function refused(name: string, reasons: string[]): Error {
  return new Error(
    `Refused by the permissions of "${name}": ${reasons.join(" ")} They are set in Settings › Permissions.`
  )
}

/**
 * A driver with a connection's permissions in front of it. Every way in —
 * the explorer, a table tab, the SQL tab, a dashboard tile, the assistant —
 * goes through here, so a hidden table is hidden from all of them and a
 * blocked statement is blocked for all of them.
 *
 * It refuses what is blocked. What is to be asked about is asked by whoever
 * started it: the renderer before it sends a statement or an edit, and the
 * assistant's approval card, which every write already has.
 */
export class GuardedDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly policy: () => Policy
  ) {}

  private context(): Context & { name: string } {
    const policy = this.policy()
    return {
      name: policy.name,
      permissions: policy.permissions,
      access: policy.access,
      engine: policy.engine,
      defaultSchema: defaultSchemaOf(policy),
    }
  }

  private see(ref: TableRef): void {
    const { permissions, name } = this.context()
    if (objectAccess(permissions, ref) === "hidden") {
      throw refused(name, [`${ref.schema}.${ref.table} is hidden on this connection.`])
    }
  }

  private limits(readOnly: boolean): { timeoutMs?: number; maxAffected?: number; maxRows?: number } {
    const { guards } = this.context().permissions
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
    return visibleTree(this.context().permissions, await this.inner.tree())
  }

  /** Everything, hidden or not: for the screen that sets what is hidden. */
  allObjects(): Promise<TreeSchema[]> {
    return this.inner.tree()
  }

  async table(ref: TableRef) {
    this.see(ref)
    return this.inner.table(ref)
  }

  /** A table's details; keys from tables hidden here are left out. */
  async details(ref: TableRef) {
    this.see(ref)
    const details = await this.inner.details(ref)
    const { permissions } = this.context()
    return {
      ...details,
      referencedBy: details.referencedBy.filter(
        (key) => objectAccess(permissions, { schema: key.schema, table: key.table }) !== "hidden"
      ),
    }
  }

  async rows(request: RowsRequest) {
    this.see(request)
    const { maxRows } = this.limits(true)
    return this.inner.rows(
      maxRows !== undefined ? { ...request, limit: Math.min(request.limit, maxRows) } : request
    )
  }

  apply(changes: ChangeSet): Promise<number> {
    const context = this.context()
    const verdict = judgeChanges(changes, context)
    if (verdict.rule === "block") return Promise.reject(refused(context.name, verdict.reasons))
    return this.inner.apply(changes)
  }

  query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const context = this.context()
    const verdict = judge(sql, context)
    // A read asked for as one is refused by the driver if it writes; here
    // only what it may not see stops it.
    const reasons = options.readOnly ? hiddenIn(sql, context) : verdict.rule === "block" ? verdict.reasons : []
    if (reasons.length) return Promise.reject(refused(context.name, reasons))
    const limits = this.limits(options.readOnly)
    return this.inner.query(sql, {
      ...options,
      maxRows: Math.min(options.maxRows, limits.maxRows ?? Infinity),
      ...(limits.timeoutMs !== undefined
        ? { timeoutMs: Math.min(options.timeoutMs ?? Infinity, limits.timeoutMs) }
        : {}),
      ...(limits.maxAffected !== undefined ? { maxAffected: limits.maxAffected } : {}),
    })
  }

  explain(sql: string): Promise<QueryResult> {
    const context = this.context()
    const reasons = hiddenIn(sql, context)
    if (reasons.length) return Promise.reject(refused(context.name, reasons))
    return this.inner.explain(sql)
  }

  runPlan(statements: string[], given: PlanLimits = {}) {
    const context = this.context()
    const reasons = statements.flatMap((statement) => {
      const verdict = judge(statement, context)
      return verdict.rule === "block" ? verdict.reasons : []
    })
    if (reasons.length) return Promise.reject(refused(context.name, [...new Set(reasons)]))
    const limits = this.limits(false)
    return this.inner.runPlan(statements, {
      ...given,
      ...(limits.maxAffected !== undefined ? { maxAffected: limits.maxAffected } : {}),
      ...(limits.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : {}),
    })
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
