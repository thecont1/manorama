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
      <p class="quickadd-copy">${local ? 'This dev server can sign you in locally before it builds your gallery.' : 'Manorama needs a Dropbox sign-in before it can build your gallery.'}</p>
      <a class="landing-signin quickadd-signin" data-quickadd-signin href="${local ? '/.dev-seed/login' : '/auth/dropbox'}">${local ? 'Sign in (dev)' : 'Continue with Dropbox'}</a>
      <p class="quickadd-copy quickadd-note" data-quickadd-status role="status" aria-live="polite"></p>`
    working.dataset.panel = 'signin'
  }
  wireSignIn(sourceUrl)
}

/** Points the sign-in button back at this exact URL, fragment included,
 *  and stashes the link as a cookie-expiry fallback. */
const wireSignIn = (sourceUrl: string) => {
  const button = document.querySelector<HTMLAnchorElement>('[data-quickadd-signin]')
  // The server chose the sign-in endpoint — Dropbox OAuth normally, the
  // dev login for local-folder quick-adds — so keep its href and just
  // attach the return address.
  const base = button?.getAttribute('href') ?? '/auth/dropbox'
  if (button) button.href = `${base}?next=${encodeURIComponent(location.href)}`
  try {
    localStorage.setItem(PENDING_KEY, sourceUrl)
  } catch {
    // Private browsing — the OAuth `next` cookie remains the real record.
  }
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
  try {
    response = await fetch('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl, quick: true }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    stopWaiting()
    try { sessionStorage.removeItem(LOOP_GUARD_KEY) } catch { /* best effort */ }
    setStatus(
      error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
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
    gallery?: { slug?: string }
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
    try { localStorage.removeItem(PENDING_KEY) } catch { /* best effort */ }
    if (response.status === 201 && payload.truncated) {
      // Accept, but never silently: show the truncation note for a beat
      // before opening the gallery so the owner understands the count.
      const { kept, total } = payload.truncated
      setStatus(`That album has ${total.toLocaleString()} items — your gallery keeps the first ${kept.toLocaleString()}.`)
      setTimeout(() => location.replace(payload.galleryUrl!), 4000)
      return
    }
    location.replace(payload.galleryUrl)
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
  const sourceUrl = root.dataset.provider === 'local'
    ? reconstructLocalSourceUrl(location)
    : reconstructSourceUrl(location)
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
