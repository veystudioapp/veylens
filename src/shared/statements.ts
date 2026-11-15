/**
 * What kind of statement a piece of SQL is, by how it starts. Shared: the
 * main process refuses on it, the renderer asks before it.
 */

const READ_KEYWORDS = new Set([
  "select",
  "with",
  "show",
  "explain",
  "describe",
  "desc",
  "table",
  "values",
])

/** The first keyword, past comments and opening parentheses. */
export function leadingKeyword(sql: string): string | null {
  let rest = sql
  for (;;) {
    const trimmed = rest.replace(/^[\s(]+/, "")
    const comment =
      /^--[^\n]*(\n|$)/.exec(trimmed) ??
      /^#[^\n]*(\n|$)/.exec(trimmed) ??
      /^\/\*[\s\S]*?\*\//.exec(trimmed)
    rest = comment ? trimmed.slice(comment[0].length) : trimmed
    if (!comment) break
  }
  return /^[a-z]+/i.exec(rest)?.[0].toLowerCase() ?? null
}

/**
 * Whether it starts like a read. Not proof — a CTE can hide a write — which
 * is why a read also runs in a read-only transaction; this is the first
 * check, and the one that catches what such a transaction lets through.
 */
export function startsLikeRead(sql: string): boolean {
  const keyword = leadingKeyword(sql)
  return (
    keyword !== null &&
    READ_KEYWORDS.has(keyword) &&
    !/\binto\s+(outfile|dumpfile)\b/i.test(sql)
  )
}
