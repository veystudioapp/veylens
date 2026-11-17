import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { IconButton } from "./icon-button"

/** Copied to the clipboard, and says so for a moment. `text` may be a function,
 * read at the click, for text that is only known once it is drawn. */
export function CopyButton({
  text,
  variant,
  className,
}: {
  text: string | (() => string)
  variant?: "ghost" | "outline"
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <IconButton
      label={copied ? "Copied" : "Copy"}
      variant={variant}
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === "function" ? text() : text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  )
}
