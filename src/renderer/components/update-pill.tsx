import { ArrowUpCircle } from "lucide-react"
import { useState } from "react"

import type { UpdateProgress } from "@shared/api"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { downloadPercent, installLabel, pendingUpdate, useUpdates } from "@/lib/updates"
import { cn } from "@/lib/utils"

/** A known total is a width; anything else sweeps rather than sitting at 0. */
export function UpdateProgressBar({
  progress,
  className,
}: {
  progress: UpdateProgress | null
  className?: string
}) {
  const percent = downloadPercent(progress)
  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-primary/15", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      {percent === null ? (
        <div className="h-full w-2/5 animate-sweep rounded-full bg-primary" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  )
}

/** What pressing install does, per platform. */
export function updateExplanation(version: string, installable: boolean): string {
  if (!installable) {
    return "Installing from inside the app is macOS and Windows only. The release page has the build for this machine."
  }
  return window.veylens.platform === "win32"
    ? `Vey Lens will quit, run the ${version} installer and reopen. Open chats are stopped and connections closed.`
    : `Vey Lens will download ${version}, check that it is signed by the same developer as this copy, then quit, replace itself and reopen. Open chats are stopped and connections closed.`
}

/**
 * "Update to x.y.z" beside Settings in the explorer's footer, and the sheet
 * that explains what pressing it does — it quits the app, so it asks first.
 */
export function UpdatePill() {
  const update = useUpdates((state) => pendingUpdate(state))
  const installing = useUpdates((state) => state.installing)
  const progress = useUpdates((state) => state.progress)
  const error = useUpdates((state) => state.error)
  const install = useUpdates((state) => state.install)
  const dismiss = useUpdates((state) => state.dismiss)
  const [open, setOpen] = useState(false)

  if (!update) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Vey Lens ${update.version} is available. You are on ${update.current}.`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary outline-none hover:bg-primary/20 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowUpCircle className="size-3 shrink-0" />
        {installing ? installLabel(installing, progress) : `Update to ${update.version}`}
      </button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to Vey Lens {update.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              {updateExplanation(update.version, update.installable)}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <p className="text-xs text-muted-foreground">
            You are on {update.current}.{" "}
            <a
              href={update.url}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              What’s new in {update.version}
            </a>
          </p>

          {installing && (
            <div className="space-y-1.5">
              <UpdateProgressBar progress={progress} />
              <p className="text-xs text-muted-foreground">
                {progress?.stage === "installing"
                  ? "Vey Lens is quitting to replace itself, and reopens when it is done."
                  : `Downloading Vey Lens ${update.version}. Nothing has been replaced yet.`}
              </p>
            </div>
          )}

          {error && <p className="text-xs leading-relaxed text-destructive">{error}</p>}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => dismiss()}>Skip {update.version}</AlertDialogCancel>
            {update.installable ? (
              <AlertDialogAction
                disabled={installing}
                onClick={(event) => {
                  // Held open: if the install fails, this is where it says why.
                  event.preventDefault()
                  void install()
                }}
              >
                {installLabel(installing, progress)}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction render={<a href={update.url} target="_blank" rel="noreferrer" />}>
                Open the release
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
