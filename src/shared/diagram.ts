/**
 * A schema diagram worked out from the catalogue: the keys the database
 * declares, the ones its column names suggest, where each table goes, and the
 * line from a key to what it points at. Pure, so the renderer draws what the
 * tests check.
 */
import type { DiagramLink, DiagramTable, SchemaDiagram } from "./api"

export const tableKeyOf = (ref: { schema: string; name?: string; table?: string }) =>
  `${ref.schema}.${ref.name ?? ref.table ?? ""}`

/** `customer_id`, `customerId`, `CustomerID` → `customer`; anything else, null. */
export function idStem(column: string): string | null {
  const match = /^(.+?)(?:_id|Id|ID)$/.exec(column)
  if (!match?.[1]) return null
  return match[1].replace(/_+$/, "").toLowerCase() || null
}

/** The names a table holding `stem` things is usually given. */
function namesFor(stem: string): string[] {
  const out = [stem, `${stem}s`, `${stem}es`]
  if (/[^aeiou]y$/.test(stem)) out.push(`${stem.slice(0, -1)}ies`)
  return out
}

/**
 * Keys the database does not declare, read off the names: `orders.customer_id`
 * points at `customers.id` when `customers` has `id` as its whole primary key.
 * A column a declared key already covers is left alone, and a table in the
 * column's own schema wins over one of the same name elsewhere.
 */
export function inferLinks(tables: DiagramTable[], declared: DiagramLink[]): DiagramLink[] {
  const covered = new Set(
    declared.flatMap((link) => link.from.columns.map((column) => `${tableKeyOf(link.from)}\u0000${column}`))
  )
  const byName = new Map<string, DiagramTable[]>()
  for (const table of tables) {
    const key = table.name.toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), table])
  }
  const singleKey = (table: DiagramTable) => {
    const keys = table.columns.filter((column) => column.primaryKey)
    return keys.length === 1 ? keys[0]! : null
  }

  const out: DiagramLink[] = []
  for (const table of tables) {
    for (const column of table.columns) {
      if (covered.has(`${tableKeyOf(table)}\u0000${column.name}`)) continue
      const stem = idStem(column.name)
      if (!stem) continue
      const candidates = namesFor(stem).flatMap((name) => byName.get(name) ?? [])
      const target =
        candidates.find((item) => item.schema === table.schema && singleKey(item)) ??
        candidates.find((item) => singleKey(item))
      if (!target) continue
      // A table's own key is not a reference to itself.
      if (target === table && singleKey(table)?.name === column.name) continue
      out.push({
        name: `${table.name}.${column.name}`,
        from: { schema: table.schema, table: table.name, columns: [column.name] },
        to: { schema: target.schema, table: target.name, columns: [singleKey(target)!.name] },
        inferred: true,
      })
    }
  }
  return out
}

/** The tables given, and every table a key links to one of them, either way. */
export function relatedTo(keys: Iterable<string>, links: DiagramLink[]): Set<string> {
  const out = new Set(keys)
  const start = new Set(out)
  for (const link of links) {
    const from = tableKeyOf(link.from)
    const to = tableKeyOf(link.to)
    if (start.has(from)) out.add(to)
    if (start.has(to)) out.add(from)
  }
  return out
}

/** Tables a key reaches in either direction, by table. */
export function linkCounts(links: DiagramLink[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const link of links) {
    for (const key of new Set([tableKeyOf(link.from), tableKeyOf(link.to)])) {
      out.set(key, (out.get(key) ?? 0) + 1)
    }
  }
  return out
}

// ── Layout ─────────────────────────────────────────────────────────────────

export const NODE_WIDTH = 248
export const HEADER_HEIGHT = 32
export const ROW_HEIGHT = 22
const NODE_PADDING = 6
const GAP_X = 120
const GAP_Y = 32
const LOOSE_GAP = 72

export type Box = { x: number; y: number; width: number; height: number }

export type DiagramLayout = {
  boxes: Map<string, Box>
  width: number
  height: number
}

/** All of a table's columns, or only the ones a key is made of. */
export type ColumnMode = "all" | "keys"

/** The columns a table shows, in its order. */
export function shownColumns(
  table: DiagramTable,
  links: DiagramLink[],
  mode: ColumnMode
): DiagramTable["columns"] {
  if (mode === "all") return table.columns
  const key = tableKeyOf(table)
  const linked = new Set<string>()
  for (const link of links) {
    if (tableKeyOf(link.from) === key) link.from.columns.forEach((column) => linked.add(column))
    if (tableKeyOf(link.to) === key) link.to.columns.forEach((column) => linked.add(column))
  }
  return table.columns.filter((column) => column.primaryKey || linked.has(column.name))
}

export const nodeHeight = (rows: number) => HEADER_HEIGHT + rows * ROW_HEIGHT + (rows ? NODE_PADDING : 0)

/**
 * Tables in columns by how far down the chain of keys they are: a table that
 * points at nothing on the left, one that points at it to its right. Within a
 * column, each sits near the middle of what it is linked to. Tables linked to
 * nothing are laid out in rows underneath.
 */
export function layoutDiagram(
  tables: DiagramTable[],
  links: DiagramLink[],
  heightOf: (table: DiagramTable) => number
): DiagramLayout {
  const keys = tables.map(tableKeyOf)
  const known = new Set(keys)
  const parents = new Map<string, Set<string>>(keys.map((key) => [key, new Set()]))
  const neighbours = new Map<string, Set<string>>(keys.map((key) => [key, new Set()]))
  for (const link of links) {
    const from = tableKeyOf(link.from)
    const to = tableKeyOf(link.to)
    if (!known.has(from) || !known.has(to) || from === to) continue
    parents.get(from)!.add(to)
    neighbours.get(from)!.add(to)
    neighbours.get(to)!.add(from)
  }

  // Depth along the keys; a cycle is cut where it is found.
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (key: string): number => {
    const done = rank.get(key)
    if (done !== undefined) return done
    if (visiting.has(key)) return 0
    visiting.add(key)
    let depth = 0
    for (const parent of parents.get(key)!) {
      if (visiting.has(parent)) continue
      depth = Math.max(depth, rankOf(parent) + 1)
    }
    visiting.delete(key)
    rank.set(key, depth)
    return depth
  }

  const byKey = new Map(tables.map((table) => [tableKeyOf(table), table]))
  const linked = keys.filter((key) => neighbours.get(key)!.size > 0)
  const loose = keys.filter((key) => neighbours.get(key)!.size === 0)
  for (const key of linked) rankOf(key)

  const columns: string[][] = []
  for (const key of [...linked].sort((a, b) => a.localeCompare(b))) {
    const at = rank.get(key)!
    ;(columns[at] ??= []).push(key)
  }
  for (let index = 0; index < columns.length; index++) columns[index] ??= []

  // Barycentre sweeps: each table toward the middle of its neighbours in the
  // columns already placed, left to right and back.
  const position = new Map<string, number>()
  const remember = () => columns.forEach((column) => column.forEach((key, index) => position.set(key, index)))
  remember()
  const sweep = (order: number[], side: (other: number, mine: number) => boolean) => {
    for (const at of order) {
      const column = columns[at]!
      const weight = new Map<string, number>()
      for (const key of column) {
        const near = [...neighbours.get(key)!].filter((other) => side(rank.get(other)!, at))
        weight.set(
          key,
          near.length ? near.reduce((sum, other) => sum + position.get(other)!, 0) / near.length : position.get(key)!
        )
      }
      column.sort((a, b) => weight.get(a)! - weight.get(b)! || a.localeCompare(b))
      column.forEach((key, index) => position.set(key, index))
    }
  }
  const forward = columns.map((_, index) => index).slice(1)
  const backward = columns.map((_, index) => index).reverse().slice(1)
  for (let round = 0; round < 3; round++) {
    sweep(forward, (other, mine) => other < mine)
    sweep(backward, (other, mine) => other > mine)
  }

  const boxes = new Map<string, Box>()
  const heights = columns.map((column) =>
    column.reduce((sum, key, index) => sum + heightOf(byKey.get(key)!) + (index ? GAP_Y : 0), 0)
  )
  const tallest = Math.max(0, ...heights)
  columns.forEach((column, at) => {
    let y = (tallest - heights[at]!) / 2
    for (const key of column) {
      const height = heightOf(byKey.get(key)!)
      boxes.set(key, { x: at * (NODE_WIDTH + GAP_X), y, width: NODE_WIDTH, height })
      y += height + GAP_Y
    }
  })

  // Tables with no keys either way, in rows below.
  const linkedWidth = columns.length ? columns.length * (NODE_WIDTH + GAP_X) - GAP_X : 0
  const perRow = Math.max(4, Math.floor((linkedWidth + GAP_X / 2) / (NODE_WIDTH + GAP_X / 2)))
  let top = linked.length ? tallest + LOOSE_GAP : 0
  const sortedLoose = [...loose].sort((a, b) => a.localeCompare(b))
  for (let start = 0; start < sortedLoose.length; start += perRow) {
    const row = sortedLoose.slice(start, start + perRow)
    let rowHeight = 0
    row.forEach((key, index) => {
      const height = heightOf(byKey.get(key)!)
      boxes.set(key, { x: index * (NODE_WIDTH + GAP_X / 2), y: top, width: NODE_WIDTH, height })
      rowHeight = Math.max(rowHeight, height)
    })
    top += rowHeight + GAP_Y
  }

  let width = 0
  let height = 0
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.width)
    height = Math.max(height, box.y + box.height)
  }
  return { boxes, width, height }
}

/** The middle of a column's row in its table, or of the header when not shown. */
export function rowY(box: Box, index: number): number {
  return index < 0 ? box.y + HEADER_HEIGHT / 2 : box.y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2
}

/**
 * The curve from a key's row to the row it points at, leaving and arriving
 * on the sides that face each other. A table pointing at itself, or two in
 * the same column, loop out to the right.
 */
export function linkPath(from: Box, fromY: number, to: Box, toY: number): string {
  const fromRight = from.x + from.width
  const toRight = to.x + to.width
  if (from === to || Math.abs(from.x - to.x) < 1) {
    const reach = 36 + Math.min(80, Math.abs(fromY - toY) / 4)
    const x = Math.max(fromRight, toRight)
    return `M ${fromRight} ${fromY} C ${x + reach} ${fromY}, ${x + reach} ${toY}, ${toRight} ${toY}`
  }
  const leftward = from.x > to.x
  const startX = leftward ? from.x : fromRight
  const endX = leftward ? toRight : to.x
  const bend = Math.max(48, Math.abs(endX - startX) / 2)
  const sign = leftward ? -1 : 1
  return `M ${startX} ${fromY} C ${startX + sign * bend} ${fromY}, ${endX - sign * bend} ${toY}, ${endX} ${toY}`
}

// ── Mermaid ────────────────────────────────────────────────────────────────

const mermaidName = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "_"

/**
 * The diagram as Mermaid's `erDiagram`, for a README or a pull request. Types
 * lose what Mermaid cannot spell; an inferred key is labelled as such.
 */
export function toMermaid(diagram: SchemaDiagram, links: DiagramLink[] = diagram.links): string {
  const qualified = new Set(diagram.tables.map((table) => table.schema)).size > 1
  const nameOf = (ref: { schema: string; table?: string; name?: string }) =>
    mermaidName(qualified && ref.schema !== diagram.schema ? `${ref.schema}_${ref.name ?? ref.table}` : (ref.name ?? ref.table ?? ""))
  const foreign = new Set(links.flatMap((link) => link.from.columns.map((column) => `${tableKeyOf(link.from)}\u0000${column}`)))

  const lines = ["erDiagram"]
  for (const table of diagram.tables) {
    lines.push(`  ${nameOf(table)} {`)
    for (const column of table.columns) {
      const marks = [
        column.primaryKey ? "PK" : null,
        foreign.has(`${tableKeyOf(table)}\u0000${column.name}`) ? "FK" : null,
      ].filter(Boolean)
      lines.push(`    ${mermaidName(column.type)} ${mermaidName(column.name)}${marks.length ? ` ${marks.join(", ")}` : ""}`)
    }
    lines.push("  }")
  }
  const byKey = new Map(diagram.tables.map((table) => [tableKeyOf(table), table]))
  for (const link of links) {
    const child = byKey.get(tableKeyOf(link.from))
    const optional = link.from.columns.some((name) => child?.columns.find((column) => column.name === name)?.nullable)
    const label = `${link.from.columns.join(", ")}${link.inferred ? " (inferred)" : ""}`
    lines.push(`  ${nameOf(link.to)} ${optional ? "|o" : "||"}--o{ ${nameOf(link.from)} : "${label.replace(/"/g, "'")}"`)
  }
  return lines.join("\n")
}
