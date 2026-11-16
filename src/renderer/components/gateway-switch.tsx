import { ChevronDown, CircleAlert } from "lucide-react"

import type { Connection, GatewaySettings, GatewayState } from "@shared/api"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { MySQL } from "@/components/ui/svgs/mysql"
import { PostgreSQL } from "@/components/ui/svgs/postgresql"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useGateway } from "@/lib/gateway"
import { useStore } from "@/lib/store"
import { connectionTone, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"

export const ENGINE_LOGO = { postgres: PostgreSQL, mysql: MySQL } as const

/** A gateway's connections, as saved connections, in its order. */
export function useGatewayConnections(gateway: GatewaySettings): Connection[] {
  const connections = useStore((store) => store.connections)
  return gateway.connections
    .map((id) => connections.find((connection) => connection.id === id))
    .filter((connection): connection is Connection => !!connection)
}

/** Points the gateway at one of its connections, asking first when that one
 * is marked red. */
export function usePick(gateway: GatewaySettings) {
  const switching = useGateway((store) => store.switching)
  const switchTo = useGateway((store) => store.switchTo)

  return async (connection: Connection) => {
    if (connection.id === gateway.active || switching) return
    if (connection.color === "red") {
      const ok = await confirm({
        title: `Point "${gateway.name}" at ${connection.name}?`,
        description: `"${connection.name}" is marked red. The app will read and write there as the connection's database user.`,
        action: "Switch",
        destructive: true,
      })
      if (!ok) return
    }
    await switchTo(gateway.id, connection.id)
  }
}

/** Whether the connections' names fit side by side in the explorer — a click
 * each — or go in a menu. */
const fits = (connections: Connection[]) =>
  connections.length <= 4 && connections.map((item) => item.name).join("").length <= 32

/** One gateway's line in the explorer: its name and its connections, the
 * live one raised. */
function GatewayLine({
  gateway,
  state,
  onOpen,
}: {
  gateway: GatewaySettings
  state: GatewayState
  onOpen: () => void
}) {
  const switching = useGateway((store) => store.switching)
  const connections = useGatewayConnections(gateway)
  const pick = usePick(gateway)
  const status = state.status.find((item) => item.gatewayId === gateway.id)
  const live = connections.find((connection) => connection.id === gateway.active)
  const Logo = ENGINE_LOGO[gateway.engine]
  const busy = (id?: string) =>
    switching?.gatewayId === gateway.id && (!id || switching.connectionId === id)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onOpen}
                className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {status?.error ? (
                  <CircleAlert className="size-3.5 shrink-0 text-destructive" />
                ) : (
                  <Logo className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{gateway.name}</span>
                {!!status?.sessions && (
                  <span className="rounded bg-muted px-1 text-[10px] tabular-nums">{status.sessions}</span>
                )}
              </button>
            }
          />
          <TooltipContent side="top" className="max-w-80 whitespace-pre-line">
            {[
              `${gateway.name} · 127.0.0.1:${gateway.port} → ${live?.name ?? "nothing"}`,
              ...(status?.error ? [status.error] : []),
            ].join("\n")}
          </TooltipContent>
        </Tooltip>
        {!fits(connections) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`${gateway.name}: connection`}
                  className="flex h-6 max-w-36 shrink-0 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-medium hover:bg-muted/70"
                >
                  {busy() && <Spinner className="size-3 shrink-0" />}
                  <span className="truncate">{live?.name ?? "None"}</span>
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                </button>
              }
            />
            <DropdownMenuContent side="top" align="end" className="w-auto min-w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{gateway.name}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={gateway.active ?? ""}
                  onValueChange={(value) => {
                    const next = connections.find((connection) => connection.id === value)
                    if (next) void pick(next)
                  }}
                >
                  {connections.map((connection) => (
                    <DropdownMenuRadioItem key={connection.id} value={connection.id}>
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: toneColor(connectionTone(connection)) }}
                      />
                      <span className="text-xs">{connection.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {fits(connections) && connections.length > 1 && (
        <div role="radiogroup" aria-label={`${gateway.name}: connection`} className="flex min-w-0 rounded-md bg-muted p-0.5">
          {connections.map((connection) => {
            const on = connection.id === gateway.active
            return (
              <button
                key={connection.id}
                type="button"
                role="radio"
                aria-checked={on}
                title={connection.name}
                onClick={() => void pick(connection)}
                className={cn(
                  "flex h-5 min-w-0 flex-1 items-center justify-center gap-1 rounded-[4px] px-1 text-[11px] whitespace-nowrap transition-colors",
                  on
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {busy(connection.id) && <Spinner className="size-3 shrink-0" />}
                <span className="truncate">{connection.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The explorer's lines for the gateways that are on, one each. */
export function GatewayBar({ onOpen }: { onOpen: () => void }) {
  const state = useGateway((store) => store.state)
  const error = useGateway((store) => store.error)
  const live = state?.gateways.filter((gateway) => gateway.enabled && gateway.connections.length) ?? []
  if (!state || !live.length) return null

  return (
    <div className="flex max-h-56 shrink-0 flex-col gap-1.5 overflow-y-auto border-t border-sidebar-border px-2 py-1.5">
      {live.map((gateway) => (
        <GatewayLine key={gateway.id} gateway={gateway} state={state} onOpen={onOpen} />
      ))}
      {error && (
        <p className="truncate px-1 text-[11px] text-destructive" title={error}>
          {error}
        </p>
      )}
    </div>
  )
}
