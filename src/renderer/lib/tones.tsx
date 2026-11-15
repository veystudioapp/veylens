import type { CSSProperties, ReactNode } from "react"

import type { Connection, Tone } from "@shared/api"

import { cn } from "@/lib/utils"

/**
 * The colour of each kind of thing, the same wherever it is drawn: the
 * explorer, the tabs, the start page, the chat. A reader learns them once —
 * orange is a dashboard — and then reads the screen by colour.
 */
export const KIND_TONE = {
  table: "blue",
  view: "teal",
  schema: "amber",
  dashboard: "orange",
  context: "green",
  query: "pink",
  chart: "green",
  skill: "amber",
  tool: "blue",
} as const satisfies Record<string, Tone>

export const toneColor = (tone: Tone) => `var(--tone-${tone})`

/** A connection's colour: the one picked, or its engine's. */
export const connectionTone = (connection: Pick<Connection, "engine" | "color">): Tone =>
  connection.color ?? (connection.engine === "postgres" ? "blue" : "orange")

/** An icon drawn in a tone. */
export const toneStyle = (tone: Tone): CSSProperties => ({ color: toneColor(tone) })

const TILE_SIZE = {
  xs: "size-5 rounded-[5px] [&_svg]:size-3",
  sm: "size-6 rounded-md [&_svg]:size-3.5",
  md: "size-8 rounded-lg [&_svg]:size-4",
  lg: "size-10 rounded-[10px] [&_svg]:size-5",
} as const

/** An icon on a wash of its tone, as macOS draws a settings pane's. */
export function IconTile({
  tone,
  size = "sm",
  className,
  children,
}: {
  tone: Tone
  size?: keyof typeof TILE_SIZE
  className?: string
  children: ReactNode
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center", TILE_SIZE[size], className)}
      style={{
        color: toneColor(tone),
        background: `color-mix(in oklch, ${toneColor(tone)} 14%, transparent)`,
      }}
    >
      {children}
    </span>
  )
}
