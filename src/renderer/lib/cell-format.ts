import { create } from "zustand"

import type {
  Abbreviation,
  Cell,
  CheckIcon,
  Column,
  ColumnKind,
  DateFormat,
  DurationFormat,
  FieldDisplay,
  FieldDisplayType,
  RatingIcon,
  Separator,
  TimeFormat,
  Tone,
} from "@shared/api"

/**
 * How a column's values are drawn in a grid, read off its type, its name, its
 * foreign keys, and the values on screen — the way NocoDB or Airtable set a
 * status as a coloured tag and an email as a link. Only the drawing changes:
 * every value is still the text the database printed, an edit starts from
 * that text, and "Format values" off shows it bare.
 */
export type CellFormat =
  | { kind: "plain" }
  | { kind: "email" }
  | { kind: "url" }
  /** An address of a picture: a thumbnail. */
  | { kind: "image" }
  /** A short value from a small set: a coloured tag per value. */
  | { kind: "tag"; colors?: Record<string, Tone> }
  /** The text as printed — chosen, so not even a date is split. */
  | { kind: "text" }
  | {
      kind: "number"
      decimals: number | null
      separator: Separator
      abbreviate: Abbreviation
    }
  | {
      kind: "currency"
      code: string
      locale: string
      decimals: number
      abbreviate: Abbreviation
    }
  | {
      kind: "percent"
      decimals: number
      scale: "fraction" | "whole"
      progress: "none" | "bar" | "circle"
    }
  | {
      kind: "date"
      format: DateFormat
      time: TimeFormat
      hour12: boolean
      timezone: string
    }
  | { kind: "duration"; unit: "seconds" | "minutes"; format: DurationFormat }
  | { kind: "multitag"; colors?: Record<string, Tone> }
  | { kind: "check"; icon: CheckIcon; color: Tone }
  | { kind: "rating"; max: number; icon: RatingIcon; color: Tone }
  | { kind: "progress"; max: number }
  | { kind: "phone" }
  | { kind: "colour" }
  /** A number with a fractional part: grouped thousands. */
  | { kind: "decimal" }
  | { kind: "bool" }
  /** A foreign key: a chip naming the table it points at. */
  | { kind: "reference"; table: string }

export type FormatColumn = Column & {
  primaryKey?: boolean
  /** The table a single-column foreign key on this column points at. */
  references?: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_PATTERN = /^https?:\/\/\S+$/i
const IMAGE_PATTERN = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?\S*)?$/i
const DECIMAL_TYPE = /decimal|numeric|money|real|double|float/i
const ID_NAME = /(^|_)(id|uuid|guid|hash|token|key|code)$/i

/** Of the non-null values, how many pass — 0 when there are none. */
function share(values: string[], test: (value: string) => boolean): number {
  if (values.length === 0) return 0
  return values.filter(test).length / values.length
}

/** A small, repeated set of short labels: a status, a category, a country. */
function looksLikeTags(values: string[]): boolean {
  if (values.length < 5) return false
  const distinct = new Set(values)
  return (
    distinct.size <= 12 &&
    distinct.size <= values.length / 2 &&
    values.every((value) => value.length <= 32 && !value.includes("\n"))
  )
}

export function detectFormat(column: FormatColumn, values: Cell[]): CellFormat {
  const present = values.filter((value): value is string => value !== null && value !== "")

  if (column.references) return { kind: "reference", table: column.references }

  if (column.kind === "boolean" || /^tinyint\(1\)/i.test(column.type)) {
    return { kind: "bool" }
  }
  if (column.kind === "number") {
    return DECIMAL_TYPE.test(column.type) ? { kind: "decimal" } : { kind: "plain" }
  }
  if (column.kind !== "text" || column.primaryKey) return { kind: "plain" }

  if (/^enum\(/i.test(column.type)) return { kind: "tag" }
  if (/e-?mail/i.test(column.name) || share(present, (value) => EMAIL.test(value)) >= 0.8) {
    return { kind: "email" }
  }
  if (share(present, (value) => IMAGE_PATTERN.test(value)) >= 0.8) return { kind: "image" }
  if (share(present, (value) => URL_PATTERN.test(value)) >= 0.8) return { kind: "url" }
  if (!ID_NAME.test(column.name) && looksLikeTags(present)) return { kind: "tag" }
  return { kind: "plain" }
}

const DISPLAY_NAME = /^(name|title|label|subject|full_?name|display_?name|username)$|_name$/i

/**
 * The column a row is known by — a customer's name, an article's title —
 * drawn in the accent as NocoDB draws its display value. The first plain text
 * column with a name like that; none when there is no such column.
 */
export function displayColumn(columns: FormatColumn[], formats: CellFormat[]): number {
  return columns.findIndex(
    (column, index) =>
      column.kind === "text" &&
      !column.primaryKey &&
      formats[index]?.kind === "plain" &&
      DISPLAY_NAME.test(column.name)
  )
}

/**
 * `FOREIGN KEY (customer_id) REFERENCES public.customers(id)` → customer_id →
 * customers. Both drivers describe a key in that form; a key over several
 * columns is left out, as no one cell holds it.
 */
export function referencesOf(foreignKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of foreignKeys) {
    const match = /FOREIGN KEY \(([^)]+)\) REFERENCES ([^\s(]+)\s*\(/i.exec(key)
    if (!match) continue
    const columns = match[1]!.split(",").map((item) => item.trim().replace(/^"|"$/g, ""))
    if (columns.length !== 1) continue
    const table = match[2]!.split(".").at(-1)!.replace(/^"|"$/g, "")
    out[columns[0]!] = table
  }
  return out
}

/** Thousands grouped, the digits after the point left exactly as printed. */
export function groupDigits(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value)
  if (!match) return value
  return `${match[1]}${match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[3] ?? ""}`
}

const TAG_TONES: Tone[] = ["blue", "green", "orange", "pink", "teal", "amber", "red"]

/** The same value always gets the same colour, on every page and every table. */
export function tagTone(value: string): Tone {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length]!
}

const STORAGE_KEY = "veydata.formatValues"

/** The toolbar's "Format values": on unless turned off, and remembered. */
export const useFormatValues = create<{ on: boolean; toggle(): void }>((set, get) => ({
  on: typeof localStorage === "undefined" || localStorage.getItem(STORAGE_KEY) !== "off",
  toggle() {
    const on = !get().on
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off")
    set({ on })
  },
}))

const HEIGHT_KEY = "veydata.rowHeight"

/** Comfortable rows, as NocoDB's, or compact ones to see more at once. */
export const useRowHeight = create<{ compact: boolean; toggle(): void }>((set, get) => ({
  compact:
    typeof localStorage !== "undefined" && localStorage.getItem(HEIGHT_KEY) === "compact",
  toggle() {
    const compact = !get().compact
    localStorage.setItem(HEIGHT_KEY, compact ? "compact" : "comfortable")
    set({ compact })
  },
}))

// ── Chosen displays ────────────────────────────────────────────────────────

/** A display the user chose, as the grid draws it. */
export function formatOfDisplay(display: FieldDisplay): CellFormat {
  switch (display.type) {
    case "text":
      return { kind: "text" }
    case "select":
      return { kind: "tag", colors: display.colors }
    case "multiselect":
      return { kind: "multitag", colors: display.colors }
    case "checkbox":
      return { kind: "check", icon: display.icon, color: display.color }
    case "email":
    case "url":
    case "image":
    case "phone":
    case "colour":
      return { kind: display.type }
    case "number":
      return {
        kind: "number",
        decimals: display.decimals,
        separator: display.separator,
        abbreviate: display.abbreviate,
      }
    case "currency":
      return {
        kind: "currency",
        code: display.code,
        locale: display.locale,
        decimals: display.decimals,
        abbreviate: display.abbreviate,
      }
    case "percent":
      return {
        kind: "percent",
        decimals: display.decimals,
        scale: display.scale,
        progress: display.progress,
      }
    case "date":
      return {
        kind: "date",
        format: display.format,
        time: display.time,
        hour12: display.hour12,
        timezone: display.timezone,
      }
    case "duration":
      return { kind: "duration", unit: display.unit, format: display.format }
    case "rating":
      return { kind: "rating", max: display.max, icon: display.icon, color: display.color }
    case "progress":
      return { kind: "progress", max: display.max }
  }
}

/** The ways a column of this kind can sensibly be shown. */
export function displayTypesFor(kind: ColumnKind): FieldDisplayType[] {
  switch (kind) {
    case "number":
      return [
        "number",
        "currency",
        "percent",
        "duration",
        "rating",
        "progress",
        "checkbox",
        "select",
        "text",
      ]
    case "text":
      return [
        "select",
        "multiselect",
        "email",
        "phone",
        "url",
        "image",
        "colour",
        "number",
        "currency",
        "percent",
        "date",
        "text",
      ]
    case "datetime":
      return ["date", "text"]
    case "boolean":
      return ["checkbox", "text"]
    case "json":
      return ["multiselect", "text"]
    default:
      return ["text"]
  }
}

/** The display a type starts with when it is picked — NocoDB's defaults. */
export function defaultDisplay(type: FieldDisplayType): FieldDisplay {
  switch (type) {
    case "number":
      return { type, decimals: null, separator: "locale", abbreviate: "none" }
    case "currency":
      return { type, code: "USD", locale: "en-US", decimals: 2, abbreviate: "none" }
    case "percent":
      return { type, decimals: 0, scale: "whole", progress: "none" }
    case "date":
      return { type, format: "YYYY-MM-DD", time: "HH:mm", hour12: false, timezone: "local" }
    case "duration":
      return { type, unit: "seconds", format: "h:mm:ss" }
    case "select":
    case "multiselect":
      return { type, colors: {} }
    case "checkbox":
      return { type, icon: "check", color: "blue" }
    case "rating":
      return { type, max: 5, icon: "star", color: "amber" }
    case "progress":
      return { type, max: 100 }
    default:
      return { type }
  }
}

/**
 * A number as printed, read for display only. Past 15 significant digits a
 * float would round it, so such a value is left to be grouped as text.
 */
export function numeric(value: string): number | null {
  const trimmed = value.trim()
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return null
  if (trimmed.replace(/[-.]|e.*$/gi, "").replace(/^0+/, "").length > 15) return null
  return Number(trimmed)
}

const NBSP = "\u00a0"

/** `1,234.5` written with another pair of marks. */
function remark(text: string, separator: Separator): string {
  const [group, decimal] = {
    locale: [",", "."],
    "comma-period": [",", "."],
    "period-comma": [".", ","],
    "space-period": [NBSP, "."],
    "space-comma": [NBSP, ","],
    "none-period": ["", "."],
    "none-comma": ["", ","],
  }[separator]
  return text.replace(/[,.]/g, (mark) => (mark === "," ? group! : decimal!))
}

const UNITS: [Exclude<Abbreviation, "none" | "auto">, number, string][] = [
  ["trillion", 1e12, "T"],
  ["billion", 1e9, "B"],
  ["million", 1e6, "M"],
  ["thousand", 1e3, "K"],
]

/** How far a number is shortened: the factor and its suffix, or none. */
function shortening(number: number, abbreviate: Abbreviation): [number, string] | null {
  if (abbreviate === "none") return null
  if (abbreviate === "auto") {
    const unit = UNITS.find(([, size]) => Math.abs(number) >= size)
    return unit ? [unit[1], unit[2]] : null
  }
  const unit = UNITS.find(([name]) => name === abbreviate)!
  return [unit[1], unit[2]]
}

export function formatNumber(
  value: string,
  decimals: number | null,
  separator: Separator,
  abbreviate: Abbreviation = "none"
): string {
  const number = numeric(value)
  if (number === null) {
    // Too long for a float: grouped as text, never rounded.
    return /^-?\d+(\.\d+)?$/.test(value.trim())
      ? remark(groupDigits(value.trim()), separator)
      : value
  }
  const short = shortening(number, abbreviate)
  if (short) {
    // Shortened figures drop their trailing zeros, as NocoDB's do.
    const text = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: Math.min(decimals ?? 1, 4),
    }).format(number / short[0])
    return `${separator === "locale" ? localeMarks(text) : remark(text, separator)}${short[1]}`
  }
  const options: Intl.NumberFormatOptions =
    decimals === null
      ? { maximumFractionDigits: 20 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
  if (separator === "locale") return new Intl.NumberFormat(undefined, options).format(number)
  return remark(new Intl.NumberFormat("en-US", options).format(number), separator)
}

/** An en-US number in the viewer's own marks. */
function localeMarks(text: string): string {
  const parts = new Intl.NumberFormat(undefined).formatToParts(12345.6)
  const group = parts.find((part) => part.type === "group")?.value ?? ","
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? "."
  return text.replace(/[,.]/g, (mark) => (mark === "," ? group : decimal))
}

export function formatCurrency(
  value: string,
  code: string,
  locale: string,
  decimals: number,
  abbreviate: Abbreviation = "none"
): string {
  const number = numeric(value)
  if (number === null) return value
  const short = shortening(number, abbreviate)
  try {
    const format = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: short ? 0 : decimals,
      maximumFractionDigits: short ? Math.min(decimals, 2) : decimals,
    })
    if (!short) return format.format(number)
    // The suffix goes after the digits, wherever the locale puts its symbol.
    const parts = format.formatToParts(number / short[0])
    const last = parts.map((part) => part.type).lastIndexOf("fraction") >= 0
      ? parts.map((part) => part.type).lastIndexOf("fraction")
      : parts.map((part) => part.type).lastIndexOf("integer")
    return parts
      .map((part, index) => (index === last ? `${part.value}${short[1]}` : part.value))
      .join("")
  } catch {
    return `${formatNumber(value, decimals, "locale", abbreviate)} ${code}`
  }
}

/** The share a percent stands for, 0.75 for 75%. */
export function percentShare(value: string, scale: "fraction" | "whole"): number | null {
  const number = numeric(value)
  if (number === null) return null
  return scale === "whole" ? number / 100 : number
}

export function formatPercent(value: string, decimals: number, scale: "fraction" | "whole"): string {
  const share = percentShare(value, scale)
  if (share === null) return value
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(share)
}

/** A timestamp's parts as printed, and whether it named a zone. */
type Stamp = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  fraction: string
  hasTime: boolean
  /** Set when the value carried a zone: the instant it names. */
  instant: Date | null
}

/**
 * A timestamp as the database printed it: `2026-11-14 14:36:19`, with or
 * without a `T`, fractional seconds, and a zone such as `+09`, `+09:00`, `Z`.
 */
export function readTimestamp(value: string): Stamp | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value.trim()
    )
  if (!match) return null
  const [, y, mo, d, h, mi, se, fr, zone] = match
  const stamp: Stamp = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h ?? 0),
    minute: Number(mi ?? 0),
    second: Number(se ?? 0),
    fraction: fr ?? "",
    hasTime: h !== undefined,
    instant: null,
  }
  if (zone) {
    const offset =
      zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.replace(/(\d{2})(\d{2})$/, "$1:$2")
    const iso = `${y}-${mo}-${d}T${h ?? "00"}:${mi ?? "00"}:${se ?? "00"}${fr ?? ""}${offset}`
    const date = new Date(iso)
    if (!Number.isNaN(date.getTime())) stamp.instant = date
  }
  return stamp
}

/** Kept for the earlier callers: the instant a timestamp names, read as local when it names no zone. */
export function parseTimestamp(value: string): Date | null {
  const stamp = readTimestamp(value)
  if (!stamp) return null
  return (
    stamp.instant ??
    new Date(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute, stamp.second)
  )
}

/**
 * The wall-clock parts to show. A value with a zone is moved into the chosen
 * one; a value without — a `timestamp` or a `date` — is shown as printed, as
 * there is no instant to move.
 */
function wallClock(stamp: Stamp, timezone: string): Stamp {
  if (!stamp.instant) return stamp
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone === "local" ? undefined : timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(stamp.instant)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    ...stamp,
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const pad = (number: number, size = 2) => String(number).padStart(size, "0")

function formatTime(stamp: Stamp, time: TimeFormat, hour12: boolean): string {
  if (time === "none") return ""
  const seconds = time === "HH:mm:ss" ? `:${pad(stamp.second)}` : ""
  if (!hour12) return `${pad(stamp.hour)}:${pad(stamp.minute)}${seconds}`
  const hour = stamp.hour % 12 || 12
  return `${hour}:${pad(stamp.minute)}${seconds} ${stamp.hour < 12 ? "AM" : "PM"}`
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
]

export function formatDate(
  value: string,
  format: DateFormat,
  time: TimeFormat = "none",
  hour12 = false,
  timezone = "local",
  now = Date.now()
): string {
  if (format === "iso") return value
  const read = readTimestamp(value)
  if (!read) return value

  if (format === "relative") {
    const at = parseTimestamp(value)!
    const seconds = (at.getTime() - now) / 1000
    const [unit, size] =
      RELATIVE_STEPS.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1]
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      Math.round(seconds / size),
      unit
    )
  }

  const stamp = wallClock(read, timezone)
  const clock = stamp.hasTime ? formatTime(stamp, time, hour12) : ""

  if (format === "locale") {
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(Date.UTC(stamp.year, stamp.month - 1, stamp.day))
    )
    return clock ? `${day}, ${clock}` : day
  }

  const weekday = WEEKDAYS[new Date(Date.UTC(stamp.year, stamp.month - 1, stamp.day)).getUTCDay()]!
  const tokens: Record<string, string> = {
    YYYY: String(stamp.year),
    YY: String(stamp.year).slice(-2),
    MMM: MONTHS[stamp.month - 1]!,
    MM: pad(stamp.month),
    DD: pad(stamp.day),
    dddd: weekday,
    ddd: weekday.slice(0, 3),
  }
  const day = format.replace(/YYYY|YY|MMM|MM|DD|dddd|ddd/g, (token) => tokens[token]!)
  return clock ? `${day} ${clock}` : day
}

/** Seconds (or minutes) as h:mm, h:mm:ss, … as NocoDB writes a duration. */
export function formatDuration(
  value: string,
  unit: "seconds" | "minutes",
  format: DurationFormat
): string {
  const number = numeric(value)
  if (number === null) return value
  const total = Math.abs(unit === "minutes" ? number * 60 : number)
  const sign = number < 0 ? "-" : ""
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (format === "h:mm") return `${sign}${hours}:${pad(Math.round(minutes + (total % 60) / 60) % 60)}`
  const digits = format === "h:mm:ss" ? 0 : format.length - "h:mm:ss.".length
  const seconds = total % 60
  const shown = digits ? seconds.toFixed(digits).padStart(3 + digits, "0") : pad(Math.floor(seconds))
  return `${sign}${hours}:${pad(minutes)}:${shown}`
}

/** The values in one cell of a multi-select: `a, b`, `{a,b}` or `["a","b"]`. */
export function splitValues(value: string): string[] {
  const text = value.trim()
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      // Not JSON after all: split it as text.
    }
  }
  const inner = text.startsWith("{") && text.endsWith("}") ? text.slice(1, -1) : text
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
}

/** A colour the cell can paint: hex, rgb(), hsl() or oklch(). */
export function cssColour(value: string): string | null {
  const text = value.trim()
  if (/^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
    return text.startsWith("#") ? text : `#${text}`
  }
  if (/^(rgb|rgba|hsl|hsla|oklch)\([^;{}]*\)$/i.test(text)) return text
  return null
}
