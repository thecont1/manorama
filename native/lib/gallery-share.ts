import { Share } from '@capacitor/share'
import {
  galleryShareText,
  isShareCancellation,
  shareGalleryOnWeb,
  type GallerySharePayload,
  type ShareResult,
} from '../../app/lib/gallery-share'

/** Native share sheet first. Cancellation is quiet; an unsupported or refused
 * sheet falls through to Web Share and then the explicit address fallback. */
export const shareGalleryNative = async (payload: GallerySharePayload): Promise<ShareResult> => {
  try {
    await Share.share({
      title: payload.title,
      text: galleryShareText(payload),
      url: payload.url,
      dialogTitle: `Share ${payload.title}`,
    })
    return 'shared'
  } catch (reason) {
    if (isShareCancellation(reason)) return 'cancelled'
    return shareGalleryOnWeb(payload)
  }
}
