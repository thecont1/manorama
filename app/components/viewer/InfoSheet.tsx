import { Sheet } from '../ui/Sheet'
import { formatDuration } from '../../islands/VideoSlide'
import type { ExifData, GalleryMediaItem } from '../../lib/imagesource'
import { formatCaptured, formatExposure } from '../../lib/exif-format'

/** The image-information sheet: a quiet definition list of the current
 *  frame's facts plus the on-device Content Credentials panel. Replaces
 *  the old "Image information" controls-modal — facts are rows, not
 *  buttons, and the sheet stays put until dismissed. */

export type CredentialPanelState = 'idle' | 'loading' | 'verified' | 'unavailable' | 'none'

export type InfoSheetProps = {
  open: boolean
  onClose: () => void
  /** 0-based index and total, for the "Photograph N of M" title. */
  index: number
  total: number
  image: GalleryMediaItem | undefined
  isVideo: boolean
  mimeType?: string
  durationSeconds?: number
  caption?: string
  /** Embedded metadata for the current still — manifest EXIF merged over
   *  lazily-read IPTC/XMP by the host. Every row renders only when its
   *  field is present. */
  exif?: ExifData
  credentialState: CredentialPanelState | undefined
  credentialStore: unknown
  onRetryCredentials: () => void
  panelStyle?: Record<string, string | undefined> | undefined
}

export default function InfoSheet({
  open, onClose, index, total, image, isVideo, mimeType, durationSeconds,
  caption, exif, credentialState, credentialStore,
  onRetryCredentials, panelStyle,
}: InfoSheetProps) {
  const title = `${isVideo ? 'Video' : 'Photograph'} ${index + 1} of ${total}`
  const noun = isVideo ? 'video' : 'photograph'
  const captured = formatCaptured(exif?.dateOriginal)
  const exposure = formatExposure(exif)
  return (
    <div class="m-dark">
      <Sheet open={open} onClose={onClose} title={title} panelStyle={panelStyle}>
        <section class="m-sheet-section">
          <dl class="m-info-rows">
            {image?.filename ? <div class="m-info-row"><dt>File</dt><dd>{image.filename}</dd></div> : null}
            {image?.width && image?.height ? <div class="m-info-row"><dt>Size</dt><dd>{image.width} × {image.height}</dd></div> : null}
            {caption ? <div class="m-info-row"><dt>Caption</dt><dd>{caption}</dd></div> : null}
            {exif?.title ? <div class="m-info-row"><dt>Title</dt><dd>{exif.title}</dd></div> : null}
            {exif?.camera ? <div class="m-info-row"><dt>Camera</dt><dd>{exif.camera}</dd></div> : null}
            {exif?.lens ? <div class="m-info-row"><dt>Lens</dt><dd>{exif.lens}</dd></div> : null}
            {exposure ? <div class="m-info-row"><dt>Exposure</dt><dd>{exposure}</dd></div> : null}
            {captured ? <div class="m-info-row"><dt>Captured</dt><dd>{captured}</dd></div> : null}
            {exif?.description ? <div class="m-info-row"><dt>Description</dt><dd>{exif.description}</dd></div> : null}
            {exif?.creator ? <div class="m-info-row"><dt>Creator</dt><dd>{exif.creator}</dd></div> : null}
            {exif?.copyright ? <div class="m-info-row"><dt>Copyright</dt><dd>{exif.copyright}</dd></div> : null}
            {exif?.location ? <div class="m-info-row"><dt>Location</dt><dd>{exif.location}</dd></div> : null}
            {Array.isArray(exif?.keywords) && exif.keywords.length ? <div class="m-info-row"><dt>Keywords</dt><dd>{exif.keywords.join(', ')}</dd></div> : null}
            {isVideo && mimeType ? <div class="m-info-row"><dt>Type</dt><dd>Video ({mimeType})</dd></div> : null}
            {isVideo && durationSeconds ? <div class="m-info-row"><dt>Duration</dt><dd>{formatDuration(durationSeconds)}</dd></div> : null}
          </dl>
        </section>

        <section class="m-sheet-section" data-c2pa-panel>
          <div class="m-sheet-labelrow">
            <h3 class="m-sheet-label">Content Credentials</h3>
            <span class="credential-mark" aria-hidden="true">C2PA</span>
          </div>
          {!image?.c2pa ? (
            <p class="m-quiet-copy">This {noun} carries no Content Credentials.</p>
          ) : credentialState === 'loading' ? (
            <p class="m-quiet-copy">Checking Content Credentials on this device…</p>
          ) : credentialState === 'verified' ? (
            <>
              <p class="m-quiet-copy credential-success">Content Credentials verified on this device.</p>
              <cai-manifest-summary manifestStore={credentialStore}></cai-manifest-summary>
            </>
          ) : credentialState === 'unavailable' ? (
            <>
              <p class="m-quiet-copy">Content Credentials could not be checked here.</p>
              <button type="button" class="text-button" onClick={onRetryCredentials}>Try again</button>
            </>
          ) : credentialState === 'none' ? (
            <p class="m-quiet-copy">No Content Credentials were found in this {noun}.</p>
          ) : (
            <>
              <p class="m-quiet-copy">This {noun} may carry Content Credentials.</p>
              <button type="button" class="text-button" onClick={onRetryCredentials}>Check on this device</button>
            </>
          )}
        </section>
      </Sheet>
    </div>
  )
}
