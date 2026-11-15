import type { Completion, CompletionSource } from "@codemirror/autocomplete"

import type { Column, Engine, TableRef } from "@shared/api"

import { completions, completionSpot, type Completion as Suggestion } from "./sql-complete"
import { useStore, type TreeState } from "./store"

/** Columns by table, per loaded tree: a reloaded explorer starts afresh. */
const columnCache = new WeakMap<TreeState, Map<string, Promise<Column[]>>>()

const TYPE: Record<Suggestion["kind"], string> = {
  table: "class",
  view: "interface",
  column: "property",
}

/**
 * The connection's tables, and the columns of the tables the statement
 * names — fetched the first time they are wanted. Ahead of the keywords, in
 * the order `completions` ranks them.
 */
export function tableCompletionSource({
  connectionId,
  engine,
  defaultSchema,
}: {
  connectionId: string
  engine: Engine
  defaultSchema: string
}): CompletionSource {
  return async (context) => {
    const spot = completionSpot(context.state.doc.toString(), context.pos, engine)
    if (!spot || (!spot.prefix && spot.qualifier === null && !context.explicit)) return null

    let tree = useStore.getState().trees[connectionId]
    if (!tree) {
      await useStore.getState().loadTree(connectionId)
      tree = useStore.getState().trees[connectionId]
    }
    if (tree?.status !== "ready" || context.aborted) return null
    const { schemas } = tree
    let cache = columnCache.get(tree)
    if (!cache) columnCache.set(tree, (cache = new Map()))
    const known = new Map<string, Column[]>()
    const keyOf = (ref: TableRef) => `${ref.schema}\u0000${ref.table}`

    const ask = () =>
      completions(spot, { schemas, defaultSchema, engine, columnsOf: (ref) => known.get(keyOf(ref)) })
    let result = ask()
    if (result.pending.length) {
      await Promise.all(
        result.pending.map(async (ref) => {
          const key = keyOf(ref)
          let columns = cache.get(key)
          if (!columns) {
            columns = window.veylens
              .getTable(connectionId, ref)
              .then((info) => info.columns)
              .catch(() => [])
            cache.set(key, columns)
          }
          known.set(key, await columns)
        })
      )
      if (context.aborted) return null
      result = ask()
    }
    if (!result.items.length) return null

    return {
      from: spot.from,
      to: spot.to,
      filter: false,
      options: result.items.map(
        (item): Completion => ({
          label: item.label,
          apply: item.insert,
          type: TYPE[item.kind],
          detail: [item.detail, item.source].filter(Boolean).join(" · ") || undefined,
        })
      ),
    }
  }
}
