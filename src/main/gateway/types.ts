import type { Duplex } from "node:stream"

import type { ConnectionConfig } from "../db/types"

/** The server a session goes to: a saved connection, signed in to with its
 * own user and password. */
export type Target = {
  /** The connection's name, for an error the app is shown. */
  name: string
  config: ConnectionConfig
  /** A new stream to the server: TCP, or — already encrypted — Cloud SQL's
   * connector. */
  open: () => Promise<Duplex>
  /** Whether `open`'s stream is encrypted already, so the driver's own SSL
   * is not asked for. */
  secure: boolean
}

/** What one app connection asks of the gateway around it. */
export type Gate = {
  /** What the app signs in to the gateway with, whatever user it names —
   * read when it signs in, so a password changed meanwhile is the one. */
  password: () => string
  /** Where the session goes, resolved when it signs in. Throws, saying why,
   * when the gateway has no connection to go to. */
  target: () => Target
  /** The server's end, once there is one: closed with the session. */
  attached: (server: Duplex) => void
  /** Postgres: the key the server gave the session, which a cancel request
   * names it by. */
  keyed?: (pid: number, key: Buffer) => void
  /** Postgres: an app asking for a running query of one of its sessions to
   * be cancelled. */
  cancel?: (pid: number, key: Buffer) => void
}

/** How long either side may take over its part of signing in. */
export const HANDSHAKE_MS = 15_000
