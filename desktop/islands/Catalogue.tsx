import { useCallback, useEffect, useRef, useState } from 'hono/jsx'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import type { GalleryManifest } from '../../app/lib/imagesource'
import {
  classifyRoot,
  galleryTitleForRoot,
  scanLocalDirectory,
  toGalleryMediaItem,
  type LocalGalleryItem,
} from '../lib/local-scan'
import {
  deserializeLocalCatalogue,
  newCatalogue,
  probeAllAvailability,
  probeAvailability,
  serializeLocalCatalogue,
  type GalleryAvailability,
  type LocalCatalogue,
  type LocalGalleryRecord,
} from '../lib/catalogue'
import { assetUrl, isDesktopRuntime, pathExists, pickGalleryFolder, readDirEntries, registerSavedGalleryRoots } from '../lib/tauri'
import { invoke } from '@tauri-apps/api/core'
import { removeDeviceGallery, syncDeviceGalleries } from '../lib/sync'
import { handleProviderDeepLink } from '../lib/providers/oauth'
import { SIGN_IN_PROVIDERS } from '../../app/lib/signin'
import { desktopScreen, showPasteFallback } from '../lib/welcome'
import ShareFlow from './ShareFlow'
import {
  beginDesktopSignIn,
  clearSession,
  completeDesktopSignIn,
  getSession,
  installDesktopAuth,
  normalizeApiBase,
  type AuthProvider,
  type DesktopSession,
} from '../lib/session'
import {
  applyTheme,
  oppositeTheme,
  readStoredTheme,
  storeTheme,
  themeControlLabel,
  type Theme,
} from '../lib/theme'

const CATALOGUE_FILE = 'catalogue.json'
const DEVICE_LABEL = 'This Mac'
const sourceLabel = (record: LocalGalleryRecord): string =>
  record.sourceKind === 'card' ? 'Memory card' : 'Folder on this device'

const openExternal = (url: string) => {
  // External links leave the app for the system browser via the opener
  // plugin; a plain-browser preview has no IPC, so it degrades to
  // window.open for the same URL.
  if (isDesktopRuntime()) {
    void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url))
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

const PRIVACY_URL = 'https://manorama.xyz/privacy'
const AUTHOR_URL = 'https://thecontrarian.in'

/** The footer markup the web and mobile shells use, verbatim, with the click
 *  routed to the system browser: inside the Tauri webview a bare external href
 *  would navigate the app itself away from the catalogue. */
const externalAnchor = (url: string) => ({
  href: url,
  target: '_blank',
  rel: 'noopener',
  onClick: (event: MouseEvent) => {
    event.preventDefault()
    openExternal(url)
  },
})

const readCatalogueFile = () => invoke<string | null>('read_private_file', { name: CATALOGUE_FILE })
const writeCatalogueFile = (contents: string) =>
  invoke('write_private_file', { name: CATALOGUE_FILE, contents })

type ViewerState = { galleryId: string; index: number }
type SyncState = 'idle' | 'syncing' | 'synced' | 'partial' | 'failed'

const syncMessage = (state: SyncState, session: DesktopSession | null): string => {
  if (!session) return 'Sign in to sync this catalogue to your account.'
  if (state === 'syncing') return 'Syncing catalogue…'
  if (state === 'synced') return 'Catalogue synced.'
  if (state === 'partial') return 'Some galleries could not be synced — will retry.'
  if (state === 'failed') return 'Sync failed — local viewing is unaffected.'
  return 'Catalogue syncs quietly; viewing never waits on it.'
}

/** Dimensions learned from decoded thumbs — ephemeral by design, never
 *  persisted or synced. */
type DimsMap = Map<string, { w: number; h: number }>

/**
 * The desktop shell: a catalogue of user-picked folders and memory cards,
 * each referenced in place. No copying, no watching — a manual rescan is
 * the only inventory refresh, and the per-gallery "Share…" sheet is the
 * only path by which bytes leave the device.
 */
export default function Catalogue({ apiBase }: { apiBase: string }) {
  const base = normalizeApiBase(apiBase)
  const [catalogue, setCatalogue] = useState<LocalCatalogue | null>(null)
  const [availability, setAvailability] = useState<Record<string, GalleryAvailability>>({})
  const [openGalleryId, setOpenGalleryId] = useState<string | null>(null)
  const [viewerState, setViewerState] = useState<ViewerState | null>(null)
  const [session, setSession] = useState<DesktopSession | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [pasteUrl, setPasteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [shareGalleryId, setShareGalleryId] = useState<string | null>(null)
  // The account waits in a slide-out pane behind one quiet edge tab, exactly
  // as it does on the web dashboard: the catalogue keeps the page width, and
  // administration stays a deliberate act. It opens closed on every load and
  // is never encoded in a URL.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  // The theme is the web dashboard's theme — read from the same storage key,
  // applied as the same `html.light` class, so a preference set on either
  // surface is honoured on both.
  const [theme, setTheme] = useState<Theme>(() =>
    readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage),
  )
  const dimsRef = useRef<DimsMap>(new Map())
  // The deep-link sign-in callback is installed once at launch — a ref is
  // the only way it can sync the catalogue as it is THEN, not as it was.
  const catalogueRef = useRef<LocalCatalogue | null>(null)
  useEffect(() => {
    catalogueRef.current = catalogue
  }, [catalogue])

  const accountTabRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    applyTheme(theme, document.documentElement)
    storeTheme(typeof localStorage === 'undefined' ? null : localStorage, theme)
  }, [theme])

  const closeAccountMenu = useCallback(() => {
    setAccountMenuOpen(false)
    accountTabRef.current?.focus()
  }, [])

  // Focus enters the pane, Tab stays inside it, and Esc hands the caret back
  // to the tab that opened it. This is the web pane's contract, kept identical
  // so the same acceptance assertions hold on both surfaces.
  useEffect(() => {
    if (!accountMenuOpen) return
    const panel = drawerRef.current
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeAccountMenu(); return }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary')]
        .filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
    }
  }, [accountMenuOpen, closeAccountMenu])

  const persistCatalogue = useCallback(async (next: LocalCatalogue) => {
    setCatalogue(next)
    try {
      await writeCatalogueFile(serializeLocalCatalogue(next))
    } catch {
      setNotice('The catalogue could not be saved locally')
    }
  }, [])

  const runSync = useCallback(
    async (cat: LocalCatalogue, active: DesktopSession | null) => {
      if (!active || !cat.galleries.length) return
      setSyncState('syncing')
      try {
        const result = await syncDeviceGalleries(base, active.token, cat)
        setSyncState(result.failed === 0 ? 'synced' : result.synced === 0 ? 'failed' : 'partial')
      } catch {
        setSyncState('failed')
      }
    },
    [base],
  )

  // Launch: restore session + catalogue, re-grant the runtime scopes for
  // every saved root (both scopes reset each launch), then probe which
  // sources are still mounted.
  useEffect(() => {
    let active = true
    let cleanup: (() => Promise<void>) | undefined
    void (async () => {
      const storedSession = await getSession()
      if (storedSession && active) setSession(storedSession)
      let next: LocalCatalogue
      try {
        next = deserializeLocalCatalogue(await readCatalogueFile()) ?? newCatalogue(crypto.randomUUID(), DEVICE_LABEL)
      } catch {
        next = newCatalogue(crypto.randomUUID(), DEVICE_LABEL)
      }
      await registerSavedGalleryRoots().catch(() => {})
      const avail = await probeAllAvailability(next.galleries, pathExists)
      if (!active) return
      setCatalogue(next)
      setAvailability(avail)
      await writeCatalogueFile(serializeLocalCatalogue(next)).catch(() => {})
      if (storedSession) void runSync(next, storedSession)
      cleanup = await installDesktopAuth(
        base,
        (signedIn) => {
          setSession(signedIn)
          setAuthError(null)
          void runSync(catalogueRef.current ?? next, signedIn)
        },
        setAuthError,
        // Everything else on our scheme is a provider OAuth redirect —
        // those complete the pending upload-provider connect, not sign-in.
        handleProviderDeepLink,
      ).catch(() => undefined) ?? undefined
    })()
    return () => {
      active = false
      void cleanup?.()
    }
  }, [base, runSync])

  const addFolder = async () => {
    setNotice(null)
    setBusy(true)
    try {
      const root = await pickGalleryFolder()
      if (!root || !catalogue) return
      const scan = await scanLocalDirectory(root, readDirEntries)
      if (!scan.items.length) {
        setNotice('That folder has no photos Manorama can display')
        return
      }
      const { sourceKind, mountPoint } = classifyRoot(root)
      const now = new Date().toISOString()
      const record: LocalGalleryRecord = {
        id: crypto.randomUUID(),
        title: galleryTitleForRoot(root),
        rootPath: root,
        sourceKind,
        ...(mountPoint ? { mountPoint } : {}),
        itemCount: scan.truncated ?? scan.items.length,
        items: scan.items,
        addedAt: now,
        lastSeenAt: now,
      }
      // Re-picking an existing root replaces its record — same source,
      // fresh scan, new id (the old remote row goes stale and is deleted).
      const replaced = catalogue.galleries.find((g) => g.rootPath === root)
      const next = {
        ...catalogue,
        galleries: [...catalogue.galleries.filter((g) => g.rootPath !== root), record],
      }
      setAvailability((previous) => ({ ...previous, [record.id]: 'available' }))
      await persistCatalogue(next)
      if (session && replaced) void removeDeviceGallery(base, session.token, replaced)
      setOpenGalleryId(record.id)
      void runSync(next, session)
    } catch {
      setNotice('That folder could not be opened')
    } finally {
      setBusy(false)
    }
  }

  const rescan = async (record: LocalGalleryRecord) => {
    if (!catalogue) return
    setNotice(null)
    // A remounted card needs its scope granted again — runtime scopes do
    // not survive eject + relaunch.
    await registerSavedGalleryRoots().catch(() => {})
    const status = await probeAvailability(record, pathExists)
    setAvailability((previous) => ({ ...previous, [record.id]: status }))
    if (status === 'unavailable') {
      // An ejected source drops its open views; the record itself stays.
      if (viewerState?.galleryId === record.id) setViewerState(null)
      return
    }
    try {
      const scan = await scanLocalDirectory(record.rootPath, readDirEntries)
      const updated: LocalGalleryRecord = {
        ...record,
        items: scan.items,
        itemCount: scan.truncated ?? scan.items.length,
        lastSeenAt: new Date().toISOString(),
      }
      const next = {
        ...catalogue,
        galleries: catalogue.galleries.map((g) => (g.id === record.id ? updated : g)),
      }
      await persistCatalogue(next)
      if (!scan.items.length) setNotice('That source has no photos Manorama can display')
      void runSync(next, session)
    } catch {
      setAvailability((previous) => ({ ...previous, [record.id]: 'unavailable' }))
    }
  }

  const remove = async (record: LocalGalleryRecord) => {
    if (!catalogue) return
    const next = { ...catalogue, galleries: catalogue.galleries.filter((g) => g.id !== record.id) }
    if (openGalleryId === record.id) setOpenGalleryId(null)
    if (viewerState?.galleryId === record.id) setViewerState(null)
    await persistCatalogue(next)
    if (session) void removeDeviceGallery(base, session.token, record)
  }

  const signIn = (provider: AuthProvider) => {
    setAuthError(null)
    void beginDesktopSignIn(provider, base).catch((reason: unknown) =>
      setAuthError(reason instanceof Error ? reason.message : 'Sign-in could not be completed. Please try again.'),
    )
  }

  const submitPastedLink = (event: Event) => {
    event.preventDefault()
    setAuthError(null)
    const url = pasteUrl.trim()
    if (!url) return
    void completeDesktopSignIn(url, base)
      .then((signedIn) => {
        setSession(signedIn)
        setPasteUrl('')
        if (catalogue) void runSync(catalogue, signedIn)
      })
      .catch((reason: unknown) =>
        setAuthError(reason instanceof Error ? reason.message : 'Sign-in could not be completed. Please try again.'),
      )
  }

  const signOut = () => {
    void clearSession()
    setSession(null)
  }

  const recordDims = (itemId: string, w: number, h: number) => {
    if (w > 0 && h > 0) dimsRef.current.set(itemId, { w, h })
  }

  // Full-screen viewing: the shared Viewer, fed by manifest items pointing
  // at convertFileSrc URLs. The viewer heals guessed dims to the real
  // natural size on load — nothing is upscaled or re-encoded.
  const viewableRecord = viewerState && catalogue
    ? catalogue.galleries.find((g) => g.id === viewerState.galleryId)
    : undefined
  if (viewableRecord && availability[viewableRecord.id] !== 'unavailable') {
    const record = viewableRecord
    const withDims = (item: LocalGalleryItem): LocalGalleryItem => {
      const dims = dimsRef.current.get(item.id)
      return dims ? { ...item, width: dims.w, height: dims.h } : item
    }
    const manifest: GalleryManifest = {
      slug: record.id,
      title: record.title,
      caption: '',
      date: '',
      images: record.items.map((item) => toGalleryMediaItem(withDims(item), assetUrl)),
    }
    const settings = defaultGallerySettings(manifest)
    return (
      <>
        <div class="desktop-titlebar" data-tauri-drag-region />
        <GalleryShell settings={settings}>
          <Viewer
            key={`${record.id}:${viewerState?.index ?? 0}`}
            slug={record.id}
            images={manifest.images}
            settings={settings}
            initialIndex={viewerState?.index ?? 0}
            alwaysShowNavigation
          />
        </GalleryShell>
        <button
          type="button"
          class="desktop-back"
          onClick={() => setViewerState(null)}
          aria-label="Back to the folder grid"
        >
          ← Folder
        </button>
      </>
    )
  }

  const openRecord = openGalleryId ? catalogue?.galleries.find((g) => g.id === openGalleryId) : undefined

  // Dev builds cannot receive the sign-in deep link, so only they get the
  // paste-the-link fallback — bundled builds never render it.
  const pasteFallback = showPasteFallback(import.meta.env.DEV, !!session)
  const pasteForm = pasteFallback ? (
    <form class="desktop-paste" onSubmit={submitPastedLink}>
      <label>
        Sign-in link
        <input
          value={pasteUrl}
          onInput={(event) => setPasteUrl((event.currentTarget as HTMLInputElement).value)}
          placeholder="in.thecontrarian.manorama.desktop://auth/callback?handoff=…"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>
      <button type="submit">Complete sign-in</button>
      <p class="desktop-paste-hint">
        The dev build cannot receive deep links until it is bundled — after the browser
        finishes sign-in, paste the link it was sent to here.
      </p>
    </form>
  ) : null

  // Until the catalogue file is read the screen is undecided — greeting a
  // returning owner with the welcome surface would be a flash of the wrong
  // thing. A bare shell keeps the window draggable while the probe runs.
  if (!catalogue) {
    return (
      <main class="desktop-shell" aria-busy="true">
        <div class="desktop-titlebar" data-tauri-drag-region />
        <p class="desktop-notice" role="status">Loading your catalogue…</p>
      </main>
    )
  }

  if (desktopScreen({ signedIn: !!session }) === 'welcome') {
    return (
      <>
        <div class="desktop-titlebar" data-tauri-drag-region />
        <main class="landing-page desktop-welcome">
          <div class="desktop-welcome-inner">
            <header class="desktop-welcome-header">
              <span class="brand-mark-wrap">
                <img src="/manorama-merged-logo.png" alt="manorama" class="landing-brand-mark" />
              </span>
            </header>
            <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            <div class="desktop-signin">
              <span class="desktop-signin-lead">Continue with</span>
              <div class="desktop-signin-icons">
                {[...SIGN_IN_PROVIDERS]
                  .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
                  .map(({ id, label, Glyph }) => (
                    <button type="button" class="desktop-signin-icon" key={id} aria-label={`Continue with ${label}`} onClick={() => signIn(id)}>
                      <Glyph />
                      <span class="desktop-signin-label">{label}</span>
                    </button>
                  ))}
              </div>
            </div>
            {authError ? <p class="landing-note" role="alert">{authError}</p> : null}
            {notice ? <p class="landing-note">{notice}</p> : null}
            {pasteForm}
          </div>
          <footer class="site-footer">
            <a class="site-footer-link" {...externalAnchor(PRIVACY_URL)}>Privacy Policy</a>
            <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a {...externalAnchor(AUTHOR_URL)}>thecontrarian.in</a></p>
          </footer>
        </main>
      </>
    )
  }

  // The greeting states what this surface can actually verify: the account
  // name and plan the session carries, and the count of galleries this Mac
  // holds. The web dashboard counts cloud galleries against a plan limit; a
  // local-first catalogue has no such limit, so it counts what it has.
  const planLabel = session?.tier === 'pro' ? 'Pro' : session?.tier === 'free' ? 'Free' : null
  const localGalleryCount = catalogue.galleries.length
  const galleryWord = localGalleryCount === 1 ? 'gallery' : 'galleries'
  const helloLine = `Hello, ${session?.ownerSlug || 'there'}. Welcome to manorama.xyz.`
  const planLine = `${planLabel ? `You are a ${planLabel} User. ` : ''}${localGalleryCount} ${galleryWord} on this Mac.`
  return (
    <>
      <div class="desktop-titlebar" data-tauri-drag-region />
      {/* The signed-in catalogue wears the web dashboard's admin surface: the
          same two-quadrant workbench, the same left-edge account pane, the
          same theme. Only what fills the quadrants differs — a Mac owner
          imports folders and cards, not cloud links. */}
      <main class="admin-page admin-page--selector" data-admin-ready="true">
        <button
          type="button"
          class="admin-edge-tab"
          aria-label="Account menu"
          aria-expanded={accountMenuOpen ? 'true' : 'false'}
          aria-controls="desktop-account-drawer"
          ref={accountTabRef}
          onClick={() => setAccountMenuOpen(true)}
        >
          <span aria-hidden="true">Account</span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        </button>
        <div class="admin-drawer" id="desktop-account-drawer" data-account-drawer hidden={!accountMenuOpen}>
          <div class="admin-drawer-scrim" aria-hidden="true" onClick={closeAccountMenu} />
          <aside class="admin-drawer-panel" role="dialog" aria-modal="true" aria-label="Account" ref={drawerRef}>
            <button type="button" class="admin-drawer-close" aria-label="Close account menu" onClick={closeAccountMenu}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
            </button>
            <div class="admin-left">
              <header class="admin-header">
                <div>
                  <p class="admin-brand-title"><span class="brand-mark-wrap"><img class="admin-brand-logo" src="/manorama-merged-logo.png" alt="manorama" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></p>
                  <p class="admin-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
                  <div class="admin-greeting">
                    <p class="admin-greeting-url">manorama.xyz/{session?.ownerSlug ?? ''}</p>
                    <p>{helloLine}</p>
                    <p>{planLine}</p>
                  </div>
                </div>
              </header>
              <footer class="site-footer">
                <a class="site-footer-link" {...externalAnchor(PRIVACY_URL)}>Privacy Policy</a>
                <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a {...externalAnchor(AUTHOR_URL)}>thecontrarian.in</a></p>
              </footer>
            </div>
            {/* The account actions sit at the pane's foot: labelled, and away
                from the galleries. The theme control is the web dashboard's —
                one key, one class, one label. */}
            <div class="admin-drawer-actions">
              <button type="button" class="admin-drawer-action" aria-pressed={theme === 'light'} onClick={() => setTheme(oppositeTheme(theme))}>{themeControlLabel(theme)}</button>
              <button type="button" class="admin-drawer-action" onClick={signOut}>Sign out</button>
            </div>
          </aside>
        </div>

        <div class="admin-content">
        {/* Only the catalogue rows span the full width; the welcome copy and
            the import action each fit inside one half of the top workbench. */}
        <div class="admin-overview">
          <section class="admin-welcome" aria-label="Welcome to manorama">
            <span class="admin-welcome-brand brand-mark-wrap">
              <img class="admin-topbar-logo" src="/manorama-merged-logo.png" alt="manorama" />
              <span class="brand-tld" aria-hidden="true">.xyz</span>
            </span>
            <p class="admin-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            <p class="admin-welcome-note">{helloLine} {planLine}</p>
          </section>
          <section class="gallery-import" aria-labelledby="desktop-import-heading">
            <div class="gallery-selector-heading"><h2 id="desktop-import-heading">Add a gallery</h2></div>
            <div class="admin-retention-policy">
              <p class="admin-limit-count">{localGalleryCount} {galleryWord} on this Mac</p>
              <p>Folders and cards you have opened on this device. Manorama references the originals in place — nothing is copied, uploaded, or moved.</p>
            </div>
            <div class="desktop-import-actions">
              <button type="button" class="admin-button admin-button--solid" onClick={() => void addFolder()} disabled={busy}>{busy ? 'Scanning…' : 'Choose a folder or card'}</button>
              {session ? <button type="button" class="admin-button" onClick={() => catalogue && void runSync(catalogue, session)} disabled={syncState === 'syncing'}>Sync now</button> : null}
            </div>
            <p class="admin-privacy-note">Publishing is a separate, explicit step: the originals upload to your own cloud account, byte for byte, and never to Manorama.</p>
            <span class="desktop-sync-state" role="status">{syncMessage(syncState, session)}</span>
            {authError ? <p class="landing-note" role="alert">{authError}</p> : null}
            {notice ? <p class="landing-note" role="status">{notice}</p> : null}
          </section>
        </div>

        <section class="gallery-list" aria-live="polite" aria-labelledby="desktop-galleries-heading">
          <h1 class="admin-galleries-heading" id="desktop-galleries-heading">Your galleries</h1>
          <section class="desktop-galleries" aria-label="Saved galleries">
            {(catalogue?.galleries ?? []).map((record, rowIndex) => {
              const state = availability[record.id] ?? 'available'
              const open = openRecord?.id === record.id
              return (
                <article class={`desktop-gallery ${open ? 'is-open' : ''}`} key={record.id}>
                  <button type="button" class={`desktop-gallery-row ${rowIndex % 2 === 0 ? 'desktop-gallery-row-thumb-left' : 'desktop-gallery-row-thumb-right'}`} onClick={() => state !== 'unavailable' && setOpenGalleryId(open ? null : record.id)} disabled={state === 'unavailable'} aria-label={`Open ${record.title}`}>
                    <span class="desktop-gallery-copy">
                      <span class="desktop-gallery-heading"><strong>{record.title}</strong><span>({record.itemCount} {record.itemCount === 1 ? 'photo' : 'photos'})</span></span>
                      <span class="desktop-gallery-subtitle">{sourceLabel(record)}</span>
                      <span class="desktop-gallery-link">{record.rootPath}</span>
                    </span>
                    {record.items[0] ? <img class="desktop-gallery-thumb" src={assetUrl(record.items[0].path)} width={record.items[0].width} height={record.items[0].height} alt="" loading="lazy" draggable={false} /> : null}
                  </button>
                  <div class="desktop-gallery-actions">
                    <button type="button" disabled={state === 'unavailable'} onClick={() => setOpenGalleryId(open ? null : record.id)}>{open ? 'Hide photos' : 'View photos'}</button>
                    <button type="button" onClick={() => void rescan(record)}>Rescan</button>
                    <button type="button" disabled={state === 'unavailable'} onClick={() => setShareGalleryId(shareGalleryId === record.id ? null : record.id)}>Share…</button>
                    <button type="button" onClick={() => void remove(record)}>Remove</button>
                    {state === 'unavailable' ? <span class="desktop-badge-unavailable">Unavailable — reconnect the source</span> : null}
                  </div>
                  {shareGalleryId === record.id && catalogue ? (
                    <ShareFlow record={record} catalogue={catalogue} apiBase={base} session={session} onClose={() => setShareGalleryId(null)} />
                  ) : null}
                  {open ? (
                    <div class="desktop-grid">
                      {record.items.map((item, index) => (
                        <button type="button" key={item.id} class="desktop-thumb" onClick={() => setViewerState({ galleryId: record.id, index })}>
                          <img src={assetUrl(item.path)} loading="lazy" alt={item.name} draggable={false} onLoad={(event: Event) => {
                            const img = event.currentTarget as HTMLImageElement
                            recordDims(item.id, img.naturalWidth, img.naturalHeight)
                          }} />
                          <span class="desktop-thumb-name">{item.name}</span>
                        </button>
                      ))}
                      {record.items.length === 0 ? <p class="desktop-empty">No photos found — rescan after adding files.</p> : null}
                    </div>
                  ) : null}
                </article>
              )
            })}
            {catalogue && catalogue.galleries.length === 0 ? (
              <p class="desktop-empty">Choose a folder or a mounted memory card. Manorama references the originals in place — nothing is copied, uploaded, or moved.</p>
            ) : null}
          </section>
        </section>
        </div>
        </main>
    </>
  )
}
