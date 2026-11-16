/**
 * The gateway's two protocols end to end, without a socket: `pg` through the
 * gateway to the in-process sample Postgres, and `mysql2` through it to a
 * small MySQL server written here, which checks each way of signing in on
 * its own terms. `bun test/gateway.ts`.
 */
import assert from "node:assert/strict"
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"

import mysql from "mysql2/promise"
import pg from "pg"

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Connections } from "../src/main/connections"
import { checkGatewaySettings, Gateway } from "../src/main/gateway"
import { nativeToken, serveMysql, sha2Token } from "../src/main/gateway/mysql"
import { Scram, servePostgres } from "../src/main/gateway/postgres"
import type { Gate, Target } from "../src/main/gateway/types"
import { Reader, cstring } from "../src/main/gateway/wire"
import type { ConnectionConfig } from "../src/main/db/types"
import type { GatewaySettings } from "../src/shared/api"
import { openSamplePostgres, Wire } from "./sample-postgres"

let failed = 0
async function check(name: string, body: () => Promise<void> | void) {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve().then(body),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), 5_000)
      }),
    ]).finally(() => clearTimeout(timer))
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${(error as Error).stack}`)
  }
}

/** Two ends of an in-process connection. */
function pair(label = ""): [Wire, Wire] {
  const a = new Wire()
  const b = new Wire()
  if (process.env.TRACE && label) {
    a.on("data", (d: Buffer) => console.log(`${label} b→a`, d.toString("hex").slice(0, 120)))
    b.on("data", (d: Buffer) => console.log(`${label} a→b`, d.toString("hex").slice(0, 120)))
  }
  a.peer = b
  b.peer = a
  a.on("error", () => {})
  b.on("error", () => {})
  return [a, b]
}

const PASSWORD = "gateway-secret"

function gate(target: Target | (() => Target), extra: Partial<Gate> = {}): Gate {
  return {
    password: () => PASSWORD,
    target: typeof target === "function" ? target : () => target,
    attached: (server) => server.on("error", () => {}),
    ...extra,
  }
}

function config(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    engine: "postgres",
    host: "in-process",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "postgres",
    ssl: "off",
    ...overrides,
  }
}

// ── Postgres ──────────────────────────────────────────────────────────────

const sample = await openSamplePostgres()
const pgTarget: Target = {
  name: "sample",
  config: config({}),
  secure: false,
  open: async () => sample.stream(),
}

/** A `pg` client whose every connection goes through a gateway. */
function viaGateway(g: Gate, password = PASSWORD, database = "my_app_db") {
  return new pg.Client({
    user: "app_user",
    password,
    database,
    stream: () => {
      const [app, gateway] = pair()
      void servePostgres(gateway, g)
      return app as never
    },
  })
}

await check("postgres: the app signs in with the gateway's password and lands on the connection's database", async () => {
  let key: number | null = null
  const client = viaGateway(gate(pgTarget, { keyed: (pid) => (key = pid) }))
  await client.connect()
  const { rows } = await client.query("select current_database() as db, count(*)::int as n from orders")
  assert.equal(rows[0].db, "postgres")
  assert.ok(rows[0].n > 0)
  // Parameters go through the extended protocol untouched.
  const typed = await client.query("select $1::int + 1 as v", [41])
  assert.equal(typed.rows[0].v, 42)
  assert.equal(typeof key, "number")
  // The sample server does not close on Terminate, so this is not waited on.
  void client.end()
})

await check("postgres: a wrong password is refused before the server is reached", async () => {
  let opened = false
  const client = viaGateway(
    gate({ ...pgTarget, open: async () => ((opened = true), sample.stream()) }),
    "wrong"
  )
  await assert.rejects(client.connect(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "28P01")
    assert.match(error.message, /Settings › Gateway/)
    return true
  })
  assert.equal(opened, false)
})

await check("postgres: a route with nothing for the environment says so", async () => {
  const client = viaGateway(
    gate(() => {
      throw new Error(`"Main DB" has no connection for dev`)
    })
  )
  await assert.rejects(client.connect(), /no connection for dev/)
})

await check("postgres: a server that cannot be reached is named in the error", async () => {
  const client = viaGateway(
    gate({ ...pgTarget, name: "PG dev", open: async () => Promise.reject(new Error("ECONNREFUSED")) })
  )
  await assert.rejects(client.connect(), /Vey Lens gateway → "PG dev": ECONNREFUSED/)
})

await check("postgres: a pool reconnects after its sessions are cut, as a switch does", async () => {
  const servers: Duplex[] = []
  const g = gate(pgTarget, { attached: (server) => servers.push(server) })
  const pool = new pg.Pool({
    user: "app",
    password: PASSWORD,
    max: 1,
    stream: () => {
      const [app, gateway] = pair()
      void servePostgres(gateway, g)
      return app as never
    },
  })
  pool.on("error", () => {})
  assert.equal((await pool.query("select 1 as one")).rows[0].one, 1)
  for (const server of servers) server.destroy()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await pool.query("select 2 as two")).rows[0].two, 2)
  void pool.end()
})

await check("postgres: SCRAM-SHA-256 matches RFC 7677's example", async () => {
  const scram = new Scram("pencil", "rOprNGfwEbeRWgbNEkqO", "user")
  const first = scram.first()
  assert.match(first.toString("latin1"), /n,,n=user,r=rOprNGfwEbeRWgbNEkqO$/)
  const final = await scram.final(
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
  )
  assert.equal(
    final.subarray(5).toString(),
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
  )
  scram.check("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
  assert.throws(() => scram.check("v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), /signature/)
})

// ── MySQL ─────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url)
const mysql2Auth = require("../node_modules/mysql2/lib/auth_41.js") as {
  calculateToken(password: string, scramble1: Buffer, scramble2: Buffer): Buffer
}
/** mysql2's own mysql_native_password answer, the challenge in its two parts. */
const mysql2Native = (password: string, scramble: Buffer) =>
  mysql2Auth.calculateToken(password, scramble.subarray(0, 8), scramble.subarray(8))

const CAPS =
  1 | 4 | 8 | 512 | 2048 /* SSL, which the gateway must not offer */ | 8192 | 32768 |
  (1 << 16) | (1 << 17) | (1 << 19) | (1 << 21) | (1 << 24)

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString()

function mysqlPacket(seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = seq
  return Buffer.concat([header, payload])
}

async function readMysqlPacket(reader: Reader) {
  const header = await reader.take(4)
  return { seq: header[3]!, payload: await reader.take(header.readUIntLE(0, 3)) }
}

const ok = (affected: number) => Buffer.from([0, affected, 0, 2, 0, 0, 0])

type SignIn = "sha2-fast" | "sha2-full" | "switch-native"

/**
 * A MySQL server as far as signing in and answering `DO`: it greets with
 * caching_sha2_password and checks the answer as the spec says, then OKs
 * each query with the number of rows it says it changed.
 */
function fakeMysql(mode: SignIn, seen: { user?: string; database?: string; capabilities?: number }) {
  return async (): Promise<Duplex> => {
    const [gatewaySide, serverSide] = pair("server")
    const reader = new Reader(serverSide, "gateway")
    const nonce = Buffer.from(randomBytes(20).map((byte) => 0x21 + (byte % 94)))
    const sha256 = (...parts: Buffer[]) =>
      parts.reduce((hash, part) => hash.update(part), createHash("sha256")).digest()
    void (async () => {
      const greeting = Buffer.concat([
        Buffer.from([10]),
        Buffer.from("8.4.0-fake\0"),
        Buffer.from([7, 0, 0, 0]),
        nonce.subarray(0, 8),
        Buffer.from([0]),
        Buffer.from([CAPS & 0xff, (CAPS >> 8) & 0xff, 255, 2, 0, (CAPS >> 16) & 0xff, (CAPS >> 24) & 0xff, 21]),
        Buffer.alloc(10),
        nonce.subarray(8),
        Buffer.from([0]),
        Buffer.from("caching_sha2_password\0"),
      ])
      serverSide.write(mysqlPacket(0, greeting))
      const response = await readMysqlPacket(reader)
      const payload = response.payload
      seen.capabilities = payload.readUInt32LE(0)
      const [user, afterUser] = cstring(payload, 32)
      const authLength = payload[afterUser]!
      const token = payload.subarray(afterUser + 1, afterUser + 1 + authLength)
      const [database] = cstring(payload, afterUser + 1 + authLength)
      seen.user = user
      seen.database = database
      let seq = response.seq + 1
      const password = "server-pass"
      const refuse = () => serverSide.end(mysqlPacket(seq, Buffer.from("\xff\x15\x04#28000Access denied", "latin1")))

      if (mode === "sha2-fast") {
        const stage1 = sha256(Buffer.from(password))
        const expected = Buffer.from(stage1.map((b, i) => b ^ sha256(sha256(stage1), nonce)[i]!))
        if (!token.equals(expected)) return refuse()
        serverSide.write(mysqlPacket(seq++, Buffer.from([1, 3])))
      } else if (mode === "sha2-full") {
        serverSide.write(mysqlPacket(seq++, Buffer.from([1, 4])))
        const ask = await readMysqlPacket(reader)
        assert.deepEqual([...ask.payload], [2])
        seq = ask.seq + 1
        serverSide.write(mysqlPacket(seq++, Buffer.concat([Buffer.from([1]), Buffer.from(PEM)])))
        const sealed = await readMysqlPacket(reader)
        seq = sealed.seq + 1
        const opened = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
          sealed.payload
        )
        const plain = Buffer.from(opened.map((b, i) => b ^ nonce[i % nonce.length]!))
        if (plain.toString() !== `${password}\0`) return refuse()
      } else {
        const fresh = Buffer.from(randomBytes(20).map((byte) => 0x21 + (byte % 94)))
        serverSide.write(
          mysqlPacket(seq++, Buffer.concat([Buffer.from("\xfemysql_native_password\0", "latin1"), fresh, Buffer.from([0])]))
        )
        const reply = await readMysqlPacket(reader)
        seq = reply.seq + 1
        if (!reply.payload.equals(mysql2Native(password, fresh))) return refuse()
      }
      serverSide.write(mysqlPacket(seq, ok(0)))

      reader.release()
      const rest = new Reader(serverSide, "gateway")
      for (;;) {
        const command = await readMysqlPacket(rest).catch(() => null)
        if (!command || command.payload[0] === 1) return serverSide.end()
        const text = command.payload.subarray(1).toString()
        const affected = Number(/\d+/.exec(text)?.[0] ?? 0)
        serverSide.write(mysqlPacket(1, ok(affected)))
      }
    })().catch(() => serverSide.destroy())
    return gatewaySide
  }
}

function mysqlTarget(mode: SignIn, seen: Parameters<typeof fakeMysql>[1], database = "orders_dev"): Target {
  return {
    name: "MySQL dev",
    config: config({ engine: "mysql", user: "dev_user", password: "server-pass", database }),
    secure: false,
    open: fakeMysql(mode, seen),
  }
}

function mysqlViaGateway(target: Target, password = PASSWORD) {
  return mysql.createConnection({
    user: "app_user",
    password,
    database: "app_db",
    stream: () => {
      const [app, gateway] = pair("app")
      void serveMysql(gateway, gate(target))
      return app as never
    },
  })
}

for (const mode of ["sha2-fast", "sha2-full", "switch-native"] as const) {
  await check(`mysql: signs in to the server (${mode}) and passes queries through`, async () => {
    const seen: Parameters<typeof fakeMysql>[1] = {}
    const connection = await mysqlViaGateway(mysqlTarget(mode, seen))
    const [result] = await connection.query("DO 7")
    assert.equal((result as { affectedRows: number }).affectedRows, 7)
    const [again] = await connection.query("DO 3")
    assert.equal((again as { affectedRows: number }).affectedRows, 3)
    assert.equal(seen.user, "dev_user")
    assert.equal(seen.database, "orders_dev")
    // Not SSL: the server offered it, the gateway did not pass it on.
    assert.equal(seen.capabilities! & 2048, 0)
    await connection.end()
  })
}

await check("mysql: the app's database is used when the connection names none", async () => {
  const seen: Parameters<typeof fakeMysql>[1] = {}
  const connection = await mysqlViaGateway(mysqlTarget("sha2-fast", seen, ""))
  assert.equal(seen.database, "app_db")
  await connection.end()
})

await check("mysql: a wrong gateway password is refused as access denied", async () => {
  const seen: Parameters<typeof fakeMysql>[1] = {}
  await assert.rejects(
    mysqlViaGateway(mysqlTarget("sha2-fast", seen), "wrong"),
    (error: Error & { errno?: number }) => {
      assert.equal(error.errno, 1045)
      assert.match(error.message, /Settings › Gateway/)
      return true
    }
  )
  assert.equal(seen.user, undefined)
})

await check("mysql: the server refusing the saved password reaches the app", async () => {
  const target = mysqlTarget("sha2-fast", {})
  target.config = { ...target.config, password: "stale" }
  await assert.rejects(mysqlViaGateway(target), /Access denied/)
})

await check("mysql: the tokens match mysql2's own", () => {
  const scramble = randomBytes(20)
  assert.deepEqual(nativeToken("pw", scramble), mysql2Native("pw", scramble))
  const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()
  const stage1 = sha256(Buffer.from("pw"))
  const mask = sha256(Buffer.concat([sha256(stage1), scramble]))
  assert.deepEqual(sha2Token("pw", scramble), Buffer.from(stage1.map((b, i) => b ^ mask[i]!)))
})

// ── Settings ──────────────────────────────────────────────────────────────

await check("settings: a gateway is one engine, one port, and connections of that engine", () => {
  const engines: Record<string, "postgres" | "mysql"> = { pgLocal: "postgres", pgDev: "postgres", myDev: "mysql" }
  const engineOf = (id: string) => engines[id] ?? null
  const base: GatewaySettings = {
    id: "",
    name: " ",
    engine: "postgres",
    port: 15432,
    enabled: true,
    connections: ["pgLocal", "pgDev", "pgLocal"],
    active: "gone",
    password: "",
  }
  const settings = checkGatewaySettings(base, engineOf)
  assert.ok(settings.id)
  assert.equal(settings.name, "PostgreSQL gateway")
  assert.deepEqual(settings.connections, ["pgLocal", "pgDev"])
  // An active connection it does not hold falls back to its first.
  assert.equal(settings.active, "pgLocal")
  // No password given: one is made; one given is kept.
  assert.ok(settings.password.length >= 20)
  assert.equal(checkGatewaySettings({ ...base, password: "mine" }, engineOf).password, "mine")
  assert.equal(checkGatewaySettings({ ...base, active: "pgDev" }, engineOf).active, "pgDev")
  assert.equal(checkGatewaySettings({ ...base, connections: [], active: null }, engineOf).active, null)

  assert.throws(() => checkGatewaySettings({ ...base, connections: ["myDev"] }, engineOf), /PostgreSQL gateway; its connections must be too/)
  assert.throws(() => checkGatewaySettings({ ...base, connections: ["nope"] }, engineOf), /no longer exists/)
  assert.throws(() => checkGatewaySettings({ ...base, port: 80 }, engineOf), /between 1024 and 65535/)
})

// ── The gateway itself ────────────────────────────────────────────────────

/** Gateways over saved connections, dialling no network: each host they are
 * asked for is noted, and the sample Postgres answers. */
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "veylens-gateway-"))
  const connections = new Connections(path.join(dir, "connections.json"), {
    encrypt: () => null,
    decrypt: () => null,
  })
  const base = { port: 5432, user: "postgres", password: "postgres", database: "postgres", ssl: "off" as const }
  const save = (name: string, host: string, engine: "postgres" | "mysql" = "postgres") =>
    connections.save(null, { ...base, engine, name, host })
  const dialled: string[] = []
  const gateway = new Gateway(path.join(dir, "gateway.json"), connections, () => {}, async (target) => {
    dialled.push(target.host)
    return sample.stream()
  })
  const passwordOf = (gatewayId: string) =>
    gateway.state().gateways.find((item) => item.id === gatewayId)!.password
  /** A pool whose every connection comes in on the gateway, with its
   * password as it is now — as it would be in the app's .env. */
  const app = (gatewayId: string) => {
    const pool = new pg.Pool({
      user: "app",
      password: passwordOf(gatewayId),
      max: 1,
      stream: () => {
        const [appSide, gatewaySide] = pair()
        gateway.accept(gatewayId, gatewaySide as never)
        return appSide as never
      },
    })
    pool.on("error", () => {})
    return pool
  }
  const sessions = (gatewayId: string) =>
    gateway.state().status.find((status) => status.gatewayId === gatewayId)!.sessions
  const create = (settings: Partial<GatewaySettings>) => {
    const state = gateway.save({
      id: "",
      name: "",
      engine: "postgres",
      port: 15432,
      enabled: false,
      connections: [],
      active: null,
      password: "",
      ...settings,
    })
    return state.gateways.at(-1)!
  }
  return { dir, connections, save, dialled, gateway, app, sessions, create, passwordOf }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

await check("gateway: picking another connection closes the old sessions and the pool lands on the new", async () => {
  const { dir, connections, save, dialled, gateway, app, sessions, create } = harness()
  try {
    assert.deepEqual(gateway.state().gateways, [])
    const local = save("PG local", "local-host")
    const dev = save("PG dev", "dev-host")
    const staging = save("PG staging", "staging-host")
    const shop = create({ name: "Shop", connections: [local.id, dev.id, staging.id] })
    assert.equal(shop.active, local.id)
    const pool = app(shop.id)
    await pool.query("select 1")
    assert.deepEqual(dialled, ["local-host"])
    assert.equal(sessions(shop.id), 1)

    gateway.switchTo(shop.id, dev.id)
    await settle()
    assert.equal(sessions(shop.id), 0)
    await pool.query("select 1")
    gateway.switchTo(shop.id, staging.id)
    await settle()
    await pool.query("select 1")
    assert.deepEqual(dialled, ["local-host", "dev-host", "staging-host"])
    assert.equal(gateway.describe(shop.id), "Shop (:15432) → PG staging")
    assert.throws(() => gateway.switchTo(shop.id, "elsewhere"), /not in "Shop"/)

    // Taking the live connection out moves it to the first that is left.
    gateway.save({ ...gateway.state().gateways[0]!, connections: [dev.id, local.id] })
    await settle()
    assert.equal(gateway.state().gateways[0]!.active, dev.id)
    await pool.query("select 1")
    assert.equal(dialled.at(-1), "dev-host")

    // Kept across a restart, password included.
    const again = new Gateway(path.join(dir, "gateway.json"), connections, () => {})
    assert.equal(again.state().gateways.length, 1)
    assert.equal(again.state().gateways[0]!.active, dev.id)
    assert.equal(again.state().gateways[0]!.password, gateway.state().gateways[0]!.password)
    again.close()
    gateway.close()
    void pool.end()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check("gateway: an empty gateway says so; two gateways switch apart and never share a port", async () => {
  const { dir, save, dialled, gateway, app, sessions, create } = harness()
  try {
    const empty = create({ name: "Empty" })
    await assert.rejects(app(empty.id).query("select 1"), /has no connection yet/)
    gateway.remove(empty.id)

    const shopLocal = save("Shop local", "shop-local")
    const shopDev = save("Shop dev", "shop-dev")
    const billingLocal = save("Billing local", "billing-local")
    const billingDev = save("Billing dev", "billing-dev")
    const mysqlDev = save("MySQL dev", "mysql-dev", "mysql")
    const shop = create({ name: "Shop", port: 15432, connections: [shopLocal.id, shopDev.id] })
    const billing = create({ name: "Billing", port: 15433, connections: [billingLocal.id, billingDev.id] })
    const shopApp = app(shop.id)
    const billingApp = app(billing.id)
    await shopApp.query("select 1")
    await billingApp.query("select 1")

    gateway.switchTo(shop.id, shopDev.id)
    await settle()
    assert.equal(sessions(shop.id), 0)
    assert.equal(sessions(billing.id), 1)
    await shopApp.query("select 1")
    await billingApp.query("select 1")
    assert.deepEqual(dialled, ["shop-local", "billing-local", "shop-dev"])

    assert.throws(() => create({ name: "Clash", port: 15432 }), /Port 15432 is already used by "Shop"/)
    assert.throws(
      () => gateway.save({ ...gateway.state().gateways[0]!, connections: [shopLocal.id, mysqlDev.id] }),
      /its connections must be too/
    )

    // Deleting one closes its sessions and leaves the other alone.
    gateway.remove(billing.id)
    await settle()
    assert.deepEqual(gateway.state().gateways.map((item) => item.name), ["Shop"])
    assert.equal(sessions(shop.id), 1)
    await assert.rejects(billingApp.query("select 1"))
    gateway.close()
    void shopApp.end()
    void billingApp.end()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check("gateway: each has its own password; a new one closes only its connections", async () => {
  const { dir, save, gateway, app, sessions, create, passwordOf } = harness()
  try {
    const shopDb = save("Shop local", "shop-host")
    const billingDb = save("Billing local", "billing-host")
    const shop = create({ name: "Shop", port: 15432, connections: [shopDb.id] })
    const billing = create({ name: "Billing", port: 15433, connections: [billingDb.id] })
    assert.notEqual(shop.password, billing.password)

    // One gateway's password does not open another.
    const wrongDoor = new pg.Pool({
      user: "app",
      password: billing.password,
      max: 1,
      stream: () => {
        const [appSide, gatewaySide] = pair()
        gateway.accept(shop.id, gatewaySide as never)
        return appSide as never
      },
    })
    wrongDoor.on("error", () => {})
    await assert.rejects(wrongDoor.query("select 1"), /password authentication failed/)

    const shopApp = app(shop.id)
    const billingApp = app(billing.id)
    await shopApp.query("select 1")
    await billingApp.query("select 1")

    gateway.resetPassword(shop.id)
    await settle()
    assert.notEqual(passwordOf(shop.id), shop.password)
    assert.equal(passwordOf(billing.id), billing.password)
    assert.equal(sessions(shop.id), 0)
    assert.equal(sessions(billing.id), 1)
    // Shop's app still has the old password: refused. Billing carries on.
    await assert.rejects(shopApp.query("select 1"), (error: Error & { code?: string }) => {
      assert.equal(error.code, "28P01")
      return true
    })
    await billingApp.query("select 1")
    // With the new one in its .env, Shop's app is let in.
    const fresh = app(shop.id)
    await fresh.query("select 1")
    gateway.close()
    for (const pool of [wrongDoor, shopApp, billingApp, fresh]) void pool.end()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check("gateway: the shared password of version 2 becomes each gateway's own", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "veylens-gateway-"))
  try {
    const connections = new Connections(path.join(dir, "connections.json"), {
      encrypt: () => null,
      decrypt: () => null,
    })
    const local = connections.save(null, {
      engine: "mysql", name: "My local", host: "h", port: 3306, user: "u", password: "p", database: "d", ssl: "off",
    })
    writeFileSync(
      path.join(dir, "gateway.json"),
      JSON.stringify({
        version: 2,
        password: "shared-before",
        gateways: [
          { id: "a", name: "A", engine: "mysql", port: 13306, enabled: false, connections: [local.id], active: local.id },
          { id: "b", name: "B", engine: "postgres", port: 15432, enabled: false, connections: [], active: null },
        ],
      })
    )
    const gateway = new Gateway(path.join(dir, "gateway.json"), connections, () => {})
    assert.deepEqual(gateway.state().gateways.map((item) => item.password), ["shared-before", "shared-before"])
    gateway.close()
    const written = JSON.parse(readFileSync(path.join(dir, "gateway.json"), "utf8"))
    assert.equal(written.version, 3)
    assert.equal(written.password, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check("gateway: settings from before version 2 are dropped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "veylens-gateway-"))
  try {
    writeFileSync(
      path.join(dir, "gateway.json"),
      JSON.stringify({ password: "old", settings: { enabled: true, environments: ["local"], active: "local", routes: [] } })
    )
    const connections = new Connections(path.join(dir, "connections.json"), {
      encrypt: () => null,
      decrypt: () => null,
    })
    const gateway = new Gateway(path.join(dir, "gateway.json"), connections, () => {})
    assert.deepEqual(gateway.state().gateways, [])
    gateway.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await sample.close()
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log("\nall passed")
process.exit(0)
