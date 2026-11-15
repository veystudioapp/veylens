import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Database,
  Eye,
  LayoutDashboard,
  PanelLeft,
  PanelRight,
  Plus,
  SquareTerminal,
  Table2,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useStore, type Tab } from "@/lib/store"
import {
  connectionTone,
  IconTile,
  KIND_TONE,
  toneColor,
  toneStyle,
} from "@/lib/tones"
import { addressOf } from "@shared/address"
import type { Tone } from "@shared/api"
import { cn } from "@/lib/utils"

import { DashboardView } from "./DashboardView"
import { KnowledgeView } from "./KnowledgeView"
import { QueryView } from "./QueryView"
import { IconButton } from "./icon-button"
import { ConnectArt } from "./illustrations"
import { TableView } from "./TableView"

function TabIcon({ tab }: { tab: Tab }) {
  const isView = useStore((state) => {
    if (tab.kind !== "table") return false
    const tree = state.trees[tab.connectionId]
    if (tree?.status !== "ready") return false
    return (
      tree.schemas
        .find((schema) => schema.name === tab.schema)
        ?.tables.find((table) => table.name === tab.table)?.kind === "view"
    )
  })
  const [icon, tone] =
    tab.kind === "query"
      ? [<SquareTerminal />, KIND_TONE.query]
      : tab.kind === "dashboard"
        ? [<LayoutDashboard />, KIND_TONE.dashboard]
        : tab.kind === "knowledge"
          ? [<BookOpen />, KIND_TONE.context]
          : isView
            ? [<Eye />, KIND_TONE.view]
            : [<Table2 />, KIND_TONE.table]
  return (
    <span className="flex [&_svg]:size-3.5" style={toneStyle(tone)}>
      {icon}
    </span>
  )
}

/** A tab's label, and the longer name its tooltip gives. */
function useTabLabel(tab: Tab): { label: string; title: string } {
  const dashboard = useStore((state) =>
    tab.kind === "dashboard"
      ? state.dashboards.find((item) => item.id === tab.dashboardId)
      : undefined
  )
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId)
  )
  switch (tab.kind) {
    case "table":
      return { label: tab.table, title: `${tab.schema}.${tab.table}` }
    case "query":
      return { label: tab.title, title: tab.title }
    case "dashboard": {
      const label = dashboard?.title ?? "Dashboard"
      return { label, title: label }
    }
    case "knowledge":
      return {
        label: "Business context",
        title: `Business context · ${connection?.name ?? ""}`,
      }
  }
}

/** A tab in the list of them all, for when the strip has run out of room. */
function TabMenuItem({ tab, active }: { tab: Tab; active: boolean }) {
  const activateTab = useStore((state) => state.activateTab)
  const { label, title } = useTabLabel(tab)
  return (
    <DropdownMenuItem title={title} onClick={() => activateTab(tab.id)}>
      <TabIcon tab={tab} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check className="text-muted-foreground" />}
    </DropdownMenuItem>
  )
}

/**
 * The open tabs, in one row that scrolls sideways: a mouse's wheel scrolls it
 * as a trackpad does, the open tab is brought into view, and an edge with
 * more beyond it fades out. When they no longer fit, a menu lists them all.
 */
function TabStrip({ tabs, activeTabId }: { tabs: Tab[]; activeTabId: string | null }) {
  const strip = useRef<HTMLDivElement>(null)
  const reorderTabs = useStore((state) => state.reorderTabs)
  /** Also what tells a reorder apart from something dragged in from outside. */
  const [dragId, setDragId] = useState<string | null>(null)
  /** The gap the tab would land in: 0 before the first, `tabs.length` after the last. */
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  function endDrag() {
    setDragId(null)
    setDropIndex(null)
  }

  function commitDrop() {
    const ids = tabs.map((tab) => tab.id)
    const from = dragId === null ? -1 : ids.indexOf(dragId)
    if (from !== -1 && dropIndex !== null) {
      // Taking the tab out first shifts every later gap left by one.
      const to = dropIndex > from ? dropIndex - 1 : dropIndex
      if (to !== from) {
        const [moved] = ids.splice(from, 1)
        ids.splice(to, 0, moved!)
        reorderTabs(ids)
      }
    }
    endDrag()
  }
  const [edges, setEdges] = useState({ before: false, after: false })

  const measure = useCallback(() => {
    const el = strip.current
    if (!el) return
    const before = el.scrollLeft > 1
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((current) =>
      current.before === before && current.after === after ? current : { before, after }
    )
  }, [])

  // A wheel turned up and down moves along the row; a sideways swipe already does.
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (el.scrollWidth <= el.clientWidth) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener("wheel", wheel, { passive: false })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      el.removeEventListener("wheel", wheel)
      observer.disconnect()
    }
  }, [measure])

  useLayoutEffect(() => {
    const el = strip.current
    const open = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    open?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
    measure()
  }, [activeTabId, tabs.length, measure])

  const fade = 24
  const mask =
    edges.before || edges.after
      ? `linear-gradient(to right, ${edges.before ? "transparent" : "#000"}, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges.after ? "transparent" : "#000"})`
      : undefined

  return (
    <>
      <div
        ref={strip}
        role="tablist"
        onScroll={measure}
        onDragLeave={(event) => {
          if (dragId === null) return
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDropIndex(null)
        }}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="flex min-w-0 items-end gap-0.5 overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => (
          <TabButton
            key={tab.id}
            tab={tab}
            dragging={dragId === tab.id}
            dropSide={
              dropIndex === index
                ? "left"
                : dropIndex === tabs.length && index === tabs.length - 1
                  ? "right"
                  : null
            }
            drag={{
              draggable: true,
              onDragStart: (event) => {
                setDragId(tab.id)
                event.dataTransfer.effectAllowed = "move"
                // Chromium starts no drag with nothing on the transfer.
                event.dataTransfer.setData("text/plain", tab.id)
              },
              onDragOver: (event) => {
                if (dragId === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                const rect = event.currentTarget.getBoundingClientRect()
                const pastMiddle = event.clientX > rect.left + rect.width / 2
                setDropIndex(pastMiddle ? index + 1 : index)
              },
              onDrop: (event) => {
                if (dragId === null) return
                event.preventDefault()
                commitDrop()
              },
              onDragEnd: endDrag,
            }}
          />
        ))}
      </div>
      {(edges.before || edges.after) && (
        <div className="flex shrink-0 items-center px-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="All open tabs"
                  title="All open tabs"
                  className="gap-0.5 px-1.5 text-muted-foreground tabular-nums"
                >
                  {tabs.length}
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="max-h-96 w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Open tabs</DropdownMenuLabel>
                {tabs.map((tab) => (
                  <TabMenuItem key={tab.id} tab={tab} active={tab.id === activeTabId} />
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </>
  )
}

type TabDragHandlers = Pick<
  HTMLAttributes<HTMLDivElement>,
  "draggable" | "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
>

function TabButton({
  tab,
  dragging,
  dropSide,
  drag,
}: {
  tab: Tab
  dragging: boolean
  /** Where a dragged tab would land, drawn as a line on that edge. */
  dropSide: "left" | "right" | null
  drag: TabDragHandlers
}) {
  const activeTabId = useStore((state) => state.activeTabId)
  const activateTab = useStore((state) => state.activateTab)
  const closeTab = useStore((state) => state.closeTab)
  const closeOtherTabs = useStore((state) => state.closeOtherTabs)
  const closeAllTabs = useStore((state) => state.closeAllTabs)
  const tabCount = useStore((state) => state.tabs.length)
  const { label, title } = useTabLabel(tab)
  const active = tab.id === activeTabId
  // A colour picked for the connection — red for production — marks its
  // open tab, so where a statement will run is never a guess.
  const marked = useStore(
    (state) => state.connections.find((item) => item.id === tab.connectionId)?.color ?? null
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        {...drag}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        title={title}
        onClick={() => activateTab(tab.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") activateTab(tab.id)
        }}
        style={
          active && marked
            ? { boxShadow: `inset 0 2px 0 ${toneColor(marked)}` }
            : undefined
        }
        onAuxClick={(event) => {
          if (event.button === 1) closeTab(tab.id)
        }}
        className={cn(
          "group relative flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-t-lg pr-1.5 pl-3 text-xs outline-offset-[-2px] transition-colors",
          active
            ? "border border-b-0 bg-background font-medium text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          dragging && "opacity-60"
        )}
      >
        {/* Inside the tab's edge rather than in the 2px gap: the strip scrolls,
            so a line outside the first or last tab would be clipped away. */}
        {dropSide && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-primary",
              dropSide === "left" ? "left-0" : "right-0"
            )}
          />
        )}
        <span className="shrink-0">
          <TabIcon tab={tab} />
        </span>
        <span className="truncate">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${label}`}
          onClick={(event) => {
            event.stopPropagation()
            closeTab(tab.id)
          }}
          className={cn("size-5", !active && "opacity-0 group-hover:opacity-100")}
        >
          <X />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() => closeTab(tab.id)}>
          <X />
          Close
        </ContextMenuItem>
        <ContextMenuItem disabled={tabCount < 2} onClick={() => closeOtherTabs(tab.id)}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem onClick={closeAllTabs}>Close all</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() =>
            void navigator.clipboard.writeText(
              tab.kind === "table" ? `${tab.schema}.${tab.table}` : label
            )
          }
        >
          <Copy />
          {tab.kind === "table" ? "Copy table name" : "Copy name"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function Panel({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "table":
      return <TableView tab={tab} active={active} />
    case "query":
      return <QueryView tab={tab} active={active} />
    case "dashboard":
      return <DashboardView tab={tab} active={active} />
    case "knowledge":
      return <KnowledgeView tab={tab} active={active} />
  }
}

/**
 * What the viewer shows with no tab open: where to start on the connection
 * last touched, rather than a sentence about the explorer.
 */
function StartPage() {
  const connections = useStore((state) => state.connections)
  const activeId = useStore((state) => state.activeConnectionId)
  const connection =
    connections.find((item) => item.id === activeId) ?? connections[0]
  const tree = useStore((state) =>
    connection ? state.trees[connection.id] : undefined
  )
  // Filtered here, not in the selector: a new array from a selector is a new
  // state on every read, and the store re-renders without end.
  const allDashboards = useStore((state) => state.dashboards)
  const dashboards = allDashboards.filter(
    (item) => item.connectionId === connection?.id
  )
  const openQuery = useStore((state) => state.openQuery)
  const openTable = useStore((state) => state.openTable)
  const openKnowledge = useStore((state) => state.openKnowledge)
  const openDashboard = useStore((state) => state.openDashboard)
  const openDialog = useStore((state) => state.openDialog)
  const loadTree = useStore((state) => state.loadTree)

  // The tables are listed here whether or not the explorer has opened the
  // connection yet.
  const connectionId = connection?.id
  const loaded = !!tree
  useEffect(() => {
    if (connectionId && !loaded) void loadTree(connectionId)
  }, [connectionId, loaded, loadTree])

  if (!connection) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <ConnectArt className="mb-6 w-60" />
          <h1 className="text-[15px] font-semibold tracking-tight">
            Connect a database
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            PostgreSQL or MySQL. Passwords are encrypted with the system
            keychain, and any connection can be made read-only.
          </p>
          <Button className="mt-4" size="sm" onClick={() => openDialog({ mode: "new" })}>
            <Plus />
            Add a connection
          </Button>
        </div>
      </div>
    )
  }

  const tables =
    tree?.status === "ready"
      ? tree.schemas.flatMap((schema) =>
          schema.tables.map((table) => ({ schema: schema.name, ...table }))
        )
      : []
  const TABLES_SHOWN = 8

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-lg px-8 pt-[12vh] pb-12">
        <div className="flex items-center gap-3">
          <IconTile tone={connectionTone(connection)} size="lg">
            <Database />
          </IconTile>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-tight">
              {connection.name}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {connection.engine === "postgres" ? "PostgreSQL" : "MySQL"} ·{" "}
              {connection.user}@{addressOf(connection)}
              {connection.database ? `/${connection.database}` : ""}
            </p>
          </div>
        </div>

        <StartSection title="Start">
          <StartRow
            icon={<SquareTerminal />}
            tone={KIND_TONE.query}
            onClick={() => openQuery(connection.id)}
          >
            New SQL query
          </StartRow>
          <StartRow
            icon={<BookOpen />}
            tone={KIND_TONE.context}
            onClick={() => openKnowledge(connection.id)}
          >
            Business context
          </StartRow>
        </StartSection>

        {dashboards.length > 0 && (
          <StartSection title="Dashboards">
            {dashboards.map((dashboard) => (
              <StartRow
                key={dashboard.id}
                icon={<LayoutDashboard />}
                tone={KIND_TONE.dashboard}
                meta={`${dashboard.tiles.length} ${dashboard.tiles.length === 1 ? "tile" : "tiles"}`}
                onClick={() => openDashboard(connection.id, dashboard.id)}
              >
                {dashboard.title}
              </StartRow>
            ))}
          </StartSection>
        )}

        {tables.length > 0 && (
          <StartSection title="Tables">
            {tables.slice(0, TABLES_SHOWN).map((table) => (
              <StartRow
                key={`${table.schema}.${table.name}`}
                icon={table.kind === "view" ? <Eye /> : <Table2 />}
                tone={table.kind === "view" ? KIND_TONE.view : KIND_TONE.table}
                meta={tree?.status === "ready" && tree.schemas.length > 1 ? table.schema : undefined}
                onClick={() => openTable(connection.id, table.schema, table.name)}
              >
                {table.name}
              </StartRow>
            ))}
            {tables.length > TABLES_SHOWN && (
              <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                {tables.length - TABLES_SHOWN} more in the explorer
              </p>
            )}
          </StartSection>
        )}
      </div>
    </div>
  )
}

function StartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-1 px-2 text-[11px] font-medium text-muted-foreground">{title}</h2>
      <div className="-mx-0 flex flex-col">{children}</div>
    </section>
  )
}

function StartRow({
  icon,
  tone,
  meta,
  onClick,
  children,
}: {
  icon: ReactNode
  tone: Tone
  meta?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-accent"
    >
      <IconTile tone={tone}>{icon}</IconTile>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="text-[11px] text-muted-foreground">{meta}</span>}
    </button>
  )
}

export function Viewer({
  explorerOpen,
  chatOpen,
  onShowExplorer,
  onShowChat,
}: {
  explorerOpen: boolean
  chatOpen: boolean
  onShowExplorer: () => void
  onShowChat: () => void
}) {
  const tabs = useStore((state) => state.tabs)
  const activeTabId = useStore((state) => state.activeTabId)
  const mac = window.veylens.platform === "darwin"

  return (
    <div className="flex h-full flex-col">
      {/* One bar for the tabs, the window's drag handle, and the panels that
          were put away. With the explorer hidden, the window's own buttons
          land here on a Mac. */}
      {/* The bar's bottom rule is an inset shadow, so the open tab — a child,
          painted over it — breaks the rule and joins the sheet below. */}
      <div
        className={cn(
          "flex h-11 shrink-0 items-stretch",
          tabs.length > 0 && "shadow-[inset_0_-1px_0_var(--border)]",
          !explorerOpen && mac && "pl-[84px]"
        )}
      >
        {!explorerOpen && (
          <div className="flex items-center px-1.5">
            <IconButton label="Show explorer" side="bottom" onClick={onShowExplorer}>
              <PanelLeft />
            </IconButton>
          </div>
        )}
        <TabStrip tabs={tabs} activeTabId={activeTabId} />
        <div className="drag-region min-w-6 flex-1" />
        {!chatOpen && (
          <div className="flex items-center px-1.5">
            <IconButton label="Show assistant" side="bottom" onClick={onShowChat}>
              <PanelRight />
            </IconButton>
          </div>
        )}
      </div>

      <div
        className={cn(
          "sheet mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden",
          tabs.length > 0 ? "rounded-b-lg border-t-0" : "rounded-lg"
        )}
      >
        {tabs.length === 0 && <StartPage />}

        {/* Every tab stays mounted, so a filter, a page or a half-typed edit
            is still there when its tab is come back to. */}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            className={cn("min-h-0 flex-1", tab.id !== activeTabId && "hidden")}
          >
            <Panel tab={tab} active={tab.id === activeTabId} />
          </div>
        ))}
      </div>
    </div>
  )
}
