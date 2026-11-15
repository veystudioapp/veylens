import { CircleAlert } from "lucide-react"
import type { ReactNode } from "react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/** The centred note a panel shows when it has nothing else to. */
export function EmptyState({
  icon,
  children,
}: {
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  )
}

/** A failure, said where it happened, in words that can be copied. */
export function ErrorNote({
  children,
  className,
  mono,
}: {
  children: ReactNode
  className?: string
  /** For a server's own message, which often quotes SQL. */
  mono?: boolean
}) {
  return (
    <div
      role="alert"
      className={cn(
        "selectable flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs whitespace-pre-wrap text-destructive",
        mono && "font-mono",
        className
      )}
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
