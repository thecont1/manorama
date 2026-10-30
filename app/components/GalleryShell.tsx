import type { Child } from 'hono/jsx'
import type { GallerySettings } from '../lib/gallery-settings'

type Props = {
  /** Who is looking (owner/member/visitor) and where their library lives —
   *  surfaced as data attributes so the seam is observable in SSR tests. */
  viewerRole?: 'owner' | 'member' | 'visitor'
  libraryHref?: string
  /** The curtain's count line: stills and videos from the manifest. */
  mediaCount?: { stills: number; videos: number }
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
export default function GalleryShell({ settings, status, viewerRole, libraryHref, mediaCount, children }: Props) {
  const countLine = mediaCount
    ? [
        mediaCount.stills ? `${mediaCount.stills} photograph${mediaCount.stills === 1 ? '' : 's'}` : null,
        mediaCount.videos ? `${mediaCount.videos} video${mediaCount.videos === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ')
    : ''
  return (
    <main class="gallery-shell" data-viewer-role={viewerRole} data-library-href={libraryHref}>
      <h1 class="sr-only" dangerouslySetInnerHTML={{ __html: escapeHtml(settings.title) }} />
      <section
        class="curtain"
        data-curtain
        role="button"
        tabIndex={0}
        aria-label="Enter gallery"
        aria-describedby={status ? 'gallery-curtain-status' : undefined}
      >
        {/* The mark sits in the same 140×47 box the top bar reserves on every
            owner surface, so opening a gallery never makes it jump. */}
        <img
          src="/manorama-merged-logo.png"
          alt="manorama"
          width="140"
          height="47"
          class="curtain-mark"
        />
        <div class="curtain-content">
          <h2 class="curtain-title" data-curtain-title dangerouslySetInnerHTML={{ __html: escapeHtml(settings.title) }} />
          <p class="curtain-caption" data-curtain-caption dangerouslySetInnerHTML={{ __html: escapeHtml(settings.caption) }} />
          {countLine ? (
            <p class="curtain-count" data-curtain-count>{countLine}</p>
          ) : null}
          <p class="curtain-prompt">Tap to open</p>
          {status && <p id="gallery-curtain-status" class="curtain-status" role="status">{status}</p>}
        </div>
      </section>
      {children}
    </main>
  )
}

export type { Props as GalleryShellProps }
