import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type TextareaHTMLAttributes,
} from "react"

import { SQL_HIGHLIGHT_LIMIT, sqlTokens } from "@/lib/sql-tokens"
import { cn } from "@/lib/utils"

/**
 * SQL, coloured: spans to put inside a `<pre>` or `<code>` of the caller's,
 * which keeps its own box, font and wrapping. Colours are `.sql-*` in
 * `index.css`.
 */
export const SqlText = memo(function SqlText({ text }: { text: string }) {
  const tokens = useMemo(
    () => (text.length > SQL_HIGHLIGHT_LIMIT ? null : sqlTokens(text)),
    [text]
  )
  if (!tokens) return <>{text}</>
  return (
    <>
      {tokens.map((token, index) =>
        token.kind === "text" ? (
          token.text
        ) : (
          <span key={index} className={`sql-${token.kind}`}>
            {token.text}
          </span>
        )
      )}
    </>
  )
})

/** What the copy over a textarea takes from it, so its letters land on the
 * textarea's own. */
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontFeatureSettings",
  "fontVariantLigatures",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const

type SqlTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  value: string
}

/**
 * A textarea for SQL whose text is coloured. The textarea stays what is typed
 * in — selection, the caret, undo, ⌘↵ and the caller's ref all as before —
 * with its letters made transparent; a copy of the text, coloured, is laid
 * exactly over it and lets every click through. The copy is placed where the
 * textarea is measured to be, so it works whatever the textarea's own layout.
 */
export const SqlTextarea = forwardRef<HTMLTextAreaElement, SqlTextareaProps>(
  function SqlTextarea({ value, className, onScroll, ...props }, ref) {
    const area = useRef<HTMLTextAreaElement>(null)
    const mirror = useRef<HTMLPreElement>(null)
    useImperativeHandle(ref, () => area.current!, [])
    const plain = value.length > SQL_HIGHLIGHT_LIMIT

    // On every render, as well as on a resize: a sibling above it may have
    // moved it without changing its size.
    useLayoutEffect(() => {
      const textarea = area.current
      const copy = mirror.current
      if (!textarea || !copy) return
      const place = () => {
        const style = getComputedStyle(textarea)
        for (const property of MIRRORED) copy.style[property] = style[property]
        const left = textarea.offsetLeft + textarea.clientLeft
        const top = textarea.offsetTop + textarea.clientTop
        copy.style.left = `${left}px`
        copy.style.top = `${top}px`
        copy.style.width = `${textarea.clientWidth}px`
        copy.style.height = `${textarea.clientHeight}px`
        // The measurements are whole pixels and a box often is not: rounded
        // up, the copy would reach past its container by a pixel — and give
        // that container a scrollbar of its own.
        copy.style.maxWidth = `calc(100% - ${left}px)`
        copy.style.maxHeight = `calc(100% - ${top}px)`
        copy.scrollTop = textarea.scrollTop
        copy.scrollLeft = textarea.scrollLeft
      }
      place()
      const observer = new ResizeObserver(place)
      observer.observe(textarea)
      return () => observer.disconnect()
    })

    return (
      <>
        <textarea
          ref={area}
          value={value}
          onScroll={(event) => {
            if (mirror.current) {
              mirror.current.scrollTop = event.currentTarget.scrollTop
              mirror.current.scrollLeft = event.currentTarget.scrollLeft
            }
            onScroll?.(event)
          }}
          className={cn(className, !plain && value && "sql-input")}
          {...props}
        />
        {!plain && value && (
          <pre
            ref={mirror}
            aria-hidden
            className="pointer-events-none absolute m-0 overflow-hidden border-0 bg-transparent break-words whitespace-pre-wrap text-foreground"
          >
            <SqlText text={value} />
            {/* A last empty line a textarea shows, a pre does not. */}
            {value.endsWith("\n") ? " " : ""}
          </pre>
        )}
      </>
    )
  }
)
