import { ChartColumn, Play, Rows3, Table2, Type } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import {
  isTextTile,
  tileText,
  type ChartSpec,
  type DashboardTile,
  type ParamValues,
  type QueryResult,
  type TileHeight,
  type TileWidth,
} from "@shared/api"
import { chartProblem, inferChart } from "@shared/chart"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/store"
import { IconTile, KIND_TONE } from "@/lib/tones"
import { cn } from "@/lib/utils"

import { Chart, ResultTable } from "../Chart"
import { ChartControls } from "../chart-controls"
import { Markdown } from "../Markdown"
import { ErrorNote } from "../state-view"
import { SqlTextarea } from "../sql-code"

const WIDTHS: { value: TileWidth; label: string }[] = [
  { value: 1, label: "¼" },
  { value: 2, label: "½" },
  { value: 3, label: "¾" },
  { value: 4, label: "Full" },
]
const HEIGHTS: { value: TileHeight; label: string }[] = [
  { value: "s", label: "Short" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Tall" },
]
/** The plot in a tile of each height — as the dashboard draws it. */
const PLOT: Record<TileHeight, number> = { s: 90, m: 220, l: 370 }

type Preview =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: QueryResult }
  | { state: "failed"; error: string }

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)

/** One choice of a few, as buttons side by side. */
function Segmented<Value extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: { value: Value; label: ReactNode; title?: string }[]
  onChange: (value: Value) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-6 flex-1 items-center justify-center gap-1 rounded-[5px] px-2 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5",
            option.value === value && "bg-background font-medium text-foreground shadow-xs"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold">{title}</h3>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </section>
  )
}

/** Four columns, the tile's span filled: what "½" means, drawn. */
function WidthGlyph({ width }: { width: number }) {
  return (
    <span aria-hidden className="flex gap-px">
      {[1, 2, 3, 4].map((column) => (
        <span
          key={column}
          className={cn("h-2 w-1 rounded-[1px]", column <= width ? "bg-current" : "bg-current opacity-20")}
        />
      ))}
    </span>
  )
}

/**
 * A tile written or rewritten in place: the query on the left over the tile
 * as the dashboard will draw it, its size and drill-down on the right.
 */
export function TileEditor({
  open,
  tile,
  connectionId,
  params,
  onClose,
  onSave,
}: {
  open: boolean
  /** A new one has no id; text or not, it is already decided. */
  tile: DashboardTile | null
  connectionId: string
  params: ParamValues
  onClose: () => void
  onSave: (tile: DashboardTile) => void
}) {
  const [draft, setDraft] = useState<DashboardTile | null>(tile)
  const [preview, setPreview] = useState<Preview>({ state: "idle" })
  const [showChart, setShowChart] = useState(true)
  const [ranSql, setRanSql] = useState<string | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(tile)
    setPreview({ state: "idle" })
    setRanSql(null)
    setShowChart(tile?.chart != null)
  }, [open, tile])

  const run = async (sql: string) => {
    setPreview({ state: "running" })
    try {
      const result = await window.veylens.runQuery(connectionId, sql, true, params)
      setPreview({ state: "done", result })
      setRanSql(sql)
      setDraft((current) => {
        if (!current) return current
        const keep = current.chart && !chartProblem(current.chart, result)
        const chart = keep ? current.chart : inferChart(result)
        if (!keep && chart) setShowChart(true)
        return { ...current, chart }
      })
    } catch (error) {
      setPreview({ state: "failed", error: errorMessage(error) })
    }
  }

  // An existing tile's result is there to look at from the start.
  useEffect(() => {
    if (open && tile && !isTextTile(tile) && tile.sql.trim()) void run(tile.sql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tile])

  if (!draft) return null
  const text = isTextTile(draft)
  const result = preview.state === "done" ? preview.result : null
  const problem = result && draft.chart && showChart ? chartProblem(draft.chart, result) : null
  const names = Object.keys(params)
  const width = draft.width ?? 2
  const height = draft.height ?? "m"
  const stale = !!result && ranSql !== null && ranSql !== draft.sql
  const tone = text ? "gray" : showChart && draft.chart ? KIND_TONE.chart : KIND_TONE.table

  // A filter's placeholder goes where the caret is, as if typed.
  const insert = (snippet: string) => {
    const element = editor.current
    const at = element?.selectionStart ?? draft.sql.length
    const to = element?.selectionEnd ?? at
    const sql = draft.sql.slice(0, at) + snippet + draft.sql.slice(to)
    setDraft({ ...draft, sql })
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(at + snippet.length, at + snippet.length)
    })
  }

  const save = () => {
    onSave({
      ...draft,
      chart: text || !showChart ? null : draft.chart,
      drillSql: draft.drillSql?.trim() ? draft.drillSql : null,
    })
  }
  const canSave = text ? !!draft.text?.trim() : !!draft.sql.trim() && !problem

  // The tile, as the dashboard will draw it: at its share of the width (but
  // never too narrow to judge), at its height.
  const tileBody = text ? (
    <div className="tile-text">
      <Markdown text={tileText(draft.text ?? "") || "*Nothing written yet.*"} />
    </div>
  ) : preview.state === "running" && !result ? (
    <div className="flex flex-1 items-center justify-center py-10">
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  ) : preview.state === "failed" ? (
    <ErrorNote mono>{preview.error}</ErrorNote>
  ) : !result ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-10 text-center text-xs text-muted-foreground">
      <Play className="mb-1 size-5 opacity-50" />
      Run the query to see the tile.
      <span className="text-[11px]">
        <kbd className="font-sans">{isMac ? "⌘" : "Ctrl"}</kbd>
        <kbd className="font-sans">↵</kbd> in the editor
      </span>
    </div>
  ) : problem ? (
    <ErrorNote>{problem}</ErrorNote>
  ) : showChart && draft.chart ? (
    <Chart
      spec={draft.chart}
      data={result}
      height={PLOT[height]}
      limit={height === "l" ? 20 : height === "s" ? 4 : 10}
      titled={!!draft.title.trim()}
    />
  ) : (
    <ResultTable
      data={result}
      maxRows={200}
      className={height === "s" ? "max-h-24" : height === "l" ? "max-h-[26rem]" : "max-h-64"}
    />
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[min(780px,90vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1120px,calc(100vw-4rem))]">
        {/* The title is the tile's own, edited where it is read. */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b pr-12 pl-4">
          <IconTile tone={tone} size="md">
            {text ? <Type /> : showChart && draft.chart ? <ChartColumn /> : <Table2 />}
          </IconTile>
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="text-[11px] font-normal text-muted-foreground">
              {tile?.id ? "Edit tile" : text ? "New text tile" : "New tile"}
            </DialogTitle>
            <input
              aria-label="Tile title"
              value={draft.title}
              placeholder={text ? "No title (the text is its heading)" : "Untitled tile"}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              className="-ml-1 h-7 rounded-md bg-transparent px-1 text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground hover:bg-muted/60 focus:bg-muted/60"
            />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_272px]">
          <div className="flex min-h-0 flex-col">
            {/* Editor */}
            <div className="relative flex shrink-0 flex-col border-b">
              <div className="flex h-9 items-center gap-1.5 border-b px-3">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {text ? "Markdown" : "SQL"}
                </span>
                {!text && names.length > 0 && (
                  <>
                    <span aria-hidden className="mx-1 h-3.5 w-px bg-border" />
                    <span className="text-[11px] text-muted-foreground">Insert</span>
                    {names.map((name) => (
                      <button
                        key={name}
                        type="button"
                        title={`Insert {{${name}}}: the filter's value`}
                        onClick={() => insert(`{{${name}}}`)}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {name}
                      </button>
                    ))}
                  </>
                )}
                <div className="flex-1" />
                {!text && (
                  <Button
                    size="xs"
                    variant={stale || !result ? "default" : "outline"}
                    disabled={!draft.sql.trim() || preview.state === "running"}
                    onClick={() => void run(draft.sql)}
                    title={`Run (${isMac ? "⌘" : "Ctrl"}↵)`}
                  >
                    {preview.state === "running" ? <Spinner className="size-3" /> : <Play />}
                    Run
                  </Button>
                )}
              </div>
              {text ? (
                <textarea
                  aria-label="Tile text"
                  value={draft.text ?? ""}
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                  placeholder={"## Section heading\nA sentence on what the tiles below show."}
                  className="h-44 resize-none bg-muted/30 px-4 py-3 font-mono text-xs leading-5 outline-none"
                />
              ) : (
                <SqlTextarea
                  ref={editor}
                  aria-label="Tile SQL"
                  value={draft.sql}
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, sql: event.target.value })}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void run(draft.sql)
                    }
                  }}
                  placeholder={"SELECT status, count(*) AS orders\n  FROM orders\n WHERE true [[AND ordered_at >= {{date_start}}]]\n GROUP BY 1"}
                  className="h-44 resize-none bg-muted/30 px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap outline-none"
                />
              )}
            </div>

            {/* The tile, as it will be */}
            <div className="flex min-h-0 flex-1 flex-col bg-muted/50 dark:bg-background">
              <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Preview
                </span>
                {result && !text && (
                  <>
                    <div className="w-36">
                      <Segmented
                        label="Show as"
                        value={showChart && draft.chart ? "chart" : "rows"}
                        options={[
                          { value: "chart", label: <><ChartColumn />Chart</> },
                          { value: "rows", label: <><Rows3 />Rows</> },
                        ]}
                        onChange={(value) => {
                          if (value === "chart" && !draft.chart) {
                            const chart = inferChart(result)
                            if (!chart) return
                            setDraft({ ...draft, chart })
                          }
                          setShowChart(value === "chart")
                        }}
                      />
                    </div>
                    {showChart && draft.chart && (
                      <ChartControls
                        spec={draft.chart}
                        data={result}
                        onChange={(chart: ChartSpec) => setDraft({ ...draft, chart })}
                      />
                    )}
                  </>
                )}
                <div className="flex-1" />
                {result && !text && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {stale && <span className="mr-2 text-amber-600 dark:text-amber-400">Edited since run</span>}
                    {result.rows.length.toLocaleString()}
                    {result.truncated ? "+" : ""} {result.rows.length === 1 ? "row" : "rows"} ·{" "}
                    {Math.round(result.ms)} ms
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
                <div
                  className={cn(
                    "flex flex-col gap-3 rounded-lg border bg-card p-4 pt-3 shadow-xs transition-opacity",
                    text && "border-dashed bg-transparent shadow-none",
                    preview.state === "running" && result && "opacity-50"
                  )}
                  style={{ width: `max(${width * 25}%, min(100%, 320px))` }}
                >
                  {!text && (
                    <div className="flex h-6 items-center text-[13px] font-semibold">
                      <span className={cn("truncate", !draft.title.trim() && "font-normal text-muted-foreground")}>
                        {draft.title.trim() || "Untitled tile"}
                      </span>
                    </div>
                  )}
                  {tileBody}
                </div>
              </div>
            </div>
          </div>

          {/* Settings */}
          <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto border-l px-4 py-4">
            <Section title="Width" hint="Of the dashboard's four columns. On a narrow window tiles stack.">
              <Segmented
                label="Tile width"
                value={width}
                options={WIDTHS.map((option) => ({
                  value: option.value,
                  title: option.value === 4 ? "Full width" : `${option.label} width`,
                  label: (
                    <>
                      <WidthGlyph width={option.value} />
                      {option.label}
                    </>
                  ),
                }))}
                onChange={(value) => setDraft({ ...draft, width: value })}
              />
            </Section>
            <Section title="Height" hint={text ? "A text tile takes the room its words need." : undefined}>
              <Segmented
                label="Tile height"
                value={height}
                options={HEIGHTS}
                onChange={(value) => setDraft({ ...draft, height: value })}
              />
            </Section>

            {!text && (
              <>
                <Section
                  title="Filters"
                  hint={
                    <>
                      <code className="font-mono">{"{{name}}"}</code> is a filter's value;
                      a clause in <code className="font-mono">[[ … ]]</code> is dropped
                      while its filter is on All. Values are bound, never pasted in.
                    </>
                  }
                >
                  {names.length === 0 ? (
                    <p className="text-xs text-muted-foreground">This dashboard has no filters.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {names.map((name) => {
                        const used = draft.sql.includes(`{{${name}}}`)
                        return (
                          <span
                            key={name}
                            className={cn(
                              "rounded px-1.5 py-0.5 font-mono text-[11px]",
                              used ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                            )}
                            title={used ? "Used by this tile" : "Not used by this tile"}
                          >
                            {name}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </Section>

                <Section
                  title="Drill-down"
                  hint={
                    <>
                      The rows behind a category, shown by <em>Show rows</em> after one is
                      clicked. <code className="font-mono">{"{{value}}"}</code> is the category;
                      the filters work here too.
                    </>
                  }
                >
                  <div className="relative flex flex-col">
                  <SqlTextarea
                    aria-label="Drill-down SQL"
                    value={draft.drillSql ?? ""}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, drillSql: event.target.value })}
                    placeholder="SELECT * FROM orders WHERE status = {{value}} LIMIT 500"
                    className="min-h-24 resize-y rounded-md border bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-4 outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  />
                  </div>
                </Section>
              </>
            )}
          </aside>
        </div>

        <div className="flex h-14 shrink-0 items-center gap-2 border-t bg-muted/40 px-4">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {problem
              ? "Fix the chart, or show the rows, to save."
              : !text && !draft.sql.trim()
                ? "A tile needs a query."
                : ""}
          </span>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {tile?.id ? "Save tile" : "Add tile"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
