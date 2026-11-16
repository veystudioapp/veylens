/**
 * A version as numbers. Anything that is not a run of digits ends the list, so
 * `1.0.20-beta.1` is `[1, 0, 20]` and its prerelease is handled separately — a
 * `-beta` sorting as a fourth component would make it newer than its release.
 */
export function versionParts(version: string): number[] {
  const core = version.replace(/^v/, "").split(/[-+]/, 1)[0] ?? ""
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isNaN(value) ? 0 : value
  })
}

function isPrerelease(version: string): boolean {
  return /[-+]/.test(version.replace(/^v/, ""))
}

/**
 * Whether `candidate` is worth offering to somebody on `current`. Strictly
 * newer, never merely different: a build ahead of the latest release should
 * not be offered a downgrade.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate)
  const right = versionParts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return isPrerelease(current) && !isPrerelease(candidate)
}
