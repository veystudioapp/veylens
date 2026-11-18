import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { CheckIcon, Database } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ENGINE_LOGO } from "@/lib/engines"
import { useStore } from "@/lib/store"

import { ToolbarButton } from "./model-menu"

/**
 * Which connections the chat works with. None picked follows the open tab,
 * as the chat always did; picking any — one or several — pins the chat to
 * them whatever tab is open.
 */
export function ConnectionMenu() {
  const connections = useStore((state) => state.connections)
  const selected = useStore((state) => state.chatConnectionIds)
  const setSelected = useStore((state) => state.setChatConnections)
  const tabConnection = useStore((state) => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    const id = tab?.connectionId || state.activeConnectionId
    return (
      state.connections.find((item) => item.id === id) ??
      (state.connections.length === 1 ? state.connections[0] : undefined)
    )
  })

  if (connections.length === 0) return null

  const picked = connections.filter((item) => selected.includes(item.id))
  const label =
    picked.length === 0
      ? (tabConnection?.name ?? "Connection")
      : picked.length === 1
        ? picked[0]!.name
        : `${picked[0]!.name} +${picked.length - 1}`

  const toggle = (id: string, checked: boolean) =>
    setSelected(
      checked
        ? connections.map((item) => item.id).filter((item) => item === id || selected.includes(item))
        : selected.filter((item) => item !== id)
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            icon={<Database />}
            label={label}
            title={
              picked.length
                ? `Connections: ${picked.map((item) => item.name).join(", ")}`
                : "Connection: follows the open tab"
            }
            on={picked.length > 0}
            className="max-w-40"
          />
        }
      />
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuItem
          onClick={() => setSelected([])}
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
        >
          <div className="flex size-4 shrink-0 items-center justify-center">
            {picked.length === 0 && <CheckIcon className="size-3.5 text-foreground" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-normal">Follow the open tab</span>
            <span className="truncate text-[0.625rem] text-muted-foreground">
              {tabConnection ? `Now ${tabConnection.name}` : "No tab open"}
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[0.625rem]">
            Work with — pick one or more
          </DropdownMenuLabel>
          {connections.map((connection) => {
            const Logo = ENGINE_LOGO[connection.engine]
            return (
              <MenuPrimitive.CheckboxItem
                key={connection.id}
                checked={selected.includes(connection.id)}
                onCheckedChange={(checked) => toggle(connection.id, checked)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-menu outline-hidden select-none focus:bg-accent focus:text-accent-foreground"
              >
                <div className="flex size-4 shrink-0 items-center justify-center">
                  <MenuPrimitive.CheckboxItemIndicator>
                    <CheckIcon className="size-3.5 text-foreground" />
                  </MenuPrimitive.CheckboxItemIndicator>
                </div>
                <Logo className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs">{connection.name}</span>
                {connection.access === "read_only" && (
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    read-only
                  </span>
                )}
              </MenuPrimitive.CheckboxItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
