import {
  ChartColumn,
  History,
  LayoutDashboard,
  MessageSquare,
  PencilLine,
  Search,
  Trash2,
} from "lucide-react"
import { useMemo, useState } from "react"

import type { ChatSummary } from "@shared/api"

import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useStore } from "@/lib/store"
import { KIND_TONE, toneStyle } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { confirm } from "./confirm"
import { IconButton } from "./icon-button"

const DAY = 86_400_000

/** Lower case, without diacritics: "Xoá" is found by "xoa". */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()

/** Which heading a chat goes under, by when it was last written to. */
export function historyGroup(time: number, now = Date.now()): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (time >= start) return "Today"
  if (time >= start - DAY) return "Yesterday"
  if (time >= start - 6 * DAY) return "Previous 7 days"
  if (time >= start - 29 * DAY) return "Previous 30 days"
  return new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" })
}

/** The time beside a chat: the hour today, the weekday this week, else the date. */
export function historyTime(time: number, now = Date.now()): string {
  const date = new Date(time)
  const group = historyGroup(time, now)
  if (group === "Today") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (group === "Yesterday" || group === "Previous 7 days") {
    return date.toLocaleDateString(undefined, { weekday: "short" })
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })
}

function Row({
  chat,
  current,
  onPick,
  onDelete,
}: {
  chat: ChatSummary
  current: boolean
  onPick: () => void
  onDelete: () => void
}) {
  const marks = [
    chat.did.chart && (
      <ChartColumn key="chart" aria-label="Drew charts" style={toneStyle(KIND_TONE.chart)} />
    ),
    chat.did.dashboard && (
      <LayoutDashboard
        key="dashboard"
        aria-label="Built a dashboard"
        style={toneStyle(KIND_TONE.dashboard)}
      />
    ),
    chat.did.change && (
      <PencilLine key="change" aria-label="Changed data" style={toneStyle("red")} />
    ),
  ].filter(Boolean)

  return (
    <div
      role="option"
      aria-selected={current}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key === "Enter") onPick()
      }}
      className={cn(
        "group/chat relative flex cursor-default gap-2.5 rounded-md px-2 py-2 outline-offset-[-2px]",
        current ? "bg-accent" : "hover:bg-accent/60"
      )}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {chat.busy ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : current ? (
          <span className="size-2 rounded-full bg-primary" aria-label="Open" />
        ) : (
          <MessageSquare className="size-3.5 text-muted-foreground/70" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", current && "font-medium")}>
            {chat.title}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover/chat:invisible">
            {historyTime(chat.updatedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {marks.length > 0 && (
            <span className="flex shrink-0 gap-1 [&_svg]:size-3">{marks}</span>
          )}
          <span className="min-w-0 truncate">
            {chat.preview || `${chat.turns} ${chat.turns === 1 ? "message" : "messages"}, no answer`}
          </span>
        </div>
      </div>
      {/* Deleting is not opening it: the click stops here, after the button. */}
      <span
        className="invisible absolute top-1.5 right-1.5 group-hover/chat:visible"
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton label="Delete chat" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </span>
    </div>
  )
}

/**
 * Earlier chats: searchable, under Today / Yesterday / Previous 7 days…, each
 * with the start of its last answer and what it did — drew charts, built a
 * dashboard, changed data.
 */
export function ChatHistory() {
  const chats = useStore((state) => state.chats)
  const current = useStore((state) => state.chat?.id)
  const selectChat = useStore((state) => state.selectChat)
  const deleteChat = useStore((state) => state.deleteChat)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const found = useMemo(() => {
    const needle = fold(query.trim())
    return needle
      ? chats.filter((chat) => fold(`${chat.title} ${chat.preview}`).includes(needle))
      : chats
  }, [chats, query])

  const groups = useMemo(() => {
    const out: { heading: string; chats: ChatSummary[] }[] = []
    for (const chat of found) {
      const heading = historyGroup(chat.updatedAt)
      const last = out.at(-1)
      if (last?.heading === heading) last.chats.push(chat)
      else out.push({ heading, chats: [chat] })
    }
    return out
  }, [found])

  const pick = (chatId: string) => {
    setOpen(false)
    setQuery("")
    void selectChat(chatId)
  }

  const remove = async (chat: ChatSummary) => {
    const ok = await confirm({
      title: `Delete "${chat.title}"?`,
      description: "The conversation is removed for good. What it changed in the database stays.",
      action: "Delete",
      destructive: true,
    })
    if (ok) void deleteChat(chat.id)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton label="Earlier chats" pressed={open}>
            <History />
          </IconButton>
        }
      />
      <PopoverContent
        align="end"
        className="flex max-h-[min(480px,70vh)] w-[360px] gap-0 overflow-hidden p-0"
      >
        <div className="relative shrink-0 border-b p-2">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            placeholder="Search chats…"
            aria-label="Search chats"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && found[0]) pick(found[0].id)
            }}
            className="h-8 border-transparent bg-muted/60 pl-8 shadow-none focus-visible:bg-background"
          />
        </div>

        <div role="listbox" aria-label="Earlier chats" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {chats.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No earlier chats yet.
            </p>
          ) : found.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.heading} className="mb-1 last:mb-0">
                <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                  {group.heading}
                </h3>
                {group.chats.map((chat) => (
                  <Row
                    key={chat.id}
                    chat={chat}
                    current={chat.id === current}
                    onPick={() => pick(chat.id)}
                    onDelete={() => void remove(chat)}
                  />
                ))}
              </section>
            ))
          )}
        </div>

        {chats.length > 0 && (
          <div className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            {query.trim()
              ? `${found.length} of ${chats.length} chats`
              : `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
