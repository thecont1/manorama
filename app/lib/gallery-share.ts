export type ShareResult = 'shared' | 'cancelled' | 'fallback'

export type GallerySharePayload = {
  title: string
  caption: string
  url: string
}

export const galleryShareText = ({ title, caption }: GallerySharePayload): string =>
  caption.trim() ? `${title}\n${caption.trim()}` : title

export const isShareCancellation = (reason: unknown): boolean =>
  reason instanceof Error && /cancel|abort/i.test(reason.message)

/** Web Share where the platform offers it; refusal or an unsupported runtime
 * asks the caller for the explicit link sheet rather than pretending success. */
export const shareGalleryOnWeb = async (payload: GallerySharePayload): Promise<ShareResult> => {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return 'fallback'
  try {
    await navigator.share({ title: payload.title, text: galleryShareText(payload), url: payload.url })
    return 'shared'
  } catch (reason) {
    return isShareCancellation(reason) ? 'cancelled' : 'fallback'
  }
}

/** Clipboard first, old DOM copy second. The boolean is intentional: callers
 * must leave the address visible when neither route worked. */
export const copyText = async (value: string): Promise<boolean> => {
  if (typeof document === 'undefined') return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the DOM path.
  }
  const field = document.createElement('textarea')
  try {
    field.value = value
    field.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(field)
    field.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
  }
}
