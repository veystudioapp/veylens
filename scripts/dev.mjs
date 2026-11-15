import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

/**
 * Runs the app in development: the renderer from Vite (hot reload), the main
 * process from a fresh `dist-electron` build. Changes under `src/main`,
 * `src/preload` or `src/shared` need this script restarted.
 *
 *   bun scripts/dev.mjs [electron flags…]
 *
 * Every child is started with the runtime that is running this script, so it
 * works under bun or a recent node whatever `node` on PATH happens to be.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

const VITE_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/

const children = []
let shuttingDown = false

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "pipe",
    detached: process.platform !== "win32",
    ...options,
  })
  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      if (process.platform === "win32" || child.pid === undefined) child.kill()
      else process.kill(-child.pid, "SIGTERM")
    } catch {
      // Already gone.
    }
  }
  process.exit(code)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0))
}

await new Promise((resolve, reject) => {
  const build = start(process.execPath, ["scripts/build-electron.mjs"], {
    stdio: "inherit",
  })
  build.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`electron build failed (${code})`))
  )
})

const vite = start(process.execPath, [
  path.join(root, "node_modules/vite/bin/vite.js"),
])

const url = await new Promise((resolve, reject) => {
  let seen = ""
  vite.stdout.setEncoding("utf8")
  vite.stdout.on("data", (chunk) => {
    process.stdout.write(chunk)
    if (seen) return
    const match = VITE_URL.exec(stripVTControlCharacters(chunk))
    if (match) {
      seen = match[1]
      resolve(seen)
    }
  })
  vite.stderr.setEncoding("utf8")
  vite.stderr.on("data", (chunk) => process.stderr.write(chunk))
  vite.on("close", (code) => {
    if (!seen) reject(new Error(`the dev server exited early (${code})`))
  })
})

// The package's main export is the path of the Electron binary itself.
const electron = start(require("electron"), [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})

electron.on("close", (code) => shutdown(code ?? 0))
