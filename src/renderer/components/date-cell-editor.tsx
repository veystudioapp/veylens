import { Popover } from "@base-ui/react/popover"
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { DayPicker } from "react-day-picker"

import type { Cell, ColumnKind } from "@shared/api"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * How a column of dates is typed into: a calendar for a date, a calendar and
 * a time for a timestamp. Null for a time of day or an interval, which a
 * calendar does not help with — those keep the plain text editor.
 */
export function dateEditorKind(column: {
  kind: ColumnKind
  type: string
}): "date" | "datetime" | null {
  if (column.kind !== "datetime") return null
  const type = column.type.trim().toLowerCase()
  if (type === "date" || type === "newdate") return "date"
  if (/^(datetime|timestamptz|timestamp|smalldatetime)\b/.test(type)) return "datetime"
  return null
}

/** `2023-02-27`, then optionally ` 12:15`, `:00`, `.123`, and a zone (`+09`). */
const VALUE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(.*))?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/

type Parts = { date: string; time: string; zone: string }

/** A value as the database printed it, in parts; null if it reads otherwise
 * (`infinity`), which is then edited as plain text. */
export function parseDateValue(value: string): Parts | null {
  const match = VALUE.exec(value)
  if (!match) return null
  return { date: match[1]!, time: match[2] ?? "", zone: match[3] ?? "" }
}

/** The day a `YYYY-MM-DD` names, at local midnight; undefined if none. */
function toDay(text: string): Date | undefined {
  if (!DATE.test(text)) return undefined
  const [year, month, day] = text.split("-").map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  // `2023-02-30` rolls over into March: not a day.
  return date.getMonth() === month - 1 && date.getDate() === day ? date : undefined
}

const pad = (n: number) => String(n).padStart(2, "0")
const fromDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** `12:15:00` reads as `12:15`; seconds that say something are kept. */
const shortTime = (time: string) => (/^\d{2}:\d{2}:00$/.test(time) ? time.slice(0, 5) : time)
/** And back: a time without seconds is given them. */
const fullTime = (time: string) => {
  const colon = time.indexOf(":")
  if (colon < 0) return time
  const padded = `${time.slice(0, colon).padStart(2, "0")}${time.slice(colon)}`
  return /^\d{2}:\d{2}$/.test(padded) ? `${padded}:00` : padded
}

/** Clicks inside the calendar leave the focus in the text, so it is not
 * read as leaving the cell. */
const keepFocus = (event: MouseEvent) => event.preventDefault()

/**
 * A date cell being edited: its date (and time) as text, to type, and a
 * calendar under it to pick a day from. Enter or leaving the cell saves it,
 * Escape puts it back.
 */
export function DateCellEditor({
  initial,
  withTime,
  nullable,
  onCommit,
  onCancel,
}: {
  initial: Cell | undefined
  withTime: boolean
  nullable: boolean
  onCommit: (value: Cell) => void
  onCancel: () => void
}) {
  const parts = initial ? parseDateValue(initial) : null
  const [date, setDate] = useState(parts?.date ?? "")
  const [time, setTime] = useState(parts ? shortTime(parts.time) : "")
  const [month, setMonth] = useState(() => toDay(parts?.date ?? "") ?? new Date())
  const zone = parts?.zone ?? ""

  const box = useRef<HTMLDivElement>(null)
  const dateInput = useRef<HTMLInputElement>(null)
  const timeInput = useRef<HTMLInputElement>(null)
  // Enter, Escape, a day picked and the NULL button each settle the edit, and
  // each may be followed by a blur that must not settle it a second time.
  const settled = useRef(false)

  useEffect(() => {
    dateInput.current?.focus()
    dateInput.current?.select()
  }, [])

  const day = toDay(date)
  const valid =
    !!day && (!withTime || time === "" || TIME.test(time))

  const settle = (action: () => void) => {
    if (settled.current) return
    settled.current = true
    action()
  }

  const commit = (nextDate = date, nextTime = time) =>
    settle(() => {
      if (!nextDate && !nextTime) {
        // Emptied: NULL where it may be, otherwise as it was.
        return initial != null && nullable ? onCommit(null) : onCancel()
      }
      const value = withTime
        ? `${nextDate} ${fullTime(nextTime || "00:00")}${zone}`
        : nextDate
      return value === initial ? onCancel() : onCommit(value)
    })

  const pick = (picked: Date | undefined) => {
    if (!picked) return
    const text = fromDay(picked)
    setDate(text)
    setMonth(picked)
    if (!withTime) {
      commit(text)
      return
    }
    // The day is set; the time is next.
    if (!time) setTime("00:00")
    timeInput.current?.focus()
    timeInput.current?.select()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      // A date that is not one stays open to be put right.
      if (valid || (!date && !time)) commit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      settle(onCancel)
    }
  }

  const field =
    "h-full min-w-0 bg-transparent font-mono text-xs outline-none [field-sizing:content] placeholder:text-muted-foreground/60"

  return (
    <Popover.Root open modal={false}>
      <div
        ref={box}
        className={cn(
          "relative flex h-full w-full items-center gap-3 bg-card px-2 ring-2 ring-inset",
          valid || (!date && !time) ? "ring-ring" : "ring-destructive"
        )}
        onBlur={(event) => {
          // Only leaving the cell, not moving from the date to the time.
          if (box.current?.contains(event.relatedTarget as Node | null)) return
          commit()
        }}
      >
        <input
          ref={dateInput}
          value={date}
          placeholder="YYYY-MM-DD"
          spellCheck={false}
          aria-label="Date"
          className={field}
          onChange={(event) => {
            setDate(event.target.value)
            const typed = toDay(event.target.value)
            if (typed) setMonth(typed)
          }}
          onKeyDown={onKeyDown}
        />
        {withTime && (
          <input
            ref={timeInput}
            value={time}
            placeholder="00:00"
            spellCheck={false}
            aria-label="Time"
            className={field}
            onChange={(event) => setTime(event.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <span className="flex-1" />
        {nullable && (
          <Button
            variant="outline"
            size="xs"
            title="Set to NULL"
            // Before the blur, which would otherwise commit the text first.
            onMouseDown={(event) => {
              event.preventDefault()
              settle(() => onCommit(null))
            }}
            className="-mr-1.5 h-5 shrink-0 px-1 font-sans text-[10px]"
          >
            NULL
          </Button>
        )}
      </div>

      <Popover.Portal>
        <Popover.Positioner
          anchor={box}
          side="bottom"
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            onMouseDown={keepFocus}
            className="rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <DayPicker
              mode="single"
              required={false}
              selected={day}
              onSelect={pick}
              month={month}
              onMonthChange={setMonth}
              weekStartsOn={1}
              showOutsideDays
              fixedWeeks
              navLayout="around"
              footer={
                <div className="flex justify-center pt-1">
                  <Button variant="outline" size="xs" onClick={() => pick(new Date())}>
                    Today
                  </Button>
                </div>
              }
              classNames={{
                root: "w-64 select-none text-[13px]",
                months: "relative",
                month: "grid grid-cols-[auto_1fr_auto] items-center",
                month_caption: "flex h-8 items-center justify-center",
                caption_label: "font-medium",
                button_previous:
                  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                button_next:
                  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                chevron: "size-3.5 fill-current",
                month_grid: "col-span-3 mt-1 w-full border-collapse border-t",
                weekdays: "border-b",
                weekday: "h-8 text-[11px] font-normal text-muted-foreground",
                week: "",
                day: "p-px text-center",
                day_button:
                  "inline-flex size-8 items-center justify-center rounded-md tabular-nums hover:bg-muted",
                outside: "text-muted-foreground/45",
                today: "font-semibold text-primary",
                selected:
                  "[&>button]:bg-muted-foreground/20 [&>button]:font-semibold [&>button]:hover:bg-muted-foreground/25",
                footer: "mt-1",
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
