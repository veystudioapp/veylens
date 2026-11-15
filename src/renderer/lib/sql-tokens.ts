/**
 * SQL cut into the pieces it is coloured by — for reading, not parsing: a
 * word is a keyword by its spelling alone, and anything not recognised is
 * left as plain text. Postgres and MySQL alike, and the dashboard's
 * `{{name}}` and `[[ … ]]`.
 */

export type SqlTokenKind =
  | "keyword"
  | "type"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "param"
  | "identifier"
  | "text"

export type SqlToken = { kind: SqlTokenKind; text: string }

const KEYWORDS = new Set(
  `add all alter analyze and any as asc begin between both by cascade case cast
  check collate column commit concurrently constraint create cross current_date
  current_time current_timestamp current_user database default deferrable delete
  desc describe distinct do drop else end escape except exists explain extension
  false fetch filter first following for foreign from full function grant group
  having if ilike in index inner insert intersect interval into is join key
  last lateral leading left like limit local materialized natural not nothing
  null nulls of offset on only or order outer over partition preceding primary
  procedure recursive references rename replace restrict returning revoke right
  rollback row rows schema select sequence set show similar some start table
  temp temporary then to trailing transaction trigger true truncate unbounded
  union unique update use using values view when where window with within
  without auto_increment duplicate ignore straight_join unsigned zerofill
  engine charset regexp rlike div mod xor`.split(/\s+/)
)

const TYPES = new Set(
  `bigint bigserial bit bool boolean box bytea char character cidr citext date
  datetime decimal double enum float float4 float8 inet int int2 int4 int8
  integer json jsonb longblob longtext mediumint mediumtext money numeric
  precision real serial smallint smallserial text time timestamp timestamptz
  timetz tinyint tinytext uuid varbinary varchar varying xml year blob
  mediumblob tinyblob`.split(/\s+/)
)

/** Longer than this is drawn plain: colouring it would cost more than it
 * gives. */
export const SQL_HIGHLIGHT_LIMIT = 100_000

// Tried in order at each position; the first that matches wins.
const RULES: [SqlTokenKind | "word", RegExp][] = [
  ["comment", /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  // Postgres's dollar quoting: $$…$$ or $tag$…$tag$.
  ["string", /\$([A-Za-z_]\w*)?\$[\s\S]*?(?:\$\1\$|$)/y],
  ["string", /[eEnNxXbB]?'(?:[^'\\]|''|\\[\s\S])*(?:'|$)/y],
  ["identifier", /"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$)/y],
  ["param", /\{\{\s*[\w.]*\s*\}\}|\[\[|\]\]|\$\d+|\?/y],
  ["number", /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w$])/y],
  ["word", /[A-Za-z_][\w$]*/y],
  ["text", /\s+|[^\sA-Za-z_0-9'"`$\-/{}[\]?.]+|[\s\S]/y],
]

export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const push = (kind: SqlTokenKind, text: string) => {
    const last = tokens.at(-1)
    // Plain runs joined, so there are fewer spans to draw.
    if (last && last.kind === kind && kind === "text") last.text += text
    else tokens.push({ kind, text })
  }
  let at = 0
  while (at < sql.length) {
    for (const [kind, rule] of RULES) {
      rule.lastIndex = at
      const match = rule.exec(sql)
      if (!match || !match[0]) continue
      const text = match[0]
      at += text.length
      if (kind !== "word") {
        push(kind, text)
        break
      }
      const lower = text.toLowerCase()
      const previous = tokens.at(-1)
      // `x.select` or `x."from"` is a name, whatever its spelling.
      const qualified = previous?.text.endsWith(".")
      if (!qualified && TYPES.has(lower)) {
        push("type", text)
      } else if (!qualified && KEYWORDS.has(lower)) {
        push("keyword", text)
      } else if (/^\s*\(/.test(sql.slice(at, at + 64))) {
        push("function", text)
      } else {
        push("text", text)
      }
      break
    }
  }
  return tokens
}
