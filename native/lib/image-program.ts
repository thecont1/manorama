/**
 * The on-device image program.
 *
 * A program is a named, versioned transform that runs on the device: it takes
 * bytes in and hands bytes out, and it never leaves the phone. The payload is
 * the program's input contract — a new capability is a new payload kind, not a
 * new program — so the shapes that follow the first one (a thumbnail, a
 * watermark, a strip) ride on the same runtime.
 *
 * The program never upscales. A source smaller than the requested bound comes
 * out at its own size, which is the rule the whole product runs on: a
 * photograph is shown at its honest dimensions or not at all.
 *
 * The runtime is injected so the maths and the decisions are testable without
 * a canvas. The browser/webview runtime lives beside this file.
 */

export const IMAGE_PROGRAM_VERSION = 1

/** What the program is asked to do. */
export type ImageProgramPayload =
  /**
   * Fit the source inside a long-edge bound and re-encode it. The bound is on
   * the LONG edge, not a box: a 2:3 portrait at 2048 is 1365×2048, which is
   * what a platform that stores media by its long edge would keep.
   */
  | { kind: 'fit'; maxEdge: number; format: 'jpeg'; quality?: number }

export type ImageProgramSource = {
  bytes: Uint8Array
  mimeType: string
  /**
   * Intrinsic size, when the caller already knows it. Supplying it lets the
   * program decide without decoding — a photograph that already fits and is
   * already in the target format is passed through untouched.
   */
  width?: number
  height?: number
}

export type ImageProgramOutput = {
  bytes: Uint8Array
  mimeType: string
  width: number
  height: number
  /** False when the payload left the bytes exactly as they arrived. */
  transformed: boolean
}

/**
 * A decoded image the runtime can re-encode at another size. The runtime owns
 * the pixels; the program owns the decision.
 */
export interface DecodedImage {
  width: number
  height: number
  encode(target: { width: number; height: number; format: 'jpeg'; quality?: number }): Promise<Uint8Array>
}

export interface ImageProgramRuntime {
  decode(bytes: Uint8Array, mimeType: string): Promise<DecodedImage>
}

/**
 * The size a photograph takes inside a long-edge bound. Never enlarges: a
 * source already inside the bound keeps its own size.
 */
export const fitSize = (width: number, height: number, maxEdge: number): { width: number; height: number } => {
  const long = Math.max(width, height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('A photograph needs a positive width and height')
  }
  if (long <= maxEdge) return { width, height }
  const scale = maxEdge / long
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** The payload's target format as a MIME type. */
const mimeFor = (payload: ImageProgramPayload): string => `image/${payload.format}`

/**
 * Runs one payload over one source.
 *
 * The pass-through case matters more than it looks: a photograph that already
 * fits and is already a JPEG is handed on byte-for-byte, so nothing is
 * re-encoded that did not have to be.
 */
export const runImageProgram = async (
  payload: ImageProgramPayload,
  source: ImageProgramSource,
  runtime: ImageProgramRuntime,
): Promise<ImageProgramOutput> => {
  let decoded: DecodedImage | undefined
  let width = source.width
  let height = source.height
  if (width === undefined || height === undefined) {
    decoded = await runtime.decode(source.bytes, source.mimeType)
    width = decoded.width
    height = decoded.height
  }
  const target = fitSize(width, height, payload.maxEdge)
  const fits = target.width === width && target.height === height
  if (fits && source.mimeType === mimeFor(payload)) {
    return { bytes: source.bytes, mimeType: source.mimeType, width, height, transformed: false }
  }
  const image = decoded ?? await runtime.decode(source.bytes, source.mimeType)
  const bytes = await image.encode({ ...target, format: payload.format, quality: payload.quality })
  return { bytes, mimeType: mimeFor(payload), width: target.width, height: target.height, transformed: true }
}

/** The payload the share-and-publish surfaces run: X's own ceiling. */
export const fitJpegPayload = (maxEdge: number, quality = 0.9): ImageProgramPayload =>
  ({ kind: 'fit', maxEdge, format: 'jpeg', quality })

/**
 * The browser/webview runtime: `createImageBitmap` to decode, a canvas to
 * re-encode. The DOM is touched inside the methods, never at module scope, so
 * this file stays importable from a plain test.
 *
 * A photograph that cannot be drawn is refused rather than silently shipped at
 * its original size — a share that silently ignores the bound would post
 * something the photographer did not see.
 */
export const browserImageProgramRuntime: ImageProgramRuntime = {
  async decode(bytes, mimeType) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      throw new Error('This device could not prepare the photograph for sharing')
    }
    const blob = new Blob([bytes.slice().buffer], { type: mimeType })
    const bitmap = await createImageBitmap(blob)
    let closed = false
    return {
      width: bitmap.width,
      height: bitmap.height,
      async encode(target) {
        if (closed) throw new Error('This photograph was already prepared for sharing')
        const canvas = document.createElement('canvas')
        canvas.width = target.width
        canvas.height = target.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('This device could not prepare the photograph for sharing')
        context.drawImage(bitmap, 0, 0, target.width, target.height)
        const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', target.quality))
        closed = true
        if (typeof bitmap.close === 'function') bitmap.close()
        if (!encoded) throw new Error('This device could not prepare the photograph for sharing')
        return new Uint8Array(await encoded.arrayBuffer())
      },
    }
  },
}
