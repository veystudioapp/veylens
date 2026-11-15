import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { keywordCompletionSource, MySQL, PostgreSQL } from "@codemirror/lang-sql"
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language"
import { lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view"
import { tagHighlighter, tags } from "@lezer/highlight"
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"

import type { Engine } from "@shared/api"

import { tableCompletionSource } from "@/lib/sql-completion-source"
import { cn } from "@/lib/utils"

/** The `.sql-*` colours of `index.css`, which the read-only SQL uses too. */
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.bool, tags.null], class: "sql-keyword" },
  { tag: tags.typeName, class: "sql-type" },
  { tag: tags.standard(tags.name), class: "sql-function" },
  { tag: tags.string, class: "sql-string" },
  { tag: tags.number, class: "sql-number" },
  { tag: tags.special(tags.name), class: "sql-param" },
  { tag: [tags.lineComment, tags.blockComment], class: "sql-comment" },
])

const muted = (share: number) => `color-mix(in oklch, var(--muted-foreground) ${share}%, transparent)`

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", color: "var(--foreground)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 12%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
    outline: "none",
  },
  ".cm-placeholder": { color: muted(50) },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklch, var(--muted) 30%, transparent)",
    borderRight: "1px solid var(--border)",
    color: muted(60),
    fontSize: "11px",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 6px 0 8px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-lint-marker": { width: "0.8em", height: "0.8em" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--destructive)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 8px 24px -8px rgb(0 0 0 / 0.25)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxHeight: "16rem",
    minWidth: "16rem",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { borderRadius: "6px", padding: "2px 8px", lineHeight: "20px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": { marginLeft: "12px", fontStyle: "normal", color: muted(100), fontSize: "11px" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-completionIcon": { opacity: "0.6", width: "1.1em", paddingRight: "0.5em" },
  ".cm-tooltip-lint": { fontFamily: "var(--font-sans)", fontSize: "12px", maxWidth: "36rem" },
  ".cm-diagnostic": { padding: "6px 10px", whiteSpace: "pre-wrap" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  ".cm-panels": { backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "12px" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--sql-number) 25%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--sql-number) 45%, transparent)" },
})

/** A change made to follow the `value` prop, which is not the user's. */
const external = Annotation.define<boolean>()

export type SqlEditorHandle = {
  focus(): void
  /** The main selection. */
  selection(): { from: number; to: number }
}

export type SqlEditorCursor = { line: number; column: number; selected: number }

type Props = {
  value: string
  onChange: (value: string) => void
  onCursor: (cursor: SqlEditorCursor) => void
  /** ⌘↵. */
  onRun: () => void
  /** ⇧⌘↵. */
  onPlan: () => void
  connectionId: string
  engine: Engine
  defaultSchema: string
  upperCaseKeywords: boolean
  /** Underlined, and told on hover. Dropped by the caller once it is stale. */
  error: { from: number; to: number; message: string } | null
  placeholder?: string
  label?: string
  className?: string
}

function language({
  connectionId,
  engine,
  defaultSchema,
  upperCaseKeywords,
}: Pick<Props, "connectionId" | "engine" | "defaultSchema" | "upperCaseKeywords">) {
  const dialect = engine === "mysql" ? MySQL : PostgreSQL
  return new LanguageSupport(dialect.language, [
    dialect.language.data.of({ autocomplete: keywordCompletionSource(dialect, upperCaseKeywords) }),
    dialect.language.data.of({
      autocomplete: tableCompletionSource({ connectionId, engine, defaultSchema }),
    }),
  ])
}

/** The SQL tab's editor: CodeMirror, with the connection's tables and
 * columns to complete and the last run's error drawn where it points. */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const languageSlot = useRef(new Compartment())

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      selection: () => {
        const main = view.current?.state.selection.main
        return main ? { from: main.from, to: main.to } : { from: 0, to: 0 }
      },
    }),
    []
  )

  useEffect(() => {
    const report = (state: EditorState) => {
      const main = state.selection.main
      const line = state.doc.lineAt(main.head)
      latest.current.onCursor({ line: line.number, column: main.head - line.from + 1, selected: main.to - main.from })
    }
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          lintGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(2),
          indentUnit.of("  "),
          indentOnInput(),
          syntaxHighlighting(highlighter),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ icons: true, filterStrict: true }),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          placeholder(latest.current.placeholder ?? ""),
          EditorView.contentAttributes.of({ "aria-label": latest.current.label ?? "SQL" }),
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (latest.current.onRun(), true) },
              { key: "Shift-Mod-Enter", run: () => (latest.current.onPlan(), true) },
            ])
          ),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          languageSlot.current.of(language(latest.current)),
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(external))) {
              latest.current.onChange(update.state.doc.toString())
            }
            if (update.docChanged || update.selectionSet) report(update.state)
          }),
        ],
      }),
    })
    view.current = editor
    report(editor.state)
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  const { value, connectionId, engine, defaultSchema, upperCaseKeywords, error } = props

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: external.of(true),
    })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(
        language({ connectionId, engine, defaultSchema, upperCaseKeywords })
      ),
    })
  }, [connectionId, engine, defaultSchema, upperCaseKeywords])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const length = editor.state.doc.length
    const diagnostics =
      error && error.from < length
        ? [{ from: error.from, to: Math.min(error.to, length), severity: "error" as const, message: error.message }]
        : []
    editor.dispatch(setDiagnostics(editor.state, diagnostics))
  }, [error])

  return <div ref={host} className={cn("h-full min-h-0 overflow-hidden", props.className)} />
})
