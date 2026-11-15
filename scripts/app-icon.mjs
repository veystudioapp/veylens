// Renders resources/icon.png (1024×1024) from resources/logo.svg.
//
// electron-builder resizes whatever PNG it is handed to a square 1024 and does
// not letterbox, so a plate drawn edge to edge would sit larger than every
// other icon in the Dock. Apple's macOS grid keeps the artwork in an 824 box
// centred in the 1024 tile; the plate is placed there and rendered straight
// from the vector, no resampling.
//
//   bun scripts/app-icon.mjs

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Resvg } from "@resvg/resvg-js"

const CANVAS = 1024
const CONTENT = 824

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources")
const logo = readFileSync(path.join(dir, "logo.svg"), "utf8")
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
const offset = (CANVAS - CONTENT) / 2

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">
<svg x="${offset}" y="${offset}" width="${CONTENT}" height="${CONTENT}" viewBox="0 0 100 100" fill="none">${inner}</svg>
</svg>`

const out = path.join(dir, "icon.png")
writeFileSync(out, new Resvg(svg).render().asPng())
console.log(`${out}  ${CANVAS}×${CANVAS}`)
