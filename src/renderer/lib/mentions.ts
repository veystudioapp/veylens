import {
  mentionTargets,
  type MentionTarget,
} from "@shared/mentions"

import { useStore } from "./store"

type State = ReturnType<typeof useStore.getState>

/** The connection a message would go to: the open tab's, the selected one, or
 * the only one there is. */
export function chatConnectionId(state: State): string | null {
  return (
    state.viewerContext().connectionId ??
    (state.connections.length === 1 ? state.connections[0]!.id : null)
  )
}

/**
 * Kept until one of its inputs is replaced. The store replaces rather than
 * mutates, so identity is the whole key, and the composer can ask on every
 * keystroke without the list being rebuilt.
 */
let cache: { key: unknown[]; targets: MentionTarget[] } | null = null

/** Everything the `@` menu can offer right now. */
export function currentMentionTargets(state: State = useStore.getState()): MentionTarget[] {
  const connectionId = chatConnectionId(state)
  const connection = state.connections.find((item) => item.id === connectionId) ?? null
  const tree = connectionId ? state.trees[connectionId] : undefined
  const knowledge = connectionId ? state.knowledge[connectionId] : undefined
  const key = [connection, state.connections, tree, state.dashboards, knowledge]
  if (cache && cache.key.every((item, index) => item === key[index])) {
    return cache.targets
  }
  const targets = mentionTargets({
    connection,
    connections: state.connections,
    schemas: tree?.status === "ready" ? tree.schemas : [],
    dashboards: state.dashboards,
    metrics: knowledge?.metrics ?? [],
  })
  cache = { key, targets }
  return targets
}

/** The same list, redrawn as tables load and dashboards change. */
export function useMentionTargets(): MentionTarget[] {
  return useStore((state) => currentMentionTargets(state))
}

/**
 * Asks for what the menu would be missing: the chat connection's tables, and
 * its metrics. Both are loaded on demand elsewhere — the explorer opens a tree
 * only when it is expanded — so the first `@` would otherwise be an empty menu.
 */
export function primeMentions(): void {
  const state = useStore.getState()
  const connectionId = chatConnectionId(state)
  if (!connectionId) return
  if (!state.trees[connectionId]) void state.loadTree(connectionId)
  if (!state.knowledge[connectionId]) {
    void state.loadKnowledge(connectionId).catch(() => undefined)
  }
}
