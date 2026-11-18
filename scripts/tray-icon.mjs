// Renders the menu bar / system tray icons into resources/:
//
//   trayTemplate.png, trayTemplate@2x.png — macOS: the mark in black on
//     clear, 18pt. A template image, so macOS tints it for a light or dark
//     menu bar itself.
//   tray.png, tray@2x.png — Windows and Linux: the plate in colour, 16px,
//     whatever the taskbar's colour.
//
// The main process bundles them as data URLs (scripts/build-electron.mjs), so
// they need not be in the packaged app's files.
//
//   bun scripts/tray-icon.mjs

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Resvg } from "@resvg/resvg-js"

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources")

function render(source, size, out) {
  const svg = readFileSync(path.join(dir, source), "utf8")
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()
  writeFileSync(path.join(dir, out), png)
  console.log(`${path.join(dir, out)}  ${size}×${size}`)
}

render("mark.svg", 18, "trayTemplate.png")
render("mark.svg", 36, "trayTemplate@2x.png")
render("logo.svg", 16, "tray.png")
render("logo.svg", 32, "tray@2x.png")
