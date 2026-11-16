import { constants, createHash, publicEncrypt, randomBytes, timingSafeEqual } from "node:crypto"
import type { Duplex } from "node:stream"

import { HANDSHAKE_MS, type Gate, type Target } from "./types"
import { Reader, cstring, join, messageOf, upgrade, within } from "./wire"

/**
 * The gateway's MySQL side.
 *
 * The server is reached first, so that the greeting the app gets is the
 * server's own — its version, connection id, character set and abilities —
 * with the gateway's challenge and without SSL or compression. The app signs
 * in with the gateway's password; the gateway then signs in to the server as
 * the saved connection with exactly the abilities the app chose (they decide
 * how every result is framed), and hands the server's OK to the app. From
 * there, bytes go straight through.
 */

const CLIENT = {
  LONG_PASSWORD: 1,
  CONNECT_WITH_DB: 8,
  COMPRESS: 32,
  PROTOCOL_41: 512,
  SSL: 2048,
  SECURE_CONNECTION: 32768,
  PLUGIN_AUTH: 1 << 19,
  CONNECT_ATTRS: 1 << 20,
  PLUGIN_AUTH_LENENC: 1 << 21,
  ZSTD_COMPRESSION: 1 << 26,
  MULTI_FACTOR_AUTH: 1 << 28,
  SSL_VERIFY_SERVER_CERT: 1 << 30,
} as const

/** What the gateway never offers the app: it speaks plain TCP on this
 * machine, uncompressed, with one password. */
const NOT_OFFERED =
  CLIENT.SSL |
  CLIENT.COMPRESS |
  CLIENT.ZSTD_COMPRESSION |
  CLIENT.MULTI_FACTOR_AUTH |
  CLIENT.SSL_VERIFY_SERVER_CERT

const NATIVE = "mysql_native_password"
const SHA2 = "caching_sha2_password"

type Packet = { seq: number; payload: Buffer }

async function readPacket(reader: Reader): Promise<Packet> {
  const header = await reader.take(4)
  const length = header.readUIntLE(0, 3)
  return { seq: header[3]!, payload: await reader.take(length) }
}

function packet(seq: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUIntLE(payload.length, 0, 3)
  header[3] = seq & 0xff
  return Buffer.concat([header, payload])
}

const u16 = (value: number) => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff)
  return buffer
}
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}
const cstr = (text: string) => Buffer.from(`${text}\0`, "utf8")

/** An ERR packet's payload. */
export function errPayload(code: number, state: string, text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff]), u16(code), Buffer.from(`#${state}${text}`, "utf8")])
}

/** What an ERR packet says. */
function errText(payload: Buffer): string {
  const code = payload.readUInt16LE(1)
  const text = payload.toString("utf8", payload[3] === 0x23 /* # */ ? 9 : 3)
  return `${text} (${code})`
}

function lenenc(buffer: Buffer, offset: number): [number, number] {
  const first = buffer[offset]!
  if (first < 0xfb) return [first, offset + 1]
  if (first === 0xfc) return [buffer.readUInt16LE(offset + 1), offset + 3]
  if (first === 0xfd) return [buffer.readUIntLE(offset + 1, 3), offset + 4]
  return [Number(buffer.readBigUInt64LE(offset + 1)), offset + 9]
}

const sha1 = (...parts: Buffer[]) => {
  const hash = createHash("sha1")
  for (const part of parts) hash.update(part)
  return hash.digest()
}
const sha256 = (...parts: Buffer[]) => {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest()
}
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, index) => byte ^ b[index % b.length]!))

/** `mysql_native_password`'s answer to a challenge. */
export function nativeToken(password: string, scramble: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const stage1 = sha1(Buffer.from(password))
  return xor(stage1, sha1(scramble, sha1(stage1)))
}

/** `caching_sha2_password`'s first answer to a challenge. */
export function sha2Token(password: string, scramble: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const stage1 = sha256(Buffer.from(password))
  return xor(stage1, sha256(sha256(stage1), scramble))
}

type Greeting = {
  version: string
  connectionId: number
  capabilities: number
  charset: number
  status: number
  /** The ten bytes after the challenge's length: MariaDB keeps its own
   * abilities in the last four. */
  reserved: Buffer
  scramble: Buffer
  plugin: string
}

function readGreeting(payload: Buffer): Greeting {
  if (payload[0] !== 10) throw new Error(`The server speaks MySQL protocol ${payload[0]}, not 10.`)
  let [version, offset] = cstring(payload, 1)
  const connectionId = payload.readUInt32LE(offset)
  offset += 4
  const part1 = payload.subarray(offset, offset + 8)
  offset += 9
  const low = payload.readUInt16LE(offset)
  offset += 2
  const charset = payload[offset]!
  const status = payload.readUInt16LE(offset + 1)
  const high = payload.readUInt16LE(offset + 3)
  const scrambleLength = payload[offset + 5]!
  const reserved = Buffer.from(payload.subarray(offset + 6, offset + 16))
  offset += 16
  const capabilities = (low | (high << 16)) >>> 0
  let part2: Buffer = Buffer.alloc(0)
  if (capabilities & CLIENT.SECURE_CONNECTION) {
    const length = Math.max(13, scrambleLength - 8)
    part2 = payload.subarray(offset, offset + length)
    offset += length
    if (part2.at(-1) === 0) part2 = part2.subarray(0, -1)
  }
  const plugin = capabilities & CLIENT.PLUGIN_AUTH ? cstring(payload, offset)[0] : NATIVE
  if (!(capabilities & CLIENT.PROTOCOL_41)) throw new Error("The server is older than MySQL 4.1.")
  return {
    version,
    connectionId,
    capabilities,
    charset,
    status,
    reserved,
    scramble: Buffer.concat([part1, part2]),
    plugin: plugin || NATIVE,
  }
}

/** The greeting the app gets: the server's, with the gateway's challenge. */
function greetingFor(server: Greeting, offered: number, scramble: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([10]),
    cstr(server.version),
    u32(server.connectionId),
    scramble.subarray(0, 8),
    Buffer.from([0]),
    u16(offered),
    Buffer.from([server.charset]),
    u16(server.status),
    u16(offered >>> 16),
    Buffer.from([scramble.length + 1]),
    server.reserved,
    scramble.subarray(8),
    Buffer.from([0]),
    cstr(SHA2),
  ])
}

type Response = {
  seq: number
  capabilities: number
  maxPacket: number
  charset: number
  /** The 23 bytes after the character set: MariaDB's abilities are in the
   * last four. */
  filler: Buffer
  user: string
  auth: Buffer
  database: string
  plugin: string
}

function readResponse({ seq, payload }: Packet): Response | "ssl" {
  const capabilities = payload.readUInt32LE(0)
  if (!(capabilities & CLIENT.PROTOCOL_41)) throw new Error("The app's MySQL client is older than 4.1.")
  if (payload.length <= 32 && capabilities & CLIENT.SSL) return "ssl"
  let [user, offset] = cstring(payload, 32)
  let auth: Buffer
  if (capabilities & CLIENT.PLUGIN_AUTH_LENENC) {
    const [length, next] = lenenc(payload, offset)
    auth = payload.subarray(next, next + length)
    offset = next + length
  } else if (capabilities & CLIENT.SECURE_CONNECTION) {
    const length = payload[offset]!
    auth = payload.subarray(offset + 1, offset + 1 + length)
    offset += 1 + length
  } else {
    const end = payload.indexOf(0, offset)
    auth = payload.subarray(offset, end < 0 ? payload.length : end)
    offset = end < 0 ? payload.length : end + 1
  }
  let database = ""
  if (capabilities & CLIENT.CONNECT_WITH_DB && offset < payload.length) {
    ;[database, offset] = cstring(payload, offset)
  }
  const plugin =
    capabilities & CLIENT.PLUGIN_AUTH && offset < payload.length ? cstring(payload, offset)[0] : ""
  return {
    seq,
    capabilities,
    maxPacket: payload.readUInt32LE(4),
    charset: payload[8]!,
    filler: Buffer.from(payload.subarray(9, 32)),
    user,
    auth: Buffer.from(auth),
    database,
    plugin: plugin || NATIVE,
  }
}

/** A challenge of printable bytes, as the server makes one. */
function newScramble(): Buffer {
  return Buffer.from(randomBytes(20).map((byte) => 0x21 + (byte % 94)))
}

/** The answer a plugin wants, to a challenge or to "send it in full". */
function answer(plugin: string, password: string, scramble: Buffer, secure: boolean): Buffer {
  switch (plugin) {
    case NATIVE:
      return nativeToken(password, scramble)
    case SHA2:
      return sha2Token(password, scramble)
    case "sha256_password":
      // Encrypted: the password itself. Otherwise ask for the server's key.
      return !password ? Buffer.from([0]) : secure ? cstr(password) : Buffer.from([1])
    case "mysql_clear_password":
      if (!secure) {
        throw new Error("The server wants the password in clear text over an unencrypted connection; turn on SSL for the connection.")
      }
      return cstr(password)
    default:
      throw new Error(`The server signs in with ${plugin}, which the gateway cannot do.`)
  }
}

/** A failure the server itself sent, passed to the app. */
class ServerRefused extends Error {
  constructor(readonly payload: Buffer) {
    super(errText(payload))
  }
}

/**
 * Signs in to the server, whose greeting has been read, as the saved
 * connection — with the abilities, character set and packet size the app
 * chose. Resolves with the server's OK and what it sent past it.
 */
async function signIn(
  target: Target,
  stream: Duplex,
  reader: Reader,
  greeting: Greeting,
  app: Response
): Promise<{ stream: Duplex; reader: Reader; ok: Buffer }> {
  const { config } = target
  const tlsWanted = !target.secure && config.ssl !== "off"
  const database = config.database || app.database
  let flags = (app.capabilities & greeting.capabilities) >>> 0
  flags &= ~(CLIENT.CONNECT_ATTRS | CLIENT.CONNECT_WITH_DB | NOT_OFFERED | CLIENT.PLUGIN_AUTH_LENENC)
  flags |= CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH
  if (greeting.capabilities & CLIENT.PLUGIN_AUTH_LENENC) flags |= CLIENT.PLUGIN_AUTH_LENENC
  if (database) flags |= CLIENT.CONNECT_WITH_DB

  let seq = 1
  const head = (withFlags: number) =>
    Buffer.concat([u32(withFlags), u32(app.maxPacket), Buffer.from([app.charset]), app.filler])

  if (tlsWanted) {
    if (!(greeting.capabilities & CLIENT.SSL)) {
      throw new Error(`The server does not take SSL connections; set SSL to Off on "${target.name}" in Vey Lens.`)
    }
    flags |= CLIENT.SSL
    stream.write(packet(seq++, head(flags)))
    reader.release()
    stream = await upgrade(stream, config.host, config.ssl === "verify")
    reader = new Reader(stream, "server")
  }
  const secure = target.secure || tlsWanted

  let plugin = greeting.plugin
  let scramble = greeting.scramble
  const auth = answer(plugin, config.password, scramble, secure)
  const authLength =
    flags & CLIENT.PLUGIN_AUTH_LENENC
      ? auth.length < 0xfb
        ? Buffer.from([auth.length])
        : Buffer.concat([Buffer.from([0xfc]), u16(auth.length)])
      : Buffer.from([auth.length])
  stream.write(
    packet(
      seq,
      Buffer.concat([
        head(flags),
        cstr(config.user),
        authLength,
        auth,
        database ? cstr(database) : Buffer.alloc(0),
        cstr(plugin),
      ])
    )
  )

  for (;;) {
    const reply = await readPacket(reader)
    seq = reply.seq + 1
    const { payload } = reply
    const kind = payload[0]
    if (kind === 0x00) return { stream, reader, ok: payload }
    if (kind === 0xff) throw new ServerRefused(payload)
    if (kind === 0xfe) {
      // Switch to another plugin, with a challenge of its own.
      const [next, offset] = cstring(payload, 1)
      plugin = next
      scramble = payload.subarray(offset)
      if (scramble.at(-1) === 0) scramble = scramble.subarray(0, -1)
      stream.write(packet(seq, answer(plugin, config.password, scramble, secure)))
      continue
    }
    if (kind === 0x01) {
      const more = payload.subarray(1)
      if (more.length === 1 && more[0] === 3) continue // cached: the OK follows
      if (more.length === 1 && more[0] === 4) {
        // A full sign-in: the password itself, encrypted by TLS or by the
        // server's key, asked for with 2.
        stream.write(packet(seq, secure ? cstr(config.password) : Buffer.from([2])))
        continue
      }
      if (more.toString("latin1").startsWith("-----BEGIN")) {
        const encrypted = publicEncrypt(
          { key: more.toString("latin1"), padding: constants.RSA_PKCS1_OAEP_PADDING },
          xor(cstr(config.password), scramble)
        )
        stream.write(packet(seq, encrypted))
        continue
      }
    }
    throw new Error(`The server sent an answer the gateway does not understand while signing in (${kind}).`)
  }
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/** One app connection, from its first byte to the pipe. */
export async function serveMysql(app: Duplex, gate: Gate): Promise<void> {
  const fail = (seq: number, text: string, code = 1105, state = "HY000") =>
    app.end(packet(seq, errPayload(code, state, text)))

  let target: Target
  try {
    target = gate.target()
  } catch (error) {
    fail(0, messageOf(error))
    return
  }

  let server: Duplex
  try {
    server = await within(target.open(), HANDSHAKE_MS, `"${target.name}" took too long to answer.`)
  } catch (error) {
    fail(0, `Vey Lens gateway → "${target.name}": ${messageOf(error)}`, 2003)
    return
  }
  gate.attached(server)
  const serverReader = new Reader(server, "server")
  const appReader = new Reader(app, "app")

  try {
    const first = await within(readPacket(serverReader), HANDSHAKE_MS, `"${target.name}" took too long to greet.`)
    if (first.payload[0] === 0xff) {
      app.end(packet(0, first.payload))
      server.destroy()
      return
    }
    const greeting = readGreeting(first.payload)
    const offered =
      ((greeting.capabilities & ~NOT_OFFERED) |
        CLIENT.PROTOCOL_41 |
        CLIENT.SECURE_CONNECTION |
        CLIENT.PLUGIN_AUTH |
        CLIENT.PLUGIN_AUTH_LENENC) >>>
      0
    const scramble = newScramble()
    app.write(packet(0, greetingFor(greeting, offered, scramble)))

    const response = readResponse(
      await within(readPacket(appReader), HANDSHAKE_MS, "The app took too long to sign in.")
    )
    if (response === "ssl") {
      fail(2, "The Vey Lens gateway speaks plain TCP on this machine: turn SSL off in the app's database settings (the gateway encrypts the server's side itself).", 2026, "HY000")
      server.destroy()
      return
    }
    let seq = response.seq
    let plugin = response.plugin
    let given = response.auth
    if (plugin !== NATIVE && plugin !== SHA2) {
      app.write(packet(++seq, Buffer.concat([Buffer.from([0xfe]), cstr(SHA2), scramble, Buffer.from([0])])))
      const reply = await within(readPacket(appReader), HANDSHAKE_MS, "The app took too long to sign in.")
      seq = reply.seq
      given = reply.payload
      plugin = SHA2
    }
    const expected =
      plugin === NATIVE ? nativeToken(gate.password(), scramble) : sha2Token(gate.password(), scramble)
    if (!sameBytes(given, expected)) {
      fail(
        seq + 1,
        `Access denied for user '${response.user}'@'localhost' (using password: ${given.length ? "YES" : "NO"}) — the Vey Lens gateway's password is in Settings › Gateway`,
        1045,
        "28000"
      )
      server.destroy()
      return
    }
    // The gateway knows the password, so the "cached" path always holds.
    if (plugin === SHA2) app.write(packet(++seq, Buffer.from([1, 3])))

    let signedIn: { stream: Duplex; reader: Reader; ok: Buffer }
    try {
      signedIn = await within(
        signIn(target, server, serverReader, greeting, response),
        HANDSHAKE_MS,
        `"${target.name}" took too long to sign in.`
      )
    } catch (error) {
      if (error instanceof ServerRefused) app.end(packet(seq + 1, error.payload))
      else fail(seq + 1, `Vey Lens gateway → "${target.name}": ${messageOf(error)}`)
      server.destroy()
      return
    }
    if (signedIn.stream !== server) gate.attached(signedIn.stream)
    app.write(packet(seq + 1, signedIn.ok))
    join(app, appReader.release(), signedIn.stream, signedIn.reader.release())
  } catch {
    app.destroy()
    server.destroy()
  }
}
