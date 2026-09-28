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
  DESKTOP_AUTH_PROVIDERS,
  type AuthProvider,
  type DesktopSession,
} from '../lib/session'

const CATALOGUE_FILE = 'catalogue.json'
const DEVICE_LABEL = 'This Mac'

const PROVIDER_META = new Map(SIGN_IN_PROVIDERS.map((provider) => [provider.id, provider]))

// The web's labels, shared with the landing page: Apple keeps the "Sign in
// with" phrasing its guidelines require, the rest are "Continue with".
const providerLabel = (id: AuthProvider, name: string): string =>
  id === 'apple' ? `Sign in with ${name}` : `Continue with ${name}`

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
  const dimsRef = useRef<DimsMap>(new Map())
  // The deep-link sign-in callback is installed once at launch — a ref is
  // the only way it can sync the catalogue as it is THEN, not as it was.
  const catalogueRef = useRef<LocalCatalogue | null>(null)
  useEffect(() => {
    catalogueRef.current = catalogue
  }, [catalogue])

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

  if (desktopScreen({ signedIn: !!session, galleryCount: catalogue.galleries.length }) === 'welcome') {
    return (
      <>
        <div class="desktop-titlebar" data-tauri-drag-region />
        <main class="landing-page desktop-welcome">
          <div class="landing-brand">
            <span class="brand-mark-wrap">
              <img src="/manorama-merged-logo.png" alt="manorama" class="landing-brand-mark" />
            </span>
            <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            <button type="button" class="landing-signin desktop-primary" onClick={() => void addFolder()} disabled={busy || !catalogue}>
              {busy ? 'Scanning…' : 'Choose a folder or card'}
            </button>
            <p class="landing-note">Manorama references the originals in place — nothing is copied, uploaded, or moved.</p>
            <p class="desktop-welcome-caption">Sign in to sync your catalogue across devices</p>
            <div class="landing-signin-group">
              {SIGN_IN_PROVIDERS.map(({ id, name, Glyph }) => (
                <button type="button" class="landing-signin" key={id} onClick={() => signIn(id)}>
                  <Glyph />
                  {providerLabel(id, name)}
                </button>
              ))}
            </div>
            {authError ? <p class="landing-note" role="alert">{authError}</p> : null}
            {notice ? <p class="landing-note">{notice}</p> : null}
            {pasteForm}
          </div>
          <footer class="site-footer">
            <button
              type="button"
              class="site-footer-link"
              onClick={() => openExternal('https://manorama.xyz/privacy')}
            >
              Privacy Policy
            </button>
            <p class="site-footer-copy">© 2026 Mahesh Shantaram</p>
          </footer>
        </main>
      </>
    )
  }

  return (
    <main class="desktop-shell">
      <div class="desktop-titlebar" data-tauri-drag-region />
      <header class="desktop-header">
        <span class="brand-mark-wrap">
          <img src="/manorama-merged-logo.png" alt="manorama" class="desktop-logo" />
        </span>
        <div class="desktop-account">
          {session ? (
            <>
              <span class="desktop-owner">{session.ownerSlug || 'Signed in'}</span>
              <button type="button" onClick={signOut}>Sign out</button>
            </>
          ) : (
            DESKTOP_AUTH_PROVIDERS.map((id) => {
              const provider = PROVIDER_META.get(id)
              if (!provider) return null
              const { name, Glyph } = provider
              return (
                <button type="button" class="landing-signin" key={id} onClick={() => signIn(id)}>
                  <Glyph />
                  {providerLabel(id, name)}
                </button>
              )
            })
          )}
        </div>
      </header>

      {authError ? <p class="desktop-notice desktop-error" role="alert">{authError}</p> : null}
      {notice ? <p class="desktop-notice" role="status">{notice}</p> : null}

      {pasteForm}

      <section class="desktop-toolbar">
        <button type="button" onClick={() => void addFolder()} disabled={busy}>
          {busy ? 'Scanning…' : 'Choose a folder or card'}
        </button>
        {session ? (
          <button type="button" onClick={() => catalogue && void runSync(catalogue, session)} disabled={syncState === 'syncing'}>
            Sync now
          </button>
        ) : null}
        <span class="desktop-sync-state">{syncMessage(syncState, session)}</span>
      </section>

      <section class="desktop-galleries" aria-label="Saved galleries">
        {(catalogue?.galleries ?? []).map((record) => {
          const state = availability[record.id] ?? 'available'
          const open = openRecord?.id === record.id
          return (
            <article class={`desktop-gallery ${open ? 'is-open' : ''}`} key={record.id}>
              <header>
                <h2>{record.title}</h2>
                <span class="desktop-gallery-meta">
                  {record.itemCount} {record.itemCount === 1 ? 'photo' : 'photos'} · {record.sourceKind === 'card' ? 'card' : 'folder'}
                </span>
                {state === 'unavailable' ? (
                  <span class="desktop-badge-unavailable">Unavailable — reconnect the source</span>
                ) : null}
              </header>
              <div class="desktop-gallery-actions">
                <button
                  type="button"
                  disabled={state === 'unavailable'}
                  onClick={() => setOpenGalleryId(open ? null : record.id)}
                >
                  {open ? 'Hide photos' : 'View photos'}
                </button>
                <button type="button" onClick={() => void rescan(record)}>
                  Rescan
                </button>
                <button
                  type="button"
                  disabled={state === 'unavailable'}
                  onClick={() => setShareGalleryId(shareGalleryId === record.id ? null : record.id)}
                >
                  Share…
                </button>
                <button type="button" onClick={() => void remove(record)}>
                  Remove
                </button>
              </div>
              {shareGalleryId === record.id && catalogue ? (
                <ShareFlow
                  record={record}
                  catalogue={catalogue}
                  apiBase={base}
                  session={session}
                  onClose={() => setShareGalleryId(null)}
                />
              ) : null}
              {open ? (
                <div class="desktop-grid">
                  {record.items.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      class="desktop-thumb"
                      onClick={() => setViewerState({ galleryId: record.id, index })}
                    >
                      <img
                        src={assetUrl(item.path)}
                        loading="lazy"
                        alt={item.name}
                        draggable={false}
                        onLoad={(event: Event) => {
                          const img = event.currentTarget as HTMLImageElement
                          recordDims(item.id, img.naturalWidth, img.naturalHeight)
                        }}
                      />
                      <span class="desktop-thumb-name">{item.name}</span>
                    </button>
                  ))}
                  {record.items.length === 0 ? (
                    <p class="desktop-empty">No photos found — rescan after adding files.</p>
                  ) : null}
                </div>
              ) : null}
            </article>
          )
        })}
        {catalogue && catalogue.galleries.length === 0 ? (
          <p class="desktop-empty">
            Choose a folder or a mounted memory card. Manorama references the originals in
            place — nothing is copied, uploaded, or moved.
          </p>
        ) : null}
      </section>
    </main>
  )
}
