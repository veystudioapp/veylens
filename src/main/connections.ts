import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  ACCESS_MODES,
  CLOUD_SQL_AUTHS,
  CLOUD_SQL_IP_TYPES,
  SHEET_ACCESS,
  TONES,
  type AccessMode,
  type CloudSql,
  type Connection,
  type ConnectionInput,
  type DataSource,
  type Engine,
  type Permissions,
} from "../shared/api"
import { checkPermissions, forAssistant } from "../shared/permissions"
import { createDriver, type ConnectionConfig, type Driver } from "./db"
import { fileKind } from "./db/files/driver"
import { spreadsheetId } from "./db/files/google-sheets"
import { GuardedDriver, ViewSourceCache, type Policy } from "./db/guarded"

/**
 * How a password is kept at rest. In the app this is Electron's `safeStorage`
 * (the OS keychain); `encrypt` answering null means none is available, and the
 * password is then written as it is into a file only this user can read.
 */
export type Secrets = {
  encrypt(text: string): string | null
  decrypt(data: string): string | null
}

type StoredPassword = { enc: string } | { plain: string } | null

type Stored = Omit<Connection, "hasPassword" | "permissions" | "cloudSql" | "sources"> & {
  password: StoredPassword
  /** Saved before files connections: none. */
  sources?: DataSource[]
  /** Saved before there were permissions: none, the defaults. */
  permissions?: Permissions
  /** Saved before Cloud SQL: none. */
  cloudSql?: CloudSql | null
}

const ENGINES: Engine[] = ["postgres", "mysql", "duckdb"]

/** `project:region:instance`; a domain-scoped project adds `example.com:`. */
const INSTANCE_NAME = /^[^:\s]+(:[^:\s]+){2,3}$/

/** The Cloud SQL settings as given, trimmed; null for none. Throws, saying
 * what is wrong, when they do not make sense. */
function checkCloudSql(cloudSql: CloudSql | null | undefined): CloudSql | null {
  if (!cloudSql) return null
  const instance = cloudSql.instance.trim()
  if (!INSTANCE_NAME.test(instance)) {
    throw new Error(
      "The instance connection name looks like project:region:instance — copy it from the instance's page in the Cloud console."
    )
  }
  return {
    instance,
    ipType: CLOUD_SQL_IP_TYPES.includes(cloudSql.ipType) ? cloudSql.ipType : "public",
    auth: CLOUD_SQL_AUTHS.includes(cloudSql.auth) ? cloudSql.auth : "password",
  }
}

/** The Cloud SQL settings a save or test is for: those given, or — left out
 * — the stored ones. */
function cloudSqlOf(input: ConnectionInput, existing: Stored | null): CloudSql | null {
  return input.cloudSql === undefined
    ? (existing?.cloudSql ?? null)
    : checkCloudSql(input.cloudSql)
}

/** A files connection's sources as given, checked; none for a server. */
function checkSources(engine: Engine, sources: DataSource[] | undefined): DataSource[] {
  if (engine !== "duckdb") return []
  const checked: DataSource[] = []
  for (const source of sources ?? []) {
    if (source?.kind === "file") {
      const file = String(source.path ?? "").trim()
      if (!path.isAbsolute(file)) throw new Error(`Not a full path to a file: ${file}`)
      if (!fileKind(file)) {
        throw new Error(
          `${path.basename(file)} is not a file this can read: Excel (.xlsx, .xls…), CSV, Parquet or JSON.`
        )
      }
      if (!checked.some((other) => other.kind === "file" && other.path === file)) {
        checked.push({ kind: "file", path: file })
      }
    } else if (source?.kind === "google_sheet") {
      const url = String(source.url ?? "").trim()
      if (!spreadsheetId(url)) throw new Error(`Not a link to a Google Sheet: ${url}`)
      checked.push({
        kind: "google_sheet",
        url,
        access: SHEET_ACCESS.includes(source.access) ? source.access : "link",
      })
    }
  }
  return checked
}

/** The sources a save or test is for: those given, or the stored ones. */
function sourcesOf(input: ConnectionInput, existing: Stored | null): DataSource[] {
  return checkSources(input.engine, input.sources === undefined ? existing?.sources : input.sources)
}

function validate(input: ConnectionInput, cloudSql: CloudSql | null, sources: DataSource[]): void {
  if (!ENGINES.includes(input.engine)) throw new Error("Pick an engine.")
  if (!input.name.trim()) throw new Error("Give the connection a name.")
  if (input.engine === "duckdb") {
    if (sources.length === 0) throw new Error("Add a file or a Google Sheet to read.")
    return
  }
  // Cloud SQL's connector finds the address itself.
  if (cloudSql) return
  if (!input.host.trim()) throw new Error("A host is required.")
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("The port must be a number between 1 and 65535.")
  }
}

/**
 * The saved connections and the one live driver each of them has.
 *
 * A driver is opened on first use and dropped whenever its connection is
 * edited or removed, so nothing keeps talking to a server with old settings.
 */
export class Connections {
  private stored: Stored[] = []
  /** Where files connections keep the copies they make; emptied on start,
   * as nothing in it outlives the driver that made it. */
  private readonly cacheRoot: string
  /** Per connection: one server driver, and the user's and the assistant's
   * guards in front of it. */
  private readonly drivers = new Map<
    string,
    { inner: Driver; user: GuardedDriver; assistant: GuardedDriver }
  >()

  constructor(
    private readonly file: string,
    private readonly secrets: Secrets,
    /** Swapped by a test for drivers that need no network. */
    private readonly create: (config: ConnectionConfig) => Driver = createDriver
  ) {
    this.cacheRoot = path.join(path.dirname(file), "file-cache")
    rmSync(this.cacheRoot, { recursive: true, force: true })
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (Array.isArray(parsed)) this.stored = parsed as Stored[]
    } catch {
      // No file yet, or one that cannot be read: start with none.
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2), {
      mode: 0o600,
    })
    // `mode` only applies when the file is created.
    chmodSync(this.file, 0o600)
  }

  private seal(password: string): StoredPassword {
    if (!password) return null
    const enc = this.secrets.encrypt(password)
    return enc === null ? { plain: password } : { enc }
  }

  private open(password: StoredPassword): string {
    if (!password) return ""
    if ("plain" in password) return password.plain
    return this.secrets.decrypt(password.enc) ?? ""
  }

  private find(id: string): Stored {
    const found = this.stored.find((connection) => connection.id === id)
    if (!found) throw new Error("That connection no longer exists.")
    return found
  }

  private static publicView(stored: Stored): Connection {
    const { password, ...rest } = stored
    // Saved before there were access modes: as it always was, read & write.
    return {
      ...rest,
      access: rest.access ?? "read_write",
      // Saved before connections had colours.
      color: rest.color ?? null,
      cloudSql: rest.cloudSql ?? null,
      sources: rest.sources ?? [],
      permissions: checkPermissions(rest.permissions),
      hasPassword: password !== null,
    }
  }

  private drop(id: string): void {
    const open = this.drivers.get(id)
    this.drivers.delete(id)
    void open?.inner.close()
  }

  list(): Connection[] {
    return this.stored.map(Connections.publicView)
  }

  get(id: string): Connection {
    return Connections.publicView(this.find(id))
  }

  save(id: string | null, input: ConnectionInput): Connection {
    const existing = id ? this.find(id) : null
    const files = input.engine === "duckdb"
    const cloudSql = files ? null : cloudSqlOf(input, existing)
    const sources = sourcesOf(input, existing)
    validate(input, cloudSql, sources)
    const next: Stored = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim(),
      engine: input.engine,
      host: input.host.trim(),
      port: input.port,
      user: input.user.trim(),
      database: input.database.trim(),
      ssl: input.ssl,
      cloudSql,
      ...(files ? { sources } : {}),
      // Files are read, never written: their tables are reloaded from them.
      access: files
        ? "read_only"
        : ACCESS_MODES.includes(input.access as AccessMode)
          ? input.access!
          : (existing?.access ?? "read_only"),
      color:
        input.color === undefined
          ? (existing?.color ?? null)
          : input.color !== null && TONES.includes(input.color)
            ? input.color
            : null,
      password:
        input.password === undefined
          ? (existing?.password ?? null)
          : this.seal(input.password),
      // Set on their own, in Settings; editing the connection keeps them.
      ...(existing?.permissions ? { permissions: existing.permissions } : {}),
    }
    this.stored = existing
      ? this.stored.map((item) => (item.id === next.id ? next : item))
      : [...this.stored, next]
    this.persist()
    this.drop(next.id)
    return Connections.publicView(next)
  }

  /** What may be done through it, beyond the access mode. Applies to the
   * driver already open: its guard reads them on every call. */
  setPermissions(id: string, permissions: Permissions): Connection {
    const stored = this.find(id)
    stored.permissions = checkPermissions(permissions)
    this.persist()
    return Connections.publicView(stored)
  }

  delete(id: string): void {
    this.stored = this.stored.filter((connection) => connection.id !== id)
    this.persist()
    this.drop(id)
  }

  private config(stored: Stored): ConnectionConfig {
    return {
      engine: stored.engine,
      host: stored.host,
      port: stored.port,
      user: stored.user,
      password: this.open(stored.password),
      database: stored.database,
      ssl: stored.ssl,
      cloudSql: stored.cloudSql ?? null,
      access: stored.access ?? "read_write",
      sources: stored.sources ?? [],
      cacheRoot: this.cacheRoot,
    }
  }

  /** Everything needed to reach the connection's server, password
   * included: for the gateway, which signs in as it. */
  serverConfig(id: string): ConnectionConfig {
    return this.config(this.find(id))
  }

  /** What this app lets anyone do through the connection. */
  access(id: string): AccessMode {
    return this.find(id).access ?? "read_write"
  }

  /** Throws, saying why, when the connection takes no writes. */
  assertWritable(id: string): void {
    const connection = this.find(id)
    if ((connection.access ?? "read_write") === "read_only") {
      throw new Error(
        `"${connection.name}" is read-only in Vey Lens, so nothing is written through it. Change its access in Settings › Permissions.`
      )
    }
  }

  /** Tries the settings in a dialog without saving them. */
  async test(id: string | null, input: ConnectionInput): Promise<string> {
    const existing = id ? this.find(id) : null
    const files = input.engine === "duckdb"
    const cloudSql = files ? null : cloudSqlOf(input, existing)
    const sources = sourcesOf(input, existing)
    validate(input, cloudSql, sources)
    const password = input.password ?? (existing ? this.open(existing.password) : "")
    const driver = this.create({ ...input, password, cloudSql, sources, cacheRoot: this.cacheRoot })
    try {
      return await driver.ping()
    } finally {
      await driver.close()
    }
  }

  private guards(id: string) {
    let open = this.drivers.get(id)
    if (!open) {
      const inner: Driver = this.create(this.config(this.find(id)))
      const policy = (): Policy => {
        const stored = this.find(id)
        return {
          name: stored.name,
          engine: stored.engine,
          database: stored.database,
          access: stored.access ?? "read_write",
          permissions: checkPermissions(stored.permissions),
        }
      }
      const views = new ViewSourceCache(inner)
      open = {
        inner,
        user: new GuardedDriver(inner, policy, views),
        assistant: new GuardedDriver(
          inner,
          () => {
            const current = policy()
            return { ...current, permissions: forAssistant(current.permissions) }
          },
          views
        ),
      }
      this.drivers.set(id, open)
    }
    return open
  }

  /** The connection's driver, behind its permissions. */
  driver(id: string): GuardedDriver {
    return this.guards(id).user
  }

  /** The same driver as the assistant meets it: what is marked structure
   * only for it is described, and its rows refused. */
  assistantDriver(id: string): GuardedDriver {
    return this.guards(id).assistant
  }

  /** Drops the open files connections, so the next use reads them again:
   * after the Google account they read sheets as has changed. */
  reopenFiles(): void {
    for (const stored of this.stored) if (stored.engine === "duckdb") this.drop(stored.id)
  }

  async closeAll(): Promise<void> {
    const open = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.all(open.map(({ inner }) => inner.close()))
  }
}
