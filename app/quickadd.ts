/**
 * Quick-add client. The server rendered either the "working" panel (a
 * session exists) or the "sign-in" panel; this module does the part only
 * a browser can.
 *
 * THE FRAGMENT PROBLEM: MEGA and iCloud links carry their decryption key
 * after `#`, and a browser never transmits a fragment. So the server saw
 * a truncated link. Here the full URL is rebuilt from what the address
 * bar actually holds — `location.pathname` tail + `search` + `hash` — and
 * that reconstruction is what gets POSTed, and what rides through OAuth
 * in `?next=` so the round trip lands back on an identical URL.
 */

import { galleryHashForSource, isEncryptedSourceUrl, keylessSourceUrl } from '../packages/core/encrypted-source'
import { SourceFetchError } from '../packages/core/imagesource'
import { webGalleryKeyStore } from './lib/key-store'

const PENDING_KEY = 'manorama:pending-source'
const LOOP_GUARD_KEY = 'manorama:quickadd-attempt'

/** Rebuilds the share URL exactly as the visitor pasted it. */
export const reconstructSourceUrl = (location: { pathname: string; search: string; hash: string }) => {
  let candidate = location.pathname.replace(/^\/+/, '')
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // A malformed escape stays as-is rather than throwing.
  }
  candidate = candidate.replace(/^(https?):\/+/i, '$1://')
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  // search and hash are already raw — the fragment is the MEGA/iCloud key.
  return `${candidate}${location.search}${location.hash}`
}

/** Local-folder variant (dev only): the path IS the source, so it goes
 *  back out as a file:// URL — `//Users/x` collapses to `/Users/x`. */
export const reconstructLocalSourceUrl = (location: { pathname: string; search: string; hash: string }) =>
  `file://${location.pathname.replace(/^\/+/, '/')}`

const statusNode = () => document.querySelector<HTMLElement>('[data-quickadd-status]')
const setStatus = (message: string) => {
  const node = statusNode()
  if (node) node.textContent = message
}

/** Swaps the working panel for the sign-in panel without a reload — the
 *  session expired between render and submit. */
const showSignInPanel = (root: HTMLElement, sourceUrl: string) => {
  root.dataset.mode = 'signin'
  const working = root.querySelector<HTMLElement>('[data-panel="working"]')
  if (working) {
    const local = root.dataset.provider === 'local'
    working.innerHTML = `
      <h1 class="quickadd-title">Sign in to open this album</h1>
      <p class="quickadd-copy">${local ? 'This dev server can sign you in locally before it builds your gallery.' : 'Manorama needs a sign-in before it can build your gallery.'}</p>
      ${local
        ? '<a class="landing-signin quickadd-signin" data-quickadd-signin data-href="/.dev-seed/login" aria-disabled="true">Sign in (dev)</a>'
        : '<a class="landing-signin quickadd-signin" data-quickadd-signin data-href="/auth/dropbox" aria-disabled="true">Continue with Dropbox</a>'
          + '<a class="landing-signin quickadd-signin" data-quickadd-signin data-href="/auth/google" aria-disabled="true">Continue with Google</a>'
          + '<a class="landing-signin quickadd-signin" data-quickadd-signin data-href="/auth/apple" aria-disabled="true">Sign in with Apple</a>'}
      <p class="quickadd-copy quickadd-note" data-quickadd-status role="status" aria-live="polite"></p>`
    working.dataset.panel = 'signin'
  }
  wireSignIn(sourceUrl)
}

/** Points every sign-in link back at this exact URL, fragment included,
 *  and stashes the link as a fallback. */
const wireSignIn = (sourceUrl: string) => {
  // The server chose the sign-in endpoints — the three providers
  // normally, the dev login for local-folder quick-adds — so keep each
  // destination and just attach the return address. Links render inert
  // (`data-href`, no `href`) so a click before this runs cannot navigate
  // without the return URL; promoting them is what makes them live.
  for (const button of document.querySelectorAll<HTMLAnchorElement>('[data-quickadd-signin]')) {
    const base = button.getAttribute('href') ?? button.dataset.href
    if (!base) continue
    const next = new URL(location.href)
    // The fragment rides inside `next` as literal text, so an encrypted
    // source's key would reach the server — it must be dropped. Other
    // providers (iCloud) carry required public tokens there instead.
    if (isEncryptedSourceUrl(sourceUrl)) next.hash = ''
    button.href = `${base}?next=${encodeURIComponent(next.toString())}`
    button.removeAttribute('data-href')
    button.removeAttribute('aria-disabled')
  }
  try {
    sessionStorage.setItem(PENDING_KEY, sourceUrl)
    // Remove the pre-ADR persistent copy if an older tab wrote one.
    localStorage.removeItem(PENDING_KEY)
  } catch {
    // Private browsing — the OAuth `next` cookie remains the real record.
  }
}

/** Give the owner a durable capability copy before leaving quick-add. */
const showEncryptedFullLink = (url: string, prefix = '') => {
  const node = statusNode()
  if (!node) return
  node.textContent = `${prefix}${prefix ? ' ' : ''}Manorama can't recover this key. Keep the full link.`
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'quickadd-copy-full'
  button.textContent = 'Copy full link'
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(url).then(() => { button.textContent = 'Copied' })
  })
  node.appendChild(document.createTextNode(' '))
  node.appendChild(button)
}

/** Submits a pasted source link, reports terminal errors in the quick-add
 *  panel, and redirects successful or duplicate responses. A paid-limit
 *  response redirects only when it supplies a safe dashboard path. */
export const createGallery = async (sourceUrl: string, root: HTMLElement) => {
  // Loop guard: if a create somehow returns us to this URL again, do not
  // retry forever.
  try {
    const previous = sessionStorage.getItem(LOOP_GUARD_KEY)
    if (previous === location.href) {
      setStatus('That link was already attempted. Open your dashboard to see your galleries.')
      return
    }
    sessionStorage.setItem(LOOP_GUARD_KEY, location.href)
  } catch {
    // Storage unavailable — proceed without the guard.
  }

  // A big album can legitimately take a while (the scan lists every file
  // and probes each one on some providers). Say so instead of letting a
  // patient visitor wonder if the page died — and keep a hard client-side
  // ceiling so a hung request can never spin forever.
  const patience = setTimeout(() => setStatus('Still reading — big albums take a little longer.'), 12_000)
  const stopWaiting = () => clearTimeout(patience)

  let response: Response
  let encryptedSource: string | null = null
  try {
    let body: Record<string, unknown> = { url: sourceUrl, quick: true }
    if (isEncryptedSourceUrl(sourceUrl)) {
      encryptedSource = sourceUrl
      const { openEncryptedSource } = await import('./lib/encrypted-client')
      const session = await openEncryptedSource(sourceUrl)
      try {
        const listing = await session.listing
        body = {
          manifest: {
            provider: session.provider,
            sourceUrl: session.sourceUrl,
            ...listing,
          },
          quick: true,
        }
      } finally {
        session.dispose()
      }
    }
    response = await fetch('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    stopWaiting()
    try { sessionStorage.removeItem(LOOP_GUARD_KEY) } catch { /* best effort */ }
    setStatus(
      // Provider refusals carry owner-facing text — show the reason instead
      // of the generic offline message.
      error instanceof SourceFetchError
        ? error.message
        : error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
          ? 'That album is taking a very long time to read — it may be too large. Try again, or split it into smaller folders.'
          : 'Manorama could not reach the server. Check your connection and reload.',
    )
    return
  }
  stopWaiting()

  const payload = await response.json().catch(() => ({})) as {
    code?: string
    dashboardUrl?: string
    galleryUrl?: string
    gallery?: { id?: string; slug?: string }
    truncated?: { kept: number; total: number }
    error?: string
  }

  // 201 created, or 409 "already exists" — both know where the gallery
  // lives, and both should simply open it.
  if ((response.status === 201 || response.status === 409) && payload.galleryUrl) {
    // Clear the guard BEFORE leaving: this response is terminal and
    // successful, so the guard has done its job. Leaving it set would block
    // a later visit to the same quick-add URL in this tab and stop the 409
    // path from reopening the gallery.
    try { sessionStorage.removeItem(LOOP_GUARD_KEY) } catch { /* best effort */ }
    try { sessionStorage.removeItem(PENDING_KEY); localStorage.removeItem(PENDING_KEY) } catch { /* best effort */ }
    // A storage failure (quota, private mode) must not swallow a successful
    // create — the target link carries the key again at open.
    if (encryptedSource && payload.gallery?.id) {
      await webGalleryKeyStore().put(payload.gallery.id, encryptedSource).catch((error) => console.warn('encrypted key custody deferred:', error))
    }
    const target = `${payload.galleryUrl}${encryptedSource ? galleryHashForSource(encryptedSource, payload.gallery?.id) : ''}`
    if (response.status === 201 && (payload.truncated || encryptedSource)) {
      // Accept, but never silently: show the truncation note for a beat
      // before opening the gallery so the owner understands the count.
      const prefix = payload.truncated
        ? `That album has ${payload.truncated.total.toLocaleString()} items — your gallery keeps the first ${payload.truncated.kept.toLocaleString()}.`
        : ''
      // The copy must be an absolute link — target is a path-relative URL.
      if (encryptedSource) showEncryptedFullLink(new URL(target, location.href).href, prefix)
      else setStatus(prefix)
      setTimeout(() => location.replace(target), 4000)
      return
    }
    location.replace(target)
    return
  }
  // The guard only exists to stop a redirect loop. Any terminal response
  // that leaves this page visible must clear it so a reload can retry a
  // transient provider/network failure in the same tab.
  try { sessionStorage.removeItem(LOOP_GUARD_KEY) } catch { /* best effort */ }
  if (response.status === 401) { showSignInPanel(root, sourceUrl); return }
  if (response.status === 403) {
    if (payload.code === 'GALLERY_LIMIT') {
      const target = typeof payload.dashboardUrl === 'string' && /^\/[a-z0-9-]+$/.test(payload.dashboardUrl) ? payload.dashboardUrl : null
      if (target) { location.replace(target); return }
      setStatus('Open your dashboard to continue.')
      return
    }
    setStatus(payload.error || 'Open your dashboard to continue.')
    return
  }

  const { friendlySourceError } = await import('./lib/source-errors')
  setStatus(friendlySourceError(payload.error))
}

const start = () => {
  const root = document.querySelector<HTMLElement>('[data-quickadd]')
  if (!root) return
  let sourceUrl = root.dataset.provider === 'local'
    ? reconstructLocalSourceUrl(location)
    : reconstructSourceUrl(location)
  if (isEncryptedSourceUrl(sourceUrl)) {
    try {
      const pending = sessionStorage.getItem(PENDING_KEY)
      if (pending && isEncryptedSourceUrl(pending) && keylessSourceUrl(pending) === keylessSourceUrl(sourceUrl)) {
        sourceUrl = pending
        sessionStorage.removeItem(PENDING_KEY)
      }
    } catch {
      // A malformed pending value is ignored; the visible link still works.
    }
  }
  if (root.dataset.mode === 'create') void createGallery(sourceUrl, root)
  else wireSignIn(sourceUrl)
}

// Auto-start only in a browser. The module is imported by tests (and
// could be pulled into an SSR graph), where touching `document` at import
// time would throw before anything is even rendered.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
