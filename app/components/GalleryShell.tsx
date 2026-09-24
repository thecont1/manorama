import type { Child } from 'hono/jsx'
import type { GallerySettings } from '../lib/gallery-settings'

type Props = {
  settings: Pick<GallerySettings, 'title' | 'caption'>
  status?: string
  children: Child
}

/** Shared public gallery chrome for SSR and the native client. */
export default function GalleryShell({ settings, status, children }: Props) {
  return (
    <main class="gallery-shell">
      <h1 class="sr-only">{settings.title}</h1>
      <section
        class="curtain"
        data-curtain
        role="button"
        tabIndex={0}
        aria-label="Enter gallery"
      >
        <div class="curtain-content">
          <span class="brand-mark-wrap curtain-logo-wrap">
            <img
              src="/manorama-merged-logo.png"
              alt=""
              aria-hidden="true"
              class="curtain-logo"
            />
            <span class="brand-tld" aria-hidden="true">.xyz</span>
          </span>
          <h1 data-curtain-title>{settings.title}</h1>
          <p class="curtain-caption" data-curtain-caption>
            {settings.caption}
          </p>
          {status && <p class="curtain-status" role="status">{status}</p>}
        </div>
      </section>
      {children}
    </main>
  )
}

export type { Props as GalleryShellProps }
