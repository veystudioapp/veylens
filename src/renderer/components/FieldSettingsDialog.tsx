import { Popover } from "@base-ui/react/popover"
import {
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  Flag,
  Flame,
  GripVertical,
  Heart,
  Plus,
  Shapes,
  Sparkles,
  Square,
  Star,
  ThumbsUp,
  X,
} from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"

import {
  CHECK_ICONS,
  DATE_FORMATS,
  DURATION_FORMATS,
  RATING_ICONS,
  TONES,
  type Abbreviation,
  type Cell,
  type CheckIcon,
  type DateFormat,
  type DurationFormat,
  type FieldDisplay,
  type FieldDisplayType,
  type FieldSettings,
  type RatingIcon,
  type Separator,
  type TimeFormat,
  type Tone,
} from "@shared/api"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  defaultDisplay,
  detectFormat,
  displayTypesFor,
  formatOfDisplay,
  splitValues,
  tagTone,
  type CellFormat,
} from "@/lib/cell-format"
import { errorMessage } from "@/lib/store"
import { toneColor } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { CellText, FieldIcon, type GridColumn } from "./DataGrid"
import { SimpleSelect } from "./simple-select"
import { ErrorNote } from "./state-view"
import { Switch } from "./switch"

// NocoDB's names for its field types, and what each is for.
const TYPE_LABEL: Record<FieldDisplayType, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  date: "Date & time",
  duration: "Duration",
  select: "Single select",
  multiselect: "Multi select",
  checkbox: "Checkbox",
  rating: "Rating",
  progress: "Progress",
  email: "Email",
  phone: "Phone",
  url: "URL",
  image: "Image",
  colour: "Colour",
}

const TYPE_HINT: Record<FieldDisplayType, string> = {
  text: "Exactly as the database prints it.",
  number: "Decimals, separators, and large numbers shortened.",
  currency: "An amount with its currency, written in the locale you pick.",
  percent: "A share as a percent, or as a bar or a ring.",
  date: "A date in the format you pick, with or without the time.",
  duration: "A count of seconds or minutes as h:mm:ss.",
  select: "A coloured tag per value; pick the colours.",
  multiselect: "Several tags in one value: a, b — {a,b} — [\"a\",\"b\"].",
  checkbox: "true / false, 1 / 0 as a checkbox or another icon.",
  rating: "A number as stars, hearts, flags…",
  progress: "A number as a bar against a maximum.",
  email: "An address, drawn as a link.",
  phone: "A phone number.",
  url: "A link; ⌘-click opens it.",
  image: "A thumbnail of the picture at the address.",
  colour: "A hex or CSS colour as a swatch.",
}

const range = (from: number, to: number) =>
  Object.fromEntries(
    Array.from({ length: to - from + 1 }, (_, index) => [String(from + index), String(from + index)])
  ) as Record<string, string>

const DECIMALS = range(0, 8)

const SEPARATOR_LABEL: Record<Separator, string> = {
  locale: "Locale — as this computer writes numbers",
  "comma-period": "1,234,567.89",
  "period-comma": "1.234.567,89",
  "space-period": "1 234 567.89",
  "space-comma": "1 234 567,89",
  "none-period": "1234567.89",
  "none-comma": "1234567,89",
}

const ABBREVIATION_LABEL: Record<Abbreviation, string> = {
  none: "None — full length",
  auto: "Auto — 1.2K, 3.4M, 5.6B",
  thousand: "Thousands — 1,234K",
  million: "Millions — 1.2M",
  billion: "Billions — 0.1B",
  trillion: "Trillions — 0.01T",
}

const CURRENCIES: Record<string, string> = {
  USD: "USD — US dollar",
  EUR: "EUR — Euro",
  GBP: "GBP — Pound sterling",
  JPY: "JPY — Japanese yen",
  VND: "VND — Vietnamese đồng",
  CNY: "CNY — Chinese yuan",
  KRW: "KRW — Korean won",
  SGD: "SGD — Singapore dollar",
  THB: "THB — Thai baht",
  IDR: "IDR — Indonesian rupiah",
  INR: "INR — Indian rupee",
  AUD: "AUD — Australian dollar",
  CAD: "CAD — Canadian dollar",
  CHF: "CHF — Swiss franc",
  HKD: "HKD — Hong Kong dollar",
  TWD: "TWD — New Taiwan dollar",
}

const LOCALES: Record<string, string> = {
  "en-US": "en-US — $1,234.50",
  "en-GB": "en-GB — £1,234.50",
  "de-DE": "de-DE — 1.234,50 €",
  "fr-FR": "fr-FR — 1 234,50 €",
  "ja-JP": "ja-JP — ￥1,235",
  "vi-VN": "vi-VN — 1.234 ₫",
  "zh-CN": "zh-CN — ¥1,234.50",
  "ko-KR": "ko-KR — ₩1,235",
  "en-IN": "en-IN — ₹1,234.50",
  "pt-BR": "pt-BR — R$ 1.234,50",
}

const DATE_FORMAT_LABEL = Object.fromEntries(
  DATE_FORMATS.map((format) => [
    format,
    format === "locale"
      ? "Locale — Nov 14, 2026"
      : format === "relative"
        ? "Relative — 3 days ago"
        : format === "iso"
          ? "As printed — 2026-11-14 14:36:19"
          : format,
  ])
) as Record<DateFormat, string>

const TIME_LABEL: Record<TimeFormat, string> = {
  none: "No time",
  "HH:mm": "HH:mm — 14:36",
  "HH:mm:ss": "HH:mm:ss — 14:36:19",
}

const TIMEZONES: Record<string, string> = {
  local: "This computer's zone",
  UTC: "UTC",
  "Asia/Ho_Chi_Minh": "Asia/Ho_Chi_Minh",
  "Asia/Tokyo": "Asia/Tokyo",
  "Asia/Seoul": "Asia/Seoul",
  "Asia/Shanghai": "Asia/Shanghai",
  "Asia/Singapore": "Asia/Singapore",
  "Asia/Bangkok": "Asia/Bangkok",
  "Asia/Kolkata": "Asia/Kolkata",
  "Europe/London": "Europe/London",
  "Europe/Berlin": "Europe/Berlin",
  "America/New_York": "America/New_York",
  "America/Los_Angeles": "America/Los_Angeles",
  "Australia/Sydney": "Australia/Sydney",
}

const DURATION_LABEL = Object.fromEntries(
  DURATION_FORMATS.map((format) => [format, format])
) as Record<DurationFormat, string>

const ICON: Record<RatingIcon | CheckIcon, typeof Star> = {
  star: Star,
  heart: Heart,
  "thumbs-up": ThumbsUp,
  flag: Flag,
  flame: Flame,
  circle: Circle,
  check: Check,
  square: Square,
  "circle-check": CircleCheck,
}

/** A field's option, a label over its control. */
function Option({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Select<Value extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: Value
  items: Record<Value, string>
  onChange: (value: Value) => void
}) {
  return (
    <SimpleSelect label={label} size="default" className="w-full" value={value} items={items} onChange={onChange} />
  )
}

function TonePicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: Tone
  onChange: (tone: Tone) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5">
      {TONES.map((tone) => (
        <button
          key={tone}
          type="button"
          role="radio"
          aria-checked={value === tone}
          aria-label={tone}
          onClick={() => onChange(tone)}
          className={cn(
            "size-4 rounded-full transition-transform hover:scale-125",
            value === tone && "ring-2 ring-offset-2 ring-offset-background"
          )}
          style={{ background: toneColor(tone), ["--tw-ring-color" as string]: toneColor(tone) }}
        />
      ))}
    </div>
  )
}

function IconPicker<Icon extends RatingIcon | CheckIcon>({
  label,
  icons,
  value,
  tone,
  onChange,
}: {
  label: string
  icons: readonly Icon[]
  value: Icon
  tone: Tone
  onChange: (icon: Icon) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {icons.map((icon) => {
        const Glyph: typeof Star = ICON[icon]
        const picked = value === icon
        return (
          <button
            key={icon}
            type="button"
            role="radio"
            aria-checked={picked}
            aria-label={icon}
            title={icon}
            onClick={() => onChange(icon)}
            className={cn(
              "flex size-8 items-center justify-center rounded-md border transition-colors",
              picked ? "border-ring bg-accent" : "hover:bg-accent/50"
            )}
          >
            <Glyph
              className="size-4"
              style={{ color: toneColor(tone), fill: picked ? toneColor(tone) : "none" }}
            />
          </button>
        )
      })}
    </div>
  )
}

/** A value's colour: a tinted square that opens the colours to pick from. */
function ToneSwatch({
  value,
  tone,
  onChange,
}: {
  value: string
  tone: Tone
  onChange: (tone: Tone) => void
}) {
  const [open, setOpen] = useState(false)
  const colour = toneColor(tone)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Colour of ${value}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-md transition-[filter] hover:brightness-95"
        style={{
          background: `color-mix(in oklch, ${colour} 22%, transparent)`,
          color: `color-mix(in oklch, ${colour} 70%, var(--foreground))`,
        }}
      >
        <ChevronDown className="size-3" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup className="rounded-lg bg-popover p-2.5 shadow-md ring-1 ring-foreground/10 outline-none">
            <TonePicker
              label={`Colour of ${value}`}
              value={tone}
              onChange={(next) => {
                onChange(next)
                setOpen(false)
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

type SelectDisplay = Extract<FieldDisplay, { type: "select" | "multiselect" }>

/**
 * A select's values, each with its colour: those kept with the field first,
 * in their order, then any new on the page. Dragged into order, added by hand,
 * or suggested from the whole column.
 */
function SelectOptionsEditor({
  display,
  seen,
  onChange,
  onSuggest,
}: {
  display: SelectDisplay
  /** The distinct values on the page. */
  seen: string[]
  onChange: (display: SelectDisplay) => void
  /** The column's values, from the database. */
  onSuggest?: () => Promise<string[]>
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const listed = useMemo(
    () => [...new Set([...(display.options ?? []), ...Object.keys(display.colors), ...seen])],
    [display.options, display.colors, seen]
  )
  const shown = display.alphabetize
    ? [...listed].sort((a, b) => a.localeCompare(b))
    : listed
  const onPage = new Set(seen)

  const setOptions = (options: string[]) => onChange({ ...display, options })

  const add = (value: string) => {
    const text = value.trim()
    if (text && !listed.includes(text)) setOptions([...listed, text])
  }

  const remove = (value: string) => {
    const { [value]: _gone, ...colors } = display.colors
    onChange({ ...display, colors, options: listed.filter((item) => item !== value) })
  }

  const move = (from: string, to: string) => {
    const fromIndex = listed.indexOf(from)
    const toIndex = listed.indexOf(to)
    if (from === to || fromIndex < 0 || toIndex < 0) return
    const next = listed.filter((item) => item !== from)
    next.splice(toIndex, 0, from)
    setOptions(next)
  }

  const suggest = async () => {
    if (!onSuggest) return
    setSuggesting(true)
    setNote(null)
    try {
      const found = await onSuggest()
      const fresh = found.filter((value) => value !== "" && !listed.includes(value))
      if (fresh.length) setOptions([...listed, ...fresh])
      setNote(
        fresh.length
          ? `Added ${fresh.length} ${fresh.length === 1 ? "value" : "values"} from the column.`
          : "Every value in the column is listed already."
      )
    } catch (failure) {
      setNote(errorMessage(failure))
    } finally {
      setSuggesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <label className="flex items-center gap-2">
          <Switch
            checked={!display.plain}
            label="Color-code options"
            onChange={(on) => onChange({ ...display, plain: !on })}
          />
          Color-code options
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={!!display.alphabetize}
            label="Alphabetize"
            onChange={(on) => onChange({ ...display, alphabetize: on })}
          />
          Alphabetize
        </label>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="max-h-56 overflow-y-auto py-1">
          {shown.length === 0 && !adding && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No values on this page. Add some, or suggest them from the column.
            </p>
          )}
          {shown.map((value) => {
            const tone = display.colors[value] ?? tagTone(value)
            const draggable = !display.alphabetize
            const below =
              dragging !== null && listed.indexOf(dragging) < listed.indexOf(value)
            return (
              <div
                key={value}
                draggable={draggable}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move"
                  event.dataTransfer.setData("text/plain", value)
                  setDragging(value)
                }}
                onDragOver={(event) => {
                  if (dragging === null) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = "move"
                  setOver(value)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging !== null) move(dragging, value)
                  setDragging(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                className={cn(
                  "group/option flex h-9 items-center gap-2.5 border-y border-transparent px-2 text-[13px]",
                  dragging === value && "opacity-40",
                  over === value && dragging !== value && (below ? "border-b-primary" : "border-t-primary")
                )}
              >
                <GripVertical
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground",
                    draggable ? "cursor-grab" : "opacity-0"
                  )}
                />
                {!display.plain && (
                  <ToneSwatch
                    value={value}
                    tone={tone}
                    onChange={(next) =>
                      onChange({ ...display, colors: { ...display.colors, [value]: next } })
                    }
                  />
                )}
                <span className="min-w-0 flex-1 truncate" title={value}>
                  {value}
                </span>
                {!onPage.has(value) && (
                  <button
                    type="button"
                    aria-label={`Remove ${value}`}
                    title="Not on this page — remove it from the list"
                    onClick={() => remove(value)}
                    className="hidden size-5 items-center justify-center rounded text-muted-foreground group-hover/option:flex hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )
          })}
          {adding && (
            <div className="flex h-9 items-center gap-2.5 px-2">
              <span className="size-3.5 shrink-0" />
              <Input
                autoFocus
                value={draft}
                placeholder="New option"
                aria-label="New option"
                className="h-7 text-[13px]"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    add(draft)
                    setDraft("")
                  } else if (event.key === "Escape") {
                    // Closes the new option, not the whole settings.
                    event.preventDefault()
                    event.stopPropagation()
                    setDraft("")
                    setAdding(false)
                  }
                }}
                onBlur={() => {
                  add(draft)
                  setDraft("")
                  setAdding(false)
                }}
              />
            </div>
          )}
        </div>
        <div className={cn("grid border-t", onSuggest ? "grid-cols-2" : "grid-cols-1")}>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex h-9 items-center justify-center gap-2 text-[13px] hover:bg-muted/60"
          >
            <Plus className="size-3.5" />
            Add option
          </button>
          {onSuggest && (
            <button
              type="button"
              disabled={suggesting}
              title="List every value the column holds, not only those on this page"
              onClick={() => void suggest()}
              className="flex h-9 items-center justify-center gap-2 border-l bg-violet-500/8 text-[13px] text-violet-700 hover:bg-violet-500/14 disabled:opacity-60 dark:text-violet-300"
            >
              {suggesting ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
              Auto suggest
            </button>
          )}
        </div>
      </div>
      {note && <p className="-mt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  )
}

/**
 * A column's settings, after NocoDB's field settings, in a card under its
 * header: how it is shown — picked from the types that suit its kind, each
 * with NocoDB's options — and a description for its header. Only how it is
 * shown changes; the data stays as the database prints it.
 */
export function FieldSettingsDialog({
  column,
  header,
  current,
  samples,
  onSave,
  onSuggest,
  onClose,
}: {
  column: GridColumn
  /** The column's header, which the card hangs from. */
  header: HTMLElement | null
  current: FieldSettings | null
  /** The column's values on the page, for the preview and the tag colours. */
  samples: Cell[]
  onSave: (settings: FieldSettings | null) => Promise<void>
  /** Every distinct value of the column, split into tags for a multi select. */
  onSuggest?: (multi: boolean) => Promise<string[]>
  onClose: () => void
}) {
  const [display, setDisplay] = useState<FieldDisplay | null>(current?.display ?? null)
  const [description, setDescription] = useState(current?.description ?? "")
  const [describing, setDescribing] = useState(!!current?.description)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const types = displayTypesFor(column.kind)
  const present = useMemo(
    () => samples.filter((value): value is string => value !== null && value !== ""),
    [samples]
  )
  const distinct = useMemo(() => {
    const values =
      display?.type === "multiselect" ? present.flatMap(splitValues) : present
    return [...new Set(values)].slice(0, 100)
  }, [present, display?.type])
  const automatic: CellFormat = useMemo(() => detectFormat(column, samples), [column, samples])
  const format = display ? formatOfDisplay(display) : automatic
  const isSelect = display?.type === "select" || display?.type === "multiselect"

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const settings: FieldSettings = {
        ...(display ? { display } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }
      await onSave(settings.display || settings.description ? settings : null)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
      setSaving(false)
    }
  }

  const pickType = (type: FieldDisplayType | null) =>
    setDisplay(
      type === null
        ? null
        : current?.display?.type === type
          ? current.display
          : // A select keeps its colours and order when it becomes the other kind.
            (type === "select" || type === "multiselect") &&
              (display?.type === "select" || display?.type === "multiselect")
            ? { ...display, type }
            : defaultDisplay(type)
    )

  const typeIcon = (type: FieldDisplayType | null) =>
    type === null ? (
      <Shapes className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <FieldIcon column={column} format={formatOfDisplay(defaultDisplay(type))} />
    )

  const options = (): ReactNode => {
    if (!display) return null
    switch (display.type) {
      case "number":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Option label="Decimals">
              <Select
                label="Decimals"
                value={display.decimals === null ? "auto" : String(display.decimals)}
                items={{ auto: "As printed", ...DECIMALS }}
                onChange={(value) =>
                  setDisplay({ ...display, decimals: value === "auto" ? null : Number(value) })
                }
              />
            </Option>
            <Option label="Separators">
              <Select
                label="Separators"
                value={display.separator}
                items={SEPARATOR_LABEL}
                onChange={(separator) => setDisplay({ ...display, separator })}
              />
            </Option>
            <Option label="Large numbers">
              <Select
                label="Large number abbreviation"
                value={display.abbreviate}
                items={ABBREVIATION_LABEL}
                onChange={(abbreviate) => setDisplay({ ...display, abbreviate })}
              />
            </Option>
          </div>
        )
      case "currency":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Option label="Currency">
              <Select
                label="Currency"
                value={display.code}
                items={{ ...CURRENCIES, ...(display.code in CURRENCIES ? {} : { [display.code]: display.code }) }}
                onChange={(code) => setDisplay({ ...display, code })}
              />
            </Option>
            <Option label="Locale" hint="How the amount is written: marks and where the symbol goes.">
              <Select
                label="Currency locale"
                value={display.locale}
                items={{ ...LOCALES, ...(display.locale in LOCALES ? {} : { [display.locale]: display.locale }) }}
                onChange={(locale) => setDisplay({ ...display, locale })}
              />
            </Option>
            <Option label="Decimals">
              <Select
                label="Decimals"
                value={String(display.decimals)}
                items={DECIMALS}
                onChange={(value) => setDisplay({ ...display, decimals: Number(value) })}
              />
            </Option>
            <Option label="Large numbers">
              <Select
                label="Large number abbreviation"
                value={display.abbreviate}
                items={ABBREVIATION_LABEL}
                onChange={(abbreviate) => setDisplay({ ...display, abbreviate })}
              />
            </Option>
          </div>
        )
      case "percent":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Option label="Stored as">
              <Select
                label="Stored as"
                value={display.scale}
                items={{ whole: "75 is 75%", fraction: "0.75 is 75%" }}
                onChange={(scale) => setDisplay({ ...display, scale })}
              />
            </Option>
            <Option label="Decimals">
              <Select
                label="Decimals"
                value={String(display.decimals)}
                items={DECIMALS}
                onChange={(value) => setDisplay({ ...display, decimals: Number(value) })}
              />
            </Option>
            <Option label="Display as progress">
              <Select
                label="Display as progress"
                value={display.progress}
                items={{ none: "No — just the number", bar: "Bar", circle: "Circle" }}
                onChange={(progress) => setDisplay({ ...display, progress })}
              />
            </Option>
          </div>
        )
      case "date":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Option label="Date format">
              <Select
                label="Date format"
                value={display.format}
                items={DATE_FORMAT_LABEL}
                onChange={(format) => setDisplay({ ...display, format })}
              />
            </Option>
            <Option label="Time format">
              <Select
                label="Time format"
                value={display.time}
                items={TIME_LABEL}
                onChange={(time) => setDisplay({ ...display, time })}
              />
            </Option>
            <Option label="Clock">
              <Select
                label="Clock"
                value={display.hour12 ? "12" : "24"}
                items={{ "24": "24-hour — 14:36", "12": "12-hour — 2:36 PM" }}
                onChange={(value) => setDisplay({ ...display, hour12: value === "12" })}
              />
            </Option>
            <Option
              label="Show in time zone"
              hint="For values that carry a zone (timestamptz); others are shown as stored."
            >
              <Select
                label="Time zone"
                value={display.timezone}
                items={{ ...TIMEZONES, ...(display.timezone in TIMEZONES ? {} : { [display.timezone]: display.timezone }) }}
                onChange={(timezone) => setDisplay({ ...display, timezone })}
              />
            </Option>
          </div>
        )
      case "duration":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Option label="Stored in">
              <Select
                label="Stored in"
                value={display.unit}
                items={{ seconds: "Seconds", minutes: "Minutes" }}
                onChange={(unit) => setDisplay({ ...display, unit })}
              />
            </Option>
            <Option label="Format">
              <Select
                label="Duration format"
                value={display.format}
                items={DURATION_LABEL}
                onChange={(format) => setDisplay({ ...display, format })}
              />
            </Option>
          </div>
        )
      case "select":
      case "multiselect":
        return (
          <SelectOptionsEditor
            display={display}
            seen={distinct}
            onChange={setDisplay}
            onSuggest={onSuggest ? () => onSuggest(display.type === "multiselect") : undefined}
          />
        )
      case "checkbox":
        return (
          <>
            <Option label="Icon">
              <IconPicker
                label="Icon"
                icons={CHECK_ICONS}
                value={display.icon}
                tone={display.color}
                onChange={(icon) => setDisplay({ ...display, icon })}
              />
            </Option>
            <Option label="Colour">
              <TonePicker
                label="Colour"
                value={display.color}
                onChange={(color) => setDisplay({ ...display, color })}
              />
            </Option>
          </>
        )
      case "rating":
        return (
          <>
            <Option label="Icon">
              <IconPicker
                label="Icon"
                icons={RATING_ICONS}
                value={display.icon}
                tone={display.color}
                onChange={(icon) => setDisplay({ ...display, icon })}
              />
            </Option>
            <div className="grid grid-cols-2 gap-3">
              <Option label="Colour">
                <TonePicker
                  label="Colour"
                  value={display.color}
                  onChange={(color) => setDisplay({ ...display, color })}
                />
              </Option>
              <Option label="Max">
                <Select
                  label="Max"
                  value={String(display.max)}
                  items={range(1, 10)}
                  onChange={(value) => setDisplay({ ...display, max: Number(value) })}
                />
              </Option>
            </div>
          </>
        )
      case "progress":
        return (
          <Option label="Full at">
            <Input
              type="number"
              min={0}
              value={String(display.max)}
              aria-label="Full at"
              onChange={(event) => setDisplay({ ...display, max: Number(event.target.value) || 0 })}
              className="w-32"
            />
          </Option>
        )
      default:
        return null
    }
  }

  return (
    <Popover.Root
      open
      onOpenChange={(open, details) => {
        // The column's menu hands its focus back to the header as it closes;
        // that is not leaving the settings. A click outside or Escape is.
        if (!open && details.reason !== "focus-out") onClose()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={header ?? undefined}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="isolate z-50"
        >
          <Popover.Popup className="flex max-h-[min(680px,var(--available-height))] w-[400px] flex-col gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <Popover.Title className="sr-only">{column.name} field settings</Popover.Title>

            {/* The column itself is not renamed here: only how it is shown. */}
            <div
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg border bg-muted/30 px-3"
              title="The column's name in the database"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{column.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {column.type}
              </span>
            </div>

            <SelectRoot
              value={display?.type ?? "auto"}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  pickType(value === "auto" ? null : (value as FieldDisplayType))
                }
              }}
            >
              <SelectTrigger aria-label="Show as" className="h-9 w-full shrink-0 shadow-xs">
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  {typeIcon(display?.type ?? null)}
                  {display ? TYPE_LABEL[display.type] : "Automatic"}
                </span>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start">
                <SelectItem value="auto">
                  {typeIcon(null)}
                  Automatic
                </SelectItem>
                <SelectSeparator />
                {types.map((type) => (
                  <SelectItem key={type} value={type}>
                    {typeIcon(type)}
                    {TYPE_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>

            <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {display
                  ? TYPE_HINT[display.type]
                  : "Read off the column's type, name and values: tags for a small set, links for addresses, checkboxes for booleans, grouped digits for decimals."}
              </p>

              {options()}

              {!isSelect && (
                <Option label="Preview">
                  <div className="overflow-hidden rounded-lg border">
                    <table className="w-full border-collapse text-xs">
                      <tbody>
                        {(present.length ? present.slice(0, 3) : [null]).map((value, index) => (
                          <tr key={index} className="border-b last:border-b-0">
                            <td className="max-w-32 truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                              {value ?? "NULL"}
                            </td>
                            <td className="max-w-48 truncate px-3 py-1.5 text-[13px]">
                              <CellText value={value} kind={column.kind} format={format} raw={false} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Option>
              )}

              {describing && (
                <Option label="Description" hint="Shown as ⓘ beside the column's name.">
                  <Textarea
                    autoFocus={!current?.description}
                    value={description}
                    rows={2}
                    placeholder="What this column holds, its unit, where it comes from…"
                    onChange={(event) => setDescription(event.target.value)}
                    className="text-xs"
                  />
                </Option>
              )}

              {error && <ErrorNote>{error}</ErrorNote>}
            </div>

            <div className="flex shrink-0 items-center gap-2 pt-1">
              {!describing && (
                <button
                  type="button"
                  onClick={() => setDescribing(true)}
                  className="flex h-8 items-center gap-2 rounded-md px-1.5 text-[13px] text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  Add description
                </button>
              )}
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving && <Spinner className="size-3.5" />}
                Update field
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
