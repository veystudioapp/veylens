import path from "node:path"

import {
  app,
  autoUpdater,
  BrowserWindow,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
} from "electron"

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
import { GatewayTray } from "./tray"

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

/**
 * Whether a quit is to go through. While a gateway is on, a quit — Cmd+Q, the
 * Dock's Quit, the last window closing — only closes the window: the app
 * stays in the menu bar so the apps going through its gateways keep their
 * database. The tray's Quit, an update and the machine shutting down set this
 * and quit for real.
 */
let quitting = false

/** Set once the gateways are up. */
let gatewaysOn = (): boolean => false

/** Brings the window up, making one if there is none — the Dock icon back
 * too, when it was hidden for the menu bar. */
async function showWindow(): Promise<void> {
  if (process.platform === "darwin") await app.dock?.show()
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Closes the windows and goes on in the menu bar alone. */
function runInBackground(): void {
  for (const window of BrowserWindow.getAllWindows()) window.close()
  if (process.platform === "darwin") app.dock?.hide()
}

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
    notice.on("click", async () => {
      await showWindow()
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
  let tray: GatewayTray | null = null
  const gateway = new Gateway(path.join(dataDir, "gateway.json"), connections, (state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.gatewayState, state)
    }
    tray?.update(state)
  })
  gatewaysOn = () => gateway.state().gateways.some((item) => item.enabled)
  gateway.watchQueries((batch) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.gatewayQueryBatch, batch)
    }
  })
  const handlers = registerIpc({
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
        quitting = true
        app.quit()
      },
    },
  })

  tray = new GatewayTray({
    connectionName: (connectionId) => gateway.connectionName(connectionId),
    open: () => void showWindow(),
    quit: () => {
      quitting = true
      app.quit()
    },
    setEnabled: (settings, enabled) => handlers.saveGateway({ ...settings, enabled }),
    switchTo: (gatewayId, connectionId) => handlers.switchGateway(gatewayId, connectionId),
  })
  tray.update(gateway.state())
  // macOS's update (Squirrel) and the machine shutting down quit for real.
  autoUpdater.on("before-quit-for-update", () => {
    quitting = true
  })
  powerMonitor.on("shutdown", () => {
    quitting = true
  })
  // So does a signal — the dev script's Ctrl+C, a `kill`.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      quitting = true
      app.quit()
    })
  }

  // In dev the app runs inside the stock Electron bundle, so the Dock shows
  // Electron's atom. A packaged build has the icon baked into its bundle (and
  // `resources/` is not in its `files`), so this is dev-only.
  if (process.env.VITE_DEV_SERVER_URL && process.platform === "darwin") {
    app.dock?.setIcon(path.join(__dirname, "..", "resources", "icon.png"))
  }

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void showWindow()
  })

  app.on("before-quit", (event) => {
    if (!quitting && gatewaysOn()) {
      event.preventDefault()
      runInBackground()
      return
    }
    quitting = true
    tray?.destroy()
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

// With a gateway on, the app goes on in the menu bar (the notification area
// off macOS) — without its Dock icon on macOS, where it would otherwise stay.
app.on("window-all-closed", () => {
  if (quitting) return
  if (gatewaysOn()) {
    if (process.platform === "darwin") app.dock?.hide()
    return
  }
  if (process.platform !== "darwin") app.quit()
})
