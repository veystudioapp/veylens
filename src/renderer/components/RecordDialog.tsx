import { ChevronDown, ChevronUp, Lock } from "lucide-react"
import { useEffect, useState } from "react"

import type { Cell } from "@shared/api"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { CellFormat } from "@/lib/cell-format"
import { cn } from "@/lib/utils"

import { CellText, FieldIcon, lockedBecause, type GridColumn } from "./DataGrid"
import { IconButton } from "./icon-button"

/**
 * One row as a form, as NocoDB expands a record: every field down the page
 * with room for long values, drawn as the grid draws them. An edit here is the
 * same pending edit as one made in the grid — it shows in both, and is saved
 * with the toolbar's Save.
 */
export function RecordDialog({
  rowId,
  columns,
  formats,
  values,
  edited,
  title,
  raw,
  editable,
  isNew = false,
  onChange,
  onPrevious,
  onNext,
  onClose,
}: {
  /** Which row this is; another one resets the form. */
  rowId: string
  columns: GridColumn[]
  formats: CellFormat[]
  values: (Cell | undefined)[]
  /** Columns with an unsaved edit. */
  edited: string[]
  title: string
  raw: boolean
  editable: boolean
  /** A row about to be added: its key may be typed, unless numbered. */
  isNew?: boolean
  onChange: (column: string, value: Cell) => void
  onPrevious?: () => void
  onNext?: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // Another row: nothing half-typed carries over to it.
  useEffect(() => setEditing(null), [rowId])

  const start = (column: GridColumn, value: Cell | undefined) => {
    if (!editable || lockedBecause(column, isNew)) return
    setEditing(column.name)
    setDraft(value ?? "")
  }

  const commit = (value: Cell) => {
    if (editing) onChange(editing, value)
    setEditing(null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(720px,calc(100%-4rem))] max-w-[calc(100%-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex items-center gap-2 border-b py-3 pr-12 pl-5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px] font-semibold tracking-tight">
              {title}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {columns.length} fields
              {edited.length > 0 &&
                ` · ${edited.length} unsaved ${edited.length === 1 ? "change" : "changes"}`}
            </DialogDescription>
          </div>
          <IconButton label="Previous row" disabled={!onPrevious} onClick={onPrevious}>
            <ChevronUp />
          </IconButton>
          <IconButton label="Next row" disabled={!onNext} onClick={onNext}>
            <ChevronDown />
          </IconButton>
        </div>

        <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {columns.map((column, index) => {
            const value = values[index]
            const format = formats[index] ?? { kind: "plain" }
            const changed = edited.includes(column.name)
            const locked = lockedBecause(column, isNew)
            const canEdit = editable && !locked
            return (
              <div
                key={column.name}
                className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-4 border-b py-2.5 last:border-b-0"
              >
                <div className="flex min-w-0 items-start gap-2 pt-1">
                  <FieldIcon column={column} format={format} className="mt-0.5" />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{column.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {column.type}
                    </div>
                    {editable && locked && (
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Lock className="size-3 shrink-0" />
                        <span className="truncate" title={locked}>{locked}</span>
                      </div>
                    )}
                  </div>
                </div>

                {editing === column.name ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      autoFocus
                      value={draft}
                      rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          commit(draft)
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          event.stopPropagation()
                          setEditing(null)
                        }
                      }}
                      className={cn(
                        "min-h-8 text-xs",
                        (column.kind === "json" || column.kind === "binary") && "font-mono"
                      )}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="xs" onClick={() => commit(draft)}>
                        Done
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      {(column.nullable ?? true) && (
                        <Button size="xs" variant="ghost" onClick={() => commit(null)}>
                          Set NULL
                        </Button>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">⌘↵</span>
                    </div>
                  </div>
                ) : (
                  <div
                    role={canEdit ? "button" : undefined}
                    tabIndex={canEdit ? 0 : undefined}
                    onClick={() => start(column, value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") start(column, value)
                    }}
                    className={cn(
                      "min-h-7 rounded-md px-2 py-1 text-[13px] break-words whitespace-pre-wrap",
                      canEdit && "cursor-text hover:bg-muted/60",
                      changed && "bg-[var(--cell-edited)]",
                      (column.kind === "json" || column.kind === "binary") &&
                        "font-mono text-xs"
                    )}
                  >
                    <CellText
                      value={value}
                      kind={column.kind}
                      format={format.kind === "image" ? { kind: "url" } : format}
                      raw={raw}
                      placeholder="default"
                    />
                    {format.kind === "image" && value && !raw && (
                      <img
                        src={value}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="mt-2 max-h-48 rounded-md border"
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {editable && (
          <div className="border-t bg-muted/30 px-5 py-2 text-[11px] text-muted-foreground">
            Edits here wait with the table's other changes until you press Save.
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
