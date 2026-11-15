/**
 * Where in its SQL a database error points. Postgres says, as a position;
 * MySQL's message quotes what follows the spot, or names what it could not
 * find. Electron hands the renderer nothing of a thrown error but its
 * message, so the offset rides at the end of it, behind a mark nobody types.
 */

import type { Engine } from "./api"

const MARK = "\u0000at "
const MARKED = /\u0000at (\d+)$/

/** The error again, its message carrying where in the SQL it points. */
export function withErrorOffset(error: unknown, offset: number | null): unknown {
  if (offset === null || !(error instanceof Error)) return error
  return new Error(`${error.message}${MARK}${offset}`)
}

/** A message without its offset, and the offset. */
export function splitErrorOffset(message: string): { message: string; offset: number | null } {
  const found = MARKED.exec(message)
  if (!found) return { message, offset: null }
  return { message: message.slice(0, found.index), offset: Number(found[1]) }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The first place a name is written in the SQL, as a whole word, quoted or not. */
function findName(sql: string, name: string): number | null {
  const parts = name.split(".")
  for (const candidate of [name, parts.at(-1)!]) {
    const pattern = candidate
      .split(".")
      .map((part) => `[\`"]?${escape(part)}[\`"]?`)
      .join("\\s*\\.\\s*")
    const found = new RegExp(`(?<![\\w$])${pattern}(?![\\w$])`, "i").exec(sql)
    if (found) return found.index
  }
  return null
}

/** Where, from 0, an error from running `sql` points in it. */
export function errorOffset(error: unknown, sql: string, engine: Engine): number | null {
  if (!(error instanceof Error)) return null
  if (engine === "postgres") {
    const position = Number((error as { position?: unknown }).position)
    return Number.isInteger(position) && position >= 1 && position <= sql.length + 1
      ? position - 1
      : null
  }
  const message = error.message
  const near = /near '([\s\S]*)' at line (\d+)$/.exec(message)
  if (near) {
    const [, text, line] = near
    if (!text) return sql.trimEnd().length
    let lineStart = 0
    for (let index = 1; index < Number(line); index++) {
      const next = sql.indexOf("\n", lineStart)
      if (next === -1) break
      lineStart = next + 1
    }
    const at = sql.indexOf(text, lineStart)
    if (at !== -1) return at
    const anywhere = sql.indexOf(text)
    return anywhere === -1 ? null : anywhere
  }
  const named =
    /^Unknown column '([^']+)'/.exec(message) ??
    /^Table '([^']+)' doesn't exist/.exec(message) ??
    /^Unknown table '([^']+)'/.exec(message) ??
    /^FUNCTION ([\w$.]+) does not exist/.exec(message)
  if (named) {
    const name = named[1]!
    // `shop.orders` is the database's name for what the SQL calls `orders`.
    return findName(sql, name) ?? (name.includes(".") ? findName(sql, name.split(".").slice(1).join(".")) : null)
  }
  return null
}

/** The stretch to underline for an offset: the word, quoted name or string
 * there — or, past the end or on a space, the one before it. */
export function errorRange(sql: string, offset: number): { from: number; to: number } | null {
  if (!sql.trim()) return null
  let at = Math.min(Math.max(offset, 0), sql.length)
  if (at === sql.length || /\s/.test(sql[at]!)) {
    at--
    while (at > 0 && /\s/.test(sql[at]!)) at--
  }
  if (at < 0 || /\s/.test(sql[at]!)) at = sql.search(/\S/)
  const char = sql[at]!
  if (/[\w$\u0080-￿]/.test(char)) {
    let from = at
    let to = at
    while (from > 0 && /[\w$\u0080-￿]/.test(sql[from - 1]!)) from--
    while (to < sql.length && /[\w$\u0080-￿]/.test(sql[to]!)) to++
    return { from, to }
  }
  if (char === "'" || char === '"' || char === "`") {
    const close = sql.indexOf(char, at + 1)
    const lineEnd = sql.indexOf("\n", at)
    const to = close === -1 ? (lineEnd === -1 ? sql.length : lineEnd) : close + 1
    return { from: at, to }
  }
  return { from: at, to: at + 1 }
}
