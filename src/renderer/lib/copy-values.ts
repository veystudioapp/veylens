import type { Cell, ColumnKind } from "@shared/api"

/** How a column's values are put on the clipboard. */
export type CopyAs = "lines" | "distinct" | "csv" | "sql"

/** A value as a spreadsheet reads it pasted: quoted only when it would
 * otherwise spill into the next cell or row. */
const sheetValue = (value: Cell) =>
  value === null ? "" : /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

const sqlValue = (value: string, kind: ColumnKind) =>
  kind === "number" && /^-?\d+(\.\d+)?$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`

export function columnValuesText(values: Cell[], kind: ColumnKind, as: CopyAs): string {
  switch (as) {
    case "lines":
      return values.map(sheetValue).join("\n")
    case "distinct":
      return [...new Set(values.map(sheetValue))].join("\n")
    case "csv":
      return values
        .map((value) => (value === null ? "" : /[,\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
        .join(", ")
    case "sql":
      // `IN (…, NULL)` matches nothing more: a NULL is left out.
      return `(${[...new Set(values)]
        .filter((value) => value !== null)
        .map((value) => sqlValue(value, kind))
        .join(", ")})`
  }
}

