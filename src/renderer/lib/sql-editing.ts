/**
 * The few edits an SQL editor is expected to make by itself — indent,
 * outdent, comment a line out — worked out as one replacement, so the caller
 * applies it as a single, undoable insertion.
 */

export type TextEdit = {
  /** The range replaced… */
  from: number
  to: number
  /** …by this. */
  insert: string
  /** The selection afterwards. */
  selectStart: number
  selectEnd: number
}

const INDENT = "  "

/** The whole lines a selection touches. One ending at the very start of a
 * line does not take that line. */
function lineSpan(text: string, start: number, end: number) {
  const from = text.lastIndexOf("\n", start - 1) + 1
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end
  const next = text.indexOf("\n", last)
  return { from, to: next === -1 ? text.length : next }
}

/** Where a column lands once its line is changed by one insertion or one
 * deletion, found where the two first differ. */
function movedColumn(column: number, old: string, next: string): number {
  let common = 0
  while (common < old.length && common < next.length && old[common] === next[common]) common++
  const delta = next.length - old.length
  if (delta >= 0) return column < common ? column : column + delta
  // Inside what was taken out: at the place it was taken from.
  return column <= common ? column : Math.max(common, column + delta)
}

/** Where a position on the lines lands once they are replaced. */
function shifted(position: number, from: number, before: string[], after: string[]): number {
  let at = from
  let moved = from
  for (let index = 0; index < before.length; index++) {
    const old = before[index]!
    const next = after[index]!
    if (position <= at + old.length) return moved + movedColumn(position - at, old, next)
    at += old.length + 1
    moved += next.length + 1
  }
  return moved
}

function replaceLines(
  text: string,
  start: number,
  end: number,
  change: (lines: string[]) => string[]
): TextEdit | null {
  const { from, to } = lineSpan(text, start, end)
  const before = text.slice(from, to).split("\n")
  const after = change(before)
  const insert = after.join("\n")
  if (insert === text.slice(from, to)) return null
  return {
    from,
    to,
    insert,
    selectStart: shifted(start, from, before, after),
    selectEnd: shifted(end, from, before, after),
  }
}

/** Tab: two spaces at the caret, or every selected line indented. Shift-Tab:
 * the lines outdented. */
export function indentEdit(
  text: string,
  start: number,
  end: number,
  outdent: boolean
): TextEdit | null {
  if (!outdent && start === end) {
    return { from: start, to: end, insert: INDENT, selectStart: start + 2, selectEnd: start + 2 }
  }
  return replaceLines(text, start, end, (lines) =>
    lines.map((line) =>
      outdent ? line.replace(/^( {1,2}|\t)/, "") : line ? INDENT + line : line
    )
  )
}

/** ⌘/: the lines commented out with `-- `, or — when every one already is —
 * back in. */
export function commentEdit(text: string, start: number, end: number): TextEdit | null {
  return replaceLines(text, start, end, (lines) => {
    const filled = lines.filter((line) => line.trim())
    if (filled.length === 0) return lines.map((line) => `-- ${line}`)
    if (filled.every((line) => /^\s*--/.test(line))) {
      return lines.map((line) => line.replace(/^(\s*)-- ?/, "$1"))
    }
    const margin = Math.min(...filled.map((line) => /^\s*/.exec(line)![0].length))
    return lines.map((line) =>
      line.trim() ? `${line.slice(0, margin)}-- ${line.slice(margin)}` : line
    )
  })
}

/** The caret's line and column, both from 1. */
export function caretAt(text: string, position: number): { line: number; column: number } {
  let line = 1
  for (let index = text.indexOf("\n"); index !== -1 && index < position; index = text.indexOf("\n", index + 1)) {
    line++
  }
  return { line, column: position - (text.lastIndexOf("\n", position - 1) + 1) + 1 }
}
