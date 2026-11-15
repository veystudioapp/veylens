import { ImageOff, X } from "lucide-react"
import { useEffect, useState } from "react"

import { imageTag } from "@shared/chat-images"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { sentImage } from "@/lib/images"
import { cn } from "@/lib/utils"

/**
 * A picture of a message, as a thumbnail that opens full size. Labelled with
 * the `[Image #n]` the text says, since that tag is how the text refers to it.
 */
export function ImageThumb({
  src,
  n,
  onRemove,
}: {
  /** Null while a sent picture loads; undefined once it is gone. */
  src: string | null | undefined
  n: number
  /** Only in the draft: takes the picture's tag out of the text, which is
   * what takes the picture out of the message. */
  onRemove?: () => void
}) {
  const [open, setOpen] = useState(false)
  const label = imageTag(n)

  return (
    <span className="group/thumb relative inline-flex shrink-0">
      <button
        type="button"
        title={label}
        aria-label={`Open ${label}`}
        disabled={!src}
        onClick={() => setOpen(true)}
        className={cn(
          "flex size-12 items-center justify-center overflow-hidden rounded-md border bg-muted/50 text-muted-foreground",
          "transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:hover:opacity-100"
        )}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            draggable={false}
            className="size-full object-cover"
          />
        ) : src === undefined ? (
          <ImageOff className="size-4" />
        ) : null}
      </button>
      <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded-[3px] bg-black/55 px-1 text-[9px] leading-[13px] font-medium text-white tabular-nums">
        #{n}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          onClick={onRemove}
          className={cn(
            "absolute -top-1.5 -right-1.5 inline-flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs",
            "opacity-0 transition-opacity group-hover/thumb:opacity-100 hover:text-foreground focus-visible:opacity-100"
          )}
        >
          <X className="size-2.5" />
        </button>
      )}
      {src && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-auto max-w-[calc(100vw-4rem)] p-2 sm:max-w-[calc(100vw-4rem)]">
            <DialogTitle className="sr-only">{label}</DialogTitle>
            {/* Contained, never scaled up. */}
            <img
              src={src}
              alt={label}
              className="max-h-[calc(100vh-6rem)] max-w-full rounded-md object-contain"
            />
          </DialogContent>
        </Dialog>
      )}
    </span>
  )
}

/** A sent message's pictures, by the file names it keeps. */
export function SentImages({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pb-1.5">
      {names.map((name, index) => (
        <SentThumb key={name} name={name} n={index + 1} />
      ))}
    </div>
  )
}

function SentThumb({ name, n }: { name: string; n: number }) {
  const [src, setSrc] = useState<string | null | undefined>(null)
  useEffect(() => {
    let live = true
    void sentImage(name).then((url) => live && setSrc(url ?? undefined))
    return () => {
      live = false
    }
  }, [name])
  return <ImageThumb src={src} n={n} />
}
