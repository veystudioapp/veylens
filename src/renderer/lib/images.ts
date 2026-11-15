import {
  SENDABLE_TYPES,
  type ChatImage,
  type ChatImageType,
} from "@shared/chat-images"

/**
 * The API refuses a picture over 5 MB of base64 — about 3.75 MB of bytes — or
 * over 8000px on a side. A Retina screenshot is comfortably under both; a photo
 * off a phone often is not.
 */
const MAX_BYTES = 3.75 * 1024 * 1024
const MAX_EDGE = 8000
/** What a picture that has to shrink shrinks to: the API scales anything past
 * about 1568px down before the model sees it, so more never arrives anyway. */
const SHRUNK_EDGE = 2000

/**
 * A pasted or dropped file as a picture to send, or null for anything that is
 * not one — a PDF, or a format Chromium cannot decode.
 *
 * Read **now**, as it arrives: a thumbnail dragged out of a screenshot preview
 * is a file macOS deletes moments later.
 */
export async function readImage(file: File): Promise<ChatImage | null> {
  if (!file.type.startsWith("image/")) return null

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const edge = Math.max(bitmap.width, bitmap.height)
    if (
      SENDABLE_TYPES.includes(file.type as ChatImageType) &&
      file.size <= MAX_BYTES &&
      edge <= MAX_EDGE
    ) {
      return { mediaType: file.type as ChatImageType, data: await base64Of(file) }
    }

    const scale = Math.min(1, SHRUNK_EDGE / edge)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    // A PNG first, since most of what lands here is a screenshot and a JPEG
    // smears text; a JPEG only when the PNG is still too large.
    const png = await blobOf(canvas, "image/png")
    if (png && png.size <= MAX_BYTES) {
      return { mediaType: "image/png", data: await base64Of(png) }
    }
    const jpeg = await blobOf(canvas, "image/jpeg", 0.85)
    if (jpeg && jpeg.size <= MAX_BYTES) {
      return { mediaType: "image/jpeg", data: await base64Of(jpeg) }
    }
    return null
  } finally {
    bitmap.close()
  }
}

/** Every picture among `files`, read; what is not one is left out. */
export async function readImages(files: Iterable<File>): Promise<ChatImage[]> {
  const read = await Promise.all([...files].map(readImage))
  return read.filter((image) => image !== null)
}

/** A held picture as something an `img` can show — it is already in memory. */
export const dataUrlOf = (image: ChatImage): string =>
  `data:${image.mediaType};base64,${image.data}`

const sent = new Map<string, Promise<string | null>>()

/** A sent picture, by the name its message keeps; asked for once per name. */
export function sentImage(name: string): Promise<string | null> {
  let url = sent.get(name)
  if (!url) {
    url = window.veylens.chatImage(name).catch(() => null)
    sent.set(name, url)
  }
  return url
}

function blobOf(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Through a data URL: the browser's own encoder, not a string built a byte
 * at a time. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("Could not read"))
    reader.readAsDataURL(blob)
  })
}
