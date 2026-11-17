import type { QueryResult } from "@shared/api"

/** A file handed to the browser to save: Electron asks where. */
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Safe as a file name on every system this runs on. */
export const fileName = (title: string, extension: string) =>
  `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "export"}.${extension}`

const csvCell = (value: string | null) =>
  value === null
    ? ""
    : /[",\n\r]/.test(value)
      ? `"${value.replaceAll('"', '""')}"`
      : value

export function resultCsv(result: Pick<QueryResult, "columns" | "rows">): string {
  return [
    result.columns.map((column) => csvCell(column.name)).join(","),
    ...result.rows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n")
}

export function downloadCsv(
  title: string,
  result: Pick<QueryResult, "columns" | "rows">
): void {
  // The byte-order mark is for Excel, which otherwise reads UTF-8 as ANSI.
  download(
    fileName(title, "csv"),
    new Blob(["﻿", resultCsv(result)], { type: "text/csv;charset=utf-8" })
  )
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** The class that keeps a control — a drag handle, a tile's buttons — out of an export. */
export const EXPORT_HIDDEN = "export-hidden"

/** Height of the export's own heading, in CSS pixels. */
const HEADING = 64

/**
 * A dashboard as a page of its own: the grid's markup as drawn now, the
 * app's styles, the theme the window is in, and a heading saying what it is
 * and as of when. No script: what is printed is what is on screen.
 */
export function dashboardPage(
  grid: HTMLElement,
  title: string,
  subtitle: string
): { html: string; width: number; height: number } {
  const css: string[] = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) css.push(rule.cssText)
    } catch {
      // A sheet from elsewhere does not let its rules be read; the app has none.
    }
  }
  const root = document.documentElement
  const attributes = [...root.attributes]
    .filter((attribute) => attribute.name === "class" || attribute.name.startsWith("data-"))
    .map((attribute) => ` ${attribute.name}="${escapeHtml(attribute.value)}"`)
    .join("")
  const box = grid.getBoundingClientRect()
  const width = Math.ceil(box.width)
  const height = HEADING + Math.ceil(grid.scrollHeight)
  const html = `<!doctype html>
<html${attributes}>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css.join("\n")}</style>
<style>
  @page { margin: 0; }
  html, body { height: auto !important; overflow: visible !important; }
  body { width: ${width}px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .${EXPORT_HIDDEN} { display: none !important; }
  .export-heading { box-sizing: border-box; height: ${HEADING}px; padding: 16px 16px 0; }
  .export-heading h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--foreground); }
  .export-heading p { margin: 2px 0 0; font-size: 11px; color: var(--muted-foreground); }
</style>
</head>
<body class="${escapeHtml(document.body.className)}">
<div class="bg-muted/50 dark:bg-background">
<header class="export-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header>
${grid.outerHTML}
</div>
</body>
</html>`
  return { html, width, height }
}

/** A dashboard saved as a PDF or a PNG, where the user picks. False when they cancel. */
export function exportDashboard(
  grid: HTMLElement,
  title: string,
  subtitle: string,
  format: "pdf" | "png"
): Promise<boolean> {
  return window.veylens.exportDashboard({ ...dashboardPage(grid, title, subtitle), title, format })
}

const PAINT = ["fill", "stroke", "opacity", "font-size", "font-weight", "font-family"]

/**
 * An SVG drawn with CSS — `var(--series-1)`, `fill-muted-foreground` — made
 * to stand on its own: every element's computed paint written onto it, so
 * the picture is the one on screen, in the current theme.
 */
export function standaloneSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const from = [svg, ...svg.querySelectorAll("*")]
  const to = [copy, ...copy.querySelectorAll("*")]
  from.forEach((element, index) => {
    const style = getComputedStyle(element)
    const target = to[index] as SVGElement
    for (const property of PAINT) {
      const value = style.getPropertyValue(property)
      if (value) target.setAttribute(property, value)
    }
    target.removeAttribute("class")
  })
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  return new XMLSerializer().serializeToString(copy)
}

export async function downloadPng(title: string, svg: SVGSVGElement): Promise<void> {
  const width = svg.width.baseVal.value
  const height = svg.height.baseVal.value
  const scale = 2
  const markup = standaloneSvg(svg)
  const image = new Image()
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }))
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("The chart could not be drawn to an image."))
      image.src = url
    })
    const canvas = document.createElement("canvas")
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("No canvas to draw on.")
    // The card's colour behind it, so the picture reads outside the app.
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--card")
      .trim() || "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.scale(scale, scale)
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    )
    if (!blob) throw new Error("The image could not be made.")
    download(fileName(title, "png"), blob)
  } finally {
    URL.revokeObjectURL(url)
  }
}
