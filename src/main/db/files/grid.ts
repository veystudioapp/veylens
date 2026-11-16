/**
 * A sheet — from an Excel file or a Google Sheet — as a table: where its
 * header is, what its columns are called and what type each one holds.
 *
 * Sheets people keep are not tables. They start with a title and a blank
 * line, merge cells across a group, leave columns empty for spacing and
 * mix a "-" into a column of numbers. What is done about it here is kept
 * small and predictable, so the result can be explained: the header is
 * the first wide row, merged cells repeat their value, empty rows and
 * columns go, and a column that is not all one type is text.
 */

/** A date, or a date and time, as the sheet shows it: no time zone. */
export class Day {
  /** `ms` is the wall-clock reading as if it were UTC. */
  constructor(
    readonly ms: number,
    readonly time: boolean
  ) {}

  get text(): string {
    const iso = new Date(this.ms).toISOString()
    return this.time ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10)
  }
}

export type Value = string | number | boolean | Day | null

export type ColumnType = "BIGINT" | "DOUBLE" | "BOOLEAN" | "DATE" | "TIMESTAMP" | "VARCHAR"

export type Shaped = {
  columns: { name: string; type: ColumnType }[]
  /** One value per column, already of the column's type: a VARCHAR column
   * holds strings only. */
  rows: Value[][]
  /** From 1, as the sheet numbers it; null when the sheet has no header and
   * the columns are named by their letters. */
  headerRow: number | null
}

const DAY_MS = 86_400_000
/** Day 0 of a 1900-based workbook (Excel's, and Google Sheets'). Excel's
 * phantom 29 February 1900 makes serials below 61 a day off; nobody keeps
 * data from January 1900. */
const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)

/** A serial date number as the date (and time) it stands for. */
export function serialDay(serial: number, withTime: boolean, date1904 = false): Day {
  const ms = Math.round(((date1904 ? EPOCH_1904 : EPOCH_1900) + serial * DAY_MS) / 1000) * 1000
  return new Day(ms, withTime && ms % DAY_MS !== 0)
}

/** A time of day alone (a serial below 1) as text: `09:30:00`. */
export function serialTime(serial: number): string {
  const seconds = Math.round((serial - Math.floor(serial)) * 86_400)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

const present = (value: Value | undefined): value is Exclude<Value, null> =>
  value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "")

/** A column's letters, as the sheet heads it: 0 → A, 27 → AB. */
export function columnLetters(index: number): string {
  let name = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

export function textOf(value: Value): string {
  if (value instanceof Day) return value.text
  return value === null ? "" : String(value)
}

/** What one column holds, if it is all one thing. */
function typeOf(values: Value[]): ColumnType {
  let numbers = 0
  let integers = 0
  let booleans = 0
  let dates = 0
  let times = 0
  let seen = 0
  for (const value of values) {
    if (!present(value)) continue
    seen++
    if (typeof value === "number") {
      numbers++
      if (Number.isSafeInteger(value)) integers++
    } else if (typeof value === "boolean") booleans++
    else if (value instanceof Day) {
      dates++
      if (value.time) times++
    }
  }
  if (seen === 0) return "VARCHAR"
  if (numbers === seen) return integers === seen ? "BIGINT" : "DOUBLE"
  if (booleans === seen) return "BOOLEAN"
  if (dates === seen) return times ? "TIMESTAMP" : "DATE"
  return "VARCHAR"
}

/** Names fit for a column: one line, trimmed, none empty, no two the same
 * — DuckDB does not tell `Name` from `name`. */
function columnNames(header: Value[] | null, columns: number[]): string[] {
  const used = new Set<string>()
  return columns.map((column) => {
    const raw = header ? textOf(header[column] ?? null).replace(/\s+/g, " ").trim() : ""
    const base = raw || columnLetters(column)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`
    used.add(name.toLowerCase())
    return name
  })
}

/** Rows looked through for the header: a title above it is a line or two,
 * not pages. */
const HEADER_SCAN = 30

/**
 * The sheet as a table, or null when it holds nothing.
 *
 * The header is the first row, within the first thirty, holding at least
 * three fifths of the cells the widest of them holds: a title in A1 or a
 * "Prepared by" line is narrower than the header under it. When that row
 * is not mostly text — the sheet starts with its data — there is no
 * header, and the columns are named A, B, C as in the sheet.
 */
export function shapeSheet(grid: Value[][]): Shaped | null {
  const counts = grid.map((row) => (row ? row.filter(present).length : 0))
  const widest = Math.max(0, ...counts.slice(0, HEADER_SCAN))
  if (widest === 0) return null
  const at = counts.findIndex((count, index) => index < HEADER_SCAN && count >= Math.max(1, Math.ceil(widest * 0.6)))
  const candidate = grid[at] ?? []
  const labels = candidate.filter(present)
  const isHeader =
    labels.length > 0 && labels.filter((value) => typeof value === "string").length * 2 >= labels.length
  const header = isHeader ? candidate : null
  const body = grid.slice(isHeader ? at + 1 : at).filter((row) => row && row.some(present))

  // Columns with a name or a value; the empty ones between are spacing.
  const width = Math.max(candidate.length, ...body.map((row) => row.length))
  const columns: number[] = []
  for (let column = 0; column < width; column++) {
    if (present(header?.[column]) || body.some((row) => present(row[column]))) columns.push(column)
  }
  if (columns.length === 0) return null

  const names = columnNames(header, columns)
  const types = columns.map((column) => typeOf(body.map((row) => row[column] ?? null)))
  const rows = body.map((row) =>
    columns.map((column, index) => {
      const value = row[column] ?? null
      if (!present(value)) return null
      return types[index] === "VARCHAR" ? textOf(value) : value
    })
  )
  return {
    columns: names.map((name, index) => ({ name, type: types[index]! })),
    rows,
    headerRow: isHeader ? at + 1 : null,
  }
}

/** A merged range — `s` to `e`, from 0 — and the value of its top-left
 * cell written into every cell of it, as a reader of the sheet sees it. */
export function fillMerges(
  grid: Value[][],
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[]
): void {
  for (const { s, e } of merges) {
    const value = grid[s.r]?.[s.c] ?? null
    if (value === null) continue
    for (let r = s.r; r <= e.r; r++) {
      const row = (grid[r] ??= [])
      for (let c = s.c; c <= e.c; c++) if (r !== s.r || c !== s.c) row[c] = value
    }
  }
}
