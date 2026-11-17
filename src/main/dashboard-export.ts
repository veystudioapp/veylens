import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { app, BrowserWindow, dialog } from "electron"

import type { DashboardExport } from "../shared/api"

/** Chromium's PDF pages stop at 200 inches; a taller dashboard goes on A4s. */
const MAX_PAGE_INCHES = 200
/** No dashboard is wider or taller than this; past it the input is not one. */
const MAX_PIXELS = 30_000

const fileName = (title: string, extension: string) =>
  `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "dashboard"}.${extension}`

function checked(input: DashboardExport): DashboardExport {
  const size = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PIXELS
  if (
    !input ||
    typeof input.html !== "string" ||
    typeof input.title !== "string" ||
    !size(input.width) ||
    !size(input.height) ||
    (input.format !== "pdf" && input.format !== "png")
  ) {
    throw new Error("Not a dashboard to export.")
  }
  return input
}

/**
 * The page the renderer made of a dashboard, drawn in a hidden window with
 * no script and no bridge, printed or captured, and saved where the user
 * says.
 */
export async function exportDashboard(raw: DashboardExport): Promise<boolean> {
  const input = checked(raw)
  const width = Math.ceil(input.width)
  const height = Math.ceil(input.height)
  const extension = input.format
  const owner = BrowserWindow.getFocusedWindow()
  const options: Electron.SaveDialogOptions = {
    title: `Export ${extension.toUpperCase()}`,
    defaultPath: fileName(input.title, extension),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  }
  const target = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
  if (target.canceled || !target.filePath) return false

  const dir = await mkdtemp(path.join(app.getPath("temp"), "veylens-export-"))
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Its own session, in memory: the guard below must not reach the app's.
      partition: "veylens-export",
    },
  })
  try {
    // A page of the app's own markup: nothing in it may leave for the network.
    window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("data:") })
    )
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const file = path.join(dir, "dashboard.html")
    await writeFile(file, input.html, "utf8")
    await window.loadFile(file)
    // Loaded is not yet painted.
    await new Promise((resolve) => setTimeout(resolve, 200))

    let data: Buffer
    if (input.format === "pdf") {
      const inches = { width: width / 96, height: height / 96 }
      data = await window.webContents.printToPDF(
        inches.height <= MAX_PAGE_INCHES
          ? { pageSize: inches, margins: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true }
          : {
              pageSize: "A4",
              landscape: true,
              margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
              printBackground: true,
            }
      )
    } else {
      window.setContentSize(width, height)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const image = await window.webContents.capturePage({ x: 0, y: 0, width, height })
      data = image.toPNG()
    }
    await writeFile(target.filePath, data)
    return true
  } finally {
    window.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}
