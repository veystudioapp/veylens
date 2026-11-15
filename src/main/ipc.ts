import { ipcMain, type IpcMainInvokeEvent } from "electron"

import { addressOf } from "../shared/address"
import { IPC, type AuditStatus, type DesktopApi } from "../shared/api"
import { toolInfo } from "../shared/agent"
import { describePermissions } from "../shared/permissions"
import { startsLikeRead } from "../shared/statements"
import { agentModels } from "./agent-models"
import type { Assist } from "./assist"
import { describeChanges, refusal, type AuditLog } from "./audit"
import type { Chats } from "./chats"
import type { Connections } from "./connections"
import type { Library } from "./library"
import { applyUserChanges, runUserQuery } from "./user-queries"

/** Rows one page of a table may hold, whatever the page asks for. */
const PAGE_ROWS = 1000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))


const statusOf = (error: unknown): AuditStatus =>
  refusal(messageOf(error)) ? "refused" : "failed"

type Handlers = {
  [K in keyof DesktopApi as DesktopApi[K] extends (
    ...args: never[]
  ) => Promise<unknown>
    ? K
    : never]: DesktopApi[K]
}

/**
 * Every call the renderer can make, in one place. Each is a thin step onto
 * `Connections` or `Chats`; an error thrown here reaches the renderer as a
 * rejected promise carrying its message.
 */
export function registerIpc({
  connections,
  chats,
  library,
  assist,
  audit,
}: {
  connections: Connections
  chats: Chats
  library: Library
  assist: Assist
  audit: AuditLog
}): void {
  const nameOf = (connectionId: string) =>
    connections.list().find((item) => item.id === connectionId)?.name ?? null
  const mine = (connectionId: string | null) => ({
    actor: "you" as const,
    connectionId,
    connectionName: connectionId ? nameOf(connectionId) : null,
  })

  const handlers: Handlers = {
    listConnections: async () => connections.list(),
    saveConnection: async (id, input) => {
      const before = id ? connections.list().find((item) => item.id === id) : undefined
      const saved = connections.save(id, input)
      const fields = (["name", "engine", "host", "port", "user", "database", "ssl", "access", "color"] as const)
        .filter((field) => before && before[field] !== saved[field])
        .concat(
          before && JSON.stringify(before.cloudSql) !== JSON.stringify(saved.cloudSql)
            ? (["cloud SQL"] as never[])
            : []
        )
        .concat(input.password !== undefined && before ? (["password"] as never[]) : [])
      if (!before || fields.length) {
        audit.record({
          ...mine(saved.id),
          action: "connection",
          status: "ok",
          summary: before
            ? `Edited connection ${saved.name}: ${fields.join(", ")}`
            : `Added connection ${saved.name} (${saved.engine}, ${addressOf(saved)}/${saved.database})`,
          ...(before && fields.includes("access")
            ? { detail: `access: ${before.access} → ${saved.access}` }
            : {}),
        })
      }
      return saved
    },
    deleteConnection: async (id) => {
      const record = mine(id)
      connections.delete(id)
      library.forget(id)
      audit.record({
        ...record,
        action: "connection",
        status: "ok",
        summary: `Removed connection ${record.connectionName ?? id}, with its dashboards and context`,
      })
    },
    testConnection: (id, input) => connections.test(id, input),

    getTree: (connectionId) => connections.driver(connectionId).tree(),
    listObjects: (connectionId) => connections.driver(connectionId).allObjects(),
    setPermissions: async (connectionId, permissions) => {
      const saved = connections.setPermissions(connectionId, permissions)
      audit.record({
        ...mine(connectionId),
        action: "permissions",
        status: "ok",
        summary: `Changed the permissions of ${saved.name}`,
        detail: describePermissions(saved.permissions, saved.access).join("\n"),
      })
      return saved
    },
    getTable: (connectionId, ref) => connections.driver(connectionId).table(ref),
    getTableDetails: (connectionId, ref) => connections.driver(connectionId).details(ref),
    getRows: (connectionId, request) =>
      connections.driver(connectionId).rows({
        ...request,
        limit: Math.min(request.limit, PAGE_ROWS),
      }),
    applyChanges: async (connectionId, changes) => {
      const started = performance.now()
      const base = {
        ...mine(connectionId),
        action: "edit_rows" as const,
        summary: `Saved rows: ${describeChanges(changes)}`,
        sql: JSON.stringify(
          { updates: changes.updates, inserts: changes.inserts, deletes: changes.deletes },
          null,
          1
        ),
      }
      try {
        const changed = await applyUserChanges(connections, connectionId, changes)
        audit.record({ ...base, status: "ok", rows: changed, ms: Math.round(performance.now() - started) })
        return changed
      } catch (error) {
        audit.record({ ...base, status: statusOf(error), detail: messageOf(error) })
        throw error
      }
    },
    runQuery: async (connectionId, sql, readOnly, params) => {
      // Dashboards, filters and metric tests ask for a read: they run all
      // the time and change nothing. A statement from the SQL tab is kept.
      if (readOnly) return runUserQuery(connections, connectionId, sql, readOnly, params)
      const started = performance.now()
      const read = startsLikeRead(sql)
      const base = {
        ...mine(connectionId),
        action: read ? ("query" as const) : ("write" as const),
        summary: read ? "Ran a query in a SQL tab" : "Ran a statement in a SQL tab",
        sql,
      }
      try {
        const result = await runUserQuery(connections, connectionId, sql, readOnly, params)
        audit.record({
          ...base,
          status: "ok",
          rows: result.affected ?? result.rows.length,
          ms: Math.round(performance.now() - started),
        })
        return result
      } catch (error) {
        audit.record({ ...base, status: statusOf(error), detail: messageOf(error) })
        throw error
      }
    },
    explainQuery: (connectionId, sql) =>
      connections.driver(connectionId).explain(sql),

    getKnowledge: async (connectionId) => library.knowledge(connectionId),
    saveKnowledge: async (connectionId, knowledge) => {
      const saved = library.saveKnowledge(connectionId, knowledge)
      audit.record({
        ...mine(connectionId),
        action: "context",
        status: "ok",
        summary: `Saved the business context: ${saved.metrics.length} ${saved.metrics.length === 1 ? "metric" : "metrics"}, ${saved.notes.split("\n").filter((line) => line.trim()).length} lines of notes`,
      })
      return saved
    },
    listDashboards: async () => library.dashboards(),
    saveDashboard: async (dashboard) => library.saveDashboard(dashboard),
    deleteDashboard: async (id) => {
      const dashboard = library.dashboards().find((item) => item.id === id)
      library.deleteDashboard(id)
      if (dashboard) {
        audit.record({
          ...mine(dashboard.connectionId),
          action: "dashboard",
          status: "ok",
          summary: `Deleted the dashboard "${dashboard.title}" (${dashboard.tiles.length} tiles)`,
        })
      }
    },
    pinToDashboard: async (input) => library.pin(input),

    listSkills: async () => library.skills(),
    saveSkill: async (input) => library.saveSkill(input),
    deleteSkill: async (id) => library.deleteSkill(id),
    resetSkill: async (id) => library.resetSkill(id),
    getTableFields: async (connectionId, ref) => library.tableFields(connectionId, ref),
    setFieldSettings: async (connectionId, ref, column, settings) =>
      library.setFieldSettings(connectionId, ref, column, settings),
    setDisplayColumn: async (connectionId, ref, column) =>
      library.setDisplayColumn(connectionId, ref, column),
    getToolModes: async () => library.toolModes(),
    getAiSettings: async () => library.aiSettings(),
    setAiSettings: async (settings) => library.setAiSettings(settings),
    setToolMode: async (tool, mode) => {
      const modes = library.setToolMode(tool, mode)
      audit.record({
        ...mine(null),
        action: "tools",
        tool,
        status: "ok",
        summary: `Set "${toolInfo(tool)?.label ?? tool}" to ${mode === "allow" ? "Allow" : mode === "ask" ? "Ask first" : "Off"}`,
      })
      return modes
    },
    listAudit: async () => audit.list(),
    clearAudit: async () => audit.clear(),

    assistSql: (input) => assist.run(input),
    cancelAssist: async (requestId) => assist.cancel(requestId),

    agentStatus: () => chats.status(),
    agentModels: (fresh) => agentModels(fresh),
    listChats: async () => chats.list(),
    createChat: async () => chats.create(),
    getChat: async (chatId) => chats.get(chatId),
    deleteChat: async (chatId) => chats.delete(chatId),
    sendMessage: (input) => chats.send(input),
    chatImage: async (name) => chats.image(name),
    stopChat: (chatId) => chats.stop(chatId),
    answerApproval: async (chatId, toolId, allow) =>
      chats.answerApproval(chatId, toolId, allow),
  }

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(
      IPC[name as keyof Handlers],
      (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
        (handler as (...args: unknown[]) => Promise<unknown>)(...args)
    )
  }
}
