import type { CSSProperties } from "react"

import type { Tone } from "@shared/api"

import { toneColor } from "@/lib/tones"

/*
 * The app's empty-state drawings: flat shapes in the kind tones (blue tables,
 * orange dashboards, green charts) on a faint wash, so each one says in the
 * app's own colours what will be there once there is something. Colours go
 * through `style`, not presentation attributes, so the CSS variables — and
 * with them dark mode — reach them.
 */

const tone = (name: Tone) => toneColor(name)
const wash = (name: Tone, percent: number) =>
  `color-mix(in oklch, ${toneColor(name)} ${percent}%, transparent)`

const CARD: CSSProperties = { fill: "var(--background)", stroke: "var(--border)" }
const LINE: CSSProperties = { fill: "var(--muted)" }
const INK: CSSProperties = {
  fill: "color-mix(in oklch, var(--foreground) 70%, transparent)",
}

/** A database wired to a chart and a table: for "no connection yet". */
export function ConnectArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={className} aria-hidden>
      <circle cx="122" cy="78" r="66" style={{ fill: wash("blue", 7) }} />

      {/* The database. */}
      <path
        d="M50 48 v58 a31 9 0 0 0 62 0 v-58"
        style={{ fill: wash("blue", 16), stroke: tone("blue"), strokeWidth: 1.5 }}
      />
      <path
        d="M50 67 a31 9 0 0 0 62 0 M50 86 a31 9 0 0 0 62 0"
        style={{ fill: "none", stroke: tone("blue"), strokeWidth: 1.5, opacity: 0.55 }}
      />
      <ellipse
        cx="81"
        cy="48"
        rx="31"
        ry="9"
        style={{ fill: wash("blue", 32), stroke: tone("blue"), strokeWidth: 1.5 }}
      />

      {/* The wire. */}
      <path
        d="M114 78 C128 78 126 58 140 58"
        style={{
          fill: "none",
          stroke: "var(--muted-foreground)",
          strokeWidth: 1.5,
          strokeDasharray: "3 3",
          opacity: 0.6,
        }}
      />
      <circle cx="114" cy="78" r="3" style={{ fill: tone("blue") }} />
      <circle cx="140" cy="58" r="3" style={{ fill: tone("orange") }} />

      {/* A chart. */}
      <rect x="145" y="31" width="68" height="58" rx="9" style={{ fill: wash("gray", 14) }} />
      <rect x="142" y="28" width="68" height="58" rx="9" style={CARD} />
      <rect x="152" y="37" width="24" height="4" rx="2" style={LINE} />
      <rect x="152" y="58" width="8" height="20" rx="2" style={{ fill: tone("orange") }} />
      <rect x="164" y="50" width="8" height="28" rx="2" style={{ fill: tone("green") }} />
      <rect x="176" y="62" width="8" height="16" rx="2" style={{ fill: tone("blue") }} />
      <rect x="188" y="46" width="8" height="32" rx="2" style={{ fill: tone("pink") }} />

      {/* A table. */}
      <rect x="128" y="98" width="82" height="36" rx="7" style={CARD} />
      <path
        d="M128.5 105 a6.5 6.5 0 0 1 6.5 -6.5 h68 a6.5 6.5 0 0 1 6.5 6.5 v4 h-81 z"
        style={{ fill: wash("teal", 22) }}
      />
      <rect x="136" y="116" width="22" height="3.5" rx="1.75" style={LINE} />
      <rect x="164" y="116" width="36" height="3.5" rx="1.75" style={LINE} />
      <rect x="136" y="124" width="16" height="3.5" rx="1.75" style={LINE} />
      <rect x="164" y="124" width="28" height="3.5" rx="1.75" style={LINE} />
    </svg>
  )
}

/** A question and an answer with a chart in it: for an empty chat. */
export function ChatArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 116" className={className} aria-hidden>
      <circle cx="96" cy="60" r="52" style={{ fill: wash("green", 7) }} />

      {/* The question. */}
      <rect x="98" y="12" width="78" height="24" rx="12" style={{ fill: wash("blue", 18) }} />
      <rect x="110" y="22" width="48" height="4" rx="2" style={{ fill: tone("blue"), opacity: 0.6 }} />

      {/* The answer. */}
      <rect x="24" y="44" width="122" height="64" rx="11" style={CARD} />
      <rect x="35" y="54" width="54" height="4" rx="2" style={LINE} />
      <rect x="35" y="62" width="34" height="4" rx="2" style={LINE} />
      <path
        d="M35 98 L53 88 L69 92 L87 77 L105 81 L133 66 L133 100 L35 100 Z"
        style={{ fill: wash("green", 16) }}
      />
      <path
        d="M35 98 L53 88 L69 92 L87 77 L105 81 L133 66"
        style={{
          fill: "none",
          stroke: tone("green"),
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
      <circle cx="133" cy="66" r="3" style={{ fill: tone("green") }} />

      {/* What it ran. */}
      <rect x="140" y="84" width="40" height="18" rx="9" style={{ fill: wash("pink", 16) }} />
      <rect x="150" y="91" width="20" height="4" rx="2" style={{ fill: tone("pink"), opacity: 0.7 }} />
    </svg>
  )
}

/** Tiles waiting to be filled: for an empty dashboard. */
export function DashboardArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 132" className={className} aria-hidden>
      <rect x="8" y="6" width="204" height="120" rx="18" style={{ fill: wash("orange", 7) }} />

      {/* Two headline figures. */}
      <rect x="26" y="22" width="52" height="36" rx="7" style={CARD} />
      <rect x="34" y="31" width="18" height="3.5" rx="1.75" style={LINE} />
      <rect x="34" y="39" width="28" height="8" rx="2" style={INK} />
      <rect x="66" y="41" width="6" height="4" rx="1" style={{ fill: tone("green") }} />
      <rect x="84" y="22" width="52" height="36" rx="7" style={CARD} />
      <rect x="92" y="31" width="22" height="3.5" rx="1.75" style={LINE} />
      <rect x="92" y="39" width="24" height="8" rx="2" style={INK} />
      <rect x="124" y="41" width="6" height="4" rx="1" style={{ fill: tone("red") }} />

      {/* A trend. */}
      <rect x="142" y="22" width="52" height="36" rx="7" style={CARD} />
      <path
        d="M150 49 L160 43 L170 46 L180 35 L186 38"
        style={{
          fill: "none",
          stroke: tone("blue"),
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />

      {/* A breakdown. */}
      <rect x="26" y="64" width="110" height="46" rx="7" style={CARD} />
      {[18, 28, 14, 32, 22, 26, 10].map((height, index) => (
        <rect
          key={index}
          x={36 + index * 13}
          y={100 - height}
          width="8"
          height={height}
          rx="2"
          style={{ fill: tone("orange"), opacity: 0.55 + (index % 3) * 0.2 }}
        />
      ))}

      {/* The next one. */}
      <rect
        x="142"
        y="64"
        width="52"
        height="46"
        rx="7"
        style={{
          fill: "none",
          stroke: "var(--muted-foreground)",
          strokeDasharray: "4 3",
          opacity: 0.5,
        }}
      />
      <path
        d="M168 80 v14 M161 87 h14"
        style={{ stroke: "var(--muted-foreground)", strokeWidth: 1.5, strokeLinecap: "round" }}
      />
    </svg>
  )
}
