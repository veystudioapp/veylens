import {
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron"

import type { GatewaySettings, GatewayState, GatewayStatus } from "../shared/api"
import tray1x from "../../resources/tray.png"
import tray2x from "../../resources/tray@2x.png"
import template1x from "../../resources/trayTemplate.png"
import template2x from "../../resources/trayTemplate@2x.png"

const mac = process.platform === "darwin"

/** What the tray needs from the app. */
export type TrayHost = {
  connectionName: (connectionId: string | null) => string
  /** Brings the window up, making one if there is none. */
  open: () => void
  /** Quits for real: the gateways go with it. */
  quit: () => void
  setEnabled: (gateway: GatewaySettings, enabled: boolean) => Promise<unknown>
  switchTo: (gatewayId: string, connectionId: string) => Promise<unknown>
}

function icon(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, dataURL: mac ? template1x : tray1x })
  image.addRepresentation({ scaleFactor: 2, dataURL: mac ? template2x : tray2x })
  // macOS tints a template for the menu bar, light or dark.
  if (mac) image.setTemplateImage(true)
  return image
}

function statusLine(gateway: GatewaySettings, status: GatewayStatus | undefined): string {
  if (!gateway.enabled) return "Off"
  if (status?.error) return status.error
  if (!status?.listening) return "Starting…"
  const sessions = status.sessions
  return `Listening on 127.0.0.1:${gateway.port}${
    sessions ? ` · ${sessions} app connection${sessions === 1 ? "" : "s"}` : ""
  }`
}

function mark(gateway: GatewaySettings, status: GatewayStatus | undefined): string {
  if (!gateway.enabled) return "○"
  if (status?.error) return "⚠︎"
  return "●"
}

/**
 * The gateways in the menu bar (the notification area off macOS): there while
 * any gateway exists, so they can be watched, switched and turned off with
 * the window closed — the app stays running for them. Next to the icon, how
 * many are listening.
 */
export class GatewayTray {
  private tray: Tray | null = null

  constructor(private readonly host: TrayHost) {}

  update(state: GatewayState): void {
    if (state.gateways.length === 0) {
      this.tray?.destroy()
      this.tray = null
      return
    }
    if (!this.tray) {
      this.tray = new Tray(icon())
      // Off macOS a click is no menu: it opens the window, as tray icons do.
      if (!mac) this.tray.on("click", () => this.host.open())
    }
    const listening = state.status.filter((item) => item.listening).length
    if (mac) this.tray.setTitle(listening ? String(listening) : "", { fontType: "monospacedDigit" })
    this.tray.setToolTip(
      `Vey Lens — ${listening} gateway${listening === 1 ? "" : "s"} listening`
    )
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(state)))
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private menu(state: GatewayState): MenuItemConstructorOptions[] {
    const gateways = state.gateways.map((gateway): MenuItemConstructorOptions => {
      const status = state.status.find((item) => item.gatewayId === gateway.id)
      const connections: MenuItemConstructorOptions[] = gateway.connections.map((id) => ({
        label: this.host.connectionName(id),
        type: "radio",
        checked: id === gateway.active,
        click: () => {
          if (id !== gateway.active) this.run(this.host.switchTo(gateway.id, id))
        },
      }))
      return {
        label: `${mark(gateway, status)}  ${gateway.name}  :${gateway.port}`,
        submenu: [
          { label: statusLine(gateway, status), enabled: false },
          { type: "separator" },
          ...(connections.length
            ? [{ label: "Goes to", enabled: false }, ...connections]
            : [{ label: "No connection yet", enabled: false }]),
          { type: "separator" },
          {
            label: gateway.enabled ? "Turn Off" : "Turn On",
            click: () => this.run(this.host.setEnabled(gateway, !gateway.enabled)),
          },
        ],
      }
    })
    return [
      { label: "Gateways", enabled: false },
      ...gateways,
      { type: "separator" },
      { label: "Open Vey Lens", click: () => this.host.open() },
      { type: "separator" },
      { label: "Quit Vey Lens", click: () => this.host.quit() },
    ]
  }

  private run(work: Promise<unknown>): void {
    work.catch((error: unknown) => {
      dialog.showErrorBox("Vey Lens", error instanceof Error ? error.message : String(error))
    })
  }
}
