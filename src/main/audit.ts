import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { AuditEntry, ChangeSet, ChatEvent } from "../shared/api"

/** A failure the app's own rules caused, rather than the database. */
export const refusal = (message: string) =>
  /Refused by the permissions|is read-only in Vey Data|turned \S+ off in Settings/i.test(message)

/** "2 updated, 1 added, 1 deleted in public.orders" */
export function describeChanges(changes: ChangeSet): string {
  const parts = [
    changes.updates.length && `${changes.updates.length} updated`,
    changes.inserts.length && `${changes.inserts.length} added`,
    changes.deletes.length && `${changes.deletes.length} deleted`,
  ].filter(Boolean)
  return `${parts.join(", ") || "Nothing changed"} in ${changes.schema}.${changes.table}`
}

/** Entries kept: the oldest go once there are more. */
export const AUDIT_KEEP = 5000

/** Text kept of a statement or a detail, past which it is cut. */
const SQL_CHARS = 20_000
const DETAIL_CHARS = 2_000

const cut = (text: string | undefined, most: number) =>
  text === undefined ? undefined : text.length > most ? `${text.slice(0, most)}…` : text

/**
 * What was changed, run or refused, and by whom — one JSON line per entry in
 * `audit.jsonl`, appended as it happens, so a crash loses nothing written
 * before it. The file is rewritten only to drop the oldest.
 */
export class AuditLog {
  private readonly file: string
  private entries: AuditEntry[] = []

  constructor(
    dataDir: string,
    private readonly emit: (event: ChatEvent) => void = () => {}
  ) {
    this.file = path.join(dataDir, "audit.jsonl")
    if (!existsSync(this.file)) return
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as AuditEntry
        if (entry && typeof entry.id === "string" && typeof entry.at === "number") {
          this.entries.push(entry)
        }
      } catch {
        // A line cut off by a crash is skipped.
      }
    }
    if (this.entries.length > AUDIT_KEEP) this.trim()
  }

  record(input: Omit<AuditEntry, "id" | "at"> & { at?: number }): AuditEntry {
    const entry: AuditEntry = {
      ...input,
      id: randomUUID(),
      at: input.at ?? Date.now(),
      summary: cut(input.summary, 500)!,
      sql: cut(input.sql, SQL_CHARS),
      detail: cut(input.detail, DETAIL_CHARS),
    }
    this.entries.push(entry)
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch {
      // Kept in memory for this run, at least.
    }
    // Rewritten now and then, not on every entry past the limit.
    if (this.entries.length > AUDIT_KEEP * 1.1) this.trim()
    this.emit({ type: "audit", entry })
    return entry
  }

  /** Newest first. */
  list(): AuditEntry[] {
    return [...this.entries].reverse()
  }

  clear(): void {
    this.entries = []
    writeFileSync(this.file, "")
  }

  private trim(): void {
    this.entries = this.entries.slice(-AUDIT_KEEP)
    try {
      writeFileSync(this.file, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    } catch {
      // The next trim tries again.
    }
  }
}
