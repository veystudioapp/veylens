import path from "node:path"

import { app, BrowserWindow, nativeTheme, Notification, safeStorage, shell } from "electron"

import { describeCondition } from "../shared/alerts"
import { IPC, type ChatEvent } from "../shared/api"
import { Alerts } from "./alerts"
import { Assist } from "./assist"
import { AuditLog } from "./audit"
import { Chats } from "./chats"
import { Connections, type Secrets } from "./connections"
import { useSignedInAccount } from "./db/files/google-sheets"
import { Gateway } from "./gateway"
import { GoogleAccount } from "./google-account"
import { registerIpc } from "./ipc"
import { Library } from "./library"

// A data directory of its own for a run that must not touch the real one.
if (process.env.VEYLENS_HOME) {
  app.setPath("userData", path.resolve(process.env.VEYLENS_HOME))
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

/** An update's installer, run at `will-quit` — after `before-quit` has closed
 * the chats and connections. */
let quitTask: (() => void) | null = null

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
    title: "Vey Lens",
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

  // Cmd/Ctrl+W closes the active tab, not the window: the default menu's
  // Close Window would otherwise take it and, off macOS, quit the app.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      (input.meta || input.control) &&
      !input.shift &&
      !input.alt &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC.closeTab)
    }
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
  const alerts = new Alerts(path.join(dataDir, "alerts.json"), connections, broadcast, (alert) => {
    const connection = connections.list().find((item) => item.id === alert.connectionId)
    audit.record({
      actor: "you",
      action: "alert",
      connectionId: alert.connectionId,
      connectionName: connection?.name ?? null,
      status: "ok",
      summary: `The alert "${alert.name}" fired: ${alert.state.value?.toLocaleString("en-US")} ${describeCondition(alert.condition, alert.threshold)}`,
      sql: alert.sql,
    })
    if (!Notification.isSupported()) return
    const notice = new Notification({
      title: alert.name,
      subtitle: connection?.name,
      body: `${alert.state.value?.toLocaleString()} — ${describeCondition(alert.condition, alert.threshold)}`,
    })
    notice.on("click", () => {
      if (!mainWindow) createWindow()
      mainWindow?.show()
      mainWindow?.focus()
      broadcast({ type: "show", target: { kind: "alerts", connectionId: alert.connectionId } })
    })
    notice.show()
  })
  alerts.start()
  const chats = new Chats(dataDir, connections, library, broadcast, audit, alerts)
  const assist = new Assist(dataDir, connections, library)
  // The OAuth client "Sign in with Google" goes through, when this build was
  // made with one (scripts/build-electron.mjs); otherwise one is imported.
  const builtInClient =
    process.env.VEYLENS_GOOGLE_CLIENT_ID && process.env.VEYLENS_GOOGLE_CLIENT_SECRET
      ? {
          clientId: process.env.VEYLENS_GOOGLE_CLIENT_ID,
          clientSecret: process.env.VEYLENS_GOOGLE_CLIENT_SECRET,
        }
      : null
  const google = new GoogleAccount(
    path.join(dataDir, "google-account.json"),
    secrets,
    builtInClient,
    (url) => shell.openExternal(url),
    () => connections.reopenFiles()
  )
  useSignedInAccount(() => google.requestClient())
  const gateway = new Gateway(path.join(dataDir, "gateway.json"), connections, (state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.gatewayState, state)
    }
  })
  registerIpc({
    connections,
    chats,
    library,
    alerts,
    assist,
    audit,
    gateway,
    google,
    updates: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      dataDir,
      progress: (event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(IPC.updateProgress, event)
        }
      },
      quitAndRun: (task) => {
        quitTask = task
        app.quit()
      },
    },
  })

  // In dev the app runs inside the stock Electron bundle, so the Dock shows
  // Electron's atom. A packaged build has the icon baked into its bundle (and
  // `resources/` is not in its `files`), so this is dev-only.
  if (process.env.VITE_DEV_SERVER_URL && process.platform === "darwin") {
    app.dock?.setIcon(path.join(__dirname, "..", "resources", "icon.png"))
  }

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on("before-quit", () => {
    chats.closeAll()
    alerts.stop()
    assist.cancelAll()
    gateway.close()
    void connections.closeAll()
  })
})

app.on("will-quit", () => {
  const task = quitTask
  quitTask = null
  try {
    task?.()
  } catch (error) {
    console.error("The quit task failed:", error)
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
