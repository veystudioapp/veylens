import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { autoUpdater as squirrel } from "electron"
import { autoUpdater, type ProgressInfo } from "electron-updater"

/**
 * macOS's in-app update: electron-updater downloads the release's zip, and
 * Squirrel.Mac checks its signature against this app's and swaps the bundle
 * once the app has quit, then reopens it.
 *
 * `log` is truncated and written as it goes: the app is gone by the time
 * Squirrel can fail, and that file is where to look afterwards.
 */
export async function installMacUpdate(input: {
  version: string
  feedUrl: string
  log: string
  onProgress: (received: number, total: number) => void
  onInstalling: () => void
}): Promise<void> {
  const { version, feedUrl, log, onProgress, onInstalling } = input
  mkdirSync(path.dirname(log), { recursive: true })
  writeFileSync(log, "")
  const write = (level: string) => (message: unknown) => {
    const text =
      message instanceof Error ? (message.stack ?? message.message) : String(message)
    try {
      appendFileSync(log, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // A log that cannot be written is no reason to stop an update.
    }
  }
  autoUpdater.logger = {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    debug: write("debug"),
  }
  autoUpdater.autoDownload = false
  // True hands the zip to Squirrel as soon as it arrives, so a refused
  // signature fails while the window is still there to show it.
  autoUpdater.autoInstallOnAppQuit = true
  // A differential download reports no `download-progress`.
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl })

  const check = await autoUpdater.checkForUpdates()
  const offered = check?.updateInfo.version
  if (offered !== version) {
    throw new Error(
      offered
        ? `The release offers ${offered}, not ${version}.`
        : `No macOS update was found in ${version}.`
    )
  }

  // Squirrel's own events, not electron-updater's: its `update-downloaded`
  // fires before Squirrel has checked the signature, the step that can refuse.
  let staged!: () => void
  let refused!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    staged = resolve
    refused = reject
  })
  const progress = (info: ProgressInfo) => onProgress(info.transferred, info.total)
  squirrel.once("update-downloaded", staged)
  squirrel.once("error", refused)
  autoUpdater.on("download-progress", progress)
  autoUpdater.once("update-downloaded", onInstalling)
  try {
    // With `autoInstallOnAppQuit` the download's promise settles only on
    // failure, so it is raced rather than awaited.
    await Promise.race([ready, autoUpdater.downloadUpdate().then(() => ready)])
  } finally {
    squirrel.off("update-downloaded", staged)
    squirrel.off("error", refused)
    autoUpdater.off("download-progress", progress)
    autoUpdater.off("update-downloaded", onInstalling)
  }

  // Quits through `before-quit` like any other quit; ShipIt waits for this
  // process to go, swaps the bundle and opens the new one.
  autoUpdater.quitAndInstall()
}
