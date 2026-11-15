import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Eye,
  EyeOff,
  KeyRound,
} from "lucide-react"
import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react"

import {
  TONES,
  type Tone,
  type ConnectionInput,
  type Engine,
  type SslMode,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { MySQL } from "@/components/ui/svgs/mysql"
import { PostgreSQL } from "@/components/ui/svgs/postgresql"
import { ACCESS_ICON, ACCESS_LABEL } from "@/lib/access"
import {
  errorMessage,
  useStore,
  type ConnectionDialog as DialogState,
} from "@/lib/store"
import { connectionTone, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"

const DEFAULT_PORT: Record<Engine, number> = { postgres: 5432, mysql: 3306 }
const DEFAULT_USER: Record<Engine, string> = {
  postgres: "postgres",
  mysql: "root",
}

const SSL_MODES: Record<SslMode, string> = {
  off: "Off",
  require: "Require",
  verify: "Verify certificate",
}

const ENGINES: {
  value: Engine
  label: string
  logo: ComponentType<SVGProps<SVGSVGElement>>
}[] = [
  { value: "postgres", label: "PostgreSQL", logo: PostgreSQL },
  { value: "mysql", label: "MySQL", logo: MySQL },
]

const ENGINE_OF = Object.fromEntries(ENGINES.map((item) => [item.value, item])) as Record<
  Engine,
  (typeof ENGINES)[number]
>

/** `sslmode=` and its MySQL spellings, as this app's three. */
const SSL_OF_URL: Record<string, SslMode> = {
  disable: "off",
  disabled: "off",
  false: "off",
  allow: "off",
  prefer: "require",
  preferred: "require",
  require: "require",
  required: "require",
  true: "require",
  "verify-ca": "verify",
  "verify-full": "verify",
  verify_ca: "verify",
  verify_identity: "verify",
}

export type ParsedUrl = {
  engine: Engine
  host: string
  port: string
  user: string
  password: string
  database: string
  ssl: SslMode | null
}

/**
 * A connection URL — `postgres://user:password@host:5432/db?sslmode=require`,
 * `mysql://…` — as the dialog's fields, or null when it is not one.
 */
export function parseConnectionUrl(text: string): ParsedUrl | null {
  const scheme = /^(postgres(?:ql)?|mysql|mariadb):\/\//i.exec(text.trim())
  if (!scheme) return null
  let url: URL
  try {
    // A scheme URL knows nothing of; read as http, it parses the same.
    url = new URL(text.trim().replace(/^[a-z]+:/i, "http:"))
  } catch {
    return null
  }
  const engine: Engine = scheme[1]!.toLowerCase().startsWith("postgres") ? "postgres" : "mysql"
  const mode = (
    url.searchParams.get("sslmode") ??
    url.searchParams.get("ssl-mode") ??
    url.searchParams.get("ssl") ??
    ""
  ).toLowerCase()
  return {
    engine,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || String(DEFAULT_PORT[engine]),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ssl: SSL_OF_URL[mode] ?? null,
  }
}

type Probe =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; text: string }
  | { state: "failed"; text: string }

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

export function ConnectionDialog({
  dialog,
}: {
  dialog: NonNullable<DialogState>
}) {
  const existing = dialog.mode === "edit" ? dialog.connection : null
  const close = useStore((state) => state.openDialog)
  const save = useStore((state) => state.saveConnection)
  const openSettings = useStore((state) => state.openSettings)
  // Live: Settings may change it while this is open.
  const access =
    useStore(
      (state) => state.connections.find((item) => item.id === existing?.id)?.access
    ) ?? "read_write"

  const [engine, setEngine] = useState<Engine>(existing?.engine ?? "postgres")
  const [name, setName] = useState(existing?.name ?? "")
  const [host, setHost] = useState(existing?.host ?? "127.0.0.1")
  const [port, setPort] = useState(
    String(existing?.port ?? DEFAULT_PORT.postgres)
  )
  const [user, setUser] = useState(existing?.user ?? DEFAULT_USER.postgres)
  // Untouched, the stored password is kept; it is never sent back to be shown.
  const [password, setPassword] = useState<string | undefined>(
    existing ? undefined : ""
  )
  const [database, setDatabase] = useState(existing?.database ?? "")
  const [ssl, setSsl] = useState<SslMode>(existing?.ssl ?? "off")
  const [color, setColor] = useState<Tone | null>(existing?.color ?? null)
  const [probe, setProbe] = useState<Probe>({ state: "idle" })
  const [showPassword, setShowPassword] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState<"ok" | "bad" | null>(null)

  // A test says something about the settings it ran with: changed, it is gone.
  useEffect(() => {
    setProbe((current) => (current.state === "running" ? current : { state: "idle" }))
  }, [engine, host, port, user, password, database, ssl])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const input = (): ConnectionInput => ({
    engine,
    name: name.trim() || `${host}${database ? `/${database}` : ""}`,
    host,
    port: Number(port),
    user,
    database,
    ssl,
    color,
    ...(password === undefined ? {} : { password }),
  })

  const pickEngine = (next: Engine) => {
    // The port and user follow the engine only while they are still the
    // previous engine's defaults — a value somebody typed is left alone.
    if (port === String(DEFAULT_PORT[engine]))
      setPort(String(DEFAULT_PORT[next]))
    if (user === DEFAULT_USER[engine]) setUser(DEFAULT_USER[next])
    setEngine(next)
    setProbe({ state: "idle" })
  }

  const fill = (text: string) => {
    const parsed = parseConnectionUrl(text)
    if (!parsed) {
      setPasted(text.trim() ? "bad" : null)
      return
    }
    setEngine(parsed.engine)
    setHost(parsed.host)
    setPort(parsed.port)
    if (parsed.user) setUser(parsed.user)
    if (parsed.password) setPassword(parsed.password)
    setDatabase(parsed.database)
    if (parsed.ssl) setSsl(parsed.ssl)
    setPasted("ok")
    setPasting(false)
  }

  const test = async () => {
    setProbe({ state: "running" })
    try {
      const version = await window.veydata.testConnection(
        existing?.id ?? null,
        input()
      )
      setProbe({ state: "ok", text: `Connected — ${version}` })
    } catch (failure) {
      setProbe({ state: "failed", text: errorMessage(failure) })
    }
  }

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      await save(existing?.id ?? null, input())
    } catch (failure) {
      setError(errorMessage(failure))
      setSaving(false)
    }
  }

  const Logo = ENGINE_OF[engine].logo
  const summary = `${user || "…"}@${host || "…"}:${port || "…"}${database ? `/${database}` : ""}`

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close(null)
      }}
    >
      <DialogContent className="flex max-h-[calc(100%-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        {/* Which server it is, at a glance: the engine's mark, the name, where. */}
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-4 pr-12">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-background shadow-xs">
            <Logo className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px]">
              {existing ? existing.name : "New connection"}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">
              {ENGINE_OF[engine].label} · {summary}
            </DialogDescription>
          </div>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center">
              <span className="flex-1 text-xs font-medium">Engine</span>
              <button
                type="button"
                onClick={() => setPasting(!pasting)}
                className="flex items-center gap-1 rounded text-xs text-primary hover:underline"
              >
                <ClipboardPaste className="size-3.5" />
                Paste a connection URL
              </button>
            </div>
            {pasting && (
              <div className="flex flex-col gap-1">
                <Input
                  autoFocus
                  aria-label="Connection URL"
                  placeholder={`${engine === "postgres" ? "postgres" : "mysql"}://user:password@host:${DEFAULT_PORT[engine]}/database`}
                  onChange={(event) => fill(event.target.value)}
                  className="font-mono text-xs md:text-xs"
                />
                <p className={cn("text-[11px]", pasted === "bad" ? "text-destructive" : "text-muted-foreground")}>
                  {pasted === "bad"
                    ? "Not a postgres:// or mysql:// URL."
                    : "Fills in the fields below; nothing is kept of the URL itself."}
                </p>
              </div>
            )}
            {pasted === "ok" && !pasting && (
              <p className="flex items-center gap-1 text-[11px] text-success">
                <Check className="size-3" />
                Filled in from the URL. Check the fields, then test.
              </p>
            )}
            <div role="radiogroup" aria-label="Engine" className="grid grid-cols-2 gap-2">
              {ENGINES.map((item) => {
                const on = engine === item.value
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={item.label}
                    onClick={() => pickEngine(item.value)}
                    className={cn(
                      "relative flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors outline-offset-2",
                      on
                        ? "border-primary bg-primary/[0.04] ring-1 ring-primary dark:bg-primary/10"
                        : "hover:bg-accent/50"
                    )}
                  >
                    <item.logo className="size-7 shrink-0" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{item.label}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        Port {DEFAULT_PORT[item.value]}
                      </span>
                    </span>
                    {on && (
                      <span className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-2.5" strokeWidth={3} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Server
            </legend>
            <div className="grid grid-cols-[1fr_104px] gap-3">
              <Field id="connection-host" label="Host">
                <Input
                  id="connection-host"
                  value={host}
                  spellCheck={false}
                  autoFocus={!existing && !pasting}
                  placeholder="db.example.com"
                  onChange={(event) => setHost(event.target.value)}
                  className="font-mono text-[13px]"
                />
              </Field>
              <Field id="connection-port" label="Port">
                <Input
                  id="connection-port"
                  value={port}
                  inputMode="numeric"
                  onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ""))}
                  className="font-mono text-[13px] tabular-nums"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field id="connection-user" label="User">
                <Input
                  id="connection-user"
                  value={user}
                  spellCheck={false}
                  onChange={(event) => setUser(event.target.value)}
                  className="font-mono text-[13px]"
                />
              </Field>
              <Field id="connection-password" label="Password">
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="connection-password"
                    type={showPassword ? "text" : "password"}
                    value={password ?? ""}
                    placeholder={
                      password === undefined && existing?.hasPassword
                        ? "Saved — unchanged"
                        : "None"
                    }
                    onChange={(event) => setPassword(event.target.value)}
                    className="pr-8 pl-8 font-mono text-[13px]"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                    disabled={!password}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </Field>
            </div>

            <div className="grid grid-cols-[1fr_168px] gap-3">
              <Field id="connection-database" label="Database">
                <Input
                  id="connection-database"
                  value={database}
                  spellCheck={false}
                  placeholder={engine === "postgres" ? "postgres" : "Optional"}
                  onChange={(event) => setDatabase(event.target.value)}
                  className="font-mono text-[13px]"
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium text-foreground">SSL</Label>
                <SimpleSelect
                  label="SSL"
                  size="default"
                  className="w-full"
                  value={ssl}
                  items={SSL_MODES}
                  onChange={setSsl}
                />
              </div>
            </div>
            <p className="-mt-1 text-[11px] text-muted-foreground">
              The password is kept in this machine&apos;s keychain, never shown again.
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              In Vey Data
            </legend>
            <Field id="connection-name" label="Name">
              <Input
                id="connection-name"
                autoFocus={!!existing}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`${host || "host"}${database ? `/${database}` : ""}`}
              />
            </Field>

            <div className="flex items-center gap-3">
              <Label className="w-12 shrink-0 text-xs font-medium text-foreground">Colour</Label>
              <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-1.5">
                {[null, ...TONES].map((tone) => {
                  const shown = tone ?? connectionTone({ engine, color: null })
                  const picked = color === tone
                  return (
                    <button
                      key={tone ?? "auto"}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      aria-label={tone ?? "Engine default"}
                      title={tone ?? "Engine default"}
                      onClick={() => setColor(tone)}
                      className={cn(
                        "relative flex size-5 items-center justify-center rounded-full outline-offset-2 transition-transform hover:scale-110",
                        picked && "ring-2 ring-offset-2 ring-offset-popover"
                      )}
                      style={{
                        background: tone
                          ? toneColor(shown)
                          : `color-mix(in oklch, ${toneColor(shown)} 18%, transparent)`,
                        ...(picked ? { ["--tw-ring-color" as string]: toneColor(shown) } : {}),
                      }}
                    >
                      {tone === null ? (
                        <span
                          className="absolute inset-[5px] rounded-full"
                          style={{ background: toneColor(shown) }}
                        />
                      ) : (
                        picked && <Check className="size-3 text-white" strokeWidth={3} />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="-mt-1 text-[11px] text-muted-foreground">
              Marks it in the explorer and on its tabs. Red for production is a good habit.
            </p>

            {/* What may be done through it is a permission, set with the
                others in Settings; here it is only said. */}
            <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">{ACCESS_ICON[access]}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{ACCESS_LABEL[access]}</span>
                <span className="text-muted-foreground">
                  {existing ? " in Vey Data." : " when added."} Permissions are set in Settings.
                </span>
              </span>
              {existing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => openSettings("permissions")}
                >
                  Permissions
                  <ArrowUpRight />
                </Button>
              )}
            </div>
          </fieldset>

          {/* So Enter in any field saves, as a form should. */}
          <button type="submit" hidden />

          {(probe.state === "failed" || error) && (
            <ErrorNote>{error ?? (probe.state === "failed" ? probe.text : "")}</ErrorNote>
          )}
        </form>

        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/40 px-5 py-3">
          <Button
            variant="outline"
            onClick={test}
            disabled={probe.state === "running" || !host.trim()}
          >
            {probe.state === "running" && <Spinner className="size-3.5" />}
            Test
          </Button>
          <span
            role="status"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 text-xs",
              probe.state === "ok" ? "text-success" : "text-muted-foreground"
            )}
            title={probe.state === "ok" ? probe.text : undefined}
          >
            {probe.state === "ok" && (
              <>
                <CircleCheck className="size-3.5 shrink-0" />
                <span className="truncate">{probe.text}</span>
              </>
            )}
            {probe.state === "failed" && (
              <>
                <CircleAlert className="size-3.5 shrink-0 text-destructive" />
                <span className="truncate text-destructive">Could not connect</span>
              </>
            )}
            {probe.state === "running" && <span>Connecting…</span>}
          </span>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Spinner className="size-3.5" />}
            {existing ? "Save" : "Add connection"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
