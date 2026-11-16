import { useEffect } from "react"
import { create } from "zustand"

import type { GatewaySettings, GatewayState } from "@shared/api"

import { errorMessage } from "./store"

/**
 * The gateway as the main process last told it: its settings, password and
 * whether each port is listening. Kept current by `useGatewayWatch`.
 */
type GatewayStore = {
  state: GatewayState | null
  /** The last save or switch that failed, and why. */
  error: string | null
  /** The gateway being switched, and to which connection. */
  switching: { gatewayId: string; connectionId: string } | null

  /** Resolves with the new state, or null when it was refused. */
  save: (settings: GatewaySettings) => Promise<GatewayState | null>
  remove: (gatewayId: string) => Promise<void>
  switchTo: (gatewayId: string, connectionId: string) => Promise<void>
  resetPassword: () => Promise<void>
  clearError: () => void
}

export const useGateway = create<GatewayStore>((set) => ({
  state: null,
  error: null,
  switching: null,

  async save(settings) {
    try {
      const state = await window.veylens.saveGateway(settings)
      set({ state, error: null })
      return state
    } catch (error) {
      set({ error: errorMessage(error) })
      return null
    }
  },

  async remove(gatewayId) {
    try {
      set({ state: await window.veylens.deleteGateway(gatewayId), error: null })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async switchTo(gatewayId, connectionId) {
    set({ switching: { gatewayId, connectionId } })
    try {
      set({ state: await window.veylens.switchGateway(gatewayId, connectionId), error: null })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ switching: null })
    }
  },

  clearError() {
    set({ error: null })
  },

  async resetPassword() {
    try {
      set({ state: await window.veylens.resetGatewayPassword(), error: null })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },
}))

/** Loads the gateway once and follows what the main process says of it. */
export function useGatewayWatch(): void {
  useEffect(() => {
    const stop = window.veylens.onGatewayState((state) => useGateway.setState({ state }))
    void window.veylens.getGateway().then((state) => useGateway.setState({ state }))
    return stop
  }, [])
}

/** The `.env` lines for a route: a URL, and the parts for an app that wants
 * them apart. */
export function envSnippet(
  engine: "postgres" | "mysql",
  port: number,
  password: string,
  database: string
): string {
  const scheme = engine === "mysql" ? "mysql" : "postgresql"
  const db = database || "app"
  return [
    `# The gateway signs in to the picked connection's own database; the`,
    `# name below is used only when that connection names none.`,
    `DATABASE_URL=${scheme}://gateway:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`,
    `DB_HOST=127.0.0.1`,
    `DB_PORT=${port}`,
    `DB_USER=gateway`,
    `DB_PASSWORD=${password}`,
    `DB_NAME=${db}`,
  ].join("\n")
}
