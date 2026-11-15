import { memo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { SqlText } from "./sql-code"

/** A fence marked as SQL, in any of the spellings a model writes. */
const SQL_FENCE = /\blanguage-(sql|postgres(ql)?|pgsql|plpgsql|mysql)\b/i

/**
 * An answer, drawn. Raw HTML in it is left as text — `react-markdown` does
 * not render it unless asked to — so nothing the model or a database value
 * says can become markup in this window.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Opened by the main process in the browser, never in this window.
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          code: ({ node: _node, className, children, ...props }) => (
            <code className={className} {...props}>
              {typeof children === "string" && SQL_FENCE.test(className ?? "") ? (
                <SqlText text={children} />
              ) : (
                children
              )}
            </code>
          ),
          table: ({ node: _node, ...props }) => (
            <div className="table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
