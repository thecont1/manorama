import { useCallback, useEffect, useRef, useState } from 'hono/jsx'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import { houseAdFrameFor, type AdFrame } from '../../app/lib/adframe'
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
import { fetchAccountGalleries, fetchAccountOwnerSlug, fetchDeviceGalleries, standaloneDeviceGalleries } from '../lib/account'
import { previewSrcFor, sourceLabelFor } from '../../native/lib/library-media'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import { cancelProviderConnect, handleProviderDeepLink } from '../lib/providers/oauth'
import { SIGN_IN_PROVIDERS } from '../../app/lib/signin'
import { desktopScreen, showPasteFallback } from '../lib/welcome'
import ShareFlow from './ShareFlow'
import LocalGalleryDetails from './LocalGalleryDetails'
import { Sheet } from '../../app/components/ui/Sheet'
import { applyTheme, oppositeTheme, readStoredTheme, storeTheme, themeControlLabel, type Theme } from '../lib/theme'
import {
  beginDesktopSignIn,
  clearSession,
  completeDesktopSignIn,
  getSession,
  installDesktopAuth,
  normalizeApiBase,
  DESKTOP_AUTH_PROVIDERS,
  type AuthProvider,
  type DesktopSession,
} from '../lib/session'

const CATALOGUE_FILE = 'catalogue.json'
const DEVICE_LABEL = 'This Mac'
const PROVIDER_META = new Map(SIGN_IN_PROVIDERS.map((provider) => [provider.id, provider]))
const sourceLabel = (record: LocalGalleryRecord): string =>
  record.sourceKind === 'card' ? 'Memory card' : 'Folder on this Mac'

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

type CardMenu =
  | { kind: 'account'; gallery: GallerySummary }
  | { kind: 'local'; record: LocalGalleryRecord }

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

/** The share sheet's steps, mirrored from ShareFlow so the host can gate
 *  dismissal on upload and settle a pending connect on early dismissal. */
type ShareStep = 'choose' | 'connecting' | 'confirm' | 'uploading' | 'done' | 'error'

/** A newly added folder's card mounts at the foot of the list: bring it into
 *  view the way the web dashboard brings a new gallery in. */
const scrollToGalleryCard = (id: string) => {
  requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-gallery-card="${id}"]`)
    if (!card) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  })
}

/**
 * The desktop shell: a catalogue of user-picked folders and memory cards,
 * each referenced in place. No copying, no watching — a manual rescan is
 * the only inventory refresh, and the per-gallery "Share…" sheet is the
 * only path by which bytes leave the device.
 *
 * The surface is the web/iOS admin workbench: the galleries run the page's
 * full width, the account waits in a slide-out pane behind one quiet
 * left-edge tab, and the theme switch lives inside that pane.
 */
export default function Catalogue({ apiBase }: { apiBase: string }) {
  const base = normalizeApiBase(apiBase)
  const [catalogue, setCatalogue] = useState<LocalCatalogue | null>(null)
  const [availability, setAvailability] = useState<Record<string, GalleryAvailability>>({})
  const [viewerState, setViewerState] = useState<ViewerState | null>(null)
  const [plate, setPlate] = useState<AdFrame | null>(null)
  const [session, setSession] = useState<DesktopSession | null>(null)
  const [accountGalleries, setAccountGalleries] = useState<GallerySummary[] | null>(null)
  const [deviceRows, setDeviceRows] = useState<DeviceGallery[]>([])
  const [galleriesFailed, setGalleriesFailed] = useState(false)
  const [devicesFailed, setDevicesFailed] = useState(false)
  const [slugFailed, setSlugFailed] = useState(false)
  const [ownerSlug, setOwnerSlug] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [pasteUrl, setPasteUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [shareGalleryId, setShareGalleryId] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareUploading, setShareUploading] = useState(false)
  const [shareStep, setShareStep] = useState<ShareStep>('choose')
  const [detailsId, setDetailsId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('details'))
  const [cardMenu, setCardMenu] = useState<CardMenu | null>(null)
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage))
  // The account pane opens closed on every load and is never encoded in the URL.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const dimsRef = useRef<DimsMap>(new Map())
  // The deep-link sign-in callback is installed once at launch — a ref is
  // the only way it can sync the catalogue as it is THEN, not as it was.
  const catalogueRef = useRef<LocalCatalogue | null>(null)
  useEffect(() => {
    catalogueRef.current = catalogue
  }, [catalogue])
  // The interim house plate rides every open gallery, seeded by its id. The
  // master's day/region switch still suppresses it — the same fail-open
  // courtesy as the native viewer: unanswered means show, never a gate.
  useEffect(() => {
    const galleryId = viewerState?.galleryId
    if (!galleryId) {
      setPlate(null)
      return
    }
    let active = true
    const apply = (show: boolean) => { if (active) setPlate(show ? houseAdFrameFor(galleryId) : null) }
    void fetch(`${base}/api/ads/visibility`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => apply((body as { show?: boolean } | null)?.show !== false))
      .catch(() => apply(true))
    return () => { active = false }
  }, [base, viewerState?.galleryId])
  // The share sheet's live state, mirrored in refs so the window-level history
  // listener (registered once, empty deps) sees the CURRENT flow instead of
  // closing over a stale render.
  const detailsIdRef = useRef<string | null>(detailsId)
  const shareStepRef = useRef<ShareStep>('choose')
  const shareUploadingRef = useRef(false)
  useEffect(() => {
    detailsIdRef.current = detailsId
  }, [detailsId])
  useEffect(() => {
    const followHistory = () => {
      const detail = new URLSearchParams(window.location.search).get('details')
      if (shareUploadingRef.current) {
        // An upload in flight owns the details surface: navigation must not
        // dismiss or unmount it, or clear the share state while ShareFlow
        // keeps working. Restore the details URL so Back can still leave
        // once the upload settles.
        const current = detailsIdRef.current
        if (current && detail !== current) {
          const url = new URL(window.location.href)
          url.searchParams.set('details', current)
          window.history.pushState(window.history.state, '', url)
        }
        return
      }
      setDetailsId(detail)
      // Any navigation dismisses the share sheet and forgets its flow; a
      // dismissal mid-connect settles the pending flow exactly like the
      // sheet's own close.
      if (shareStepRef.current === 'connecting') cancelProviderConnect()
      resetShare()
    }
    window.addEventListener('popstate', followHistory)
    return () => window.removeEventListener('popstate', followHistory)
  }, [])

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

  // The account's galleries join the list once a session exists — the iOS
  // Library's feeds, applied as each one lands rather than batched: the cloud
  // cards appear the moment /api/galleries settles, and the device rows and
  // owner slug arrive whenever their own calls return. The slug lookup only
  // replaces the sign-in copy stored in session.json — it goes stale the
  // moment a rename happens elsewhere, so a failed refresh is worth a note.
  useEffect(() => {
    if (!session) {
      setAccountGalleries(null)
      setDeviceRows([])
      setGalleriesFailed(false)
      setDevicesFailed(false)
      setSlugFailed(false)
      setOwnerSlug(null)
      return
    }
    const controller = new AbortController()
    const alive = () => !controller.signal.aborted
    void fetchAccountGalleries(base, session.token, fetch, controller.signal).then(
      (rows) => { if (alive()) { setAccountGalleries(rows); setGalleriesFailed(false) } },
      () => { if (alive()) setGalleriesFailed(true) },
    )
    void fetchDeviceGalleries(base, session.token, fetch, controller.signal).then(
      (rows) => { if (alive()) { setDeviceRows(rows); setDevicesFailed(false) } },
      () => { if (alive()) setDevicesFailed(true) },
    )
    void fetchAccountOwnerSlug(base, session.token, fetch, controller.signal).then(
      (slug) => { if (alive()) { setOwnerSlug(slug); setSlugFailed(false) } },
      () => { if (alive()) setSlugFailed(true) },
    )
    return () => controller.abort()
  }, [base, session, syncState])

  // The theme belongs to the catalogue, not to the stage. While a photograph is
  // in view the class is held off: the stage is a neutral near-black by
  // contract, and a light `--ink` over that ground would leave the curtain copy
  // unreadable. The choice itself is remembered either way.
  useEffect(() => {
    if (viewerState) {
      applyTheme('dark', document.documentElement)
      return
    }
    applyTheme(theme, document.documentElement)
    storeTheme(typeof localStorage === 'undefined' ? null : localStorage, theme)
  }, [theme, viewerState])

  // The pane is a modal dialog: focus enters it, Tab stays inside it, and
  // Escape or a backdrop click hands the caret back to the tab that opened it.
  const closeMenu = () => {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }
  useEffect(() => {
    if (!menuOpen) return
    const panel = drawerRef.current
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
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
  }, [menuOpen])

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
      setNotice(`${record.title} added.`)
      scrollToGalleryCard(record.id)
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
      throw new Error('The source is unavailable — reconnect it, then rescan.')
    }
    let updated: LocalGalleryRecord
    let next: LocalCatalogue
    try {
      const scan = await scanLocalDirectory(record.rootPath, readDirEntries)
      updated = {
        ...record,
        items: scan.items,
        itemCount: scan.truncated ?? scan.items.length,
        lastSeenAt: new Date().toISOString(),
      }
      next = {
        ...catalogue,
        galleries: catalogue.galleries.map((g) => (g.id === record.id ? updated : g)),
      }
    } catch (reason) {
      // A genuine source read failure may mark the source unavailable.
      setAvailability((previous) => ({ ...previous, [record.id]: 'unavailable' }))
      throw reason instanceof Error ? reason : new Error('The source could not be read again')
    }
    // Persist first, exactly like rename/remove: a failed private-store write
    // keeps the prior record on screen instead of pretending the rescan stuck.
    await writeCatalogueFile(serializeLocalCatalogue(next))
    setCatalogue(next)
    if (!updated.items.length) setNotice('That source has no photos Manorama can display')
    void runSync(next, session)
  }

  /** Card-level rescan has no note surface of its own — a success repaints
   *  the rail and count (and rescan itself reports an empty source); only a
   *  thrown read needs the section's status line. */
  const rescanFromCard = (record: LocalGalleryRecord) => {
    rescan(record).catch((reason: unknown) =>
      setNotice(reason instanceof Error ? reason.message : 'That source could not be read again'))
  }

  /** Forget the share sheet, its step, and any in-flight upload together. */
  const resetShare = () => {
    setShareOpen(false)
    setShareGalleryId(null)
    setShareStep('choose')
    setShareUploading(false)
    shareStepRef.current = 'choose'
    shareUploadingRef.current = false
  }

  const remove = async (record: LocalGalleryRecord) => {
    if (!catalogue) return
    const next = { ...catalogue, galleries: catalogue.galleries.filter((g) => g.id !== record.id) }
    // Persist first: the Library entry only goes once the private store has
    // acknowledged the write — a failed save keeps the record and surfaces the
    // reason inside the confirmation sheet.
    await writeCatalogueFile(serializeLocalCatalogue(next))
    setCatalogue(next)
    if (viewerState?.galleryId === record.id) setViewerState(null)
    // The catalogue entry goes; nothing on disk is touched, ever.
    if (session) void removeDeviceGallery(base, session.token, record)
    // The acknowledgement is what returns to the Library.
    closeDetails()
  }

  const openDetails = (record: LocalGalleryRecord) => {
    const url = new URL(window.location.href)
    url.searchParams.set('details', record.id)
    window.history.pushState({ manoramaDetails: true }, '', url)
    setDetailsId(record.id)
    resetShare()
  }

  const closeDetails = () => {
    // An upload in flight owns the details surface — Back must not dismiss it
    // mid-transfer; it can leave once the upload settles.
    if (shareUploading) return
    resetShare()
    setDetailsId(null)
    if (window.history.state?.manoramaDetails) {
      window.history.back()
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('details')
    window.history.replaceState(null, '', url)
  }

  const dismissShare = () => {
    if (shareUploading) return
    // A dismissal mid-connect must settle the pending flow so the next attempt
    // starts clean — the same settle ShareFlow's own close performs.
    if (shareStep === 'connecting') cancelProviderConnect()
    resetShare()
  }

  const openShareFromDetails = () => {
    if (!detailsId) return
    setShareGalleryId(detailsId)
    setShareStep('choose')
    setShareUploading(false)
    setShareOpen(true)
    shareStepRef.current = 'choose'
    shareUploadingRef.current = false
  }

  const handleShareStep = (step: ShareStep) => {
    setShareStep(step)
    setShareUploading(step === 'uploading')
    shareStepRef.current = step
    shareUploadingRef.current = step === 'uploading'
  }

  const rename = async (record: LocalGalleryRecord, value: string) => {
    if (!catalogue) return
    const title = value.trim()
    if (!title) throw new Error('Give this gallery a name')
    if (title === record.title) return
    const next = {
      ...catalogue,
      galleries: catalogue.galleries.map(gallery => gallery.id === record.id ? { ...gallery, title } : gallery),
    }
    // Persist first: a failed private-store write keeps the old title on screen
    // and inside the open edit sheet, rather than pretending the rename stuck.
    await writeCatalogueFile(serializeLocalCatalogue(next))
    setCatalogue(next)
    void runSync(next, session)
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
            plate={plate}
            initialIndex={viewerState?.index ?? 0}
            allowFullscreen={false}
            onReturnToGalleries={() => setViewerState(null)}
          />
        </GalleryShell>
      </>
    )
  }

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

  // The selected record's details: a full-screen local surface mounted in
  // place of the workbench, with the shared Sheet+ShareFlow hosted alongside
  // it (Share opens only from Details). The viewer takes precedence when a
  // photograph is open — Open leaves details first.
  const detailsRecord = detailsId && catalogue ? catalogue.galleries.find((g) => g.id === detailsId) ?? null : null
  const shareRecord = shareGalleryId && catalogue ? catalogue.galleries.find((g) => g.id === shareGalleryId) ?? null : null
  const shareHost = shareOpen && shareRecord ? (
    <Sheet open={shareOpen} onClose={dismissShare} title={`Share “${shareRecord.title}”`} dismissible={!shareUploading}>
      <ShareFlow
        record={shareRecord}
        catalogue={catalogue}
        apiBase={base}
        session={session}
        presentation="sheet"
        onClose={resetShare}
        onStepChange={handleShareStep}
      />
    </Sheet>
  ) : null

  if (detailsRecord) {
    return (
      <>
        <div class="desktop-titlebar" data-tauri-drag-region />
        <LocalGalleryDetails
          record={detailsRecord}
          availability={availability[detailsRecord.id] ?? 'available'}
          onBack={closeDetails}
          onOpen={() => {
            closeDetails()
            setViewerState({ galleryId: detailsRecord.id, index: 0 })
          }}
          onShare={openShareFromDetails}
          onRescan={() => rescan(detailsRecord)}
          onRename={(title) => rename(detailsRecord, title)}
          onRemove={() => remove(detailsRecord)}
        />
        {shareHost}
      </>
    )
  }

  const galleries = catalogue.galleries
  // Dedupe at render so whichever feed lands last re-derives the list — a
  // device row published as a cloud gallery collapses the moment the account
  // read arrives, without waiting on the slower call.
  const remoteDeviceGalleries = standaloneDeviceGalleries(deviceRows, accountGalleries ?? [], catalogue.deviceId)
  const accountNote = galleriesFailed || devicesFailed ? 'Your galleries could not be loaded — this Mac’s catalogue is unaffected.' : null
  const slugNote = slugFailed ? 'Gallery links may open at an older account address — the saved URL name could not be refreshed.' : null
  const photoCount = galleries.reduce((total, record) => total + record.itemCount, 0)

  // The account surface speaks the vocabulary the web dashboard and iOS
  // already use — "Welcome to manorama.xyz.", and the plan as a sentence. What
  // follows it is the Mac's own fact: these galleries live on this Mac rather
  // than against an account limit, so the count is local, not the account's.
  // A session stored before the exchange answered `tier` omits the plan
  // sentence rather than guessing Free.
  const planSentence = session?.tier === 'pro' ? 'You are a Visionary.' : session?.tier === 'free' ? 'You are a Free User.' : null
  const galleryWord = galleries.length === 1 ? 'gallery' : 'galleries'
  const helloLine = `Hello, ${session?.ownerSlug || 'there'}. Welcome to manorama.xyz.`
  const planLine = `${planSentence ? `${planSentence} ` : ''}${galleries.length} ${galleryWord} on this Mac.`

  const accountGalleryUrl = (gallery: GallerySummary) => `${base}/${ownerSlug ?? session?.ownerSlug ?? ''}/${gallery.slug}`
  const menuAnchor = (url: string) => ({
    ...externalAnchor(url),
    onClick: (event: MouseEvent) => {
      event.preventDefault()
      setCardMenu(null)
      openExternal(url)
    },
  })

  return (
    // `data-admin-ready` is the shell's own "catalogue restored" signal: the
    // island renders nothing above until the private files have been read, so
    // anything measuring the surface can wait for it instead of guessing.
    <main class="admin-page admin-page--selector desktop-catalogue" data-admin-ready="true">
      <div class="desktop-titlebar" data-tauri-drag-region />
      {/* Account tools live at the edge; the photographs keep the page width.
          The tab belongs to the catalogue only, never to the viewing stage. */}
      <button
        type="button"
        class="admin-edge-tab"
        aria-label="Account menu"
        aria-expanded={menuOpen ? 'true' : 'false'}
        aria-controls="admin-account-drawer"
        ref={menuButtonRef}
        onClick={() => setMenuOpen(true)}
      >
        <span class="admin-tab-label" aria-hidden="true">Account</span>
        <svg class="admin-hamburger" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        <svg class="admin-tab-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      {/* Hidden account controls stay outside the accessibility tree until the
          hydrated catalogue opens them. */}
      <div class="admin-drawer" id="admin-account-drawer" data-account-drawer hidden={!menuOpen}>
        <div class="admin-drawer-scrim" aria-hidden="true" onClick={closeMenu} />
        <aside class="admin-drawer-panel" role="dialog" aria-modal="true" aria-label="Account" ref={drawerRef}>
          <button type="button" class="admin-drawer-close" aria-label="Close account menu" onClick={closeMenu}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </button>
          <div class="admin-left">
            <header class="admin-header">
              <div>
                <p class="admin-brand-title"><span class="brand-mark-wrap"><img class="admin-brand-logo" src="/manorama-merged-logo.png" alt="manorama" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></p>
                <p class="admin-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
                <div class="admin-greeting">
                  <p>Hello <mark class="admin-greeting-name">{session?.ownerSlug || 'there'}</mark>. Welcome to manorama.xyz.</p>
                  {/* The address the owner's galleries answer to — the web
                      dashboard's own line, kept so the pane reads the same on
                      every surface. */}
                  <p class="admin-greeting-url">manorama.xyz/{session?.ownerSlug ?? ''}</p>
                  {planSentence ? <p>{planSentence}</p> : null}
                  <p class="desktop-device-line">{catalogue.deviceLabel} · {galleries.length} {galleryWord} · {photoCount} {photoCount === 1 ? 'photograph' : 'photographs'}</p>
                </div>
                {!session ? (
                  <div class="desktop-signin desktop-account-signin">
                    <span class="desktop-signin-lead">Continue with</span>
                    <div class="desktop-signin-icons">
                      {DESKTOP_AUTH_PROVIDERS.map((id) => {
                        const provider = PROVIDER_META.get(id)
                        if (!provider) return null
                        const { name, Glyph } = provider
                        return (
                          <button type="button" class="desktop-signin-icon" key={id} aria-label={`Continue with ${name}`} onClick={() => signIn(id)}>
                            <Glyph />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
                {authError ? <p class="landing-note" role="alert">{authError}</p> : null}
                {pasteForm}
              </div>
            </header>
            <footer class="site-footer">
              <a class="site-footer-link" {...externalAnchor(PRIVACY_URL)}>Privacy Policy</a>
              <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a {...externalAnchor(AUTHOR_URL)}>thecontrarian.in</a></p>
            </footer>
          </div>
          {/* The account actions sit at the pane's foot: labelled, and away
              from the galleries. */}
          <div class="admin-drawer-actions">
            <button
              type="button"
              class="admin-drawer-action"
              aria-pressed={theme === 'light'}
              onClick={() => setTheme(oppositeTheme(theme))}
            >{themeControlLabel(theme)}</button>
            <button type="button" class="admin-drawer-action" onClick={signOut}>Sign out</button>
          </div>
        </aside>
      </div>

      <div class="admin-content">
        {/* Only the continuous photographic rails span the centre. The welcome
            copy and the local-source picker each fit inside one half of the
            top workbench. */}
        <div class="admin-overview">
          <section class="admin-welcome" aria-label="Welcome to manorama">
            <span class="admin-welcome-brand brand-mark-wrap">
              <img class="admin-topbar-logo" src="/manorama-merged-logo.png" alt="manorama" />
              <span class="brand-tld" aria-hidden="true">.xyz</span>
            </span>
            <p class="admin-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            <p class="admin-profile-address">manorama.xyz/{session?.ownerSlug ?? ''}</p>
            <p class="admin-welcome-note">{helloLine} {planLine}</p>
          </section>
          <section class="gallery-import" aria-labelledby="import-heading">
            <div class="gallery-selector-heading"><h2 id="import-heading">Add a gallery</h2></div>
            <div class="admin-retention-policy">
              {/* The web dashboard's slot states the account's retention; here
                  it states the Mac's own fact, in the same words the welcome
                  quadrant uses. The photograph count lives on the pane's device
                  line, where it is not a repetition. */}
              <p class="admin-limit-count">{galleries.length} {galleryWord} on this Mac</p>
              <p class="desktop-sync-state">{syncMessage(syncState, session)}</p>
            </div>
            <div class="desktop-source-actions">
              <button type="button" class="admin-button admin-button--solid" onClick={() => void addFolder()} disabled={busy}>{busy ? 'Scanning…' : 'Choose a folder or card'}</button>
              {session ? <button type="button" class="admin-button" onClick={() => catalogue && void runSync(catalogue, session)} disabled={syncState === 'syncing'}>Sync now</button> : null}
            </div>
            {notice ? <p class="desktop-source-note" role="status">{notice}</p> : null}
            <p class="admin-privacy-note">Manorama reads only the folders and cards you pick, and references the originals in place: nothing is copied, uploaded, moved or re-encoded. Removing a gallery removes this Mac’s entry; nothing in the folder itself is ever modified or deleted.</p>
          </section>
        </div>

        <section class="gallery-list" aria-labelledby="galleries-heading">
          <h1 class="admin-galleries-heading" id="galleries-heading">Your galleries</h1>
          {accountNote ? <p class="desktop-source-note" role="status">{accountNote}</p> : null}
          {slugNote ? <p class="desktop-source-note" role="status">{slugNote}</p> : null}
          {galleries.length || accountGalleries?.length || remoteDeviceGalleries.length ? (
            <ul class="lib-list">
              {accountGalleries?.map((gallery) => {
                const title = gallery.title || gallery.slug
                const galleryUrl = accountGalleryUrl(gallery)
                return <li key={`account-${gallery.slug}`}><article class="lib-card">
                  {gallery.images.length ? (
                    <div class="admin-gallery-strip-frame">
                      <ul class="admin-gallery-strip" aria-label={`${title} photographs`}>
                        {gallery.images.map((image, index) => (
                          <li class="admin-gallery-strip-item" key={image.id}>
                            <a
                              {...externalAnchor(galleryUrl)}
                              draggable={false}
                              aria-label={`Open ${title} — photograph ${index + 1} of ${gallery.images.length}`}
                            >
                              <img
                                src={previewSrcFor(image)}
                                alt=""
                                loading="lazy"
                                draggable={false}
                                onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')}
                              />
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div class="lib-card-head">
                    <a class="lib-card-title" {...externalAnchor(galleryUrl)} draggable={false}>{title}</a>
                    <button type="button" class="lib-card-menu" aria-label={`${title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'account', gallery })}>···</button>
                  </div>
                  <p class="lib-card-sub">
                    {gallery.imageCount} {gallery.imageCount === 1 ? 'photograph' : 'photographs'} · {sourceLabelFor(gallery.sourceUrl)} · cloud gallery
                  </p>
                </article></li>
              })}
              {remoteDeviceGalleries.map((gallery) => (
                <li key={`device-${gallery.id}`}><article class="lib-card">
                  {/* Nothing on this Mac opens a remote copy — the card stays
                      informational: no rail, no menu, no title action. */}
                  <div class="lib-card-head">
                    <span class="lib-card-title">{gallery.title}</span>
                  </div>
                  <p class="lib-card-sub">
                    {gallery.itemCount} {gallery.itemCount === 1 ? 'photograph' : 'photographs'} · {gallery.deviceLabel} · synced — open it on that device
                  </p>
                </article></li>
              ))}
              {galleries.map((record) => {
                const state = availability[record.id] ?? 'available'
                const unavailable = state === 'unavailable'
                return <li key={record.id}><article class="lib-card" data-gallery-card={record.id} data-availability={state}>
                  {/* One gapless row of aspect-true originals, hung exactly as
                      the web editor rail and the native picker hang them: one
                      height, width from the source, zero gaps. */}
                  <div class="admin-gallery-strip-frame">
                    <ul class="admin-gallery-strip" aria-label={`${record.title} photographs`}>
                      {record.items.map((item, index) => (
                        <li class="admin-gallery-strip-item" key={item.id} data-image-id={item.id}>
                          <button
                            type="button"
                            disabled={unavailable}
                            aria-label={`Open ${item.name} — photograph ${index + 1} of ${record.items.length} in ${record.title}`}
                            onClick={() => setViewerState({ galleryId: record.id, index })}
                          >
                            <img
                              src={assetUrl(item.path)}
                              alt=""
                              loading="lazy"
                              draggable={false}
                              onLoad={(event: Event) => {
                                const img = event.currentTarget as HTMLImageElement
                                img.classList.add('is-loaded')
                                recordDims(item.id, img.naturalWidth, img.naturalHeight)
                              }}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {record.items.length === 0 ? <p class="desktop-empty">No photos found — rescan after adding files.</p> : null}
                  </div>
                  <div class="lib-card-head">
                    {/* Title is the primary action like everywhere else: the
                        gallery when it can open, Details — where the fix lives —
                        when the source is gone. */}
                    <button
                      type="button"
                      class="lib-card-title"
                      onClick={() => unavailable ? openDetails(record) : setViewerState({ galleryId: record.id, index: 0 })}
                    >{record.title}</button>
                    <button type="button" class="lib-card-menu" aria-label={`${record.title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'local', record })}>···</button>
                  </div>
                  <p class="lib-card-sub">
                    {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
                  </p>
                  {unavailable ? <p class="desktop-badge-unavailable">Unavailable — reconnect the source, then rescan.</p> : null}
                </article></li>
              })}
            </ul>
          ) : (
            <p class="desktop-empty">Choose a folder or a mounted memory card. Manorama references the originals in place — nothing is copied, uploaded, or moved.</p>
          )}
        </section>
      </div>

      {cardMenu ? (
        <Sheet open onClose={() => setCardMenu(null)} title={cardMenu.kind === 'account' ? cardMenu.gallery.title || cardMenu.gallery.slug : cardMenu.record.title}>
          {/* Native buttons and links, not menu/menuitem roles: there is no
              arrow-key roving focus here, so the menu role would overpromise. */}
          <div class="lib-menu">
            {cardMenu.kind === 'account' ? (<>
              <a {...menuAnchor(accountGalleryUrl(cardMenu.gallery))}>Open</a>
              {cardMenu.gallery.sourceUrl ? <a {...menuAnchor(cardMenu.gallery.sourceUrl)}>Open source</a> : null}
            </>) : (<>
              <button type="button" onClick={() => { const record = cardMenu.record; setCardMenu(null); openDetails(record) }}>Gallery details</button>
              <button type="button" onClick={() => { const record = cardMenu.record; setCardMenu(null); rescanFromCard(record) }}>Read the folder again</button>
            </>)}
          </div>
        </Sheet>
      ) : null}
    </main>
  )
}
