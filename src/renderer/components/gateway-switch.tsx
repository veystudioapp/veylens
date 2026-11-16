import { CircleAlert } from "lucide-react"

import type { Connection, GatewaySettings, GatewayState } from "@shared/api"

import { Spinner } from "@/components/ui/spinner"
import { MySQL } from "@/components/ui/svgs/mysql"
import { PostgreSQL } from "@/components/ui/svgs/postgresql"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useGateway } from "@/lib/gateway"
import { useStore } from "@/lib/store"
import { connectionTone, toneColor } from "@/lib/tones"

import { confirm } from "./confirm"
import { SimpleSelect } from "./simple-select"

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

/** One gateway's lines in the explorer: its name, and a select of its
 * connections — picking one sends the app there. */
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
  const busy = switching?.gatewayId === gateway.id

  return (
    <div className="flex flex-col gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {status?.error ? (
                <CircleAlert className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <Logo className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{gateway.name}</span>
              {!!status?.sessions && (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums">{status.sessions}</span>
              )}
              {busy && <Spinner className="size-3 shrink-0" />}
            </button>
          }
        />
        <TooltipContent side="top" className="max-w-80 whitespace-pre-line">
          {[
            `127.0.0.1:${gateway.port} → ${live?.name ?? "nothing"}`,
            ...(status?.error ? [status.error] : []),
          ].join("\n")}
        </TooltipContent>
      </Tooltip>
      <SimpleSelect
        label={`${gateway.name}: connection`}
        value={live?.id ?? ""}
        items={Object.fromEntries(connections.map((connection) => [connection.id, connection.name]))}
        size="sm"
        heading="Send the app to"
        align="start"
        className="w-full justify-between"
        leading={
          live && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: toneColor(connectionTone(live)) }}
            />
          )
        }
        onChange={(id) => {
          const next = connections.find((connection) => connection.id === id)
          if (next) void pick(next)
        }}
      />
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
