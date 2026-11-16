import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto"
import type { Duplex } from "node:stream"
import { promisify } from "node:util"

import { HANDSHAKE_MS, type Gate, type Target } from "./types"
import { Reader, cstring, join, messageOf, samePassword, upgrade, within } from "./wire"

/**
 * The gateway's Postgres side. The app signs in to the gateway with the
 * gateway's password (asked for in clear text: it never leaves this machine),
 * and the gateway signs in to the server as the saved connection — its user,
 * password, database and SSL, cleartext, MD5 or SCRAM as the server asks.
 * Once the server says the session is ready, bytes go straight through.
 */

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const CANCEL_REQUEST = 80877102
const PROTOCOL_3_0 = 196608

const pbkdf2Async = promisify(pbkdf2)

/** A message: its type byte, then its length (itself included), then body. */
function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5)
  header.write(type, 0, "latin1")
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

const int32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value)
  return buffer
}

const cstr = (text: string) => Buffer.from(`${text}\0`, "utf8")

const authentication = (code: number, extra: Buffer = Buffer.alloc(0)) =>
  message("R", Buffer.concat([int32(code), extra]))

/** A FATAL ErrorResponse, as the server sends one. */
export function fatal(code: string, text: string): Buffer {
  return message(
    "E",
    Buffer.concat([
      cstr("SFATAL"),
      cstr("VFATAL"),
      cstr(`C${code}`),
      cstr(`M${text}`),
      Buffer.from([0]),
    ])
  )
}

type Message = { type: string; body: Buffer; raw: Buffer }

async function readMessage(reader: Reader): Promise<Message> {
  const header = await reader.take(5)
  const length = header.readInt32BE(1)
  if (length < 4 || length > 64 * 1024 * 1024) {
    throw new Error("That does not look like the Postgres protocol.")
  }
  const body = await reader.take(length - 4)
  return {
    type: String.fromCharCode(header[0]!),
    body,
    raw: Buffer.concat([header, body]),
  }
}

/** What an ErrorResponse says: its message, and its SQLSTATE. */
function errorText(body: Buffer): string {
  let offset = 0
  let text = ""
  let code = ""
  while (offset < body.length && body[offset] !== 0) {
    const field = String.fromCharCode(body[offset]!)
    const [value, next] = cstring(body, offset + 1)
    if (field === "M") text = value
    if (field === "C") code = value
    offset = next
  }
  return code ? `${text} (${code})` : text
}

type Startup = { minor: number; params: Map<string, string> }

/** The app's opening: SSL and GSS requests turned down, a cancel request
 * passed on, and the startup message read. Null for a cancel. */
async function readStartup(app: Duplex, reader: Reader, gate: Gate): Promise<Startup | null> {
  for (;;) {
    const length = (await reader.take(4)).readInt32BE(0)
    if (length < 8 || length > 10_000) {
      throw new Error("That does not look like the Postgres protocol.")
    }
    const body = await reader.take(length - 4)
    const code = body.readInt32BE(0)
    if (code === SSL_REQUEST || code === GSS_REQUEST) {
      // Plain TCP on this machine; the server's end is encrypted as the
      // connection says.
      app.write("N")
      continue
    }
    if (code === CANCEL_REQUEST) {
      gate.cancel?.(body.readInt32BE(4), Buffer.from(body.subarray(8)))
      return null
    }
    if (code >> 16 !== 3) {
      app.write(fatal("08P01", `The gateway speaks protocol 3, not ${code >> 16}.`))
      return null
    }
    const params = new Map<string, string>()
    let offset = 4
    while (offset < body.length && body[offset] !== 0) {
      const [key, afterKey] = cstring(body, offset)
      const [value, afterValue] = cstring(body, afterKey)
      params.set(key, value)
      offset = afterValue
    }
    return { minor: code & 0xffff, params }
  }
}

/** The server's stream with SSL settled as the connection says. */
async function openServer(target: Target): Promise<{ stream: Duplex; reader: Reader }> {
  let stream = await target.open()
  let reader = new Reader(stream, "server")
  if (!target.secure && target.config.ssl !== "off") {
    stream.write(Buffer.concat([int32(8), int32(SSL_REQUEST)]))
    const [answer] = await reader.take(1)
    if (answer !== 0x53 /* S */) {
      stream.destroy()
      throw new Error(
        `The server does not take SSL connections; set SSL to Off on "${target.name}" in Vey Lens.`
      )
    }
    reader.release()
    stream = await upgrade(stream, target.config.host, target.config.ssl === "verify")
    reader = new Reader(stream, "server")
  }
  return { stream, reader }
}

/** Asks the server to cancel what the session with this key is running. */
export async function cancelPostgres(target: Target, pid: number, key: Buffer): Promise<void> {
  const { stream } = await openServer(target)
  stream.end(Buffer.concat([int32(12 + key.length), int32(CANCEL_REQUEST), int32(pid), key]))
}

const md5 = (data: Buffer | string) => createHash("md5").update(data).digest("hex")
const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest()

/** SCRAM-SHA-256 without channel binding, as RFC 7677 and Postgres have it.
 * Postgres takes the user from the startup message, so it is `*` here; the
 * nonce and user are only given by a test. */
export class Scram {
  private readonly firstBare: string
  private serverSignature: Buffer | null = null

  constructor(
    private readonly password: string,
    private readonly nonce = randomBytes(18).toString("base64"),
    user = "*"
  ) {
    this.firstBare = `n=${user},r=${nonce}`
  }

  first(): Buffer {
    const text = Buffer.from(`n,,${this.firstBare}`)
    return message(
      "p",
      Buffer.concat([cstr("SCRAM-SHA-256"), int32(text.length), text])
    )
  }

  async final(serverFirst: string): Promise<Buffer> {
    const fields = new Map(
      serverFirst.split(",").map((part) => [part[0], part.slice(2)] as const)
    )
    const nonce = fields.get("r") ?? ""
    const salt = Buffer.from(fields.get("s") ?? "", "base64")
    const iterations = Number(fields.get("i"))
    if (!nonce.startsWith(this.nonce) || !salt.length || !(iterations > 0)) {
      throw new Error("The server's SCRAM challenge does not make sense.")
    }
    const salted = await pbkdf2Async(this.password.normalize("NFKC"), salt, iterations, 32, "sha256")
    const clientKey = hmac(salted, "Client Key")
    const storedKey = createHash("sha256").update(clientKey).digest()
    const withoutProof = `c=biws,r=${nonce}`
    const authMessage = `${this.firstBare},${serverFirst},${withoutProof}`
    const signature = hmac(storedKey, authMessage)
    const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]!))
    this.serverSignature = hmac(hmac(salted, "Server Key"), authMessage)
    return message("p", Buffer.from(`${withoutProof},p=${proof.toString("base64")}`))
  }

  check(serverFinal: string): void {
    const verifier = Buffer.from(serverFinal.replace(/^v=/, "").split(",")[0] ?? "", "base64")
    if (
      !this.serverSignature ||
      verifier.length !== this.serverSignature.length ||
      !timingSafeEqual(verifier, this.serverSignature)
    ) {
      throw new Error("The server's SCRAM signature is wrong: it may not be the server it says.")
    }
  }
}

/** A failure the server itself sent, passed to the app as it came. */
class ServerRefused extends Error {
  constructor(readonly raw: Buffer, text: string) {
    super(text)
  }
}

/**
 * Signs in to the server as the saved connection, with what the app asked
 * for beyond the user and database. Resolves once the server has said the
 * authentication went through.
 */
async function signIn(
  target: Target,
  startup: Startup
): Promise<{ stream: Duplex; reader: Reader }> {
  const { config } = target
  const { stream, reader } = await openServer(target)
  const params = new Map<string, string>()
  for (const [key, value] of startup.params) {
    if (key === "user" || key === "database" || key === "replication" || key.startsWith("_pq_.")) {
      continue
    }
    params.set(key, value)
  }
  params.set("user", config.user)
  params.set("database", config.database || startup.params.get("database") || config.user)
  if (!params.has("application_name")) params.set("application_name", "veylens-gateway")
  const body = Buffer.concat([
    int32(PROTOCOL_3_0),
    ...[...params].flatMap(([key, value]) => [cstr(key), cstr(value)]),
    Buffer.from([0]),
  ])
  stream.write(Buffer.concat([int32(body.length + 4), body]))

  let scram: Scram | null = null
  for (;;) {
    const { type, body: data, raw } = await readMessage(reader)
    if (type === "E") throw new ServerRefused(raw, errorText(data))
    if (type === "v" || type === "N") continue
    if (type !== "R") throw new Error(`The server sent "${type}" while signing in.`)
    const code = data.readInt32BE(0)
    if (code === 0) return { stream, reader }
    if (code === 3) {
      stream.write(message("p", cstr(config.password)))
    } else if (code === 5) {
      const salt = data.subarray(4, 8)
      const inner = md5(config.password + config.user)
      stream.write(message("p", cstr(`md5${md5(Buffer.concat([Buffer.from(inner), salt]))}`)))
    } else if (code === 10) {
      const mechanisms: string[] = []
      let offset = 4
      while (offset < data.length && data[offset] !== 0) {
        const [name, next] = cstring(data, offset)
        mechanisms.push(name)
        offset = next
      }
      if (!mechanisms.includes("SCRAM-SHA-256")) {
        throw new Error(`The server asks for ${mechanisms.join(", ")}, which the gateway cannot do.`)
      }
      scram = new Scram(config.password)
      stream.write(scram.first())
    } else if (code === 11 && scram) {
      stream.write(await scram.final(data.subarray(4).toString()))
    } else if (code === 12 && scram) {
      scram.check(data.subarray(4).toString())
    } else {
      throw new Error(`The server asks for an authentication the gateway cannot do (${code}).`)
    }
  }
}

/** One app connection, from its first byte to the pipe. */
export async function servePostgres(app: Duplex, gate: Gate): Promise<void> {
  const appReader = new Reader(app, "app")
  try {
    const startup = await within(
      readStartup(app, appReader, gate),
      HANDSHAKE_MS,
      "The app took too long to start."
    )
    if (!startup) {
      app.end()
      return
    }
    const unknown = [...startup.params.keys()].filter((key) => key.startsWith("_pq_."))
    if (startup.minor > 0 || unknown.length) {
      app.write(
        message(
          "v",
          Buffer.concat([int32(0), int32(unknown.length), ...unknown.map(cstr)])
        )
      )
    }

    app.write(authentication(3))
    const reply = await within(readMessage(appReader), HANDSHAKE_MS, "The app took too long to sign in.")
    const user = startup.params.get("user") ?? ""
    const [given] = reply.type === "p" ? cstring(reply.body, 0) : [""]
    if (!samePassword(given, gate.password())) {
      app.end(fatal("28P01", `password authentication failed for user "${user}" (the Vey Lens gateway's password is in Settings › Gateway)`))
      return
    }

    let target: Target
    try {
      target = gate.target()
    } catch (error) {
      app.end(fatal("08004", messageOf(error)))
      return
    }

    let server: { stream: Duplex; reader: Reader }
    try {
      server = await within(signIn(target, startup), HANDSHAKE_MS, `"${target.name}" took too long to answer.`)
    } catch (error) {
      app.end(
        error instanceof ServerRefused
          ? error.raw
          : fatal("08006", `Vey Lens gateway → "${target.name}": ${messageOf(error)}`)
      )
      return
    }
    gate.attached(server.stream)
    app.write(authentication(0))

    // The parameters, the session's key and the first ReadyForQuery, passed
    // on as they come; the key is kept for a cancel request.
    for (;;) {
      const next = await readMessage(server.reader)
      app.write(next.raw)
      if (next.type === "K" && next.body.length >= 8) {
        gate.keyed?.(next.body.readInt32BE(0), Buffer.from(next.body.subarray(4)))
      }
      if (next.type === "E") {
        app.end()
        server.stream.destroy()
        return
      }
      if (next.type === "Z") break
    }
    join(app, appReader.release(), server.stream, server.reader.release())
  } catch {
    app.destroy()
  }
}
