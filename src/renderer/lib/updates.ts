import { useEffect } from "react"
import { create } from "zustand"

import type { UpdateCheck, UpdateProgress } from "@shared/api"

/**
 * Whether there is a newer Vey Lens, and the button that installs it.
 *
 * Checked once at launch and then every six hours: releases are rare, and
 * GitHub allows an anonymous address 60 API requests an hour. Nothing pops up —
 * the answer is a pill in the explorer's footer and a section in Settings.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Dismissing is per version: the next release brings the pill back. */
const DISMISSED_KEY = "veylens.update-dismissed"

type Available = Extract<UpdateCheck, { status: "available" }>

type UpdatesState = {
  /** Null until the first check comes back. */
  check: UpdateCheck | null
  checking: boolean
  /** The download has started. There is no "finished": success is the app
   * quitting. */
  installing: boolean
  progress: UpdateProgress | null
  /** Why the download or the installer failed — never a failure of the install
   * itself, which happens after the app is gone (see `update.log`). */
  error: string | null
  dismissed: string | null

  refresh: () => Promise<void>
  install: () => Promise<void>
  dismiss: () => void
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  check: null,
  checking: false,
  installing: false,
  progress: null,
  error: null,
  dismissed: localStorage.getItem(DISMISSED_KEY),

  async refresh() {
    if (get().checking) return
    set({ checking: true })
    try {
      set({ check: await window.veylens.checkForUpdate() })
    } catch (error) {
      set({
        check: {
          status: "unknown",
          current: get().check?.current ?? "",
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      set({ checking: false })
    }
  },

  async install() {
    const check = get().check
    if (check?.status !== "available") return
    set({ installing: true, progress: null, error: null })
    try {
      await window.veylens.installUpdate(check.version)
    } catch (error) {
      set({
        installing: false,
        // A bar left at 63% under an error reads as "still going".
        progress: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  dismiss() {
    const check = get().check
    if (check?.status !== "available") return
    set({ dismissed: check.version })
    localStorage.setItem(DISMISSED_KEY, check.version)
  },
}))

/** The release worth a button, or null. Settings passes `respectDismissal`
 * false: somebody on that page has come to ask. */
export function pendingUpdate(
  state: UpdatesState,
  respectDismissal = true
): Available | null {
  const { check, dismissed } = state
  if (check?.status !== "available") return null
  if (respectDismissal && dismissed === check.version) return null
  return check
}

/** The download's percentage, or null when there is no honest number. */
export function downloadPercent(progress: UpdateProgress | null): number | null {
  if (progress?.stage !== "downloading" || progress.total <= 0) return null
  return Math.min(100, Math.round((progress.received / progress.total) * 100))
}

export function installLabel(
  installing: boolean,
  progress: UpdateProgress | null
): string {
  if (!installing) return "Update and reopen"
  if (progress?.stage === "installing") return "Installing…"
  const percent = downloadPercent(progress)
  return percent === null ? "Downloading…" : `Downloading ${percent}%`
}

/** Starts the checks and listens for progress. Mounted once, by `App`. */
export function useUpdateWatch(): void {
  useEffect(() => {
    const stop = window.veylens.onUpdateProgress((progress) => {
      useUpdates.setState({ progress })
    })
    void useUpdates.getState().refresh()
    const timer = setInterval(() => void useUpdates.getState().refresh(), CHECK_INTERVAL_MS)
    return () => {
      stop()
      clearInterval(timer)
    }
  }, [])
}
