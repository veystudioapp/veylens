import type { DesktopApi } from "@shared/api"

declare global {
  interface Window {
    /** The preload's bridge to the main process — see `src/shared/api.ts`. */
    veylens: DesktopApi
  }
}
