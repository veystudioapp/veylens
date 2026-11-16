import type { SheetAccess } from "../../../shared/api"
import { fillMerges, serialDay, serialTime, shapeSheet, type Value } from "./grid"
import { readWorkbook, type Sheet } from "./workbook"

export type Spreadsheet = { title: string; sheets: Sheet[] }

/** The spreadsheet's id in a link to it — `…/spreadsheets/d/<id>/edit#gid=0`
 * — or the id itself. */
export function spreadsheetId(url: string): string | null {
  const text = url.trim()
  const linked = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(text)
  if (linked) return linked[1]!
  return /^[A-Za-z0-9_-]{20,}$/.test(text) ? text : null
}

const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"

const SIGN_IN_HINT =
  'Use "Sign in with Google" by the sheet in the connection, or sign this machine in with gcloud auth application-default login ' +
  "--scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform," +
  READONLY_SCOPE

/** A client for the Sheets API: `request` as google-auth-library has it. */
type RequestClient = {
  request<T>(options: { url: string; params?: Record<string, unknown> }): Promise<{ data: T }>
}

let signedIn: () => Promise<RequestClient | null> = async () => null

/** The account signed in from the app, used before this machine's gcloud
 * credentials when there is one. Set once, by the main process. */
export function useSignedInAccount(provider: () => Promise<RequestClient | null>): void {
  signedIn = provider
}

/** The account a private sheet is read as: the one signed in from the app,
 * or else this machine's Application Default Credentials. */
async function sheetsClient(): Promise<{ client: RequestClient; who: "app" | "gcloud" }> {
  const account = await signedIn()
  if (account) return { client: account, who: "app" }
  // Loaded when first needed: it is large, and most connections never are.
  const { GoogleAuth } = require("google-auth-library") as typeof import("google-auth-library")
  try {
    return { client: await new GoogleAuth({ scopes: [READONLY_SCOPE] }).getClient(), who: "gcloud" }
  } catch (error) {
    throw new Error(`Not signed in to Google. ${SIGN_IN_HINT}`, { cause: error })
  }
}

/** How the spreadsheet is fetched: swapped by a test. */
export type SheetFetcher = {
  /** The workbook as Google exports it to anyone with the link. */
  exportXlsx(id: string): Promise<{ data: Uint8Array; title: string | null }>
  /** The Sheets API's answer for the spreadsheet, values and formats. */
  gridData(id: string): Promise<SheetsApiSpreadsheet>
}

/** What is asked of the Sheets API: the parts read below. */
const FIELDS =
  "properties(title),sheets(properties(title,sheetType),merges," +
  "data(startRow,startColumn,rowData(values(effectiveValue,effectiveFormat/numberFormat/type))))"

export type SheetsApiSpreadsheet = {
  properties?: { title?: string }
  sheets?: {
    properties?: { title?: string; sheetType?: string }
    merges?: {
      startRowIndex?: number
      endRowIndex?: number
      startColumnIndex?: number
      endColumnIndex?: number
    }[]
    data?: {
      startRow?: number
      startColumn?: number
      rowData?: {
        values?: {
          effectiveValue?: {
            numberValue?: number
            stringValue?: string
            boolValue?: boolean
            errorValue?: unknown
          }
          effectiveFormat?: { numberFormat?: { type?: string } }
        }[]
      }[]
    }[]
  }[]
}

/** The file name Google gives the export, which is the spreadsheet's title. */
function titleOf(disposition: string | null): string | null {
  if (!disposition) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/\.xlsx$/i, "")
    } catch {
      // Fall through to the plain name.
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1]?.replace(/\.xlsx$/i, "") ?? null
}

export const googleFetcher: SheetFetcher = {
  async exportXlsx(id) {
    const response = await fetch(
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`,
      { redirect: "follow" }
    )
    const type = response.headers.get("content-type") ?? ""
    if (response.status === 404) throw new Error("No spreadsheet at that link.")
    // A sheet not shared with anyone with the link answers with a sign-in page.
    if (!response.ok || !type.includes("spreadsheetml")) {
      throw new Error(
        `The spreadsheet is not shared as "Anyone with the link" (Google answered ${response.status}${type ? `, ${type.split(";")[0]}` : ""}). Share it that way, or read it with your Google account instead.`
      )
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      title: titleOf(response.headers.get("content-disposition")),
    }
  },

  async gridData(id) {
    const { client, who } = await sheetsClient()
    try {
      const response = await client.request<SheetsApiSpreadsheet>({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`,
        params: { includeGridData: true, fields: FIELDS },
      })
      return response.data
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } }).response?.status
      const message = error instanceof Error ? error.message : String(error)
      if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)) {
        throw new Error(
          who === "app"
            ? "The Google sign-in does not include reading Sheets: sign in with Google again and allow it."
            : `This machine's gcloud sign-in does not include Sheets. ${SIGN_IN_HINT}`
        )
      }
      if (status === 404) throw new Error("No spreadsheet with that id.")
      if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(message)) {
        throw new Error(
          who === "app"
            ? `The Google Sheets API is not enabled in the Google Cloud project of the OAuth client: enable it there. (${message})`
            : `The Google Sheets API is not enabled in the Google Cloud project this sign-in bills to. Enable it there, or set another project with gcloud auth application-default set-quota-project. (${message})`
        )
      }
      if (status === 403) {
        throw new Error(
          `The signed-in Google account cannot open this spreadsheet: share it with that account. (${message})`
        )
      }
      throw new Error(`Google Sheets: ${message}`)
    }
  },
}

/** A Sheets API cell as a value, by the number format it shows with. */
type SheetsApiCell = NonNullable<
  NonNullable<NonNullable<NonNullable<SheetsApiSpreadsheet["sheets"]>[number]["data"]>[number]["rowData"]>[number]["values"]
>[number]

function cellValue(cell: SheetsApiCell): Value {
  const value = cell.effectiveValue
  if (!value || value.errorValue !== undefined) return null
  if (value.stringValue !== undefined) return value.stringValue
  if (value.boolValue !== undefined) return value.boolValue
  if (value.numberValue === undefined) return null
  const number = value.numberValue
  switch (cell.effectiveFormat?.numberFormat?.type) {
    case "DATE":
      return serialDay(number, false)
    case "DATE_TIME":
      return serialDay(number, true)
    case "TIME":
      return serialTime(number)
    default:
      return number
  }
}

/** The Sheets API's answer as tables. */
export function sheetsFromApi(spreadsheet: SheetsApiSpreadsheet): Spreadsheet {
  const sheets: Sheet[] = []
  for (const sheet of spreadsheet.sheets ?? []) {
    // Charts on their own tab and connected sheets hold no cells.
    if (sheet.properties?.sheetType && sheet.properties.sheetType !== "GRID") continue
    const grid: Value[][] = []
    for (const block of sheet.data ?? []) {
      const top = block.startRow ?? 0
      const left = block.startColumn ?? 0
      ;(block.rowData ?? []).forEach((row, r) => {
        const target = (grid[top + r] ??= [])
        ;(row.values ?? []).forEach((cell, c) => {
          target[left + c] = cellValue(cell)
        })
      })
    }
    fillMerges(
      grid,
      (sheet.merges ?? []).map((merge) => ({
        s: { r: merge.startRowIndex ?? 0, c: merge.startColumnIndex ?? 0 },
        e: { r: (merge.endRowIndex ?? 1) - 1, c: (merge.endColumnIndex ?? 1) - 1 },
      }))
    )
    const dense = Array.from(grid, (row) => Array.from(row ?? [], (value) => value ?? null))
    const table = shapeSheet(dense)
    if (table) sheets.push({ name: sheet.properties?.title ?? `Sheet${sheets.length + 1}`, table })
  }
  return { title: spreadsheet.properties?.title ?? "", sheets }
}

/** A Google Sheet, every tab of it, as tables. */
export async function readGoogleSheet(
  url: string,
  access: SheetAccess,
  fetcher: SheetFetcher = googleFetcher
): Promise<Spreadsheet> {
  const id = spreadsheetId(url)
  if (!id) throw new Error(`Not a Google Sheets link: ${url}`)
  if (access === "google") {
    const read = sheetsFromApi(await fetcher.gridData(id))
    return { title: read.title || `sheet ${id.slice(0, 8)}`, sheets: read.sheets }
  }
  const { data, title } = await fetcher.exportXlsx(id)
  return { title: title || `sheet ${id.slice(0, 8)}`, sheets: readWorkbook(data) }
}
