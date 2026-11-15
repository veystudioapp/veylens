import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Which `claude` this app runs, and the PATH it is run with.
 *
 * The user's own install rather than one bundled here: their login, their
 * plan, their endpoint. `CLAUDE_BIN` names a custom one.
 *
 * Asked of the login shell because an app launched from the Dock inherits
 * almost no environment — `claude` is rarely on the PATH launchd hands out.
 */
export type ClaudeBinary = { path: string; shellPath: string | null }

const MARK = "__VEYLENS__"

function askShell(): Promise<{ binary: string; shellPath: string } | null> {
  if (process.platform === "win32") return Promise.resolve(null)
  const shell = process.env.SHELL || "/bin/zsh"
  const name = process.env.CLAUDE_BIN ?? "claude"
  return new Promise((resolve) => {
    execFile(
      shell,
      // Interactive as well as login: nvm, asdf and the CLI's own installer
      // all write their PATH lines to the rc file an interactive shell reads.
      ["-lic", `echo "${MARK}$(command -v ${JSON.stringify(name)})${MARK}$PATH${MARK}"`],
      { timeout: 8000, encoding: "utf8" },
      (_error, stdout) => {
        const parts = (stdout ?? "").split(MARK)
        const binary = parts[1]?.trim() ?? ""
        const shellPath = parts[2]?.trim() ?? ""
        resolve(binary.startsWith("/") ? { binary, shellPath } : null)
      }
    )
  })
}

function wellKnown(): string | null {
  const home = os.homedir()
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".local", "bin", "claude.exe"),
          path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        ]
      : [
          path.join(home, ".local", "bin", "claude"),
          path.join(home, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

let located: Promise<ClaudeBinary | null> | null = null

/** Asked once per run: a login shell's startup is the slow part. */
export function locateClaude(): Promise<ClaudeBinary | null> {
  located ??= (async () => {
    const override = process.env.CLAUDE_BIN
    if (override && path.isAbsolute(override) && existsSync(override)) {
      return { path: override, shellPath: null }
    }
    const fromShell = await askShell()
    if (fromShell) {
      return { path: fromShell.binary, shellPath: fromShell.shellPath }
    }
    const known = wellKnown()
    return known ? { path: known, shellPath: null } : null
  })()
  return located
}

/** Marks a running `claude` exports for what it spawns. */
const AGENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_TMPDIR",
])

/**
 * The environment the CLI is spawned with: this process's own, on the shell's
 * PATH, without the marks of an agent session this app may itself have been
 * started from — a `claude` that believes it is nested inside another stops
 * writing the transcript a resume depends on.
 */
export function claudeEnvironment(
  binary: ClaudeBinary
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) {
    // Which provider and which token are the user's own choices, not marks
    // of a session, and are left as they are.
    if (/^CLAUDE_CODE_(USE_|SKIP_|OAUTH_TOKEN$)/.test(key)) continue
    if (key.startsWith("CLAUDE_CODE_") || AGENT_SESSION_VARS.has(key)) {
      delete env[key]
    }
  }
  const paths = [
    path.dirname(binary.path),
    binary.shellPath ?? "",
    env.PATH ?? "",
  ].filter(Boolean)
  env.PATH = paths.join(path.delimiter)
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "veylens/0.1.0"
  return env
}
