import {
  Check,
  Circle,
  CircleCheck,
  Flag,
  Flame,
  Heart,
  Shapes,
  Square,
  Star,
  ThumbsUp,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

/** Each value's colour, for a single or multi select. */
function ValueColours({
  values,
  colors,
  onChange,
}: {
  values: string[]
  colors: Record<string, Tone>
  onChange: (colors: Record<string, Tone>) => void
}) {
  if (values.length === 0) {
    return <p className="text-xs text-muted-foreground">No values on this page.</p>
  }
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {values.map((value) => {
        const tone = colors[value] ?? tagTone(value)
        return (
          <div key={value} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">
              <CellText
                value={value}
                kind="text"
                format={{ kind: "tag", colors: { [value]: tone } }}
                raw={false}
              />
            </span>
            <TonePicker
              label={`Colour of ${value}`}
              value={tone}
              onChange={(next) => onChange({ ...colors, [value]: next })}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * A column's settings, after NocoDB's field settings: how it is shown —
 * picked from the types that suit its kind, each with NocoDB's options — and
 * a description for its header. The values on the page are the preview.
 */
export function FieldSettingsDialog({
  column,
  current,
  samples,
  onSave,
  onClose,
}: {
  column: GridColumn
  current: FieldSettings | null
  /** The column's values on the page, for the preview and the tag colours. */
  samples: Cell[]
  onSave: (settings: FieldSettings | null) => Promise<void>
  onClose: () => void
}) {
  const [display, setDisplay] = useState<FieldDisplay | null>(current?.display ?? null)
  const [description, setDescription] = useState(current?.description ?? "")
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
    return [...new Set(values)].slice(0, 30)
  }, [present, display?.type])
  const automatic: CellFormat = useMemo(() => detectFormat(column, samples), [column, samples])
  const format = display ? formatOfDisplay(display) : automatic

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

  const typeRow = (type: FieldDisplayType | null) => {
    const picked = type === null ? display === null : display?.type === type
    return (
      <button
        key={type ?? "auto"}
        type="button"
        role="radio"
        aria-checked={picked}
        onClick={() =>
          setDisplay(
            type === null
              ? null
              : current?.display?.type === type
                ? current.display
                : defaultDisplay(type)
          )
        }
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
          picked ? "bg-accent font-medium" : "hover:bg-accent/50"
        )}
      >
        {type === null ? (
          <Shapes className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FieldIcon column={column} format={formatOfDisplay(defaultDisplay(type))} chosen={picked} />
        )}
        {type === null ? "Automatic" : TYPE_LABEL[type]}
      </button>
    )
  }

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
          <Option label="Colours">
            <ValueColours
              values={distinct}
              colors={display.colors}
              onChange={(colors) => setDisplay({ ...display, colors })}
            />
          </Option>
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(640px,calc(100%-4rem))] max-w-[calc(100%-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="border-b py-3.5 pr-12 pl-5">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">
            <span className="font-mono text-[14px]">{column.name}</span> field settings
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {column.type} · only how it is shown changes; the data and edits stay as the
            database prints them.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            role="radiogroup"
            aria-label="Show as"
            className="flex w-44 shrink-0 flex-col gap-px overflow-y-auto border-r bg-sidebar p-2"
          >
            {typeRow(null)}
            <div className="my-1 border-t border-sidebar-border" />
            {types.map((type) => typeRow(type))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {display
                ? TYPE_HINT[display.type]
                : "Read off the column's type, name and values: tags for a small set, links for addresses, checkboxes for booleans, grouped digits for decimals."}
            </p>

            {options()}

            <Option label="Preview">
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-muted/50 text-left text-[11px] text-muted-foreground">
                      <th className="border-b px-3 py-1.5 font-medium">Stored</th>
                      <th className="border-b px-3 py-1.5 font-medium">Shown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(present.length ? present.slice(0, 5) : [null]).map((value, index) => (
                      <tr key={index} className="border-b last:border-b-0">
                        <td className="max-w-40 truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                          {value ?? "NULL"}
                        </td>
                        <td className="max-w-72 truncate px-3 py-1.5 text-[13px]">
                          <CellText value={value} kind={column.kind} format={format} raw={false} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Option>

            <Option label="Description" hint="Shown as ⓘ beside the column's name.">
              <Textarea
                value={description}
                rows={2}
                placeholder="What this column holds, its unit, where it comes from…"
                onChange={(event) => setDescription(event.target.value)}
                className="text-xs"
              />
            </Option>

            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && <Spinner className="size-3.5" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
