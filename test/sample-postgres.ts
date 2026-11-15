import { Duplex } from "node:stream"

import { PGLiteSocketServer } from "@electric-sql/pglite-socket"

import { createSampleDb } from "../scripts/sample-db"

/**
 * The sample Postgres, reachable without a socket.
 *
 * `pg` is given a stream of its own making instead of a TCP connection, and
 * the other end of that stream is handed to PGlite's socket server as if it
 * had been accepted. Everything between — the wire protocol, the driver, the
 * cursor — is the real thing; only the kernel is left out, so the test runs
 * where listening on a port is not allowed.
 *
 * It reaches into the server for `handleConnection`, which is private: the
 * package offers no public way to serve a stream it did not accept itself.
 */
class Wire extends Duplex {
  peer: Wire | null = null
  remoteAddress = "in-process"
  remotePort = 0

  _read(): void {}

  _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.peer?.push(chunk)
    done()
  }

  _final(done: () => void): void {
    this.peer?.push(null)
    done()
  }

  _destroy(error: Error | null, done: (error: Error | null) => void): void {
    const peer = this.peer
    this.peer = null
    if (peer && !peer.destroyed) peer.destroy()
    done(error)
  }

  // What `pg` and the socket server ask of a `net.Socket` beyond a stream.
  connect(): this {
    process.nextTick(() => this.emit("connect"))
    return this
  }
  setNoDelay(): this {
    return this
  }
  setKeepAlive(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

export async function openSamplePostgres() {
  const db = await createSampleDb()
  const server = new PGLiteSocketServer({ db, maxConnections: 16 })
  const accept = server as unknown as {
    active: boolean
    handleConnection(socket: Wire): Promise<void>
  }
  accept.active = true

  return {
    /** For `pg`'s `stream` option: a fresh connection each time it is asked. */
    stream: () => {
      const client = new Wire()
      const remote = new Wire()
      client.peer = remote
      remote.peer = client
      void accept.handleConnection(remote)
      return client
    },
    close: () => db.close(),
  }
}
