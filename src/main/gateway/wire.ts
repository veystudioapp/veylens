import { timingSafeEqual } from "node:crypto"
import { once } from "node:events"
import { isIP } from "node:net"
import type { Duplex } from "node:stream"
import tls from "node:tls"

/**
 * Bytes off a stream, as many as are asked for, while a handshake is being
 * read; then, with `release`, the stream handed back for piping with whatever
 * came in past what was taken.
 */
export class Reader {
  private buffered: Buffer = Buffer.alloc(0)
  private wake: (() => void) | null = null
  private failure: Error | null = null

  private readonly onData = (chunk: Buffer) => {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk
    this.poke()
  }
  private readonly onEnd = () => {
    this.failure ??= new Error(`The ${this.side} closed the connection.`)
    this.poke()
  }
  private readonly onError = (error: Error) => {
    this.failure ??= error
    this.poke()
  }

  constructor(
    readonly stream: Duplex,
    /** Who is at the other end, for an error: "app", "server". */
    private readonly side: string
  ) {
    stream.on("data", this.onData)
    stream.on("end", this.onEnd)
    stream.on("close", this.onEnd)
    stream.on("error", this.onError)
    // A stream paused by an earlier reader's `release` stays paused when a
    // listener is added; this one reads.
    stream.resume()
  }

  private poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  async take(count: number): Promise<Buffer> {
    while (this.buffered.length < count) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    const out = this.buffered.subarray(0, count)
    this.buffered = this.buffered.subarray(count)
    return out
  }

  /** Stops reading — the stream paused, so nothing is lost — and gives back
   * what came in past what was taken. */
  release(): Buffer {
    this.stream.pause()
    this.stream.off("data", this.onData)
    this.stream.off("end", this.onEnd)
    this.stream.off("close", this.onEnd)
    this.stream.off("error", this.onError)
    const rest = this.buffered
    this.buffered = Buffer.alloc(0)
    return rest
  }
}

/** A NUL-terminated string at `offset`, and where the next field starts. */
export function cstring(buffer: Buffer, offset: number): [string, number] {
  let end = buffer.indexOf(0, offset)
  if (end < 0) end = buffer.length
  return [buffer.toString("utf8", offset, end), end + 1]
}

/**
 * The two streams joined once both sides have signed in: what each had
 * already sent past its handshake goes first. Either end closing closes the
 * other. A `tap` is shown every byte each way, as it goes — it reads, it
 * never holds anything up or changes it.
 */
export function join(
  app: Duplex,
  appRest: Buffer,
  server: Duplex,
  serverRest: Buffer,
  tap?: { app: (chunk: Buffer) => void; server: (chunk: Buffer) => void }
): void {
  if (tap) {
    if (serverRest.length) tap.server(serverRest)
    if (appRest.length) tap.app(appRest)
    app.on("data", tap.app)
    server.on("data", tap.server)
  }
  if (serverRest.length) app.write(serverRest)
  if (appRest.length) server.write(appRest)
  const close = () => {
    app.destroy()
    server.destroy()
  }
  app.once("close", close)
  server.once("close", close)
  // A reset on either side ends the session; it is no error of this process.
  app.on("error", close)
  server.on("error", close)
  app.pipe(server)
  server.pipe(app)
}

/** `socket` wrapped in TLS, once the handshake is done. `require` encrypts
 * without checking the certificate, as the drivers do. */
export async function upgrade(
  socket: Duplex,
  host: string,
  verify: boolean
): Promise<tls.TLSSocket> {
  const secure = tls.connect({
    socket: socket as never,
    rejectUnauthorized: verify,
    ...(isIP(host) ? {} : { servername: host }),
  })
  // `once` rejects with the error if one comes first.
  await once(secure, "secureConnect")
  return secure
}

/** Rejects after `ms` with `message`, unless `work` settles first. */
export function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** The gateway's password, compared in constant time. An empty one never
 * matches. */
export function samePassword(given: Buffer | string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
