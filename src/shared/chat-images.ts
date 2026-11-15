/**
 * Pictures in a chat message: `[Image #n]` in the text, the bytes beside it.
 *
 * The tag is the one `claude` writes for a picture pasted into its terminal,
 * so a message reads the same either way, and it is plain text: it can be
 * moved or deleted like any other word. Deleting it is how a picture is taken
 * back out — what goes is whatever the text still names when it is sent
 * (`attachedIn`).
 *
 * Kept in `shared` so the rules can be tested without a window, and so main
 * checks what arrives by the same list the renderer reads with.
 */

export type ChatImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/** A picture as it travels with a message. */
export type ChatImage = {
  mediaType: ChatImageType
  /** Base64, without a `data:` prefix. */
  data: string
}

/** What the API takes as it is; anything else is redrawn as a PNG first. */
export const SENDABLE_TYPES: readonly ChatImageType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]

/** The API refuses a picture over 5 MB of base64. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
/** More than this in one message is far more than anyone means to send. */
export const MAX_IMAGES = 20

export const EXTENSION: Record<ChatImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** The text standing in for the `n`th picture held by a draft. */
export const imageTag = (n: number): string => `[Image #${n}]`

const TAG = /\[Image #(\d+)\]/g

/**
 * The message as it goes out: the pictures the text still names, renumbered
 * `1…k` in the order they appear.
 *
 * Renumbered because a draft numbers in the order pictures were *added*, and
 * deleting the first of two would leave a message saying `[Image #2]` beside a
 * single picture. A tag naming nothing held is left as it is: it is somebody's
 * text. `held[n - 1]` is `[Image #n]`'s picture.
 */
export function attachedIn<T>(
  text: string,
  held: readonly T[]
): { text: string; images: T[] } {
  const renumbered = new Map<number, number>()
  const images: T[] = []
  const out = text.replace(TAG, (tag, digits: string) => {
    const n = Number(digits)
    const image = held[n - 1]
    if (image === undefined) return tag
    let next = renumbered.get(n)
    if (next === undefined) {
      images.push(image)
      next = images.length
      renumbered.set(n, next)
    }
    return imageTag(next)
  })
  return { text: out, images }
}

/**
 * The pictures a draft's text still names, with the number each goes by — what
 * gets a thumbnail. In the order they were added, so a thumbnail does not jump
 * when its tag is moved.
 */
export function namedIn<T>(
  text: string,
  held: readonly T[]
): { n: number; image: T }[] {
  const named = new Set<number>()
  for (const match of text.matchAll(TAG)) named.add(Number(match[1]))
  return held.flatMap((image, index) =>
    named.has(index + 1) ? [{ n: index + 1, image }] : []
  )
}

/** The draft without the `n`th picture's tag, and the space that led into it,
 * so taking a picture out leaves no gap. */
export function withoutTag(text: string, n: number): string {
  return text.split(` ${imageTag(n)}`).join("").split(imageTag(n)).join("")
}

/** Why a picture cannot be sent, or null when it can. */
export function imageProblem(image: unknown): string | null {
  if (!image || typeof image !== "object") return "not a picture"
  const { mediaType, data } = image as Partial<ChatImage>
  if (!SENDABLE_TYPES.includes(mediaType as ChatImageType)) {
    return `${String(mediaType)} is not a picture the model reads`
  }
  if (typeof data !== "string" || !data || !/^[A-Za-z0-9+/]+=*$/.test(data)) {
    return "the picture is not base64"
  }
  if (data.length > MAX_IMAGE_BASE64) return "the picture is larger than 5 MB"
  return null
}
