import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Cloud,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FolderOpen,
  FileKey,
  KeyRound,
  LogIn,
  Plus,
  Sheet,
  UserRound,
  X,
} from "lucide-react"
import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react"

import { addressOf, sourceLabel } from "@shared/address"
import {
  TONES,
  type CloudSql,
  type CloudSqlAuth,
  type CloudSqlIpType,
  type DataSource,
  type GoogleAccountState,
  type SheetAccess,
  type Tone,
  type ConnectionInput,
  type Engine,
  type ServerEngine,
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
import { ACCESS_ICON, ACCESS_LABEL } from "@/lib/access"
import { ENGINE_LABEL, ENGINE_LOGO } from "@/lib/engines"
import {
  errorMessage,
  useStore,
  type ConnectionDialog as DialogState,
} from "@/lib/store"
import { connectionTone, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"

const DEFAULT_PORT: Record<Engine, number> = { postgres: 5432, mysql: 3306, duckdb: 0 }
const DEFAULT_USER: Record<Engine, string> = {
  postgres: "postgres",
  mysql: "root",
  duckdb: "",
}

const SHEET_ACCESS_LABEL: Record<SheetAccess, string> = {
  link: "Anyone with the link",
  google: "My Google account",
}

const SSL_MODES: Record<SslMode, string> = {
  off: "Off",
  require: "Require",
  verify: "Verify certificate",
}

/** How the server is reached: at a host and port, or through Google's Cloud
 * SQL connector by the instance's connection name. */
type Via = "host" | "cloudSql"

const CLOUD_SQL_IP: Record<CloudSqlIpType, string> = {
  public: "Public IP",
  private: "Private IP",
  psc: "Private Service Connect",
}

const CLOUD_SQL_AUTH: Record<CloudSqlAuth, string> = {
  password: "Password",
  iam: "IAM (Google account)",
}

/** Who the database user is when signing in as the Google account. */
const IAM_USER: Record<ServerEngine, string> = {
  postgres:
    "The user is the Google account's email; for a service account, its email without .gserviceaccount.com.",
  mysql:
    "The user is the Google account's email without the @ and domain; for a service account, its name before @.",
}

const ENGINES: {
  value: Engine
  label: string
  logo: ComponentType<SVGProps<SVGSVGElement>>
  /** Under its name in the picker. */
  hint: string
}[] = [
  { value: "postgres", label: ENGINE_LABEL.postgres, logo: ENGINE_LOGO.postgres, hint: "Port 5432" },
  { value: "mysql", label: ENGINE_LABEL.mysql, logo: ENGINE_LOGO.mysql, hint: "Port 3306" },
  { value: "duckdb", label: ENGINE_LABEL.duckdb, logo: ENGINE_LOGO.duckdb, hint: "Excel, Sheets" },
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

/**
 * The Google account private sheets are read as: who is signed in, a way to
 * sign in, or — in a build without its own OAuth client — a way to import
 * the company's.
 */
function GoogleSignIn() {
  const [state, setState] = useState<GoogleAccountState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.veylens.googleAccount().then(setState, () => {})
  }, [])

  const run = async (task: () => Promise<GoogleAccountState>) => {
    setBusy(true)
    setError(null)
    try {
      setState(await task())
    } catch (failure) {
      setError(errorMessage(failure))
      void window.veylens.googleAccount().then(setState, () => {})
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null
  const signingIn = busy && state.client !== null && !state.email

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs">
      {state.email ? (
        <div className="flex items-center gap-2">
          <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            Private sheets are read as <span className="font-medium">{state.email}</span>
          </span>
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => run(() => window.veylens.signOutOfGoogle())}>
            Sign out
          </Button>
        </div>
      ) : state.client ? (
        <div className="flex items-center gap-2">
          {signingIn ? (
            <>
              <Spinner className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 text-muted-foreground">Finish signing in in your browser…</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => void window.veylens.cancelGoogleSignIn()}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-muted-foreground">
                Sign in with a Google account the sheets are shared with.
              </span>
              <Button type="button" size="sm" disabled={busy} onClick={() => run(() => window.veylens.signInWithGoogle())}>
                <LogIn />
                Sign in with Google
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground">
            Signing in needs your company&apos;s Google OAuth client (type &ldquo;Desktop app&rdquo;). Import the
            client_secret_….json your admin made.
          </span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(() => window.veylens.importGoogleClient())}>
            <FileKey />
            Import client…
          </Button>
        </div>
      )}
      {signingIn && (
        // Google shows this one in the browser and never comes back.
        <p className="text-[11px] text-muted-foreground">
          Google says <code>redirect_uri_mismatch</code>? The OAuth client is not of type &ldquo;Desktop app&rdquo;
          (a &ldquo;Web application&rdquo; one cannot be used): make a Desktop app client and use that.
        </p>
      )}
      {state.client === "imported" && !signingIn && (
        <p className="text-[11px] text-muted-foreground">
          Through an imported OAuth client.{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            disabled={busy}
            onClick={() => run(() => window.veylens.importGoogleClient())}
          >
            Import another
          </button>
          {" · "}
          <button
            type="button"
            className="text-primary hover:underline"
            disabled={busy}
            onClick={() => run(() => window.veylens.forgetGoogleClient())}
          >
            Forget it
          </button>
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/** A Google Sheets link, or a bare spreadsheet id. */
const SHEET_LINK = /\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}|^[A-Za-z0-9_-]{20,}$/

/** A files connection's sources: files picked from disk, Google Sheets by
 * link, each one removable. */
function SourcesField({
  sources,
  onChange,
}: {
  sources: DataSource[]
  onChange: (sources: DataSource[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState("")
  const [access, setAccess] = useState<SheetAccess>("link")
  const [picking, setPicking] = useState(false)
  const valid = SHEET_LINK.test(url.trim())
  const needsAccount =
    sources.some((source) => source.kind === "google_sheet" && source.access === "google") ||
    (adding && access === "google")

  const pick = async () => {
    setPicking(true)
    try {
      const paths = await window.veylens.pickDataFiles()
      const known = new Set(sources.flatMap((source) => (source.kind === "file" ? [source.path] : [])))
      const added = paths.filter((file) => !known.has(file)).map((file): DataSource => ({ kind: "file", path: file }))
      if (added.length) onChange([...sources, ...added])
    } finally {
      setPicking(false)
    }
  }

  const addSheet = () => {
    if (!valid) return
    onChange([...sources, { kind: "google_sheet", url: url.trim(), access }])
    setUrl("")
    setAdding(false)
  }

  return (
    <div className="flex flex-col gap-2">
      {sources.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {sources.map((source, index) => (
            <li key={source.kind === "file" ? source.path : `${source.url}#${index}`} className="flex items-center gap-2.5 px-3 py-2">
              {source.kind === "file" ? (
                <FileSpreadsheet className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Sheet className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{sourceLabel(source)}</span>
                <span
                  className="block truncate font-mono text-[11px] text-muted-foreground"
                  title={source.kind === "file" ? source.path : source.url}
                >
                  {source.kind === "file" ? source.path : source.url}
                </span>
              </span>
              {source.kind === "google_sheet" && (
                <SimpleSelect
                  label="Read as"
                  heading="Read as"
                  value={source.access}
                  items={SHEET_ACCESS_LABEL}
                  onChange={(next) =>
                    onChange(sources.map((item) => (item === source ? { ...source, access: next } : item)))
                  }
                />
              )}
              <button
                type="button"
                aria-label={`Remove ${sourceLabel(source)}`}
                title="Remove"
                onClick={() => onChange(sources.filter((item) => item !== source))}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {needsAccount && <GoogleSignIn />}

      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
          <Field id="sheet-url" label="Google Sheet link">
            <Input
              id="sheet-url"
              autoFocus
              value={url}
              spellCheck={false}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addSheet()
                }
              }}
              className="font-mono text-xs md:text-xs"
            />
          </Field>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Read as</span>
            <SimpleSelect label="Read as" heading="Read as" value={access} items={SHEET_ACCESS_LABEL} onChange={setAccess} />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!valid} onClick={addSheet}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {access === "link"
              ? "For a sheet shared as \u201cAnyone with the link\u201d: no sign-in."
              : "For a sheet shared with you: read through the Sheets API as the Google account signed in above (or, without one, this machine's gcloud sign-in)."}
          </p>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={pick} disabled={picking}>
            {picking ? <Spinner className="size-3.5" /> : <FolderOpen />}
            Add files…
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add Google Sheet
          </Button>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Excel (.xlsx, .xls), CSV, Parquet and JSON. A workbook is a schema with a table per sheet; other
        files are tables in <code>main</code>. Files are read again when they change, Google Sheets every
        five minutes. Nothing is written back.
      </p>
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
    ) ?? "read_only"

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
  const [via, setVia] = useState<Via>(existing?.cloudSql ? "cloudSql" : "host")
  const [instance, setInstance] = useState(existing?.cloudSql?.instance ?? "")
  const [ipType, setIpType] = useState<CloudSqlIpType>(existing?.cloudSql?.ipType ?? "public")
  const [auth, setAuth] = useState<CloudSqlAuth>(existing?.cloudSql?.auth ?? "password")
  const cloud = via === "cloudSql"
  const iam = cloud && auth === "iam"
  const [sources, setSources] = useState<DataSource[]>(existing?.sources ?? [])
  const files = engine === "duckdb"
  const [color, setColor] = useState<Tone | null>(existing?.color ?? null)
  const [probe, setProbe] = useState<Probe>({ state: "idle" })
  const [showPassword, setShowPassword] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState<"ok" | "bad" | null>(null)

  // A test says something about the settings it ran with: changed, it is gone.
  useEffect(() => {
    setProbe((current) => (current.state === "running" ? current : { state: "idle" }))
  }, [engine, host, port, user, password, database, ssl, via, instance, ipType, auth, sources])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cloudSql: CloudSql | null = cloud ? { instance: instance.trim(), ipType, auth } : null
  /** What the name is when none is typed: where it goes. */
  const where = files
    ? sources[0]
      ? sourceLabel(sources[0]).replace(/\.[^.]+$/, "")
      : ""
    : cloud
      ? instance.trim().split(":").pop() || ""
      : host
  const input = (): ConnectionInput =>
    files
      ? {
          engine,
          name: name.trim() || where || "Files",
          host: "",
          port: 0,
          user: "",
          database: "",
          ssl: "off",
          cloudSql: null,
          sources,
          color,
        }
      : {
    engine,
    name: name.trim() || `${where}${database ? `/${database}` : ""}`,
    host,
    port: Number(port),
    user,
    database,
    ssl,
    cloudSql,
    color,
    // Signing in as the Google account, there is no password to keep.
    ...(iam ? { password: "" } : password === undefined ? {} : { password }),
        }

  const pickEngine = (next: Engine) => {
    // The port and user follow the engine only while they are still the
    // previous engine's defaults — a value somebody typed is left alone.
    if (next !== "duckdb" && (engine === "duckdb" || port === String(DEFAULT_PORT[engine])))
      setPort(String(DEFAULT_PORT[next]))
    if (next !== "duckdb" && (engine === "duckdb" || user === DEFAULT_USER[engine]))
      setUser(DEFAULT_USER[next])
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
    setVia("host")
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
      const version = await window.veylens.testConnection(
        existing?.id ?? null,
        input()
      )
      setProbe({ state: "ok", text: files ? `Read — ${version}` : `Connected — ${version}` })
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
  const summary = files
    ? addressOf({ engine, sources, host, port: 0, cloudSql: null })
    : `${user || "…"}@${cloud ? `Cloud SQL ${instance || "…"}` : `${host || "…"}:${port || "…"}`}${database ? `/${database}` : ""}`

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
              {!files && (
              <button
                type="button"
                onClick={() => setPasting(!pasting)}
                className="flex items-center gap-1 rounded text-xs text-primary hover:underline"
              >
                <ClipboardPaste className="size-3.5" />
                Paste a connection URL
              </button>
              )}
            </div>
            {pasting && !files && (
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
            <div role="radiogroup" aria-label="Engine" className="grid grid-cols-3 gap-2">
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
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {item.hint}
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

          {files ? (
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Sources
              </legend>
              <SourcesField sources={sources} onChange={setSources} />
            </fieldset>
          ) : (
          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Server
            </legend>
            <div
              role="radiogroup"
              aria-label="Connect through"
              className="-mt-1 flex rounded-md bg-muted p-0.5"
            >
              {(
                [
                  ["host", "Host & port", null],
                  ["cloudSql", "Google Cloud SQL", <Cloud key="icon" />],
                ] as const
              ).map(([value, label, icon]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={via === value}
                  onClick={() => setVia(value)}
                  className={cn(
                    "flex h-6 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-xs whitespace-nowrap transition-colors [&_svg]:size-3.5",
                    via === value
                      ? "bg-background font-medium text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>

            {cloud ? (
              <div className="grid grid-cols-[1fr_168px] gap-3">
                <Field id="connection-instance" label="Instance connection name">
                  <Input
                    id="connection-instance"
                    value={instance}
                    spellCheck={false}
                    autoFocus={!existing && !pasting}
                    placeholder="project:region:instance"
                    onChange={(event) => setInstance(event.target.value)}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-foreground">IP address</Label>
                  <SimpleSelect
                    label="IP address"
                    heading="IP address"
                    size="default"
                    className="w-full justify-between"
                    value={ipType}
                    items={CLOUD_SQL_IP}
                    onChange={setIpType}
                  />
                </div>
              </div>
            ) : (
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
            )}

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
                    value={iam ? "" : (password ?? "")}
                    disabled={iam}
                    placeholder={
                      iam
                        ? "Not used with IAM"
                        : password === undefined && existing?.hasPassword
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
                    disabled={iam || !password}
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
              {cloud ? (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-foreground">Sign in with</Label>
                  <SimpleSelect
                    label="Sign in with"
                    heading="Sign in with"
                    size="default"
                    className="w-full justify-between"
                    value={auth}
                    items={CLOUD_SQL_AUTH}
                    onChange={setAuth}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-foreground">SSL</Label>
                  <SimpleSelect
                    label="SSL"
                    heading="SSL"
                    size="default"
                    className="w-full justify-between"
                    value={ssl}
                    items={SSL_MODES}
                    onChange={setSsl}
                  />
                </div>
              )}
            </div>
            {cloud ? (
              <p className="-mt-1 text-[11px] text-muted-foreground">
                Reached through Google&apos;s Cloud SQL connector, which encrypts the
                connection itself. It signs in to Google as this machine&apos;s
                default credentials (<code>gcloud auth application-default login</code>);
                that account needs the Cloud SQL Client role.
                {iam ? ` ${IAM_USER[engine as ServerEngine]}` : " The password is kept in this machine's keychain."}
              </p>
            ) : (
              <p className="-mt-1 text-[11px] text-muted-foreground">
                The password is kept in this machine&apos;s keychain, never shown again.
              </p>
            )}
          </fieldset>
          )}

          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              In Vey Lens
            </legend>
            <Field id="connection-name" label="Name">
              <Input
                id="connection-name"
                autoFocus={!!existing}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  files ? where || "Files" : `${where || (cloud ? "instance" : "host")}${database ? `/${database}` : ""}`
                }
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
              <span className="text-muted-foreground">{ACCESS_ICON[files ? "read_only" : access]}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{ACCESS_LABEL[files ? "read_only" : access]}</span>
                <span className="text-muted-foreground">
                  {files
                    ? " always: files are read, never written. Hidden sheets are set in Settings."
                    : `${existing ? " in Vey Lens." : " when added."} Permissions are set in Settings.`}
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
            disabled={
              probe.state === "running" || (files ? sources.length === 0 : !(cloud ? instance : host).trim())
            }
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
                <span className="truncate text-destructive">{files ? "Could not read it all" : "Could not connect"}</span>
              </>
            )}
            {probe.state === "running" && <span>{files ? "Reading…" : "Connecting…"}</span>}
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
