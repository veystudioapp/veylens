import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"

import {
  GATEWAY_DEFAULT_PORT,
  type Connection,
  type ServerEngine,
  type GatewaySettings,
  type GatewayStatus,
  type Tone,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { ENGINE_LABEL, ENGINE_LOGO } from "@/lib/engines"
import { envSnippet, useGateway } from "@/lib/gateway"
import { useStore } from "@/lib/store"
import { connectionTone, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"
import { useGatewayConnections, usePick } from "./gateway-switch"
import { IconButton } from "./icon-button"
import { Switch } from "./switch"

/**
 * Settings › Gateways. A gateway is one engine on one port, holding a few
 * saved connections of that engine; the app goes to the one picked. That is
 * all there is: a card per gateway, its connections in a list, a click to
 * pick one. Every change is saved as it is made.
 */


const wash = (tone: Tone, percent: number) =>
  `color-mix(in oklch, ${toneColor(tone)} ${percent}%, transparent)`

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      label={done ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check /> : <Copy />}
    </IconButton>
  )
}

/** Text that edits in place, committed on Enter or on leaving it. */
function InlineInput({
  value,
  label,
  onCommit,
  className,
  numeric,
}: {
  value: string
  label: string
  onCommit: (value: string) => void
  className?: string
  numeric?: boolean
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      value={text}
      aria-label={label}
      spellCheck={false}
      inputMode={numeric ? "numeric" : undefined}
      size={Math.max(numeric ? 5 : 4, text.length)}
      onChange={(event) => setText(numeric ? event.target.value.replace(/[^\d]/g, "") : event.target.value)}
      onBlur={() => {
        const next = text.trim()
        if (next && next !== value) onCommit(next)
        else setText(value)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()
        if (event.key === "Escape") {
          setText(value)
          event.currentTarget.blur()
        }
      }}
      className={cn(
        "min-w-0 rounded-[5px] border border-transparent bg-transparent px-1 py-0.5 outline-none hover:border-input focus:border-ring focus:bg-background focus:ring-3 focus:ring-ring/30",
        className
      )}
    />
  )
}

function health(gateway: GatewaySettings, status: GatewayStatus | undefined): { tone: Tone; text: string } {
  if (!gateway.enabled) return { tone: "gray", text: "Off" }
  if (status?.error) return { tone: "red", text: status.error }
  if (!status?.listening) return { tone: "amber", text: "Starting…" }
  if (!gateway.connections.length) return { tone: "amber", text: "Listening · add a connection" }
  return {
    tone: "green",
    text: status.sessions
      ? `Listening · ${status.sessions} app ${status.sessions === 1 ? "connection" : "connections"}`
      : "Listening",
  }
}

function GatewayCard({ gateway, status }: { gateway: GatewaySettings; status: GatewayStatus | undefined }) {
  const save = useGateway((store) => store.save)
  const remove = useGateway((store) => store.remove)
  const switching = useGateway((store) => store.switching)
  const resetPassword = useGateway((store) => store.resetPassword)
  const all = useStore((store) => store.connections)
  const connections = useGatewayConnections(gateway)
  const pick = usePick(gateway)
  const [showEnv, setShowEnv] = useState(false)
  const [reveal, setReveal] = useState(false)

  const Logo = ENGINE_LOGO[gateway.engine]
  const state = health(gateway, status)
  const addable = all.filter(
    (connection) => connection.engine === gateway.engine && !gateway.connections.includes(connection.id)
  )
  const live = connections.find((connection) => connection.id === gateway.active)
  const push = (patch: Partial<GatewaySettings>) => void save({ ...gateway, ...patch })
  const snippet = envSnippet(gateway.engine, gateway.port, gateway.password, live?.database ?? "")

  const rotate = async () => {
    const ok = await confirm({
      title: `Make a new password for "${gateway.name}"?`,
      description: `${status?.sessions ? "The app connections open through it are closed now, and apps" : "Apps"} with the old password in their .env are refused when they connect. Other gateways are not touched.`,
      action: "New password",
    })
    if (ok) void resetPassword(gateway.id)
  }

  const destroy = async () => {
    const ok = await confirm({
      title: `Delete the gateway "${gateway.name}"?`,
      description: `Port ${gateway.port} stops listening${status?.sessions ? " and the apps connected through it are cut off" : ""}. The saved connections stay.`,
      action: "Delete",
      destructive: true,
    })
    if (ok) void remove(gateway.id)
  }

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Logo className="size-5 shrink-0" />
        <InlineInput
          value={gateway.name}
          label="Gateway name"
          onCommit={(name) => push({ name })}
          className="text-[13px] font-medium"
        />
        <span className="flex items-center text-xs text-muted-foreground">
          <span className="font-mono">127.0.0.1:</span>
          <InlineInput
            value={String(gateway.port)}
            label="Port"
            numeric
            onCommit={(port) => push({ port: Number(port) })}
            className="-ml-0.5 font-mono text-xs text-foreground tabular-nums"
          />
        </span>
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
          style={{ color: toneColor(state.tone) }}
          title={state.text}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-current" />
          <span className="truncate">{state.text}</span>
        </span>
        <Switch checked={gateway.enabled} label="Gateway on" onChange={(enabled) => push({ enabled })} />
        <IconButton label="Delete gateway" onClick={() => void destroy()}>
          <Trash2 />
        </IconButton>
      </div>

      <div className="flex flex-col gap-0.5 p-1.5">
        {connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            live={connection.id === gateway.active}
            busy={switching?.gatewayId === gateway.id && switching.connectionId === connection.id}
            onPick={() => void pick(connection)}
            onRemove={() => push({ connections: gateway.connections.filter((id) => id !== connection.id) })}
          />
        ))}
        {connections.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            Add the {ENGINE_LABEL[gateway.engine]} connections the app should be able to go to: your
            local one, dev, staging…
          </p>
        )}
        <div className="flex items-center gap-1 px-1 pt-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={!addable.length}>
                  <Plus />
                  {addable.length ? "Add connection" : `No other ${ENGINE_LABEL[gateway.engine]} connections`}
                  {addable.length > 0 && <ChevronDown />}
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-auto min-w-56">
              {addable.map((connection) => (
                <DropdownMenuItem
                  key={connection.id}
                  onClick={() => push({ connections: [...gateway.connections, connection.id] })}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: toneColor(connectionTone(connection)) }}
                  />
                  <span className="flex-1">{connection.name}</span>
                  <span className="text-[11px] text-muted-foreground">{connection.database}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* What the app signs in with, and the lines for its .env */}
      <div className="flex items-center gap-1.5 border-t px-3 py-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">Password</span>
        <code className="min-w-0 flex-1 truncate px-1 font-mono text-[11px]">
          {reveal ? gateway.password : "•".repeat(Math.min(20, gateway.password.length))}
        </code>
        <IconButton label={reveal ? "Hide password" : "Show password"} onClick={() => setReveal(!reveal)}>
          {reveal ? <EyeOff /> : <Eye />}
        </IconButton>
        <CopyButton text={gateway.password} label="Copy password" />
        <IconButton label="New password" onClick={() => void rotate()}>
          <RotateCcw />
        </IconButton>
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setShowEnv(!showEnv)}>
          .env
          <ChevronDown className={cn("transition-transform", showEnv && "rotate-180")} />
        </Button>
      </div>
      {showEnv && (
        <div className="mx-3 mb-3 rounded-md border bg-muted/60">
          <div className="flex items-center border-b py-0.5 pr-1 pl-2.5">
            <span className="flex-1 text-[11px] text-muted-foreground">Paste once into the app's .env</span>
            <CopyButton text={snippet} label="Copy" />
          </div>
          <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed select-text">
            {snippet}
          </pre>
        </div>
      )}
    </div>
  )
}

/** One of a gateway's connections: click to make it the one the app goes to. */
function ConnectionRow({
  connection,
  live,
  busy,
  onPick,
  onRemove,
}: {
  connection: Connection
  live: boolean
  busy: boolean
  onPick: () => void
  onRemove: () => void
}) {
  return (
    <div
      role="radio"
      aria-checked={live}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onPick()
        }
      }}
      title={live ? undefined : `Click to send the app to ${connection.name}`}
      className={cn(
        "group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-xs outline-offset-[-2px] transition-colors",
        !live && "cursor-pointer hover:bg-muted/60"
      )}
      style={live ? { background: wash("green", 9) } : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          live ? "border-transparent" : "border-muted-foreground/40 group-hover:border-foreground/60"
        )}
        style={live ? { background: toneColor("green") } : undefined}
      >
        {busy ? <Spinner className="size-2.5" /> : live && <span className="size-1.5 rounded-full bg-white" />}
      </span>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: toneColor(connectionTone(connection)) }}
      />
      <span className={cn("min-w-0 truncate", live && "font-medium")}>{connection.name}</span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
        {connection.database || "no database set"}
      </span>
      <span className="flex-1" />
      {live && (
        <span
          className="shrink-0 rounded px-1.5 text-[10px] leading-4 font-semibold uppercase"
          style={{ background: wash("green", 18), color: toneColor("green") }}
        >
          live
        </span>
      )}
      <span onClick={(event) => event.stopPropagation()}>
        <IconButton
          label={`Remove ${connection.name} from the gateway`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
        >
          <X />
        </IconButton>
      </span>
    </div>
  )
}

export function GatewayPage() {
  const state = useGateway((store) => store.state)
  const error = useGateway((store) => store.error)
  const save = useGateway((store) => store.save)
  const clearError = useGateway((store) => store.clearError)

  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const create = (engine: ServerEngine) => {
    const ports = new Set(state.gateways.map((gateway) => gateway.port))
    let port = GATEWAY_DEFAULT_PORT[engine]
    while (ports.has(port)) port++
    const names = new Set(state.gateways.map((gateway) => gateway.name))
    let name = `${ENGINE_LABEL[engine]} gateway`
    for (let n = 2; names.has(name); n++) name = `${ENGINE_LABEL[engine]} gateway ${n}`
    // An empty password: the gateway makes its own.
    void save({ id: "", name, engine, port, enabled: true, connections: [], active: null, password: "" })
  }

  const newButton = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant={state.gateways.length ? "outline" : "default"}>
            <Plus />
            New gateway
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        {(["postgres", "mysql"] as const).map((engine) => {
          const Logo = ENGINE_LOGO[engine]
          return (
            <DropdownMenuItem key={engine} onClick={() => create(engine)}>
              <Logo className="size-4" />
              {ENGINE_LABEL[engine]}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-4 border-b py-4 pr-14 pl-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Gateways</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Point your app at a gateway instead of a database. Pick which
            connection it goes to with one click, here or at the foot of the
            explorer; the app's <code>.env</code> never changes.
          </p>
        </div>
        {state.gateways.length > 0 && newButton}
      </div>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b px-6 py-2 text-xs"
          style={{ background: wash("red", 8), color: toneColor("red") }}
        >
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={clearError} className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
        {state.gateways.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              A gateway is a port for one kind of database. Add your local,
              dev and staging connections to it, then switch between them
              without touching the app.
            </p>
            {newButton}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {state.gateways.map((gateway) => (
              <GatewayCard
                key={gateway.id}
                gateway={gateway}
                status={state.status.find((item) => item.gatewayId === gateway.id)}
              />
            ))}
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Each gateway has its own password; any user name works. The app lands
          in the picked connection's own database. Use <code>127.0.0.1</code>{" "}
          and SSL off in the app. Vey Lens's permissions do not apply through
          a gateway: the app signs in as the connection's database user.
        </p>
      </div>
    </div>
  )
}
