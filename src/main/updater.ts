import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import type { UpdateCheck } from "../shared/api"
import { isNewer } from "../shared/version"

/**
 * Whether there is a newer Vey Lens, and installing it on Windows.
 *
 * The check is GitHub's `releases/latest` on every platform. macOS installs
 * through electron-updater's Squirrel.Mac (`electron-updates.ts`), which needs
 * `electron` and so is not here; Windows downloads the NSIS `.exe` here, so the
 * wait has a percentage, and runs it silently once the app has quit.
 */

const REPO = "veystudioapp/veylens"
const API = `https://api.github.com/repos/${REPO}/releases`
// GitHub rejects an anonymous API request with no user agent as a 403.
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "Vey Lens" }

/** Short, because the check runs unasked on a timer and an unreachable GitHub
 * should read as `unknown` rather than leave a request pending. */
const REQUEST_TIMEOUT_MS = 10_000

/** IPC messages per second while downloading; a chunk each would be thousands. */
const PROGRESS_INTERVAL_MS = 100

/**
 * One release's download directory: the feed electron-updater's generic
 * provider reads `latest-mac.yml` from. Pinned to the version the button was
 * pressed for, not whatever is latest by the time it is pressed.
 */
export function releaseFeedUrl(version: string): string {
  const bare = version.replace(/^v/, "")
  return `https://github.com/${REPO}/releases/download/v${encodeURIComponent(bare)}`
}

export async function checkForUpdate(
  current: string,
  platform: NodeJS.Platform
): Promise<UpdateCheck> {
  let record: Record<string, unknown>
  try {
    const response = await fetch(`${API}/latest`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) throw new Error("GitHub sent no release.")
    record = body as Record<string, unknown>
    if (typeof record.tag_name !== "string" || !record.tag_name) {
      throw new Error("The latest release has no tag.")
    }
  } catch (error) {
    return {
      status: "unknown",
      current,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const version = (record.tag_name as string).replace(/^v/, "")
  if (!isNewer(version, current)) return { status: "current", current }
  return {
    status: "available",
    version,
    current,
    notes: typeof record.body === "string" ? record.body : "",
    url:
      typeof record.html_url === "string"
        ? record.html_url
        : `https://github.com/${REPO}/releases`,
    installable: platform === "darwin" || platform === "win32",
  }
}

type Asset = { url: string; name: string; size: number }

/** The Windows installer among a release's assets, found by its own name's
 * suffix rather than a filename this app would have to guess. */
export function windowsInstaller(release: unknown, arch: string): Asset | null {
  if (typeof release !== "object" || release === null) return null
  const assets = (release as Record<string, unknown>).assets
  if (!Array.isArray(assets)) return null
  for (const entry of assets) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const { name, browser_download_url: url, size } = record
    if (typeof name !== "string" || typeof url !== "string") continue
    if (!name.endsWith(`-${arch}.exe`)) continue
    return { name, url, size: typeof size === "number" && size > 0 ? size : 0 }
  }
  return null
}

/** Downloads a release's Windows installer into `dir`, which is emptied first,
 * and answers with the file's path. */
export async function downloadWindowsUpdate(input: {
  version: string
  arch: string
  dir: string
  onProgress: (received: number, total: number) => void
}): Promise<string> {
  const bare = input.version.replace(/^v/, "")
  const response = await fetch(`${API}/tags/v${encodeURIComponent(bare)}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
  const asset = windowsInstaller(await response.json(), input.arch)
  if (!asset) throw new Error(`No Windows ${input.arch} installer in ${bare}.`)

  await rm(input.dir, { recursive: true, force: true })
  await mkdir(input.dir, { recursive: true })
  const file = path.join(input.dir, asset.name)

  // No timeout: a slow link is not a hung request, and somebody is watching.
  const download = await fetch(asset.url, { headers: { "User-Agent": HEADERS["User-Agent"] } })
  if (!download.ok || !download.body) {
    throw new Error(`The download answered ${download.status}.`)
  }
  const declared = Number(download.headers.get("content-length"))
  const total = Number.isFinite(declared) && declared > 0 ? declared : asset.size

  let received = 0
  let announced = 0
  const body = Readable.fromWeb(download.body as WebReadableStream<Uint8Array>)
  body.on("data", (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - announced < PROGRESS_INTERVAL_MS) return
    announced = now
    input.onProgress(received, total)
  })
  await pipeline(body, createWriteStream(file))
  input.onProgress(received, total)
  return file
}

/**
 * Starts the NSIS installer, detached, from `will-quit` — after the app's own
 * quit, so it does not race the cleanup. `/S` is silent, `--updated` closes any
 * copy still running, `--force-run` reopens the app afterwards.
 */
export function startWindowsInstaller(file: string): void {
  spawn(file, ["/S", "--updated", "--force-run"], {
    detached: true,
    stdio: "ignore",
    // Not the install directory, which this is about to replace.
    cwd: path.dirname(file),
  }).unref()
}
