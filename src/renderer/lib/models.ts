import { useEffect, useState } from "react"

import {
  CHAT_MODEL_FALLBACK,
  DEFAULT_CHAT_EFFORT,
  type AgentModel,
  type ChatEffort,
} from "@shared/api"

/**
 * The model list the picker draws, as in Vey's `lib/chat/models.ts`: the
 * fallback rows until the user's `claude` has answered, its own rows after.
 * Held for the run and shared by every picker.
 */

let asked: Promise<AgentModel[]> | null = null
let held: AgentModel[] | null = null
let reloading = false
const listeners = new Set<() => void>()

function changed() {
  for (const listener of listeners) listener()
}

/** The CLI's rows, keeping the fallback's order where a row is one of them.
 * An empty answer — no CLI, or none in time — leaves the fallback. */
function merge(discovered: AgentModel[]): AgentModel[] {
  if (discovered.length === 0) return CHAT_MODEL_FALLBACK
  const presets = new Map(CHAT_MODEL_FALLBACK.map((model) => [model.value, model]))
  return discovered.map((model) => {
    const order = presets.get(model.value)?.order
    return order === undefined ? model : { ...model, order }
  })
}

export function useAgentModels(): AgentModel[] {
  const [, redraw] = useState(0)

  useEffect(() => {
    const listener = () => redraw((count) => count + 1)
    listeners.add(listener)
    if (!held && !asked) {
      asked = window.veylens.agentModels()
      asked.then(
        (answer) => {
          held = merge(answer)
          changed()
        },
        () => {
          asked = null
        }
      )
    }
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return held ?? CHAT_MODEL_FALLBACK
}

/** Asks the CLI again — a CLI upgraded or a plan changed mid-run. */
export async function reloadAgentModels(): Promise<void> {
  if (reloading) return
  reloading = true
  changed()
  try {
    const answer = await window.veylens.agentModels(true)
    if (answer.length > 0 || !held) held = merge(answer)
  } finally {
    reloading = false
    changed()
  }
}

export const isReloadingModels = () => reloading

/** `default` first, then the fallback's order, then by name. */
export function orderedModels(models: AgentModel[]): AgentModel[] {
  return [...models].sort((left, right) => {
    if (left.value === "default") return -1
    if (right.value === "default") return 1
    if (left.order !== undefined && right.order !== undefined) {
      return left.order - right.order
    }
    if (left.order !== undefined) return -1
    if (right.order !== undefined) return 1
    return left.label.localeCompare(right.label)
  })
}

/** Which named row the CLI's `default` stands for, when it says. */
export function defaultModelAlias(models: AgentModel[]): string | null {
  const fallback = models.find((entry) => entry.value === "default")
  if (!fallback?.resolvedModel) return null
  const named = models.find(
    (entry) =>
      entry.value !== "default" &&
      entry.resolvedModel === fallback.resolvedModel
  )
  return named?.label ?? null
}

/**
 * The level a pick lands on: the one already chosen where the model takes
 * it, the default level where it takes that, otherwise its strongest. Null
 * for a model that takes no effort at all.
 */
export function effortFor(
  levels: ChatEffort[],
  effort: ChatEffort | null
): ChatEffort | null {
  if (levels.length === 0) return null
  if (effort && levels.includes(effort)) return effort
  if (levels.includes(DEFAULT_CHAT_EFFORT)) return DEFAULT_CHAT_EFFORT
  return levels[levels.length - 1] ?? null
}
