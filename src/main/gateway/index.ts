import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"

import { AuthTypes, Connector } from "@google-cloud/cloud-sql-connector"

import type { Engine, GatewaySettings, GatewayState } from "../../shared/api"
import type { Connections } from "../connections"
import { IP_TYPE, withHint } from "../db/cloud-sql"
import type { ConnectionConfig } from "../db/types"
import { serveMysql } from "./mysql"
import { cancelPostgres, servePostgres } from "./postgres"
import type { Gate, Target } from "./types"
import { within } from "./wire"

export type { Gate, Target } from "./types"
export { serveMysql } from "./mysql"
export { servePostgres } from "./postgres"

const ENGINES: Engine[] = ["postgres", "mysql"]
const ENGINE_NAME: Record<Engine, string> = { postgres: "PostgreSQL", mysql: "MySQL" }

/** How long reaching a server's port may take. */
const CONNECT_MS = 10_000

const newPassword = () => randomBytes(18).toString("base64url")

/** One app connection: which gateway it came in on, where it went. */
type Session = {
  gatewayId: string
  /** Null until it has signed in to the gateway. */
  connectionId: string | null
  target: Target | null
  app: net.Socket
  servers: Duplex[]
  /** Postgres: the server's key for it, for a cancel request. */
  key: { pid: number; key: Buffer } | null
}

type Listener = {
  port: number
  engine: Engine
  server: net.Server
  listening: boolean
  error: string | null
}

/** One gateway's settings as given, made sense of. Throws, saying what is
 * wrong. A connection that is gone, or of the other engine, is refused. */
export function checkGatewaySettings(
  input: GatewaySettings,
  engineOf: (connectionId: string) => Engine | null
): GatewaySettings {
  if (!ENGINES.includes(input.engine)) throw new Error("Pick PostgreSQL or MySQL.")
  const name = String(input.name ?? "").trim().slice(0, 40) || `${ENGINE_NAME[input.engine]} gateway`
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`"${name}": the port must be a number between 1024 and 65535.`)
  }
  const connections: string[] = []
  for (const id of input.connections ?? []) {
    if (connections.includes(id)) continue
    const engine = engineOf(id)
    if (!engine) throw new Error(`"${name}": one of its connections no longer exists.`)
    if (engine !== input.engine) {
      throw new Error(`"${name}" is a ${ENGINE_NAME[input.engine]} gateway; its connections must be too.`)
    }
    connections.push(id)
  }
  return {
    id: input.id || randomUUID(),
    name,
    engine: input.engine,
    port,
    enabled: input.enabled === true,
    connections,
    active: input.active && connections.includes(input.active) ? input.active : (connections[0] ?? null),
  }
}

/** Throws when two gateways would listen on one port. */
function checkPorts(gateways: GatewaySettings[]): void {
  const seen = new Map<number, string>()
  for (const gateway of gateways) {
    const other = seen.get(gateway.port)
    if (other !== undefined) throw new Error(`Port ${gateway.port} is already used by "${other}".`)
    seen.set(gateway.port, gateway.name)
  }
}

/**
 * The gateways: one port each on 127.0.0.1, going to the saved connection
 * picked in it.
 *
 * A switch closes the sessions open to the old connection — a pool that
 * keeps its sockets would otherwise go on talking to the old server — and
 * the app's pool opens new ones, which go to the new. Nothing of Vey Lens's
 * access modes or permissions applies here: the app signs in to the server
 * as the connection's database user, as it would with that in its `.env`.
 */
export class Gateway {
  private gateways: GatewaySettings[] = []
  private password = newPassword()
  /** Per gateway. */
  private readonly listeners = new Map<string, Listener>()
  private readonly sessions = new Set<Session>()
  /** Per connection on Cloud SQL: the connector, and its stream maker. */
  private readonly connectors = new Map<
    string,
    { key: string; connector: Connector; stream: Promise<() => Duplex> }
  >()
  private notifyTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    private readonly connections: Connections,
    private readonly notify: (state: GatewayState) => void,
    /** Swapped by a test for servers that need no network. */
    private readonly dial: ((config: ConnectionConfig) => Promise<Duplex>) | null = null
  ) {
    let current = false
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version?: number
        gateways?: GatewaySettings[]
        password?: string
      }
      if (typeof parsed.password === "string" && parsed.password) this.password = parsed.password
      // Settings from before gateways were this simple are not carried over;
      // the password is.
      if (parsed.version === 2) {
        current = true
        const engineOf = (id: string) => this.engineOf(id)
        for (const stored of parsed.gateways ?? []) {
          try {
            // A connection removed since is dropped, not fatal.
            const kept = (stored.connections ?? []).filter((id) => engineOf(id) === stored.engine)
            const gateway = checkGatewaySettings({ ...stored, connections: kept }, engineOf)
            checkPorts([...this.gateways, gateway])
            this.gateways.push(gateway)
          } catch {
            // One that no longer makes sense is left out; the rest load.
          }
        }
      }
    } catch {
      // No file yet, or one that cannot be read: no gateways.
    }
    if (!current) this.persist()
    this.reconcile()
  }

  private engineOf(connectionId: string): Engine | null {
    return this.connections.list().find((item) => item.id === connectionId)?.engine ?? null
  }

  private nameOf(connectionId: string | null): string | null {
    if (!connectionId) return null
    return this.connections.list().find((item) => item.id === connectionId)?.name ?? null
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(
      this.file,
      JSON.stringify({ version: 2, gateways: this.gateways, password: this.password }, null, 2),
      { mode: 0o600 }
    )
    chmodSync(this.file, 0o600)
  }

  private gateway(gatewayId: string): GatewaySettings {
    const gateway = this.gateways.find((item) => item.id === gatewayId)
    if (!gateway) throw new Error("That gateway no longer exists.")
    return gateway
  }

  state(): GatewayState {
    return {
      gateways: this.gateways,
      password: this.password,
      status: this.gateways.map((gateway) => {
        const listener = this.listeners.get(gateway.id)
        let sessions = 0
        for (const session of this.sessions) if (session.gatewayId === gateway.id) sessions++
        return {
          gatewayId: gateway.id,
          listening: listener?.listening ?? false,
          error: listener?.error ?? null,
          sessions,
        }
      }),
    }
  }

  /** Tells the renderer, once for a burst of changes. */
  private changed(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify(this.state())
    }, 50)
  }

  /** Adds the gateway (an empty id) or replaces the one with its id. */
  save(input: GatewaySettings): GatewayState {
    if (input.id) this.gateway(input.id)
    const next = checkGatewaySettings(input, (id) => this.engineOf(id))
    const gateways = input.id
      ? this.gateways.map((item) => (item.id === next.id ? next : item))
      : [...this.gateways, next]
    checkPorts(gateways)
    this.gateways = gateways
    this.persist()
    this.dropMoved()
    this.reconcile()
    return this.state()
  }

  remove(gatewayId: string): GatewayState {
    this.gateway(gatewayId)
    this.gateways = this.gateways.filter((item) => item.id !== gatewayId)
    this.persist()
    this.dropMoved()
    this.reconcile()
    return this.state()
  }

  switchTo(gatewayId: string, connectionId: string): GatewayState {
    const gateway = this.gateway(gatewayId)
    if (!gateway.connections.includes(connectionId)) {
      throw new Error(`That connection is not in "${gateway.name}".`)
    }
    this.gateways = this.gateways.map((item) =>
      item.id === gatewayId ? { ...item, active: connectionId } : item
    )
    this.persist()
    this.dropMoved()
    this.changed()
    return this.state()
  }

  /** A new password. Every app connection open is closed: what signed in
   * with the old one keeps no access, and the app's pool must sign in again
   * with the new. */
  resetPassword(): GatewayState {
    this.password = newPassword()
    this.persist()
    for (const session of this.sessions) this.end(session)
    this.changed()
    return this.state()
  }

  /** "Name (:port) → connection", for the audit log. */
  describe(gatewayId: string): string {
    const gateway = this.gateways.find((item) => item.id === gatewayId)
    if (!gateway) return ""
    return `${gateway.name} (:${gateway.port}) → ${this.nameOf(gateway.active) ?? "nothing"}`
  }

  /** The name of a saved connection, for the audit log. */
  connectionName(connectionId: string | null): string {
    return this.nameOf(connectionId) ?? "nothing"
  }

  /** Closes the sessions whose gateway is gone or now goes elsewhere. A port
   * moved is `reconcile`'s. */
  private dropMoved(): void {
    for (const session of this.sessions) {
      if (!session.connectionId) continue
      const gateway = this.gateways.find((item) => item.id === session.gatewayId)
      if (!gateway || gateway.active !== session.connectionId) this.end(session)
    }
    this.dropConnectors()
  }

  private end(session: Session): void {
    session.app.destroy()
    for (const server of session.servers) server.destroy()
  }

  /** Listens on the ports of the gateways that are on, and on no others. */
  private reconcile(): void {
    const wanted = this.gateways.filter((gateway) => gateway.enabled)
    for (const [id, listener] of this.listeners) {
      const gateway = wanted.find((item) => item.id === id)
      if (gateway && gateway.port === listener.port && gateway.engine === listener.engine) continue
      listener.server.close()
      this.listeners.delete(id)
      for (const session of this.sessions) if (session.gatewayId === id) this.end(session)
    }
    for (const gateway of wanted) {
      if (!this.listeners.has(gateway.id)) this.listen(gateway)
    }
    this.changed()
  }

  private listen(gateway: GatewaySettings): void {
    const server = net.createServer((socket) => this.accept(gateway.id, socket))
    const listener: Listener = {
      port: gateway.port,
      engine: gateway.engine,
      server,
      listening: false,
      error: null,
    }
    server.on("listening", () => {
      listener.listening = true
      listener.error = null
      this.changed()
    })
    server.on("error", (error: NodeJS.ErrnoException) => {
      listener.listening = false
      listener.error =
        error.code === "EADDRINUSE"
          ? `Port ${gateway.port} is already in use on this machine.`
          : error.code === "EACCES" || error.code === "EPERM"
            ? `Not allowed to listen on port ${gateway.port}.`
            : error.message
      this.changed()
    })
    server.listen({ host: "127.0.0.1", port: gateway.port })
    this.listeners.set(gateway.id, listener)
  }

  /** An app connection on a gateway's port. A test hands in a stream of its
   * own. */
  accept(gatewayId: string, app: net.Socket): void {
    const engine = this.gateways.find((item) => item.id === gatewayId)?.engine
    if (!engine) {
      app.destroy()
      return
    }
    app.setNoDelay(true)
    // A reset ends the session; it is no error of this process.
    app.on("error", () => {})
    const session: Session = {
      gatewayId,
      connectionId: null,
      target: null,
      app,
      servers: [],
      key: null,
    }
    this.sessions.add(session)
    app.once("close", () => {
      this.sessions.delete(session)
      for (const server of session.servers) server.destroy()
      this.changed()
    })
    this.changed()
    const gate: Gate = {
      password: () => this.password,
      target: () => {
        const target = this.target(gatewayId)
        session.connectionId = target.connectionId
        session.target = target
        return target
      },
      attached: (server) => {
        session.servers.push(server)
        server.on("error", () => {})
        server.once("close", () => app.destroy())
        if (app.destroyed) server.destroy()
      },
      keyed: (pid, key) => {
        session.key = { pid, key }
      },
      cancel: (pid, key) => this.cancel(pid, key),
    }
    void (engine === "mysql" ? serveMysql(app, gate) : servePostgres(app, gate))
  }

  private target(gatewayId: string): Target & { connectionId: string } {
    const gateway = this.gateways.find((item) => item.id === gatewayId)
    if (!gateway) throw new Error("This gateway has been removed in Vey Lens.")
    const connectionId = gateway.active
    if (!connectionId) {
      throw new Error(
        `The gateway "${gateway.name}" has no connection yet: add one in Vey Lens › Settings › Gateways.`
      )
    }
    const connection = this.connections.get(connectionId)
    const config = this.connections.serverConfig(connectionId)
    if (config.engine !== gateway.engine) {
      throw new Error(`"${connection.name}" is not a ${ENGINE_NAME[gateway.engine]} connection.`)
    }
    return {
      connectionId,
      name: connection.name,
      config,
      secure: Boolean(config.cloudSql),
      open: () => this.open(connectionId, config),
    }
  }

  private async open(connectionId: string, config: ConnectionConfig): Promise<Duplex> {
    if (this.dial) return this.dial(config)
    if (config.cloudSql) {
      const stream = (await this.cloudSqlStream(connectionId, config))()
      stream.on("error", () => {})
      return stream
    }
    const socket = net.connect({ host: config.host, port: config.port })
    socket.on("error", () => {})
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    try {
      await within(once(socket, "connect"), CONNECT_MS, `${config.host}:${config.port} did not answer.`)
    } catch (error) {
      socket.destroy()
      throw error
    }
    return socket
  }

  private cloudSqlStream(connectionId: string, config: ConnectionConfig): Promise<() => Duplex> {
    const cloudSql = config.cloudSql!
    const key = JSON.stringify(cloudSql)
    const existing = this.connectors.get(connectionId)
    if (existing?.key === key) return existing.stream
    existing?.connector.close()
    const connector = new Connector()
    const stream = connector
      .getOptions({
        instanceConnectionName: cloudSql.instance,
        ipType: IP_TYPE[cloudSql.ipType],
        authType: cloudSql.auth === "iam" ? AuthTypes.IAM : AuthTypes.PASSWORD,
      })
      .then(
        ({ stream: make }) => make as () => Duplex,
        (error: unknown) => {
          if (this.connectors.get(connectionId)?.connector === connector) {
            this.connectors.delete(connectionId)
          }
          connector.close()
          throw withHint(error)
        }
      )
    this.connectors.set(connectionId, { key, connector, stream })
    return stream
  }

  /** Lets go of the Cloud SQL connectors no gateway goes to now. */
  private dropConnectors(): void {
    const used = new Set(this.gateways.map((gateway) => gateway.active).filter(Boolean))
    for (const session of this.sessions) if (session.connectionId) used.add(session.connectionId)
    for (const [id, entry] of this.connectors) {
      if (used.has(id)) continue
      entry.connector.close()
      this.connectors.delete(id)
    }
  }

  private cancel(pid: number, key: Buffer): void {
    for (const session of this.sessions) {
      if (session.key?.pid === pid && session.key.key.equals(key) && session.target) {
        void cancelPostgres(session.target, pid, key).catch(() => {})
        return
      }
    }
  }

  close(): void {
    for (const listener of this.listeners.values()) listener.server.close()
    this.listeners.clear()
    for (const session of this.sessions) this.end(session)
    for (const entry of this.connectors.values()) entry.connector.close()
    this.connectors.clear()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
  }
}
