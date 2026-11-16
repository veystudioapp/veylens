import { readFileSync } from "node:fs"
import path from "node:path"

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"

import { locationOf } from "../shared/address"
import {
  DATA_FILE_EXTENSIONS,
  IPC,
  type AuditStatus,
  type DesktopApi,
  type UpdateProgress,
} from "../shared/api"
import { toolInfo } from "../shared/agent"
import { describePermissions } from "../shared/permissions"
import { errorOffset, withErrorOffset } from "../shared/sql-errors"
import { startsLikeRead } from "../shared/statements"
import { agentModels } from "./agent-models"
import type { Assist } from "./assist"
import { describeChanges, refusal, type AuditLog } from "./audit"
import type { Chats } from "./chats"
import type { Connections } from "./connections"
import type { Gateway } from "./gateway"
import type { GoogleAccount } from "./google-account"
import type { Library } from "./library"
import { bare, explained } from "./db/types"
import { installMacUpdate } from "./electron-updates"
import {
  checkForUpdate,
  downloadWindowsUpdate,
  releaseFeedUrl,
  startWindowsInstaller,
} from "./updater"
import { applyUserChanges, runUserQuery } from "./user-queries"

/** What the update handlers need from the app itself. */
export type UpdateHost = {
  version: string
  packaged: boolean
  dataDir: string
  progress: (event: UpdateProgress) => void
  /** Quits the app, then runs `task` at `will-quit`. */
  quitAndRun: (task: () => void) => void
}

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
  gateway,
  google,
  updates,
}: {
  connections: Connections
  chats: Chats
  library: Library
  assist: Assist
  audit: AuditLog
  gateway: Gateway
  google: GoogleAccount
  updates: UpdateHost
}): void {
  const nameOf = (connectionId: string) =>
    connections.list().find((item) => item.id === connectionId)?.name ?? null
  const mine = (connectionId: string | null) => ({
    actor: "you" as const,
    connectionId,
    connectionName: connectionId ? nameOf(connectionId) : null,
  })

  const runQuery: DesktopApi["runQuery"] = async (connectionId, sql, readOnly, params) => {
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
  }

  /** The error again, carrying where it points in what the renderer sent:
   * found in `sent`, then mapped back onto that. */
  const located = (
    connectionId: string,
    error: unknown,
    sent: string,
    map: (offset: number) => number | null = (offset) => offset
  ) => {
    const at = errorOffset(error, sent, connections.get(connectionId).engine)
    return withErrorOffset(error, at === null ? null : map(at))
  }

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
        .concat(
          before && JSON.stringify(before.sources) !== JSON.stringify(saved.sources)
            ? (["sources"] as never[])
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
            : `Added connection ${saved.name} (${saved.engine}, ${locationOf(saved)})`,
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
    pickDataFiles: async () => {
      const options: Electron.OpenDialogOptions = {
        title: "Add files",
        buttonLabel: "Add",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Spreadsheets and data files", extensions: Object.values(DATA_FILE_EXTENSIONS).flat() },
          { name: "Excel", extensions: [...DATA_FILE_EXTENSIONS.workbook] },
          { name: "CSV", extensions: [...DATA_FILE_EXTENSIONS.csv] },
          { name: "Parquet", extensions: [...DATA_FILE_EXTENSIONS.parquet] },
          { name: "JSON", extensions: [...DATA_FILE_EXTENSIONS.json] },
        ],
      }
      const window = BrowserWindow.getFocusedWindow()
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths
    },
    googleAccount: async () => google.state(),
    importGoogleClient: async () => {
      const options: Electron.OpenDialogOptions = {
        title: "Import the OAuth client",
        buttonLabel: "Import",
        properties: ["openFile"],
        filters: [{ name: "OAuth client (client_secret_….json)", extensions: ["json"] }],
      }
      const window = BrowserWindow.getFocusedWindow()
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return google.state()
      const state = google.importClient(readFileSync(picked.filePaths[0], "utf8"))
      audit.record({ ...mine(null), action: "connection", status: "ok", summary: "Imported a Google OAuth client for signing in" })
      return state
    },
    forgetGoogleClient: async () => google.forgetClient(),
    signInWithGoogle: async () => {
      const state = await google.signIn()
      audit.record({ ...mine(null), action: "connection", status: "ok", summary: `Signed in to Google as ${state.email}` })
      return state
    },
    cancelGoogleSignIn: async () => google.cancelSignIn(),
    signOutOfGoogle: async () => {
      const email = google.state().email
      const state = await google.signOut()
      if (email) audit.record({ ...mine(null), action: "connection", status: "ok", summary: `Signed out of Google (${email})` })
      return state
    },

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
      try {
        return await runQuery(connectionId, sql, readOnly, params)
      } catch (error) {
        // With parameters bound, what ran is not what was written.
        throw params ? error : located(connectionId, error, sql)
      }
    },
    explainQuery: async (connectionId, sql) => {
      try {
        return await connections.driver(connectionId).explain(sql)
      } catch (error) {
        if (!bare(sql)) throw error
        const sent = explained(sql)
        const prefix = sent.length - bare(sql).length
        const start = sql.length - sql.trimStart().length
        throw located(connectionId, error, sent, (offset) =>
          offset < prefix ? null : offset - prefix + start
        )
      }
    },

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

    getGateway: async () => gateway.state(),
    saveGateway: async (settings) => {
      const before = gateway.state().gateways.find((item) => item.id === settings.id)
      const state = gateway.save(settings)
      const after = settings.id
        ? state.gateways.find((item) => item.id === settings.id)!
        : state.gateways.at(-1)!
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        audit.record({
          ...mine(null),
          action: "gateway",
          status: "ok",
          summary: !before
            ? `Created the gateway "${after.name}"`
            : before.enabled !== after.enabled
              ? `Turned the gateway "${after.name}" ${after.enabled ? "on" : "off"}`
              : `Changed the gateway "${after.name}"`,
          detail: gateway.describe(after.id),
        })
      }
      return state
    },
    deleteGateway: async (gatewayId) => {
      const before = gateway.state().gateways.find((item) => item.id === gatewayId)
      const state = gateway.remove(gatewayId)
      if (before) {
        audit.record({
          ...mine(null),
          action: "gateway",
          status: "ok",
          summary: `Deleted the gateway "${before.name}"`,
        })
      }
      return state
    },
    switchGateway: async (gatewayId, connectionId) => {
      const before = gateway.state().gateways.find((item) => item.id === gatewayId)
      const state = gateway.switchTo(gatewayId, connectionId)
      if (before && before.active !== connectionId) {
        audit.record({
          ...mine(connectionId),
          action: "gateway",
          status: "ok",
          summary: `Switched the gateway "${before.name}" from ${gateway.connectionName(before.active)} to ${gateway.connectionName(connectionId)}`,
          detail: gateway.describe(gatewayId),
        })
      }
      return state
    },
    resetGatewayPassword: async (gatewayId) => {
      const state = gateway.resetPassword(gatewayId)
      const changed = state.gateways.find((item) => item.id === gatewayId)
      audit.record({
        ...mine(null),
        action: "gateway",
        status: "ok",
        summary: `Made a new password for the gateway "${changed?.name ?? gatewayId}"`,
      })
      return state
    },

    appVersion: async () => updates.version,
    checkForUpdate: () => checkForUpdate(updates.version, process.platform),
    installUpdate: async (version) => {
      const platform = process.platform
      if (platform !== "darwin" && platform !== "win32") {
        throw new Error("There is no in-app installer for this platform — open the release page instead.")
      }
      if (!updates.packaged) {
        throw new Error("This is a development build — pull and restart instead.")
      }
      // It reaches a URL and a file name, so it is checked, not trusted.
      if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) {
        throw new Error(`Not a version: ${String(version)}`)
      }
      const onProgress = (received: number, total: number) =>
        updates.progress({ stage: "downloading", version, received, total })
      const onInstalling = () => updates.progress({ stage: "installing", version })
      if (platform === "darwin") {
        await installMacUpdate({
          version,
          feedUrl: releaseFeedUrl(version),
          log: path.join(updates.dataDir, "update.log"),
          onProgress,
          onInstalling,
        })
        return
      }
      const installer = await downloadWindowsUpdate({
        version,
        arch: process.arch,
        dir: path.join(updates.dataDir, "updates"),
        onProgress,
      })
      onInstalling()
      updates.quitAndRun(() => startWindowsInstaller(installer))
    },
  }

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(
      IPC[name as keyof Handlers],
      (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
        (handler as (...args: unknown[]) => Promise<unknown>)(...args)
    )
  }
}
