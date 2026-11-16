import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Ellipsis,
  Eye,
  Folder,
  LayoutDashboard,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
  Table2,
  Trash2,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { addressOf } from "@shared/address"
import type { Connection, Dashboard, Tone } from "@shared/api"

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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ACCESS_ICON, ACCESS_LABEL } from "@/lib/access"
import { useStore } from "@/lib/store"
import { quoteName } from "@/lib/sql-complete"
import { connectionTone, KIND_TONE, toneStyle } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"
import { IconButton } from "./icon-button"
import { promptText } from "./prompt"

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL" } as const

/** One choice in a row's right-click menu, or a line between groups of them. */
type MenuEntry =
  | {
      label: string
      icon: ReactNode
      onSelect: () => void
      destructive?: boolean
    }
  | "separator"

const copy = (text: string) => void navigator.clipboard.writeText(text)

/** One line of the tree. `depth` is how far it is indented. */
function Row({
  depth,
  open,
  icon,
  label,
  trailing,
  actions,
  menu,
  active,
  title,
  tone,
  onClick,
}: {
  depth: number
  /** The icon's colour: what kind of thing the row is. */
  tone?: Tone
  /** Undefined for a leaf, which has no chevron. */
  open?: boolean
  icon: ReactNode
  label: string
  trailing?: ReactNode
  actions?: ReactNode
  /** What a right-click on the row offers. */
  menu?: MenuEntry[]
  active?: boolean
  title?: string
  onClick: () => void
}) {
  const row = (
    <div
      role="treeitem"
      aria-expanded={open}
      aria-selected={active}
      tabIndex={0}
      title={title}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onClick()
        }
      }}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        "group flex h-[26px] items-center gap-1.5 rounded-md pr-1.5 text-[13px] outline-offset-[-2px] hover:bg-sidebar-accent/70 data-popup-open:bg-sidebar-accent/70",
        active && "bg-primary/10 font-medium text-foreground hover:bg-primary/15"
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {open === undefined ? null : open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
      </span>
      <span
        className={cn("shrink-0 [&_svg]:size-3.5", !tone && "text-muted-foreground")}
        style={tone ? toneStyle(tone) : undefined}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {actions && (
        <span
          className="hidden items-center group-focus-within:flex group-hover:flex has-aria-expanded:flex"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      )}
      {trailing && (
        <span
          className={cn(
            "shrink-0 text-[11px] text-muted-foreground tabular-nums",
            !!actions &&
              "group-focus-within:hidden group-hover:hidden group-has-aria-expanded:hidden"
          )}
        >
          {trailing}
        </span>
      )}
    </div>
  )

  if (!menu?.length) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-52">
        {menu.map((entry, index) =>
          entry === "separator" ? (
            <ContextMenuSeparator key={index} />
          ) : (
            <ContextMenuItem
              key={entry.label}
              variant={entry.destructive ? "destructive" : "default"}
              onClick={entry.onSelect}
            >
              {entry.icon}
              {entry.label}
            </ContextMenuItem>
          )
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ConnectionNode({
  connection,
  search,
}: {
  connection: Connection
  search: string
}) {
  const tree = useStore((state) => state.trees[connection.id])
  const expanded = useStore((state) => state.expanded)
  const toggle = useStore((state) => state.toggle)
  const loadTree = useStore((state) => state.loadTree)
  const openTable = useStore((state) => state.openTable)
  const openQuery = useStore((state) => state.openQuery)
  const openDialog = useStore((state) => state.openDialog)
  const deleteConnection = useStore((state) => state.deleteConnection)
  const openKnowledge = useStore((state) => state.openKnowledge)
  const openDashboard = useStore((state) => state.openDashboard)
  const saveDashboard = useStore((state) => state.saveDashboard)
  const deleteDashboard = useStore((state) => state.deleteDashboard)
  const loadKnowledge = useStore((state) => state.loadKnowledge)
  const knowledge = useStore((state) => state.knowledge[connection.id])
  const allDashboards = useStore((state) => state.dashboards)
  const activeTab = useStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId)
  )

  const key = `c:${connection.id}`
  const open = !!expanded[key]
  const needle = search.trim().toLowerCase()
  const dashboardsKey = `d:${connection.id}`
  const dashboards = allDashboards.filter(
    (item) =>
      item.connectionId === connection.id &&
      (!needle || item.title.toLowerCase().includes(needle))
  )
  const dashboardsOpen = needle ? dashboards.length > 0 : !!expanded[dashboardsKey]

  // For the count beside "Business context"; cheap, and only once.
  useEffect(() => {
    if (open && !knowledge) void loadKnowledge(connection.id).catch(() => {})
  }, [connection.id, knowledge, loadKnowledge, open])

  const newDashboard = async () => {
    const title = await promptText({
      title: "New dashboard",
      label: "Dashboard name",
      action: "Create",
    })
    if (!title) return
    const dashboard = await saveDashboard({
      id: "",
      connectionId: connection.id,
      title,
      tiles: [],
      filters: [],
      refreshSeconds: 0,
      updatedAt: 0,
    })
    openDashboard(connection.id, dashboard.id)
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Remove "${connection.name}"?`,
      description:
        "Its saved settings and password are deleted. The database itself is not touched.",
      action: "Remove",
      destructive: true,
    })
    if (ok) void deleteConnection(connection.id)
  }

  const renameDashboard = async (dashboard: Dashboard) => {
    const title = await promptText({
      title: "Rename dashboard",
      label: "Dashboard name",
      initial: dashboard.title,
      action: "Rename",
    })
    if (title) void saveDashboard({ ...dashboard, title }).catch(() => {})
  }

  const removeDashboard = async (dashboard: Dashboard) => {
    const ok = await confirm({
      title: `Delete "${dashboard.title}"?`,
      description:
        "The dashboard, its filters and its tiles are removed. The data they show is not touched.",
      action: "Delete",
      destructive: true,
    })
    if (ok) void deleteDashboard(dashboard.id)
  }

  const quote = (name: string) => quoteName(name, connection.engine)

  /** Shared by the row's "…" button and its right-click menu. */
  const connectionEntries: MenuEntry[] = [
    {
      label: "Refresh tables",
      icon: <RefreshCw />,
      onSelect: () => void loadTree(connection.id),
    },
    {
      label: "Edit connection",
      icon: <Pencil />,
      onSelect: () => openDialog({ mode: "edit", connection }),
    },
    "separator",
    {
      label: "Remove",
      icon: <Trash2 />,
      destructive: true,
      onSelect: () => void remove(),
    },
  ]

  return (
    <div role="group">
      <Row
        depth={0}
        open={open}
        icon={<Database />}
        tone={connectionTone(connection)}
        label={connection.name}
        title={`${ENGINE_LABEL[connection.engine]} · ${connection.user}@${addressOf(connection)}${connection.database ? `/${connection.database}` : ""} · ${ACCESS_LABEL[connection.access]}`}
        onClick={() => toggle(key)}
        trailing={
          tree?.status === "loading" ? (
            <Spinner className="size-3.5" />
          ) : (
            <span className="flex items-center gap-1">
              {connection.access !== "read_write" && (
                <span
                  aria-label={ACCESS_LABEL[connection.access]}
                  className="text-muted-foreground [&_svg]:size-3"
                >
                  {ACCESS_ICON[connection.access]}
                </span>
              )}
              {ENGINE_LABEL[connection.engine]}
            </span>
          )
        }
        actions={
          <>
            <IconButton
              label="New SQL query"
              onClick={() => openQuery(connection.id)}
            >
              <SquareTerminal />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <IconButton label="More">
                    <Ellipsis />
                  </IconButton>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                {connectionEntries.map((entry, index) =>
                  entry === "separator" ? (
                    <DropdownMenuSeparator key={index} />
                  ) : (
                    <DropdownMenuItem
                      key={entry.label}
                      variant={entry.destructive ? "destructive" : "default"}
                      onClick={entry.onSelect}
                    >
                      {entry.icon}
                      {entry.label}
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        menu={[
          {
            label: "New SQL query",
            icon: <SquareTerminal />,
            onSelect: () => openQuery(connection.id),
          },
          {
            label: "New dashboard",
            icon: <LayoutDashboard />,
            onSelect: () => void newDashboard(),
          },
          {
            label: "Business context",
            icon: <BookOpen />,
            onSelect: () => openKnowledge(connection.id),
          },
          "separator",
          ...connectionEntries,
        ]}
      />

      {open && tree?.status === "error" && (
        <div className="selectable mt-0.5 mr-1.5 mb-1 ml-8 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs leading-snug text-destructive">
          {tree.error}
          <Button
            variant="link"
            size="xs"
            className="h-auto px-1.5 text-destructive"
            onClick={() => void loadTree(connection.id)}
          >
            Retry
          </Button>
        </div>
      )}

      {open && !needle && (
        <Row
          depth={1}
          icon={<BookOpen />}
          tone={KIND_TONE.context}
          label="Business context"
          title="Notes and metrics the assistant works from"
          trailing={
            knowledge?.metrics.length
              ? `${knowledge.metrics.length} ${knowledge.metrics.length === 1 ? "metric" : "metrics"}`
              : undefined
          }
          active={
            activeTab?.kind === "knowledge" &&
            activeTab.connectionId === connection.id
          }
          onClick={() => openKnowledge(connection.id)}
        />
      )}

      {open && (!needle || dashboards.length > 0) && (
        <div role="group">
          <Row
            depth={1}
            open={dashboardsOpen}
            icon={<LayoutDashboard />}
            tone={KIND_TONE.dashboard}
            label="Dashboards"
            trailing={dashboards.length || undefined}
            onClick={() => toggle(dashboardsKey)}
            actions={
              <IconButton label="New dashboard" onClick={() => void newDashboard()}>
                <Plus />
              </IconButton>
            }
            menu={[
              {
                label: "New dashboard",
                icon: <Plus />,
                onSelect: () => void newDashboard(),
              },
            ]}
          />
          {dashboardsOpen &&
            (dashboards.length === 0 ? (
              <div className="py-1 pl-12 text-xs text-muted-foreground">
                None yet.
              </div>
            ) : (
              dashboards.map((dashboard) => (
                <Row
                  key={dashboard.id}
                  depth={2}
                  icon={<LayoutDashboard />}
                  tone={KIND_TONE.dashboard}
                  label={dashboard.title}
                  trailing={dashboard.tiles.length}
                  active={
                    activeTab?.kind === "dashboard" &&
                    activeTab.dashboardId === dashboard.id
                  }
                  onClick={() => openDashboard(connection.id, dashboard.id)}
                  menu={[
                    {
                      label: "Rename…",
                      icon: <Pencil />,
                      onSelect: () => void renameDashboard(dashboard),
                    },
                    "separator",
                    {
                      label: "Delete dashboard",
                      icon: <Trash2 />,
                      destructive: true,
                      onSelect: () => void removeDashboard(dashboard),
                    },
                  ]}
                />
              ))
            ))}
        </div>
      )}

      {open &&
        tree?.status === "ready" &&
        (tree.schemas.length === 0 ? (
          <div className="py-1 pl-10 text-xs text-muted-foreground">
            No tables.
          </div>
        ) : (
          tree.schemas.map((schema) => {
            const tables = needle
              ? schema.tables.filter((table) =>
                  table.name.toLowerCase().includes(needle)
                )
              : schema.tables
            if (needle && tables.length === 0) return null
            const schemaKey = `s:${connection.id}:${schema.name}`
            // While searching, every schema with a match is shown open.
            const schemaOpen = needle ? true : !!expanded[schemaKey]
            return (
              <div key={schema.name} role="group">
                <Row
                  depth={1}
                  open={schemaOpen}
                  icon={<Folder />}
                  tone={KIND_TONE.schema}
                  label={schema.name}
                  trailing={tables.length}
                  onClick={() => toggle(schemaKey)}
                  menu={[
                    {
                      label: "New SQL query",
                      icon: <SquareTerminal />,
                      onSelect: () => openQuery(connection.id),
                    },
                    {
                      label: "Refresh tables",
                      icon: <RefreshCw />,
                      onSelect: () => void loadTree(connection.id),
                    },
                    "separator",
                    {
                      label: "Copy name",
                      icon: <Copy />,
                      onSelect: () => copy(schema.name),
                    },
                  ]}
                />
                {schemaOpen &&
                  tables.map((table) => (
                    <Row
                      key={table.name}
                      depth={2}
                      icon={table.kind === "view" ? <Eye /> : <Table2 />}
                      tone={table.kind === "view" ? KIND_TONE.view : KIND_TONE.table}
                      label={table.name}
                      title={`${table.kind} ${schema.name}.${table.name}`}
                      active={
                        activeTab?.kind === "table" &&
                        activeTab.connectionId === connection.id &&
                        activeTab.schema === schema.name &&
                        activeTab.table === table.name
                      }
                      onClick={() =>
                        openTable(connection.id, schema.name, table.name)
                      }
                      menu={[
                        {
                          label: "Query in SQL editor",
                          icon: <SquareTerminal />,
                          onSelect: () =>
                            openQuery(connection.id, {
                              title: table.name,
                              sql: `SELECT *\nFROM ${quote(schema.name)}.${quote(table.name)}\nLIMIT 100;`,
                            }),
                        },
                        "separator",
                        {
                          label: "Copy name",
                          icon: <Copy />,
                          onSelect: () => copy(table.name),
                        },
                        {
                          label: "Copy qualified name",
                          icon: <Copy />,
                          onSelect: () =>
                            copy(`${quote(schema.name)}.${quote(table.name)}`),
                        },
                      ]}
                    />
                  ))}
              </div>
            )
          })
        ))}
    </div>
  )
}

export function Explorer({
  onCollapse,
  onSettings,
}: {
  onCollapse: () => void
  onSettings: () => void
}) {
  const connections = useStore((state) => state.connections)
  const openDialog = useStore((state) => state.openDialog)
  const loadTree = useStore((state) => state.loadTree)
  const expanded = useStore((state) => state.expanded)
  const [search, setSearch] = useState("")

  const refreshAll = () => {
    for (const connection of connections) {
      if (expanded[`c:${connection.id}`]) void loadTree(connection.id)
    }
  }

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* The window's own buttons sit in this bar on a Mac; the space beside
          them is what the window is dragged by. */}
      <div className="flex h-11 shrink-0 items-center gap-0.5 pr-2">
        <div
          className={cn(
            "drag-region h-full flex-1",
            window.veylens.platform === "darwin" ? "min-w-[84px]" : "min-w-3"
          )}
        />
        <IconButton
          label="New connection"
          onClick={() => openDialog({ mode: "new" })}
        >
          <Plus />
        </IconButton>
        <IconButton label="Refresh" onClick={refreshAll}>
          <RefreshCw />
        </IconButton>
        <IconButton label="Hide explorer" onClick={onCollapse}>
          <PanelLeftClose />
        </IconButton>
      </div>

      <div className="relative mx-2 mb-2 shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search tables…"
          aria-label="Search tables"
          spellCheck={false}
          className="h-7 bg-background pl-7 text-xs shadow-none md:text-xs dark:bg-input/30"
        />
      </div>

      <div role="tree" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {connections.length === 0 ? (
          <div className="px-3 pt-6 text-center text-xs leading-relaxed text-muted-foreground">
            No connections yet.
            <Button
              variant="outline"
              size="sm"
              className="mx-auto mt-3 flex"
              onClick={() => openDialog({ mode: "new" })}
            >
              <Plus />
              Add a connection
            </Button>
          </div>
        ) : (
          connections.map((connection) => (
            <ConnectionNode
              key={connection.id}
              connection={connection}
              search={search}
            />
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-1.5">
        <button
          type="button"
          onClick={onSettings}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
        >
          <Settings className="size-3.5" />
          Settings
        </button>
      </div>
    </div>
  )
}
