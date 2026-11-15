import path from "node:path"

import { app, BrowserWindow, nativeTheme, safeStorage, shell } from "electron"

import { IPC, type ChatEvent } from "../shared/api"
import { Assist } from "./assist"
import { AuditLog } from "./audit"
import { Chats } from "./chats"
import { Connections, type Secrets } from "./connections"
import { registerIpc } from "./ipc"
import { Library } from "./library"

// A data directory of its own for a run that must not touch the real one.
if (process.env.VEYDATA_HOME) {
  app.setPath("userData", path.resolve(process.env.VEYDATA_HOME))
}

/** Passwords at rest go through the OS keychain where there is one. */
const secrets: Secrets = {
  encrypt: (text) =>
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(text).toString("base64")
      : null,
  decrypt: (data) => {
    try {
      return safeStorage.decryptString(Buffer.from(data, "base64"))
    } catch {
      return null
    }
  },
}

let mainWindow: BrowserWindow | null = null

function broadcast(event: ChatEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.chatEvent, event)
  }
}

function createWindow(): void {
  const mac = process.platform === "darwin"
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Vey Data",
    // The two `--background` values in `index.css`, so the first frame is
    // not a flash of the other theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c21" : "#fdfdfe",
    ...(mac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 15 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => {
    mainWindow = null
  })

  // A link in an answer opens in the browser; nothing navigates this window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else {
    void mainWindow.loadFile(
      path.join(__dirname, "..", "dist-renderer", "index.html")
    )
  }
}

void app.whenReady().then(() => {
  const dataDir = app.getPath("userData")
  const connections = new Connections(
    path.join(dataDir, "connections.json"),
    secrets
  )
  const library = new Library(dataDir, broadcast)
  const audit = new AuditLog(dataDir, broadcast)
  const chats = new Chats(dataDir, connections, library, broadcast, audit)
  const assist = new Assist(dataDir, connections, library)
  registerIpc({ connections, chats, library, assist, audit })

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on("before-quit", () => {
    chats.closeAll()
    assist.cancelAll()
    void connections.closeAll()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
