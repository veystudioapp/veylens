/**
 * `@` in the chat: pointing a message at a table, a dashboard, a metric or a
 * connection by name.
 *
 * **A mention is plain text** — `@orders`, or `@"Sales overview"` for a name
 * with a space in it — not a chip or a hidden id. It reads the same in the
 * field, in the transcript and in the prompt, and one typed by hand works as
 * well as one picked from the menu. The tint behind it comes from looking the
 * word up, so `@orders` lights up only while the connection has an `orders`.
 *
 * **What it adds is the lookup.** On sending, every `@word` that names
 * something is resolved here, and the message goes out with a list saying what
 * each one is: `@orders` → table `sales.orders` on `my_app`. The agent no
 * longer has to guess the schema, which dashboard of three similar titles was
 * meant, or what a metric is computed from.
 *
 * Kept in `shared` so the rules can be tested without a window.
 */

export type MentionKind = "table" | "view" | "dashboard" | "metric" | "connection"

/** What the message carries for a mention, enough for main to describe it. */
export type MentionRef = {
  kind: MentionKind
  connectionId: string
  /** A table's or view's name, a dashboard's title, a metric's name, a
   * connection's name. */
  name: string
  schema?: string
  /** A dashboard's or metric's id. */
  id?: string
}

/** One row of the `@` menu. */
export type MentionTarget = MentionRef & {
  /** What is inserted after the `@`: the name, quoted when it has to be. */
  token: string
  /** Every spelling that refers to it — `orders` and `sales.orders`. */
  tokens: string[]
  /** The row's main text. */
  label: string
  /** The row's grey text: a schema, a tile count, a description. */
  detail: string
}

export type MentionSources = {
  /** The chat's connection: what an unqualified table name means. */
  connection: { id: string; name: string; engine: string } | null
  /** The connections set up — offered to point a message at another one. */
  connections: { id: string; name: string; engine: string }[]
  /** The chat connection's schemas, when its tree has loaded. */
  schemas: { name: string; tables: { name: string; kind: "table" | "view" }[] }[]
  dashboards: { id: string; connectionId: string; title: string; tiles: unknown[] }[]
  metrics: { id: string; name: string; description: string }[]
}

/** The order rows are offered in, and which kind wins a name two share. */
export const MENTION_ORDER: MentionKind[] = [
  "table",
  "view",
  "dashboard",
  "metric",
  "connection",
]

export const MENTION_WORDS: Record<MentionKind, string> = {
  table: "table",
  view: "view",
  dashboard: "dashboard",
  metric: "metric",
  connection: "connection",
}

const BARE = /^[\p{L}\p{N}_$][\p{L}\p{N}_.$-]*$/u

/** A name as it is written after `@`: as it is, or in quotes when it has a
 * space or punctuation that would end the word. */
export function tokenOf(name: string): string {
  return BARE.test(name) && !/[.-]$/.test(name)
    ? name
    : `"${name.replace(/"/g, "'").replace(/\n/g, " ")}"`
}

/** Everything a message can mention, in `MENTION_ORDER`. */
export function mentionTargets(sources: MentionSources): MentionTarget[] {
  const targets: MentionTarget[] = []
  const connection = sources.connection

  if (connection) {
    // A table's own name when no other schema has one by that name; its
    // qualified name when two do, so the token says which.
    const count = new Map<string, number>()
    for (const schema of sources.schemas) {
      for (const table of schema.tables) {
        count.set(table.name, (count.get(table.name) ?? 0) + 1)
      }
    }
    const onlySchema = sources.schemas.length === 1
    for (const kind of ["table", "view"] as const) {
      for (const schema of sources.schemas) {
        for (const table of schema.tables) {
          if (table.kind !== kind) continue
          const qualified = `${schema.name}.${table.name}`
          const unique = count.get(table.name) === 1
          const token = tokenOf(unique ? table.name : qualified)
          targets.push({
            kind,
            connectionId: connection.id,
            name: table.name,
            schema: schema.name,
            token,
            tokens: unique ? [token, tokenOf(qualified)] : [token],
            label: unique ? table.name : qualified,
            detail: onlySchema && unique ? MENTION_WORDS[kind] : `${schema.name} · ${MENTION_WORDS[kind]}`,
          })
        }
      }
    }

    for (const dashboard of sources.dashboards) {
      if (dashboard.connectionId !== connection.id) continue
      const token = tokenOf(dashboard.title)
      const tiles = dashboard.tiles.length
      targets.push({
        kind: "dashboard",
        connectionId: connection.id,
        name: dashboard.title,
        id: dashboard.id,
        token,
        tokens: [token],
        label: dashboard.title,
        detail: `${tiles} ${tiles === 1 ? "tile" : "tiles"}`,
      })
    }

    for (const metric of sources.metrics) {
      const token = tokenOf(metric.name)
      targets.push({
        kind: "metric",
        connectionId: connection.id,
        name: metric.name,
        id: metric.id,
        token,
        tokens: [token],
        label: metric.name,
        detail: metric.description.split("\n")[0] ?? "",
      })
    }
  }

  for (const other of sources.connections) {
    if (other.id === connection?.id) continue
    const token = tokenOf(other.name)
    targets.push({
      kind: "connection",
      connectionId: other.id,
      name: other.name,
      token,
      tokens: [token],
      label: other.name,
      detail: other.engine === "postgres" ? "PostgreSQL" : "MySQL",
    })
  }

  return targets
}

/** Where the `@` being typed starts, and what has been typed after it. */
export type MentionQuery = { from: number; filter: string }

/**
 * `@` where a word could start, so an email address does not open the menu.
 * After `@"` the query runs on through spaces, to the closing quote.
 */
const QUERY = /(?:^|[\s(])@(?:"([^"\n]*)|([\p{L}\p{N}_.$-]*))$/u

/** The mention the caret is in the middle of typing, or null. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const match = QUERY.exec(before)
  if (!match) return null
  const quoted = match[1] !== undefined
  const filter = (quoted ? match[1] : match[2]) ?? ""
  return {
    from: caret - filter.length - (quoted ? 2 : 1),
    filter,
  }
}

/**
 * The draft with the typed `@query` replaced by `@token`, and where the caret
 * lands. A space follows, so the next word is not typed onto the name — but
 * not a second one when the draft already has one there.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  caret: number,
  token: string
): { text: string; caret: number } {
  // A quote typed by hand that the pick is about to close.
  let end = caret
  if (token.startsWith('"') && text[end] === '"') end += 1
  const inserted = `@${token}`
  const after = text.slice(end)
  const spaced = /^\s/.test(after) ? inserted : `${inserted} `
  return {
    text: text.slice(0, query.from) + spaced + after,
    caret: query.from + spaced.length,
  }
}

/** A run of text, and what it names when it is a mention. */
export type MentionSegment = { text: string; target: MentionTarget | null }

/** `@` and a word, or `@` and a quoted name, starting where a word can. */
const MENTION = /(^|[\s(\[{'"`])@(?:"([^"\n]+)"|([\p{L}\p{N}_.$-]+))/gu

function lookup(targets: readonly MentionTarget[]) {
  const byToken = new Map<string, MentionTarget[]>()
  for (const target of targets) {
    for (const token of target.tokens) {
      const key = token.replace(/^"|"$/g, "").toLowerCase()
      const list = byToken.get(key) ?? []
      list.push(target)
      byToken.set(key, list)
    }
  }
  return byToken
}

type Found = { start: number; end: number; targets: MentionTarget[] }

/**
 * Every `@` in `text` that names something. Case does not matter — `@Orders`
 * is `orders` — and a sentence's full stop is not part of the name, so
 * "look at @orders." still finds `orders`.
 */
function scan(text: string, targets: readonly MentionTarget[]): Found[] {
  if (!text.includes("@") || targets.length === 0) return []
  const byToken = lookup(targets)
  const found: Found[] = []
  for (const match of text.matchAll(MENTION)) {
    const start = match.index + match[1]!.length
    if (match[2] !== undefined) {
      const hit = byToken.get(match[2].toLowerCase())
      if (hit) found.push({ start, end: start + match[0].length - match[1]!.length, targets: hit })
      continue
    }
    let word = match[3]!
    while (word) {
      const hit = byToken.get(word.toLowerCase())
      if (hit) {
        found.push({ start, end: start + 1 + word.length, targets: hit })
        break
      }
      if (!/[.-]$/.test(word)) break
      word = word.slice(0, -1)
    }
  }
  return found
}

/** The text cut into plain runs and mentions, for drawing the tint. */
export function markMentions(
  text: string,
  targets: readonly MentionTarget[]
): MentionSegment[] {
  const segments: MentionSegment[] = []
  let at = 0
  for (const found of scan(text, targets)) {
    if (found.start > at) segments.push({ text: text.slice(at, found.start), target: null })
    segments.push({ text: text.slice(found.start, found.end), target: found.targets[0]! })
    at = found.end
  }
  if (at < text.length || segments.length === 0) {
    segments.push({ text: text.slice(at), target: null })
  }
  return segments
}

/**
 * What a message mentions, once each. A name two things share — a table and a
 * metric both called `revenue` — sends both, and the agent reads which fits.
 */
export function findMentions(
  text: string,
  targets: readonly MentionTarget[]
): { token: string; ref: MentionRef }[] {
  const seen = new Set<string>()
  const out: { token: string; ref: MentionRef }[] = []
  for (const found of scan(text, targets)) {
    for (const target of found.targets) {
      const key = `${target.kind}:${target.connectionId}:${target.schema ?? ""}:${target.id ?? target.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const { kind, connectionId, name, schema, id } = target
      out.push({
        token: text.slice(found.start, found.end),
        ref: {
          kind,
          connectionId,
          name,
          ...(schema === undefined ? {} : { schema }),
          ...(id === undefined ? {} : { id }),
        },
      })
    }
  }
  return out
}

/**
 * The rows for `filter`, best first.
 *
 * Nothing typed: a few of each kind, so a connection with two hundred tables
 * still shows that dashboards can be mentioned too. Something typed: the name
 * starting with it, then a word in it starting with it, then containing it,
 * then its letters in order (`ordit` finds `order_items`); shorter breaks a tie.
 */
export function rankMentions(
  targets: readonly MentionTarget[],
  filter: string,
  limit = 30
): MentionTarget[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) {
    const caps: Record<MentionKind, number> = {
      table: 8,
      view: 3,
      dashboard: 4,
      metric: 4,
      connection: 3,
    }
    const taken: Record<MentionKind, number> = {
      table: 0,
      view: 0,
      dashboard: 0,
      metric: 0,
      connection: 0,
    }
    const out: MentionTarget[] = []
    for (const target of targets) {
      if (taken[target.kind] >= caps[target.kind]) continue
      taken[target.kind] += 1
      out.push(target)
    }
    return out.slice(0, limit)
  }

  const scored: { target: MentionTarget; score: number; order: number }[] = []
  for (const target of targets) {
    const score = scoreOf(target.label.toLowerCase(), needle)
    if (score !== null) {
      scored.push({ target, score, order: MENTION_ORDER.indexOf(target.kind) })
    }
  }
  return scored
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.target.label.length - right.target.label.length ||
        left.order - right.order ||
        left.target.label.localeCompare(right.target.label)
    )
    .slice(0, limit)
    .map((entry) => entry.target)
}

function scoreOf(label: string, needle: string): number | null {
  const name = label.slice(label.lastIndexOf(".") + 1)
  if (name.startsWith(needle) || label.startsWith(needle)) return 0
  if (new RegExp(`(?:^|[\\s_.-])${escape(needle)}`, "u").test(label)) return 1
  if (label.includes(needle)) return 2
  let at = 0
  for (const character of needle.replace(/\s+/g, "")) {
    at = label.indexOf(character, at)
    if (at === -1) return null
    at += 1
  }
  return 3
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
