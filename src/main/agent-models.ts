import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk"

import { CHAT_EFFORTS, type AgentModel, type ChatEffort } from "../shared/api"
import { claudeEnvironment, locateClaude } from "./claude-bin"

/**
 * Which models the user's own `claude` offers, asked of it — the same way
 * Vey's `main/agent-models.ts` does. A process, no tokens, no turn: the
 * session is opened on a prompt that never arrives, asked over the control
 * channel, and closed.
 */

const TIMEOUT_MS = 10_000

/** Held for the run: the answer belongs to the install and the account, and
 * neither changes under a running app often enough to ask every time. */
let asking: Promise<AgentModel[]> | null = null

export function agentModels(fresh = false): Promise<AgentModel[]> {
  if (asking && !fresh) return asking
  const pending = ask().catch((error: unknown) => {
    console.error("Could not ask claude which models it has", error)
    // A failure is not remembered: the next picker to open asks again.
    if (asking === pending) asking = null
    return []
  })
  asking = pending
  return pending
}

async function ask(): Promise<AgentModel[]> {
  const binary = await locateClaude()
  if (!binary) return []

  const held = new AbortController()
  // A prompt that never arrives: one that ended would let the CLI exit before
  // the control request was answered.
  const nothing: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never, undefined>>((resolve) => {
          held.signal.addEventListener(
            "abort",
            () => resolve({ done: true, value: undefined }),
            { once: true }
          )
        }),
    }),
  }

  const conversation = query({
    prompt: nothing,
    options: {
      pathToClaudeCodeExecutable: binary.path,
      env: claudeEnvironment(binary),
      abortController: held,
      settingSources: ["user"],
    },
  })

  try {
    const models = await Promise.race([
      conversation.supportedModels(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`No answer in ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS
        ).unref()
      ),
    ])
    return models.map(readModel)
  } finally {
    held.abort()
    await conversation.return?.(undefined).catch(() => {})
  }
}

/** The CLI's row as the picker's, as Vey reads it. */
function readModel(model: ModelInfo): AgentModel {
  const levels = model.supportsEffort ? (model.supportedEffortLevels ?? []) : []
  const isNew =
    /\b(?:opus\s*5|sonnet\s*5|new)\b/i.test(model.displayName) ||
    /\b(?:opus\s*5|sonnet\s*5)\b/i.test(model.description)
  const isFavorite =
    /\b(?:5\.5|recommended)\b/i.test(model.displayName) ||
    model.value === "default"
  return {
    value: model.value,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    label: model.displayName,
    description: model.description,
    efforts: levels.filter((level): level is ChatEffort =>
      (CHAT_EFFORTS as readonly string[]).includes(level)
    ),
    ...(isNew ? { isNew: true } : {}),
    ...(isFavorite ? { isFavorite: true } : {}),
  }
}
