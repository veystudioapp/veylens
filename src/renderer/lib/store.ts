import { create } from "zustand"

import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_CHAT_EFFORT,
  type AccessMode,
  type AiSettings,
  type AgentStatus,
  type Chat,
  type ChatImage,
  type ChatEvent,
  type ChatEffort,
  type ChartSpec,
  type ChatSummary,
  type Connection,
  type ConnectionInput,
  type Dashboard,
  type Knowledge,
  type Permissions,
  type PinInput,
  type TreeSchema,
  type ViewerContext,
  type ViewerTarget,
} from "@shared/api"
import { findMentions } from "@shared/mentions"
import { splitErrorOffset } from "@shared/sql-errors"

import { currentMentionTargets } from "./mentions"

export type TreeState =
  | { status: "loading" }
  | { status: "ready"; schemas: TreeSchema[] }
  | { status: "error"; error: string }

export type Tab =
  | {
      id: string
      kind: "table"
      connectionId: string
      schema: string
      table: string
    }
  | {
      id: string
      kind: "query"
      connectionId: string
      title: string
      /** What the editor starts with. What it holds now is in `tabSql`. */
      sql: string
      /** Opened by the agent: run once on open, in a read-only transaction. */
      autoRun: boolean
      /** Shown as this chart rather than as a grid, to begin with. */
      chart?: ChartSpec
    }
  | { id: string; kind: "dashboard"; connectionId: string; dashboardId: string }
  | { id: string; kind: "knowledge"; connectionId: string }

export type SettingsSection = "ai" | "skills" | "tools" | "permissions" | "audit"

export type ConnectionDialog =
  { mode: "new" } | { mode: "edit"; connection: Connection } | null

type State = {
  ready: boolean
  connections: Connection[]
  trees: Record<string, TreeState>
  /** `c:<id>` for a connection, `s:<id>:<schema>` for a schema. */
  expanded: Record<string, boolean>
  /** The connection last touched — what the chat falls back to with no tab. */
  activeConnectionId: string | null
  dialog: ConnectionDialog
  /** The settings dialog, open on this section, or closed. */
  settings: SettingsSection | null

  tabs: Tab[]
  activeTabId: string | null
  /** A query tab's current text, for the chat's viewer context. */
  tabSql: Record<string, string>
  /** Bumped when the agent changes data, so open tables reload. */
  dataVersion: Record<string, number>

  /** Per connection, once asked for. */
  knowledge: Record<string, Knowledge>
  dashboards: Dashboard[]
  /** Text put into the composer from elsewhere, taken once. */
  draft: string | null

  agent: AgentStatus | null
  chats: ChatSummary[]
  chat: Chat | null
  /** A row's `value` from the CLI's list, or null to inherit its settings. */
  model: string | null
  effort: ChatEffort | null
  /** Settings › Models & language, as the main process keeps them. */
  ai: AiSettings

  init(): Promise<void>
  /** What `init` runs, once. */
  start(): Promise<void>
  openDialog(dialog: ConnectionDialog): void
  openSettings(section: SettingsSection | null): void
  /** What this app lets anyone do through a connection — nothing else of it changes. */
  setAccess(id: string, access: AccessMode): Promise<void>
  /** Its permissions; the explorer is reloaded, as what is hidden may change. */
  setPermissions(id: string, permissions: Permissions): Promise<void>
  saveConnection(id: string | null, input: ConnectionInput): Promise<void>
  deleteConnection(id: string): Promise<void>
  loadTree(connectionId: string): Promise<void>
  toggle(key: string): void

  openTable(connectionId: string, schema: string, table: string): void
  openQuery(
    connectionId: string,
    options?: {
      sql?: string
      title?: string
      autoRun?: boolean
      chart?: ChartSpec
    }
  ): void
  openDashboard(connectionId: string, dashboardId: string): void
  openKnowledge(connectionId: string): void
  closeTab(tabId: string): void
  closeOtherTabs(tabId: string): void
  closeAllTabs(): void
  /** Takes every open tab's id, in the new order. */
  reorderTabs(ids: string[]): void
  activateTab(tabId: string): void
  setTabSql(tabId: string, sql: string): void
  viewerContext(): ViewerContext

  newChat(): Promise<void>
  selectChat(chatId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  send(text: string, images?: ChatImage[]): Promise<void>
  setModel(model: string | null, effort: ChatEffort | null): void
  /** Saved; a new default for the chat moves the chat's picker to it too. */
  setAiSettings(settings: AiSettings): Promise<void>
  setDraft(draft: string | null): void

  loadKnowledge(connectionId: string): Promise<Knowledge>
  saveKnowledge(connectionId: string, knowledge: Knowledge): Promise<Knowledge>
  saveDashboard(dashboard: Dashboard): Promise<Dashboard>
  deleteDashboard(dashboardId: string): Promise<void>
  pin(input: PinInput): Promise<Dashboard>
}

const api = () => window.veydata

const message = (error: unknown) =>
  splitErrorOffset(
    // Electron prefixes what a handler threw with the channel it came through.
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      ""
    )
  ).message

export { message as errorMessage }

let nextTab = 1
const tabId = () => `tab-${nextTab++}`

export const useStore = create<State>((set, get) => {
  function openTarget(target: ViewerTarget): void {
    switch (target.kind) {
      case "table":
        get().openTable(target.connectionId, target.schema, target.table)
        return
      case "query":
        get().openQuery(target.connectionId, {
          sql: target.sql,
          title: target.title,
          autoRun: true,
          chart: target.chart,
        })
        return
      case "dashboard":
        get().openDashboard(target.connectionId, target.dashboardId)
        return
      case "knowledge":
        get().openKnowledge(target.connectionId)
        return
    }
  }

  function upsertDashboard(dashboard: Dashboard): void {
    const { dashboards } = get()
    set({
      dashboards: dashboards.some((item) => item.id === dashboard.id)
        ? dashboards.map((item) => (item.id === dashboard.id ? dashboard : item))
        : [...dashboards, dashboard],
    })
  }

  function onChatEvent(event: ChatEvent): void {
    switch (event.type) {
      case "item": {
        const chat = get().chat
        if (chat?.id !== event.chatId) return
        const index = chat.items.findIndex((item) => item.id === event.item.id)
        const items =
          index === -1
            ? [...chat.items, event.item]
            : chat.items.map((item, i) => (i === index ? event.item : item))
        set({ chat: { ...chat, items } })
        return
      }
      case "delta": {
        const chat = get().chat
        if (chat?.id !== event.chatId) return
        set({
          chat: {
            ...chat,
            items: chat.items.map((item) =>
              item.id === event.itemId && item.kind === "assistant"
                ? { ...item, text: item.text + event.text }
                : item
            ),
          },
        })
        return
      }
      case "summary": {
        const { chat, chats } = get()
        const others = chats.filter((item) => item.id !== event.chat.id)
        set({
          chats: [event.chat, ...others].sort(
            (a, b) => b.updatedAt - a.updatedAt
          ),
          chat:
            chat?.id === event.chat.id ? { ...chat, ...event.chat } : chat,
        })
        return
      }
      case "open": {
        if (get().chat?.id === event.chatId) openTarget(event.target)
        return
      }
      case "changed": {
        const { dataVersion } = get()
        set({
          dataVersion: {
            ...dataVersion,
            [event.connectionId]: (dataVersion[event.connectionId] ?? 0) + 1,
          },
        })
        // A statement may have been DDL: the tree is asked again too.
        void get().loadTree(event.connectionId)
        return
      }
      case "dashboard": {
        upsertDashboard(event.dashboard)
        return
      }
      case "dashboard_deleted": {
        const { dashboards, tabs } = get()
        if (dashboards.some((item) => item.id === event.dashboardId)) {
          set({ dashboards: dashboards.filter((item) => item.id !== event.dashboardId) })
        }
        for (const tab of tabs) {
          if (tab.kind === "dashboard" && tab.dashboardId === event.dashboardId) {
            get().closeTab(tab.id)
          }
        }
        return
      }
      case "knowledge": {
        set({
          knowledge: { ...get().knowledge, [event.connectionId]: event.knowledge },
        })
        return
      }
    }
  }

  // React's StrictMode runs the effect that calls `init` twice. A second run
  // would subscribe again — every streamed delta then lands twice — and open
  // a second empty chat; so there is only ever the one.
  let started: Promise<void> | null = null

  return {
    ready: false,
    connections: [],
    trees: {},
    expanded: {},
    activeConnectionId: null,
    dialog: null,
    settings: null,
    tabs: [],
    activeTabId: null,
    tabSql: {},
    dataVersion: {},
    knowledge: {},
    dashboards: [],
    draft: null,
    agent: null,
    chats: [],
    chat: null,
    // As in Vey, a chat opens on the CLI's recommended row rather than on
    // whatever somebody set for their terminal.
    model: "default",
    effort: DEFAULT_CHAT_EFFORT,
    ai: DEFAULT_AI_SETTINGS,

    init() {
      started ??= get().start()
      return started
    },

    async start() {
      api().onChatEvent(onChatEvent)
      const [connections, chats, chat, agent, dashboards, ai] = await Promise.all([
        api().listConnections(),
        api().listChats(),
        api().createChat(),
        api().agentStatus(),
        api().listDashboards(),
        api().getAiSettings(),
      ])
      set({
        ready: true,
        ai,
        // The chat starts on the model and effort set in Settings.
        model: ai.models.chat.model,
        effort: ai.models.chat.effort,
        connections,
        chats,
        chat,
        agent,
        dashboards,
        activeConnectionId: connections[0]?.id ?? null,
      })
      // One connection is the common case: show its tables straight away.
      const only = connections.length === 1 ? connections[0] : undefined
      if (only) {
        get().toggle(`c:${only.id}`)
      }
    },

    openDialog: (dialog) => set({ dialog }),
    openSettings: (settings) => set({ settings }),

    async setPermissions(id, permissions) {
      const saved = await api().setPermissions(id, permissions)
      set({
        connections: get().connections.map((item) => (item.id === id ? saved : item)),
      })
      if (get().trees[id]) await get().loadTree(id)
    },

    async setAccess(id, access) {
      const connection = get().connections.find((item) => item.id === id)
      if (!connection) return
      // Password and colour left out are kept as stored.
      const saved = await api().saveConnection(id, {
        name: connection.name,
        engine: connection.engine,
        host: connection.host,
        port: connection.port,
        user: connection.user,
        database: connection.database,
        ssl: connection.ssl,
        access,
      })
      set({
        connections: get().connections.map((item) => (item.id === id ? saved : item)),
      })
    },

    async saveConnection(id, input) {
      const saved = await api().saveConnection(id, input)
      const { connections, expanded } = get()
      set({
        connections: id
          ? connections.map((item) => (item.id === id ? saved : item))
          : [...connections, saved],
        activeConnectionId: saved.id,
        expanded: { ...expanded, [`c:${saved.id}`]: true },
        dialog: null,
      })
      await get().loadTree(saved.id)
    },

    async deleteConnection(id) {
      await api().deleteConnection(id)
      const {
        connections,
        tabs,
        activeTabId,
        activeConnectionId,
        trees,
        knowledge,
        dashboards,
      } = get()
      const remaining = tabs.filter((tab) => tab.connectionId !== id)
      const { [id]: _gone, ...restTrees } = trees
      const { [id]: _forgotten, ...restKnowledge } = knowledge
      set({
        connections: connections.filter((item) => item.id !== id),
        trees: restTrees,
        knowledge: restKnowledge,
        dashboards: dashboards.filter((item) => item.connectionId !== id),
        tabs: remaining,
        activeTabId: remaining.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (remaining.at(-1)?.id ?? null),
        activeConnectionId:
          activeConnectionId === id ? null : activeConnectionId,
      })
    },

    async loadTree(connectionId) {
      set({ trees: { ...get().trees, [connectionId]: { status: "loading" } } })
      let next: TreeState
      try {
        const schemas = await api().getTree(connectionId)
        next = { status: "ready", schemas }
        // A lone schema is opened: there is nothing else to choose.
        const first = schemas[0]
        if (first) {
          const key = `s:${connectionId}:${first.name}`
          const { expanded } = get()
          if (expanded[key] === undefined) {
            set({ expanded: { ...expanded, [key]: true } })
          }
        }
      } catch (error) {
        next = { status: "error", error: message(error) }
      }
      set({ trees: { ...get().trees, [connectionId]: next } })
    },

    toggle(key) {
      const { expanded, trees } = get()
      const open = !expanded[key]
      set({ expanded: { ...expanded, [key]: open } })
      if (open && key.startsWith("c:")) {
        const connectionId = key.slice(2)
        set({ activeConnectionId: connectionId })
        if (!trees[connectionId]) void get().loadTree(connectionId)
      }
    },

    openTable(connectionId, schema, table) {
      const { tabs } = get()
      const existing = tabs.find(
        (tab) =>
          tab.kind === "table" &&
          tab.connectionId === connectionId &&
          tab.schema === schema &&
          tab.table === table
      )
      if (existing) {
        set({ activeTabId: existing.id, activeConnectionId: connectionId })
        return
      }
      const tab: Tab = { id: tabId(), kind: "table", connectionId, schema, table }
      set({
        tabs: [...tabs, tab],
        activeTabId: tab.id,
        activeConnectionId: connectionId,
      })
    },

    openQuery(connectionId, options = {}) {
      const { tabs, tabSql } = get()
      const count = tabs.filter((tab) => tab.kind === "query").length
      const tab: Tab = {
        id: tabId(),
        kind: "query",
        connectionId,
        title: options.title ?? `Query ${count + 1}`,
        sql: options.sql ?? "",
        autoRun: options.autoRun ?? false,
        ...(options.chart ? { chart: options.chart } : {}),
      }
      set({
        tabs: [...tabs, tab],
        activeTabId: tab.id,
        activeConnectionId: connectionId,
        tabSql: { ...tabSql, [tab.id]: tab.sql },
      })
    },

    openDashboard(connectionId, dashboardId) {
      const { tabs } = get()
      const existing = tabs.find(
        (tab) => tab.kind === "dashboard" && tab.dashboardId === dashboardId
      )
      const tab: Tab = existing ?? {
        id: tabId(),
        kind: "dashboard",
        connectionId,
        dashboardId,
      }
      set({
        tabs: existing ? tabs : [...tabs, tab],
        activeTabId: tab.id,
        activeConnectionId: connectionId,
      })
    },

    openKnowledge(connectionId) {
      const { tabs } = get()
      const existing = tabs.find(
        (tab) => tab.kind === "knowledge" && tab.connectionId === connectionId
      )
      const tab: Tab = existing ?? { id: tabId(), kind: "knowledge", connectionId }
      set({
        tabs: existing ? tabs : [...tabs, tab],
        activeTabId: tab.id,
        activeConnectionId: connectionId,
      })
    },

    closeTab(id) {
      const { tabs, activeTabId, tabSql } = get()
      const index = tabs.findIndex((tab) => tab.id === id)
      const remaining = tabs.filter((tab) => tab.id !== id)
      const { [id]: _gone, ...restSql } = tabSql
      set({
        tabs: remaining,
        tabSql: restSql,
        activeTabId:
          activeTabId === id
            ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null)
            : activeTabId,
      })
    },

    closeOtherTabs(id) {
      const { tabs, tabSql } = get()
      const tab = tabs.find((item) => item.id === id)
      if (!tab) return
      set({
        tabs: [tab],
        tabSql: id in tabSql ? { [id]: tabSql[id]! } : {},
        activeTabId: id,
        activeConnectionId: tab.connectionId,
      })
    },

    closeAllTabs: () => set({ tabs: [], tabSql: {}, activeTabId: null }),

    reorderTabs(ids) {
      const byId = new Map(get().tabs.map((tab) => [tab.id, tab]))
      set({ tabs: ids.flatMap((id) => byId.get(id) ?? []) })
    },

    activateTab(id) {
      const tab = get().tabs.find((item) => item.id === id)
      if (tab) set({ activeTabId: id, activeConnectionId: tab.connectionId })
    },

    setTabSql: (id, sql) => set({ tabSql: { ...get().tabSql, [id]: sql } }),

    viewerContext() {
      const { tabs, activeTabId, activeConnectionId, tabSql } = get()
      const tab = tabs.find((item) => item.id === activeTabId)
      if (!tab) return { connectionId: activeConnectionId, tab: null }
      switch (tab.kind) {
        case "table":
          return {
            connectionId: tab.connectionId,
            tab: { kind: "table", schema: tab.schema, table: tab.table },
          }
        case "query":
          return {
            connectionId: tab.connectionId,
            tab: { kind: "query", sql: tabSql[tab.id] ?? tab.sql },
          }
        case "dashboard": {
          const dashboard = get().dashboards.find(
            (item) => item.id === tab.dashboardId
          )
          return {
            connectionId: tab.connectionId,
            tab: {
              kind: "dashboard",
              title: dashboard?.title ?? "Dashboard",
              tiles: dashboard?.tiles.map((tile) => tile.title) ?? [],
            },
          }
        }
        case "knowledge":
          return { connectionId: tab.connectionId, tab: { kind: "knowledge" } }
      }
    },

    async newChat() {
      set({ chat: await api().createChat() })
    },

    async selectChat(chatId) {
      const chat = await api().getChat(chatId)
      if (chat) set({ chat })
    },

    async deleteChat(chatId) {
      await api().deleteChat(chatId)
      set({ chats: get().chats.filter((item) => item.id !== chatId) })
      if (get().chat?.id === chatId) await get().newChat()
    },

    async send(text, images) {
      const { chat, model, effort } = get()
      if (!chat) return
      await api().sendMessage({
        chatId: chat.id,
        text,
        ...(images?.length && { images }),
        model,
        effort,
        context: {
          ...get().viewerContext(),
          mentions: findMentions(text, currentMentionTargets(get())),
        },
      })
    },

    setModel: (model, effort) => set({ model, effort }),

    async setAiSettings(settings) {
      const before = get().ai.models.chat
      const ai = await api().setAiSettings(settings)
      const chat = ai.models.chat
      set({
        ai,
        ...(chat.model !== before.model || chat.effort !== before.effort
          ? { model: chat.model, effort: chat.effort }
          : {}),
      })
    },
    setDraft: (draft) => set({ draft }),

    async loadKnowledge(connectionId) {
      const knowledge = await api().getKnowledge(connectionId)
      set({ knowledge: { ...get().knowledge, [connectionId]: knowledge } })
      return knowledge
    },

    async saveKnowledge(connectionId, input) {
      const knowledge = await api().saveKnowledge(connectionId, input)
      set({ knowledge: { ...get().knowledge, [connectionId]: knowledge } })
      return knowledge
    },

    async saveDashboard(input) {
      const dashboard = await api().saveDashboard(input)
      upsertDashboard(dashboard)
      return dashboard
    },

    async deleteDashboard(dashboardId) {
      await api().deleteDashboard(dashboardId)
      const { dashboards, tabs } = get()
      set({ dashboards: dashboards.filter((item) => item.id !== dashboardId) })
      for (const tab of tabs) {
        if (tab.kind === "dashboard" && tab.dashboardId === dashboardId) {
          get().closeTab(tab.id)
        }
      }
    },

    async pin(input) {
      const dashboard = await api().pinToDashboard(input)
      upsertDashboard(dashboard)
      return dashboard
    },
  }
})
