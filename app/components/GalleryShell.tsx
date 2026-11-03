import type { Child } from 'hono/jsx'
import { formatMediaCount } from '../lib/imagesource'
import type { GallerySettings } from '../lib/gallery-settings'

type Props = {
  /** Who is looking (owner/member/visitor) and where their library lives —
   *  surfaced as data attributes so the seam is observable in SSR tests. */
  viewerRole?: 'owner' | 'member' | 'visitor'
  libraryHref?: string
  /** The curtain's count line: stills and videos from the manifest. */
  mediaCount?: { stills: number; videos: number }
  /** `?photo=` lands straight on the photograph — the viewer treats the
   *  absent curtain as already entered, so Back from owner surfaces returns
   *  to the open frame rather than the veil. */
  entered?: boolean
  settings: Pick<GallerySettings, 'title' | 'caption'>
  status?: string
  children: Child
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

/** Shared public gallery chrome for SSR and the native client. */
export default function GalleryShell({ settings, status, viewerRole, libraryHref, mediaCount, entered = false, children }: Props) {
  // The curtain stays silent on an empty gallery — formatMediaCount would
  // say "0 photographs", which the veil never does.
  const countLine = mediaCount && mediaCount.stills + mediaCount.videos > 0
    ? formatMediaCount(mediaCount)
    : ''
  return (
    <main class="gallery-shell" data-viewer-role={viewerRole} data-library-href={libraryHref}>
      <h1 class="sr-only" dangerouslySetInnerHTML={{ __html: escapeHtml(settings.title) }} />
      {entered ? null : (
        <>
          {/* Parses before the curtain so a tap before island hydration still
              dismisses — the replay in curtain-boot.js re-taps until the island's
              own listeners take over. */}
          <script src="/curtain-boot.js"></script>
          <section
            class="curtain"
            data-curtain
            role="button"
            tabIndex={0}
            aria-label="Enter gallery"
            aria-describedby={status ? 'gallery-curtain-status' : undefined}
          >
            <div class="curtain-content">
              {/* The mark floats a couple of line spaces above the title in the
                  same 140×47 box every surface gives it — a title card, not a
                  pinned header. */}
              <img
                src="/manorama-merged-logo.png"
                alt="manorama"
                width="140"
                height="47"
                class="curtain-mark"
              />
              <h2 class="curtain-title" data-curtain-title dangerouslySetInnerHTML={{ __html: escapeHtml(settings.title) }} />
              <p class="curtain-caption" data-curtain-caption dangerouslySetInnerHTML={{ __html: escapeHtml(settings.caption) }} />
              {countLine ? (
                <p class="curtain-count" data-curtain-count>{countLine}</p>
              ) : null}
              <p class="curtain-prompt">Tap to open</p>
              {status && <p id="gallery-curtain-status" class="curtain-status" role="status">{status}</p>}
            </div>
          </section>
        </>
      )}
      {children}
    </main>
  )
}

export type { Props as GalleryShellProps }
