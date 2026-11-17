/**
 * What an alert means, shared by the main process that checks it and the
 * page that sets it up: when it fires, what number a result is, and how its
 * condition reads.
 */
import type { AlertCondition, QueryResult } from "./api"

/** Whether a number is out of bounds. A change needs a check before it. */
export function alertFires(
  condition: AlertCondition,
  threshold: number,
  value: number,
  previous: number | null
): boolean {
  switch (condition) {
    case "above":
      return value > threshold
    case "below":
      return value < threshold
    case "change": {
      if (previous === null) return false
      return changePercent(previous, value) >= threshold
    }
  }
}

/** How far a number moved, in percent of where it was; any move off zero is
 * all the way. */
export function changePercent(previous: number, value: number): number {
  if (previous === 0) return value === 0 ? 0 : Infinity
  return (Math.abs(value - previous) / Math.abs(previous)) * 100
}

/**
 * The number a check reads: the first row's first column. Anything else — no
 * rows, a null, text — is said plainly rather than read as zero.
 */
export function readAlertValue(result: QueryResult): number {
  if (result.columns.length === 0) throw new Error("The query returned no columns.")
  const row = result.rows[0]
  if (!row) throw new Error("The query returned no rows; it should return one number.")
  const cell = row[0]
  if (cell === null || cell === undefined) throw new Error(`${result.columns[0]!.name} is NULL.`)
  const value = Number(cell)
  if (cell.trim() === "" || !Number.isFinite(value)) {
    throw new Error(`${result.columns[0]!.name} is "${cell.slice(0, 40)}", not a number.`)
  }
  return value
}

const plain = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 })

/** "goes above 1,000", "changes by 20% or more". */
export function describeCondition(condition: AlertCondition, threshold: number): string {
  switch (condition) {
    case "above":
      return `goes above ${plain(threshold)}`
    case "below":
      return `drops below ${plain(threshold)}`
    case "change":
      return `changes by ${plain(threshold)}% or more between checks`
  }
}

/** "every 15 min", "every hour", "every 6 hours", "every day". */
export function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`
  return `every ${minutes} min`
}
