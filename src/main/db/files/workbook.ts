import * as XLSX from "xlsx"
import * as cptable from "xlsx/dist/cpexcel.full"

import { fillMerges, serialDay, serialTime, shapeSheet, type Shaped, type Value } from "./grid"

// Old .xls files keep their text in a code page (Shift_JIS for Japanese
// Excel): without the tables, it reads as garbage.
XLSX.set_cptable(cptable)

export type Sheet = { name: string; table: Shaped }

/** A number format that shows a date, a time or both — and which. */
function dateFormat(format: string | undefined): "date" | "datetime" | "time" | null {
  if (!format || !XLSX.SSF.is_date(format)) return null
  // Quoted text and escapes are not format codes.
  // `m` is a month unless it sits by an hour or a second: h:mm, mm:ss.
  const codes = format
    .replace(/"[^"]*"|\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .toLowerCase()
    .replace(/am\/pm|a\/p/g, "")
    .replace(/h+\s*:\s*m+/g, "h")
    .replace(/m+\s*:\s*s+/g, "s")
  const hasDate = /[ydmeg]/.test(codes)
  const hasTime = /[hs]/.test(codes)
  if (hasDate && hasTime) return "datetime"
  return hasDate ? "date" : "time"
}

/** One cell as a value: a date cell as a `Day`, an error as nothing. */
function valueOf(cell: XLSX.CellObject | undefined, date1904: boolean): Value {
  if (!cell) return null
  switch (cell.t) {
    case "n": {
      const value = cell.v as number
      const kind = dateFormat(typeof cell.z === "string" ? cell.z : undefined)
      if (kind === "time" || (kind && value < 1 && value >= 0 && kind !== "date")) return serialTime(value)
      if (kind) return serialDay(value, kind === "datetime", date1904)
      return value
    }
    case "s":
      return String(cell.v ?? "")
    case "b":
      return Boolean(cell.v)
    case "d":
      return cell.v instanceof Date ? serialDay((cell.v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000, true) : null
    default:
      // e: #N/A, #DIV/0!…; z: a cell with formatting only.
      return null
  }
}

/** Every sheet of a workbook that holds something, as a table. */
export function readWorkbook(data: Uint8Array): Sheet[] {
  const workbook = XLSX.read(data, {
    type: "buffer",
    dense: true,
    cellNF: true,
    cellDates: false,
    cellHTML: false,
    cellStyles: false,
  })
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904)
  const sheets: Sheet[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const data = (sheet as { "!data"?: (XLSX.CellObject | undefined)[][] } | undefined)?.["!data"]
    if (!sheet || !data) continue
    const grid: Value[][] = []
    for (let r = 0; r < data.length; r++) {
      const row = data[r]
      const values: Value[] = []
      if (row) for (let c = 0; c < row.length; c++) values[c] = valueOf(row[c], date1904)
      grid.push(values)
    }
    fillMerges(grid, sheet["!merges"] ?? [])
    const table = shapeSheet(grid.map((row) => Array.from(row, (value) => value ?? null)))
    if (table) sheets.push({ name, table })
  }
  return sheets
}
