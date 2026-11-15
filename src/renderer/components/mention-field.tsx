import { Database, Eye, LayoutDashboard, Sigma, Table2 } from "lucide-react"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react"

import type { Tone } from "@shared/api"
import {
  MENTION_WORDS,
  insertMention,
  markMentions,
  mentionQuery,
  rankMentions,
  type MentionKind,
  type MentionQuery,
  type MentionSegment,
  type MentionTarget,
} from "@shared/mentions"

import { primeMentions, useMentionTargets } from "@/lib/mentions"
import { useStore } from "@/lib/store"
import { connectionTone, IconTile, KIND_TONE, toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

const KIND_ICON: Record<MentionKind, ReactNode> = {
  table: <Table2 />,
  view: <Eye />,
  dashboard: <LayoutDashboard />,
  metric: <Sigma />,
  connection: <Database />,
}

const KIND_TONES: Record<Exclude<MentionKind, "connection">, Tone> = {
  table: KIND_TONE.table,
  view: KIND_TONE.view,
  dashboard: KIND_TONE.dashboard,
  metric: KIND_TONE.context,
}

/** A connection keeps its own colour, as in the explorer. */
function useToneOf(): (target: MentionTarget) => Tone {
  const connections = useStore((state) => state.connections)
  return (target) => {
    if (target.kind !== "connection") return KIND_TONES[target.kind]
    const connection = connections.find((item) => item.id === target.connectionId)
    return connection ? connectionTone(connection) : "gray"
  }
}

const MAX_ROWS = 30

/** The parts of the textarea the mirror has to match exactly, or the tint
 * drifts off the words it marks. */
const TEXT_BOX =
  "px-3 pt-2.5 pb-1 text-[13px] leading-relaxed whitespace-pre-wrap break-words"

export type MentionFieldHandle = {
  element: HTMLTextAreaElement | null
  /** Puts an `@` at the caret and opens the menu. */
  startMention(): void
  /** Writes `text` at the caret as a word of its own, and puts the caret
   * after it. */
  insert(text: string): void
}

type Props = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
> & {
  value: string
  onValueChange: (value: string) => void
  /** How many pictures the draft holds: `[Image #1]`…`[Image #n]` are tinted
   * as what they stand for. */
  images?: number
}

/**
 * The chat's field, with `@` to mention a table, dashboard, metric or
 * connection.
 *
 * Still a plain textarea — the caret, undo, IME and paste are the browser's —
 * with a mirror behind it holding the same text in transparent glyphs, so a
 * mention's tint can be drawn exactly where its word is.
 */
export const MentionField = forwardRef<MentionFieldHandle, Props>(
  function MentionField(
    { value, onValueChange, onKeyDown, className, images = 0, ...props },
    ref
  ) {
    const area = useRef<HTMLTextAreaElement>(null)
    const mirror = useRef<HTMLDivElement>(null)
    const list = useRef<HTMLUListElement>(null)
    const targets = useMentionTargets()
    const toneOf = useToneOf()
    const loading = useStore((state) => {
      const id =
        state.viewerContext().connectionId ??
        (state.connections.length === 1 ? state.connections[0]!.id : null)
      return id ? state.trees[id]?.status === "loading" : false
    })

    const [query, setQuery] = useState<MentionQuery | null>(null)
    const [selected, setSelected] = useState(0)
    /** Escape closes the menu until the caret leaves this `@`. */
    const dismissed = useRef<number | null>(null)
    /** Where the caret goes once the text it was computed for is drawn. */
    const pending = useRef<number | null>(null)

    const items = useMemo(
      () => (query ? rankMentions(targets, query.filter, MAX_ROWS) : []),
      [query, targets]
    )
    const open = query !== null && (items.length > 0 || query.filter !== "" || loading)

    useImperativeHandle(ref, () => ({
      get element() {
        return area.current
      },
      startMention() {
        const element = area.current
        if (!element) return
        const at = element.selectionStart ?? value.length
        const end = element.selectionEnd ?? at
        const before = value.slice(0, at)
        const insert = before && !/\s$/.test(before) ? " @" : "@"
        pending.current = at + insert.length
        dismissed.current = null
        onValueChange(before + insert + value.slice(end))
        element.focus()
      },
      insert(text) {
        const element = area.current
        const at = element?.selectionStart ?? value.length
        const end = element?.selectionEnd ?? at
        const before = value.slice(0, at)
        const after = value.slice(end)
        const lead = before && !/\s$/.test(before) ? " " : ""
        const trail = /^\s/.test(after) ? "" : " "
        pending.current = at + lead.length + text.length + trail.length
        onValueChange(before + lead + text + trail + after)
      },
    }))

    useEffect(primeMentions, [])

    // The caret, once the text that put it there is in the field.
    useLayoutEffect(() => {
      const element = area.current
      if (!element || pending.current === null) return
      const caret = pending.current
      pending.current = null
      element.focus()
      element.setSelectionRange(caret, caret)
      refresh(value, caret)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value])

    // The selected row stays in sight as the arrows move it.
    useEffect(() => {
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest" })
    }, [selected, open])

    function refresh(text: string, caret: number) {
      const next = mentionQuery(text, caret)
      if (!next) {
        dismissed.current = null
        setQuery(null)
        return
      }
      if (dismissed.current === next.from) {
        setQuery(null)
        return
      }
      dismissed.current = null
      if (next.from !== query?.from || next.filter !== query.filter) setSelected(0)
      setQuery(next)
      primeMentions()
    }

    function pick(target: MentionTarget) {
      const element = area.current
      if (!element || !query) return
      const next = insertMention(value, query, element.selectionStart, target.token)
      pending.current = next.caret
      setQuery(null)
      onValueChange(next.text)
    }

    function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (open && !event.nativeEvent.isComposing) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (items.length) {
            event.preventDefault()
            const step = event.key === "ArrowDown" ? 1 : -1
            setSelected((index) => (index + step + items.length) % items.length)
          }
          return
        }
        if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
          const target = items[selected]
          if (target) {
            event.preventDefault()
            pick(target)
            return
          }
        }
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          dismissed.current = query.from
          setQuery(null)
          return
        }
      }
      onKeyDown?.(event)
    }

    const segments = markMentions(value, targets)

    return (
      <div className="relative">
        {open && (
          <div className="absolute inset-x-0 bottom-full z-30 mb-1.5 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
              <span>Mention a table, dashboard, metric or connection</span>
              <span className="shrink-0 tabular-nums">↑↓ ↵ esc</span>
            </div>
            {items.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                {loading
                  ? "Loading tables…"
                  : `Nothing here is called “${query.filter}”.`}
              </div>
            ) : (
              <ul
                ref={list}
                role="listbox"
                aria-label="Mentions"
                className="max-h-64 overflow-y-auto p-1"
              >
                {items.map((target, index) => (
                  <li
                    key={`${target.kind}:${target.connectionId}:${target.schema ?? ""}:${target.id ?? target.name}`}
                    role="option"
                    aria-selected={index === selected}
                    onMouseDown={(event) => {
                      // The field keeps focus, and its caret.
                      event.preventDefault()
                      pick(target)
                    }}
                    onMouseMove={() => index !== selected && setSelected(index)}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                      index === selected && "bg-accent text-accent-foreground"
                    )}
                  >
                    <IconTile tone={toneOf(target)} size="xs">
                      {KIND_ICON[target.kind]}
                    </IconTile>
                    <span className="min-w-0 truncate font-medium">{target.label}</span>
                    {target.detail && (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {target.detail}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/80">
                      {MENTION_WORDS[target.kind]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div
          ref={mirror}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden text-transparent",
            TEXT_BOX
          )}
        >
          <Marks segments={segments} toneOf={toneOf} images={images} />
          {"​"}
        </div>
        <textarea
          {...props}
          ref={area}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value)
            refresh(event.target.value, event.target.selectionStart)
          }}
          onSelect={(event) =>
            refresh(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onBlur={(event) => {
            setQuery(null)
            props.onBlur?.(event)
          }}
          onScroll={(event) => {
            if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop
          }}
          onKeyDown={keyDown}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className={cn(
            "relative block w-full resize-none bg-transparent outline-none",
            TEXT_BOX,
            className
          )}
        />
      </div>
    )
  }
)

const IMAGE_TAG = /(\[Image #(\d+)\])/

/** A plain run, with the `[Image #n]` tags that name a held picture tinted. */
function Plain({
  text,
  images,
  visible,
}: {
  text: string
  images: number
  visible?: boolean
}) {
  if (!images || !text.includes("[Image #")) return <span>{text}</span>
  // `split` with a capture group keeps the tag, and its number after it.
  const parts = text.split(IMAGE_TAG)
  const out: ReactNode[] = []
  for (let index = 0; index < parts.length; index += 3) {
    if (parts[index]) out.push(parts[index])
    const tag = parts[index + 1]
    if (tag === undefined) continue
    const n = Number(parts[index + 2])
    out.push(
      n >= 1 && n <= images ? (
        <span
          key={index}
          className={cn(
            "rounded-[3px] bg-muted-foreground/12 ring-1 ring-muted-foreground/25",
            visible && "font-medium text-muted-foreground"
          )}
        >
          {tag}
        </span>
      ) : (
        tag
      )
    )
  }
  return <span>{out}</span>
}

function Marks({
  segments,
  toneOf,
  visible,
  images = 0,
}: {
  segments: MentionSegment[]
  toneOf: (target: MentionTarget) => Tone
  visible?: boolean
  images?: number
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (!segment.target) {
          return <Plain key={index} text={segment.text} images={images} visible={visible} />
        }
        const color = toneColor(toneOf(segment.target))
        return (
          <span
            key={index}
            title={
              visible
                ? `${MENTION_WORDS[segment.target.kind]} ${segment.target.schema ? `${segment.target.schema}.` : ""}${segment.target.name}`
                : undefined
            }
            className={cn("rounded-[3px]", visible && "font-medium")}
            style={{
              backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
              boxShadow: `0 0 0 1px color-mix(in oklab, ${color} 30%, transparent)`,
              color: visible ? color : undefined,
            }}
          >
            {segment.text}
          </span>
        )
      })}
    </>
  )
}

/** A sent message, with its mentions tinted as they were in the field. */
export function MentionText({ text, images = 0 }: { text: string; images?: number }) {
  const targets = useMentionTargets()
  const toneOf = useToneOf()
  return (
    <Marks segments={markMentions(text, targets)} toneOf={toneOf} images={images} visible />
  )
}
