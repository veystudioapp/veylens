/**
 * What an app asks of its database through the gateway, read off a copy of
 * the bytes as they go by. Nothing here writes to either side: the session is
 * the pipe it always was, and these only watch. A watcher that meets
 * something it cannot follow stops watching that session — the app never
 * notices.
 *
 * Postgres: the simple protocol (Query) and the extended one (Parse, Bind,
 * Execute, Sync — what ORMs and `pg` with parameters use), pipelined or not.
 * MySQL: COM_QUERY and prepared statements (COM_STMT_PREPARE / EXECUTE),
 * with result sets framed as the session's abilities say.
 */

import { cstring } from "./wire"

/** One statement as the app ran it. */
export type ObservedQuery = {
  /** When the app sent it, ms since the epoch. */
  at: number
  /** From sending to the server's answer being complete. */
  ms: number
  sql: string
  /** Bound values, as text; null when there were none or they are binary. */
  params: string[] | null
  /** SELECT, INSERT, … — the server's word for it where it gives one. */
  command: string | null
  /** Rows returned or changed, where the server says. */
  rows: number | null
  error: string | null
}

/** Watches one direction's bytes. */
export type Tap = { app: (chunk: Buffer) => void; server: (chunk: Buffer) => void }

/** The longest SQL kept of one statement. */
const SQL_LIMIT = 100_000
/** Values kept of one statement, and of each value. */
const PARAMS_KEPT = 20
const PARAM_LIMIT = 200

const now = () => performance.now()

/** A tap that stops at the first thing it cannot follow. */
function guarded(tap: Tap): Tap {
  let dead = false
  const wrap = (side: (chunk: Buffer) => void) => (chunk: Buffer) => {
    if (dead) return
    try {
      side(chunk)
    } catch {
      dead = true
    }
  }
  return { app: wrap(tap.app), server: wrap(tap.server) }
}

// ── Postgres ───────────────────────────────────────────────────────────────

/**
 * Postgres messages out of a stream of chunks: a type byte, a length that
 * counts itself, a body. Only the bodies asked for are kept, and only up to a
 * limit — a result's rows go by uncopied.
 */
export class PgFramer {
  private readonly header = Buffer.alloc(5)
  private filled = 0
  private remaining = -1
  private type = ""
  private parts: Buffer[] | null = null
  private kept = 0

  constructor(
    private readonly wanted: (type: string) => boolean,
    private readonly limit: number,
    private readonly emit: (type: string, body: Buffer | null) => void
  ) {}

  push(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining < 0) {
        const take = Math.min(5 - this.filled, chunk.length - offset)
        chunk.copy(this.header, this.filled, offset, offset + take)
        this.filled += take
        offset += take
        if (this.filled < 5) return
        const length = this.header.readInt32BE(1)
        if (length < 4 || length > 1024 * 1024 * 1024) throw new Error("Lost the Postgres framing.")
        this.type = String.fromCharCode(this.header[0]!)
        this.remaining = length - 4
        this.parts = this.wanted(this.type) ? [] : null
        this.kept = 0
      }
      const take = Math.min(this.remaining, chunk.length - offset)
      if (this.parts && this.kept < this.limit && take > 0) {
        const keep = Math.min(take, this.limit - this.kept)
        this.parts.push(Buffer.from(chunk.subarray(offset, offset + keep)))
        this.kept += keep
      }
      this.remaining -= take
      offset += take
      if (this.remaining === 0) {
        const body = this.parts ? Buffer.concat(this.parts) : null
        this.remaining = -1
        this.filled = 0
        this.parts = null
        this.emit(this.type, body)
      }
    }
  }
}

/** "SELECT 5" → SELECT, 5; "INSERT 0 3" → INSERT, 3; "BEGIN" → BEGIN, null. */
export function commandTag(tag: string): { command: string | null; rows: number | null } {
  const words = tag.trim().split(/\s+/)
  const last = words.at(-1) ?? ""
  const rows = words.length > 1 && /^\d+$/.test(last) ? Number(last) : null
  return { command: words[0] || null, rows }
}

/** What an ErrorResponse says: its message, and its SQLSTATE. */
function pgError(body: Buffer): string {
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

/** A Bind's values, as text: binary ones and the rest past the limit left out. */
function bindParams(body: Buffer, offset: number): string[] | null {
  const formatCount = body.readInt16BE(offset)
  offset += 2
  const formats: number[] = []
  for (let index = 0; index < formatCount; index++) formats.push(body.readInt16BE(offset + index * 2))
  offset += formatCount * 2
  const count = body.readInt16BE(offset)
  offset += 2
  if (count === 0) return null
  const out: string[] = []
  for (let index = 0; index < count && out.length < PARAMS_KEPT; index++) {
    if (offset + 4 > body.length) break
    const length = body.readInt32BE(offset)
    offset += 4
    const format = formatCount === 0 ? 0 : formatCount === 1 ? formats[0]! : (formats[index] ?? 0)
    if (length < 0) out.push("NULL")
    else if (format === 1) out.push("<binary>")
    else {
      const text = body.toString("utf8", offset, Math.min(body.length, offset + length))
      out.push(text.length > PARAM_LIMIT ? `${text.slice(0, PARAM_LIMIT)}…` : text)
    }
    if (length > 0) offset += length
  }
  return out
}

type PgPending =
  | {
      kind: "simple" | "execute"
      at: number
      started: number
      sql: string
      params: string[] | null
      command: string | null
      rows: number | null
      error: string | null
    }
  | { kind: "sync" }

/**
 * A Postgres session as the app and the server take turns in it. Answers
 * come back in the order things were asked, so what was asked is a queue:
 * a Query, each Execute, each Sync. An error in the extended protocol makes
 * the server skip to the next Sync, so what was queued before it never runs.
 */
export class PgTracker {
  private readonly statements = new Map<string, string>()
  private readonly portals = new Map<string, { sql: string; params: string[] | null }>()
  private readonly pending: PgPending[] = []

  constructor(private readonly emit: (query: ObservedQuery) => void) {}

  private finish(item: Extract<PgPending, { kind: "simple" | "execute" }>): void {
    this.emit({
      at: item.at,
      ms: Math.max(0, now() - item.started),
      sql: item.sql,
      params: item.params,
      command: item.command,
      rows: item.rows,
      error: item.error,
    })
  }

  fromApp(type: string, body: Buffer | null): void {
    if (!body) return
    switch (type) {
      case "Q":
        this.pending.push({
          kind: "simple",
          at: Date.now(),
          started: now(),
          sql: cstring(body, 0)[0],
          params: null,
          command: null,
          rows: null,
          error: null,
        })
        return
      case "P": {
        const [name, offset] = cstring(body, 0)
        this.statements.set(name, cstring(body, offset)[0])
        return
      }
      case "B": {
        const [portal, afterPortal] = cstring(body, 0)
        const [statement, afterStatement] = cstring(body, afterPortal)
        let params: string[] | null = null
        try {
          params = bindParams(body, afterStatement)
        } catch {
          // Cut short by the limit: the statement is still known.
        }
        this.portals.set(portal, { sql: this.statements.get(statement) ?? "", params })
        return
      }
      case "E": {
        const portal = this.portals.get(cstring(body, 0)[0])
        this.pending.push({
          kind: "execute",
          at: Date.now(),
          started: now(),
          sql: portal?.sql ?? "",
          params: portal?.params ?? null,
          command: null,
          rows: null,
          error: null,
        })
        return
      }
      case "S":
        this.pending.push({ kind: "sync" })
        return
      case "C": {
        const [name] = cstring(body, 1)
        if (body[0] === 0x53 /* S */) this.statements.delete(name)
        else this.portals.delete(name)
        return
      }
    }
  }

  fromServer(type: string, body: Buffer | null): void {
    const head = this.pending[0]
    switch (type) {
      case "C": {
        if (!head || head.kind === "sync" || !body) return
        Object.assign(head, commandTag(cstring(body, 0)[0]))
        // A Query's statements each say they are done; the Query is done
        // when the server is ready again.
        if (head.kind === "execute") this.finish(this.pending.shift() as typeof head)
        return
      }
      case "I":
      case "s":
        if (head?.kind === "execute") {
          if (type === "s") head.command = "FETCH"
          this.finish(this.pending.shift() as typeof head)
        }
        return
      case "E": {
        if (!head || head.kind === "sync") return
        head.error = body ? pgError(body) : "error"
        if (head.kind === "execute") this.finish(this.pending.shift() as typeof head)
        return
      }
      case "Z": {
        if (head?.kind === "simple") {
          this.finish(this.pending.shift() as typeof head)
          return
        }
        // Up to the Sync this answers: what is left was skipped after an error.
        while (this.pending.length && this.pending[0]!.kind !== "sync") this.pending.shift()
        if (this.pending[0]?.kind === "sync") this.pending.shift()
        return
      }
    }
  }
}

const APP_WANTED = new Set(["Q", "P", "B", "E", "S", "C"])
const SERVER_WANTED = new Set(["C", "E", "Z", "I", "s"])

/** Watches a signed-in Postgres session. */
export function postgresTap(emit: (query: ObservedQuery) => void): Tap {
  const tracker = new PgTracker((query) => emit({ ...query, sql: query.sql.slice(0, SQL_LIMIT) }))
  const app = new PgFramer((type) => APP_WANTED.has(type), SQL_LIMIT + 1024, (type, body) =>
    tracker.fromApp(type, body)
  )
  const server = new PgFramer((type) => SERVER_WANTED.has(type), 8 * 1024, (type, body) =>
    tracker.fromServer(type, body)
  )
  return guarded({ app: (chunk) => app.push(chunk), server: (chunk) => server.push(chunk) })
}

// ── MySQL ──────────────────────────────────────────────────────────────────

export const MYSQL_DEPRECATE_EOF = 1 << 24
export const MYSQL_QUERY_ATTRIBUTES = 1 << 27
const MORE_RESULTS = 0x0008
const MAX_PACKET = 0xffffff

/**
 * MySQL packets out of a stream of chunks: a three-byte length, a sequence
 * number, a payload — of which the first `limit` bytes are kept.
 */
export class MysqlFramer {
  private readonly header = Buffer.alloc(4)
  private filled = 0
  private remaining = -1
  private length = 0
  private seq = 0
  private parts: Buffer[] = []
  private kept = 0

  constructor(
    private readonly limit: number,
    private readonly emit: (seq: number, length: number, head: Buffer) => void
  ) {}

  push(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining < 0) {
        const take = Math.min(4 - this.filled, chunk.length - offset)
        chunk.copy(this.header, this.filled, offset, offset + take)
        this.filled += take
        offset += take
        if (this.filled < 4) return
        this.length = this.header.readUIntLE(0, 3)
        this.seq = this.header[3]!
        this.remaining = this.length
        this.parts = []
        this.kept = 0
      }
      const take = Math.min(this.remaining, chunk.length - offset)
      if (this.kept < this.limit && take > 0) {
        const keep = Math.min(take, this.limit - this.kept)
        this.parts.push(Buffer.from(chunk.subarray(offset, offset + keep)))
        this.kept += keep
      }
      this.remaining -= take
      offset += take
      if (this.remaining === 0) {
        this.remaining = -1
        this.filled = 0
        this.emit(this.seq, this.length, Buffer.concat(this.parts))
      }
    }
  }
}

function lenenc(buffer: Buffer, offset: number): [number, number] {
  const first = buffer[offset]!
  if (first < 0xfb) return [first, offset + 1]
  if (first === 0xfc) return [buffer.readUInt16LE(offset + 1), offset + 3]
  if (first === 0xfd) return [buffer.readUIntLE(offset + 1, 3), offset + 4]
  return [Number(buffer.readBigUInt64LE(offset + 1)), offset + 9]
}

/** An OK packet's rows changed and status flags. `eofHeader` is the 0xFE
 * form that ends a result set when EOF packets are deprecated. */
function okPacket(head: Buffer): { affected: number; status: number } {
  const [affected, afterAffected] = lenenc(head, 1)
  const [, afterId] = lenenc(head, afterAffected)
  return { affected, status: afterId + 2 <= head.length ? head.readUInt16LE(afterId) : 0 }
}

function mysqlError(head: Buffer): string {
  const code = head.readUInt16LE(1)
  const text = head.toString("utf8", head[3] === 0x23 /* # */ ? 9 : 3)
  return `${text} (${code})`
}

const firstWord = (sql: string) =>
  /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase() ?? null

type MyCommand = {
  kind: "query" | "prepare" | "other"
  at: number
  started: number
  sql: string
  phase: "first" | "columns" | "rows" | "skip"
  /** Column or parameter definitions still to come. */
  left: number
  rows: number
  affected: number | null
  error: string | null
}

/**
 * A MySQL session, one command at a time: what the app sent at sequence 0,
 * and the server's packets until its answer is complete — an OK, an error,
 * or a result set's columns, rows and end (more than one when the status
 * says more results follow).
 */
export class MysqlTracker {
  private readonly statements = new Map<number, string>()
  private current: MyCommand | null = null
  /** The previous packet was full-size: this one continues it. */
  private continued = false

  constructor(
    private readonly capabilities: number,
    private readonly emit: (query: ObservedQuery) => void
  ) {}

  private get deprecateEof(): boolean {
    return (this.capabilities & MYSQL_DEPRECATE_EOF) !== 0
  }

  private done(): void {
    const command = this.current
    this.current = null
    if (!command || command.kind !== "query") return
    this.emit({
      at: command.at,
      ms: Math.max(0, now() - command.started),
      sql: command.sql,
      params: null,
      command: firstWord(command.sql),
      rows: command.error ? null : command.affected ?? command.rows,
      error: command.error,
    })
  }

  fromApp(seq: number, head: Buffer): void {
    if (seq !== 0 || head.length === 0) return
    // A command before the last was answered: that one is past following.
    this.current = null
    const start = (kind: MyCommand["kind"], sql: string) => {
      this.current = {
        kind,
        at: Date.now(),
        started: now(),
        sql,
        phase: "first",
        left: 0,
        rows: 0,
        affected: null,
        error: null,
      }
    }
    switch (head[0]) {
      case 0x03: {
        let offset = 1
        if (this.capabilities & MYSQL_QUERY_ATTRIBUTES) {
          const [count, afterCount] = lenenc(head, offset)
          const [, afterSets] = lenenc(head, afterCount)
          // Attributes with values come before the text; not followed.
          if (count > 0) return start("query", "(a query sent with attributes)")
          offset = afterSets
        }
        return start("query", head.toString("utf8", offset))
      }
      case 0x16:
        return start("prepare", head.toString("utf8", 1))
      case 0x17:
        return start("query", this.statements.get(head.readUInt32LE(1)) ?? "(a prepared statement)")
      case 0x19:
        this.statements.delete(head.readUInt32LE(1))
        return
      case 0x18: // send long data: no answer
      case 0x01: // quit
        return
      default:
        return start("other", "")
    }
  }

  fromServer(_seq: number, length: number, head: Buffer): void {
    const continuation = this.continued
    this.continued = length === MAX_PACKET
    const command = this.current
    if (!command || continuation || head.length === 0) return
    const kind = head[0]!

    if (command.phase === "first") {
      if (kind === 0xff) {
        command.error = mysqlError(head)
        return this.done()
      }
      if (command.kind === "prepare") {
        if (kind !== 0x00) return this.done()
        const id = head.readUInt32LE(1)
        const columns = head.readUInt16LE(5)
        const params = head.readUInt16LE(7)
        this.statements.set(id, command.sql)
        const eofs = this.deprecateEof ? 0 : (params ? 1 : 0) + (columns ? 1 : 0)
        command.left = params + columns + eofs
        command.phase = "skip"
        if (command.left === 0) this.done()
        return
      }
      if (kind === 0x00) {
        const ok = okPacket(head)
        command.affected = (command.affected ?? 0) + ok.affected
        if (!(ok.status & MORE_RESULTS)) this.done()
        return
      }
      if (kind === 0xfb) {
        // LOCAL INFILE: the app sends a file next; not followed.
        this.current = null
        return
      }
      if (command.kind === "other") return this.done()
      const [columns] = lenenc(head, 0)
      command.left = columns + (this.deprecateEof ? 0 : 1)
      command.phase = "columns"
      return
    }

    if (command.phase === "skip") {
      if (--command.left <= 0) this.done()
      return
    }

    if (command.phase === "columns") {
      if (--command.left <= 0) command.phase = "rows"
      return
    }

    // Rows, until the packet that ends them.
    if (kind === 0xff) {
      command.error = mysqlError(head)
      return this.done()
    }
    const end = kind === 0xfe && (this.deprecateEof ? length < MAX_PACKET : length < 9)
    if (!end) {
      command.rows++
      return
    }
    const status = this.deprecateEof ? okPacket(head).status : head.length >= 5 ? head.readUInt16LE(3) : 0
    if (status & MORE_RESULTS) {
      command.phase = "first"
      return
    }
    this.done()
  }
}

/** Watches a signed-in MySQL session, framed by the abilities it agreed. */
export function mysqlTap(capabilities: number, emit: (query: ObservedQuery) => void): Tap {
  const tracker = new MysqlTracker(capabilities, (query) => emit({ ...query, sql: query.sql.slice(0, SQL_LIMIT) }))
  const app = new MysqlFramer(SQL_LIMIT + 64, (seq, _length, head) => tracker.fromApp(seq, head))
  const server = new MysqlFramer(4 * 1024, (seq, length, head) => tracker.fromServer(seq, length, head))
  return guarded({ app: (chunk) => app.push(chunk), server: (chunk) => server.push(chunk) })
}
