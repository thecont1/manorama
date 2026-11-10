import { useCallback, useEffect, useRef, useState } from 'hono/jsx'
import { publishAddFolder, publishAddGallery, publishClose, publishNavigation, shellPost } from '../lib/shell'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import EncryptedGallery from '../../app/islands/EncryptedGallery'
import { defaultGallerySettings, type GallerySettings } from '../../app/lib/gallery-settings'
import { houseAdFrameFor, type AdFrame } from '../../app/lib/adframe'
import type { GalleryManifest } from '../../app/lib/imagesource'
import { cardCountSource, formatMediaCount, summaryMediaCount } from '../../app/lib/imagesource'
import { FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT, PIPELINE_LOCK_MESSAGE, expiryCountdownText } from '../../app/lib/gallery-policy'
import { libraryLayout } from '../../packages/core/library-layout'
import {
  classifyRoot,
  galleryTitleForRoot,
  mergeRescannedItems,
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
  visibleItemsFor,
  type GalleryAvailability,
  type LocalCatalogue,
  type LocalGalleryRecord,
} from '../lib/catalogue'
import { assetUrl, isDesktopRuntime, pathExists, pickGalleryFolder, readDirEntries, registerSavedGalleryRoots, revealGalleryRoot } from '../lib/tauri'
import { invoke } from '@tauri-apps/api/core'
import { removeDeviceGallery, syncDeviceGalleries } from '../lib/sync'
import { copyText, shareGalleryOnWeb } from '../../app/lib/gallery-share'
import { AccountApiError, createAccountGallery, deleteAccount, deleteAccountGallery, deleteDeviceGalleryRecord, fetchAccountGalleries, fetchAccountGallery, fetchAccountIdentities, fetchAccountProfile, fetchDeviceGalleries, mintLinkHandoff, patchAccountOwnerSlug, refreshAccountGallery, scanGalleryLink, setAccountGalleryPin, standaloneDeviceGalleries, unlinkAccountIdentity } from '../lib/account'
import { previewSrcFor, sourceLabelFor } from '../../native/lib/library-media'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import { cancelProviderConnect, handleProviderDeepLink } from '../lib/providers/oauth'
import { galleryHashForSource, isEncryptedSourceUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import type { EncryptedMediaResolver } from '../../app/lib/encrypted-resolver'
import { SIGN_IN_PROVIDERS } from '../../app/lib/signin'
import { desktopScreen, showPasteFallback } from '../lib/welcome'
import ShareFlow from './ShareFlow'
import LocalGalleryDetails from './LocalGalleryDetails'
import { Sheet } from '../../app/components/ui/Sheet'
import { SettingsIcon, LinkIcon, SourceIcon } from '../../app/components/admin-icons'
import { AddGallerySheet } from '../../app/components/AddGallerySheet'
import { GalleryShareSheet } from '../../app/components/GalleryShareSheet'
import OwnerGalleryPanel from '../../app/components/viewer/OwnerGalleryPanel'
import type { PickerEditItem } from '../../app/components/viewer/PickerEditor'
import { HeicImg } from '../../app/components/ui/HeicImg'
import { refreshRequestInit } from '../../app/lib/encrypted-refresh'
import { configureEncryptedDisplayKeyStore } from '../../app/lib/encrypted-display'
import { desktopKeyStore } from '../lib/key-store'
import { desktopOfflineStore, desktopVaultPersistence, openDesktopEncryptedSession, createDesktopVaultSettings } from '../lib/offline-gallery'
import { desktopVault } from '../lib/vault'
import { EncryptedSourceLockedError, EncryptedSourceMismatchError } from '../../native/lib/encrypted-gallery'
import { openGalleryNetworkFirst, OfflineGalleryUnavailableError, type OfflineGallerySummary, type OfflineGridGallery } from '../../native/lib/offline-gallery'
import { applyVaultCap, galleryPolicyKey, loadGalleryStreamOnly, loadVaultCapPreference, loadVaultLoadPolicy, saveGalleryStreamOnly, type VaultLoadPolicy } from '../../native/lib/vault-settings'
import VaultSettings, { formatBytes } from '../../native/islands/VaultSettings'
import { Meter } from '../../app/components/ui/Meter'
import { WebSettings, type AccountIdentityWeb } from '../../app/components/WebSettings'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { Switch } from '../../app/components/ui/Switch'
import { Button } from '../../app/components/ui/Button'
import { friendlySourceError } from '../../app/lib/source-errors'
import type { EncryptedClientSession } from '../../app/lib/encrypted-resolver'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../lib/theme'
import {
  beginDesktopSignIn,
  clearSession,
  completeDesktopSignIn,
  getSession,
  installDesktopAuth,
  linkResultFromDeepLink,
  normalizeApiBase,
  storeSession,
  type AuthProvider,
  type DesktopSession,
} from '../lib/session'

const CATALOGUE_FILE = 'catalogue.json'
// The catalogue's device label is the owner's own name for the machine
// (scutil ComputerName → hostname → generic), resolved natively once per
// launch. Two of the owner's Macs stop reading identically.
const FALLBACK_DEVICE_LABEL = 'This Mac'
const resolveDeviceLabel = () => invoke<string>('device_label').catch(() => FALLBACK_DEVICE_LABEL)

// The build tag under the rail mark — injected by vite's define, 'dev' under
// tests and scripts which never see it.
const buildCommit = typeof __MANORAMA_COMMIT__ === 'string' ? __MANORAMA_COMMIT__ : 'dev'
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
  | { kind: 'device'; gallery: DeviceGallery }

/* The strip/card helpers the web Library uses — same badges, same temp
 *  wording, so an owner sees one product across the two shells. */
type SummaryImage = GallerySummary['images'][number]
const isLocked = (gallery: GallerySummary) => gallery.retention === 'pipeline'
const isVideoPreview = (image: SummaryImage) => (image as { type?: string }).type === 'video'
const itemKind = (image: SummaryImage) => isVideoPreview(image) ? 'video' : 'image'
const videoBadge = (image: SummaryImage) => {
  const seconds = isVideoPreview(image) ? (image as { durationSeconds?: number }).durationSeconds : undefined
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '▶'
  const total = Math.round(seconds)
  return `▶ ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
/** The stopwatch flag is a status icon here — the pin-swap flow it opens
 *  on the web dashboard has no desktop surface yet. */
const tempFlag = (gallery: GallerySummary) => (
  <span class="lib-temp-flag" role="img" title={`Temporary gallery${gallery.expiresAt ? ` — expires in ${expiryCountdownText(gallery.expiresAt, Date.now())}` : ''}`} aria-label={`Temporary gallery${gallery.expiresAt ? ` — expires in ${expiryCountdownText(gallery.expiresAt, Date.now())}` : ''}`}>
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>
  </span>
)
const tempWording = (gallery: GallerySummary) =>
  isLocked(gallery) ? ` · Temporary gallery${gallery.expiresAt ? ` · expires in ${expiryCountdownText(gallery.expiresAt, Date.now())}` : ''}` : ''
const pinGlyph = (entry: { pinnedAt?: string | null }) => entry.pinnedAt
  ? <span class="lib-pin" role="img" aria-label="Pinned"><svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6l.8 2 .8-2v-6H18v-2l-2-2z"/></svg></span>
  : null
/** Strips overflow horizontally; a vertical wheel gesture pans them so a
 *  mouse/trackpad never strands the rail — same mapping the web uses. */
const stripWheel = (event: WheelEvent) => {
  const frame = event.currentTarget as HTMLDivElement
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  frame.scrollLeft += delta
  event.preventDefault()
}
/* A transient upstream 5xx otherwise leaves a permanent hole in a remote
   strip — one bounded retry, keyed on the source so a swapped-in src earns
   its own. Same guard the web strip carries. */
const stripImgRetry = (event: Event) => {
  const img = event.currentTarget as HTMLImageElement
  const baseOf = (src: string) => src.replace(/([?&])mreload=\d+&?/, '$1').replace(/[?&]$/, '')
  const failed = baseOf(img.getAttribute('src') ?? '')
  if (!failed || img.dataset.retriedSrc === failed) return
  img.dataset.retriedSrc = failed
  window.setTimeout(() => {
    if (baseOf(img.getAttribute('src') ?? '') === failed) {
      img.src = `${failed}${failed.includes('?') ? '&' : '?'}mreload=1`
    }
  }, 1500)
}

const readCatalogueFile = () => invoke<string | null>('read_private_file', { name: CATALOGUE_FILE })
const writeCatalogueFile = (contents: string) =>
  invoke('write_private_file', { name: CATALOGUE_FILE, contents })

type ViewerState = { galleryId: string; index: number; edit?: boolean }
/** A fetched cloud manifest riding the same Viewer the local records use. */
type AccountViewerState = { manifest: GalleryManifest; settings: GallerySettings; index: number; gallery?: GallerySummary; galleryId?: string; edit?: boolean; encryptedSourceUrl?: string; encryptedResolver?: EncryptedMediaResolver | null }

/** The app's gallery-key custody: an app is not a browser tab, so keys
 *  persist on this Mac (the webview's own storage, never synced) until the
 *  owner removes them. Passed explicitly so the web's session-only rule
 *  stays untouched. */
// The shared display resolver reads the session-scoped web store by
// default; this shell's custody is the durable local one.
configureEncryptedDisplayKeyStore(desktopKeyStore)
type SyncState = 'idle' | 'syncing' | 'synced' | 'partial' | 'failed'

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
  const [accountViewer, setAccountViewer] = useState<AccountViewerState | null>(null)
  // The native shell's Gallery menu drives the mounted Viewer through this
  // handle. The Viewer keeps sole ownership of the index — the handle asks it
  // to move, it never sets it. Under Tauri there is no shell, so the handle
  // simply goes unused and the build is unchanged.
  const navigationRef = useRef<{ goTo(index: number): void } | null>(null)
  // Tell the native shell what the shell needs to know: whether a gallery is
  // open, and which photograph it is on. Both calls are no-ops without a
  // shell, so the Tauri build is unaffected.
  useEffect(() => {
    publishNavigation(navigationRef)
    // The shell's Gallery menu has a Close Gallery item; the page owns
    // what closing means, so the shell asks the page.
    publishClose(() => {
      if (accountViewer) { disposeOpenLease(); setAccountViewer(null) }
      setViewerState(null)
    })
    // The native menu's "Add Gallery…" opens the chooser when signed in;
    // "Open Folder…" runs the Library's direct folder flow.
    publishAddGallery(() => {
      if (session) setAddChooserOpen(true)
      else void addFolder()
    })
    publishAddFolder(() => { void addFolder() })
  })

  useEffect(() => {
    const open = accountViewer !== null || viewerState !== null
    shellPost({ type: 'gallery', open, title: accountViewer?.manifest.title })
  }, [accountViewer, viewerState])

  // Escape leaves the gallery, and only the native shell hears it: the
  // Tauri build has no shell on the other end, so its behaviour is
  // unchanged.
  //
  // The Viewer consumes Escape for its own overlays — the picker, the
  // information sheet — so the message goes out only when nothing else
  // claimed the key. The check waits for the dispatch to finish, because
  // the listener that claims Escape may run after this one.
  useEffect(() => {
    if (!viewerState && !accountViewer) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        shellPost({ type: 'escape' })
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewerState, accountViewer])

  // The Library is mounted. The shell needs to know: its own commands drive
  // the page, and a command sent before this would find nothing to drive.
  useEffect(() => { shellPost({ type: 'ready' }) }, [])

  // The encrypted on-device vault: galleries whose bytes already live in the
  // login-Keychain-locked store, the owner's load policy, and the per-gallery
  // stream-only overrides — the same three surfaces the iOS app carries.
  const [savedGalleries, setSavedGalleries] = useState<OfflineGallerySummary[]>([])
  // Grid entries mint the section's covers from vault thumbnails — object
  // URLs, revoked on the next refresh, never a durable URL to ciphertext.
  const [savedGridGalleries, setSavedGridGalleries] = useState<OfflineGridGallery[]>([])
  const [keyChecked, setKeyChecked] = useState<ReadonlySet<string>>(new Set())
  const [savedThumbs, setSavedThumbs] = useState<ReadonlyMap<string, string>>(new Map())
  const savedThumbsRef = useRef<ReadonlyMap<string, string>>(new Map())
  const [vaultLoadPolicy, setVaultLoadPolicy] = useState<VaultLoadPolicy | null>(null)
  const [streamOnlyPolicies, setStreamOnlyPolicies] = useState<Record<string, boolean>>({})
  // Live rail tracker: usage + the cap actually enforced, re-polled so a
  // background fill, a purge, or a cap change in Settings shows through.
  const [vaultSpace, setVaultSpace] = useState<{ measuredBytes: number; cap: number | null } | null>(null)
  // The mounted viewer's lease on open results: an offline lease's object
  // URLs must not be revoked while the Viewer reads them, and an online
  // encrypted resolver must outlive the background cache fill.
  const openLeaseRef = useRef<{ dispose?(): void; cacheFill?: Promise<unknown> } | null>(null)
  const vaultOpenAbortRef = useRef<AbortController | null>(null)
  const [plate, setPlate] = useState<AdFrame | null>(null)
  const [accountAd, setAccountAd] = useState<AdFrame | null>(null)
  const [adsShow, setAdsShow] = useState(true)
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
  // The card menu's own confirmations and sub-surfaces — the web keeps
  // the same range: pin, share, settings, reorder, source, rescan, remove.
  const [menuRemove, setMenuRemove] = useState(false)
  const [shareGallery, setShareGallery] = useState<GallerySummary | null>(null)
  const [galSettingsSlug, setGalSettingsSlug] = useState<string | null>(null)
  /** Full-link fragments for encrypted galleries this device can share —
   *  keyed by gallery id, same contract as the web's galleryHashes. */
  const [galleryHashes, setGalleryHashes] = useState<Record<string, string>>({})
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage))
  // Signed-in gear opens the shared WebSettings — the same groups and
  // options the web dashboard shows, fed by bearer-token API calls.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ownerSlugDraft, setOwnerSlugDraft] = useState('')
  const [settingsNote, setSettingsNote] = useState<string | null>(null)
  const [identities, setIdentities] = useState<AccountIdentityWeb[] | null>(null)
  const [identityNote, setIdentityNote] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteNote, setDeleteNote] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const dimsRef = useRef<DimsMap>(new Map())
  // The deep-link sign-in callback is installed once at launch — a ref is
  // the only way it can sync the catalogue as it is THEN, not as it was.
  const catalogueRef = useRef<LocalCatalogue | null>(null)
  const sessionRef = useRef<DesktopSession | null>(null)
  useEffect(() => {
    catalogueRef.current = catalogue
  }, [catalogue])
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  // Toasts are transient like the web dashboard's — five seconds, then
  // gone. The derived account/slug warnings are not timed: they stay up
  // until the underlying failure clears on the next refresh.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])
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
  // The rail carries the same sponsored slot the web Library does. Seeded
  // client-side so a midnight straddle cannot hydrate the wrong frame; a
  // failed fetch still means show (suppression is a courtesy, not a gate).
  useEffect(() => {
    let live = true
    setAccountAd(houseAdFrameFor('library'))
    void fetch(`${base}/api/ads/visibility`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (live) setAdsShow(payload !== null ? (payload as { show?: boolean }).show !== false : true)
      })
      .catch(() => { if (live) setAdsShow(true) })
    return () => { live = false }
  }, [base])
  // Opening a gallery seeds its own creative up front — otherwise the
  // freshly mounted Viewer keeps wearing the previous gallery's plate for
  // the round-trip until the visibility fetch above answers.
  // Local galleries are a Visionary feature: the session's last-known tier
  // gates the section, the add flow, and every mount path below. The account
  // read refreshes it on each sync tick, so a downgrade takes effect live.
  const accountTier = session?.tier ?? 'free'

  // A test run asks for a folder to be added. The add waits for the
  // session, because local galleries are a Visionary feature and the tier
  // is what says so — an add that ran before the session loaded would be
  // refused as a free account.
  useEffect(() => {
    if (!catalogue || accountTier !== 'pro') return
    const asked = (window as unknown as { __manoramaSeedRequested?: boolean }).__manoramaSeedRequested
    if (!asked) return
    ;(window as unknown as { __manoramaSeedRequested?: boolean }).__manoramaSeedRequested = false
    void addFolder()
  }, [catalogue, accountTier, session])

  // The vault's persisted preferences and saved index load once; the cap
  // re-applies on every tier change because Free and Visionary resolve
  // different ceilings for the same stored preference.
  useEffect(() => {
    void loadVaultLoadPolicy(desktopVaultPersistence).then(setVaultLoadPolicy).catch(() => {})
    void loadGalleryStreamOnly(desktopVaultPersistence).then(setStreamOnlyPolicies).catch(() => {})
    void desktopOfflineStore.listGalleries().then(setSavedGalleries).catch(() => {})
  }, [])
  useEffect(() => {
    void loadVaultCapPreference(desktopVaultPersistence)
      .then((preference) => applyVaultCap(desktopVault, accountTier, preference))
      .catch(() => {})
  }, [accountTier])
  // The rail tracker re-reads the vault on a short beat: a background fill
  // grows usage between renders and Settings can change the cap at any time,
  // so no state transition is a reliable refresh point. Each beat re-applies
  // the resolved cap first, so the figure shown is the cap actually enforced.
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      void loadVaultCapPreference(desktopVaultPersistence)
        .then(async (preference) => {
          applyVaultCap(desktopVault, accountTier, preference)
          const usage = await desktopVault.usage()
          if (!cancelled) setVaultSpace({ measuredBytes: usage.measuredBytes, cap: desktopVault.cap })
        })
        .catch(() => {})
    }
    tick()
    const timer = window.setInterval(tick, 2500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [accountTier, savedGalleries])
  // The settings sheet's own vault card writes the same persistence this
  // state reads — closing it is the moment to re-pull policy and saved list.
  useEffect(() => {
    if (settingsOpen) return
    void loadVaultLoadPolicy(desktopVaultPersistence).then(setVaultLoadPolicy).catch(() => {})
    void refreshSavedGalleries()
  }, [settingsOpen])
  const openViewer = (galleryId: string, index: number, edit = false) => {
    setPlate(houseAdFrameFor(galleryId))
    setViewerState({ galleryId, index, edit })
  }
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
      // Free accounts hold their catalogue locally and nothing else — the
      // server refuses the rows anyway, so the sync is skipped outright.
      if (!active || active.tier !== 'pro') return
      // An emptied catalogue has nothing to publish — reset rather than
      // leave a prior outcome ("Up to date") showing for zero galleries.
      if (!cat.galleries.length) { setSyncState('idle'); return }
      setSyncState('syncing')
      try {
        const result = await syncDeviceGalleries(base, active.token, cat)
        // The sync belongs to the account that started it — signing out or
        // into another account must not inherit its outcome.
        if (sessionRef.current?.token !== active.token) return
        setSyncState(result.failed === 0 ? 'synced' : result.synced === 0 ? 'failed' : 'partial')
      } catch {
        if (sessionRef.current?.token !== active.token) return
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
      const deviceLabel = await resolveDeviceLabel()
      let next: LocalCatalogue
      try {
        next = deserializeLocalCatalogue(await readCatalogueFile()) ?? newCatalogue(crypto.randomUUID(), deviceLabel)
      } catch {
        next = newCatalogue(crypto.randomUUID(), deviceLabel)
      }
      // A catalogue written before labels were resolved still says the
      // generic "This Mac" — heal it once; an owner-set name is never
      // overwritten.
      if (next.deviceLabel === FALLBACK_DEVICE_LABEL && deviceLabel !== FALLBACK_DEVICE_LABEL) {
        next = { ...next, deviceLabel }
      }
      await registerSavedGalleryRoots().catch(() => {})
      const avail = await probeAllAvailability(next.galleries, pathExists)
      // One-time dims backfill: catalogues scanned before the shell reported
      // image dims carry nothing but the 1200×800 render guess, and the
      // picker's matrix cells mis-size off it. Fill only what each record
      // already references — membership changes stay a manual rescan.
      for (const record of next.galleries) {
        if (avail[record.id] !== 'available') continue
        if (!record.items.some((item) => !(item.width && item.height))) continue
        try {
          const scan = await scanLocalDirectory(record.rootPath, readDirEntries)
          const fresh = new Map(scan.items.map((item) => [item.id, item]))
          next = {
            ...next,
            galleries: next.galleries.map((g) =>
              g.id === record.id
                ? {
                    ...g,
                    items: g.items.map((item) => {
                      const seen = fresh.get(item.id)
                      return seen?.width && seen.height && !(item.width && item.height)
                        ? { ...item, width: seen.width, height: seen.height }
                        : item
                    }),
                  }
                : g
            ),
          }
        } catch {
          // Keep the record — a manual rescan remains the repair path.
        }
      }
      if (!active) return
      setCatalogue(next)
      setAvailability(avail)
      await writeCatalogueFile(serializeLocalCatalogue(next)).catch(() => {})
      // Pin the ref before the sync starts — its result lands only while
      // the same account holds the session.
      if (storedSession) { sessionRef.current = storedSession; void runSync(next, storedSession) }
      cleanup = await installDesktopAuth(
        base,
        (signedIn) => {
          setSession(signedIn)
          setAuthError(null)
          void runSync(catalogueRef.current ?? next, signedIn)
        },
        setAuthError,
        // Everything else on our scheme is either an upload-provider OAuth
        // redirect or a Connect flow's ?linked= result — the first settles
        // the pending connect, the second refreshes Settings' method list.
        (url) => {
          if (handleProviderDeepLink(url)) return
          const result = linkResultFromDeepLink(url)
          if (!result) return
          if (result.kind === 'conflict') {
            setNotice('That sign-in method is already connected to another account.')
            return
          }
          const name = SIGN_IN_PROVIDERS.find((p) => p.id === result.provider)?.name ?? result.provider
          setNotice(`${name} connected.`)
          const active = sessionRef.current
          if (active) void fetchAccountIdentities(base, active.token).then(setIdentities).catch(() => {})
        },
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
    void fetchAccountProfile(base, session.token, fetch, controller.signal).then(
      (account) => {
        if (!alive()) return
        setOwnerSlug(account.ownerSlug)
        setSlugFailed(false)
        // A downgrade observed here demotes the session immediately — the
        // Local galleries gate reads session.tier, and persisting keeps the
        // next launch honest too. An upgrade restores the sync the gate
        // suspended — push the catalogue now rather than waiting for the
        // next sign-in or launch.
        if (account.tier && account.tier !== session.tier) {
          const refreshed = { ...session, tier: account.tier }
          setSession(refreshed)
          void storeSession(refreshed).catch(() => {})
          if (account.tier === 'pro' && catalogueRef.current) void runSync(catalogueRef.current, refreshed)
        }
      },
      () => { if (alive()) setSlugFailed(true) },
    )
    return () => controller.abort()
  }, [base, session, syncState, runSync])

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
  // Add-a-gallery state: the chooser sits in front of two paths — a folder
  // on this Mac (the existing local flow) or a shared cloud link, which
  // follows the web dashboard's verify-then-create contract exactly.
  const [addChooserOpen, setAddChooserOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [addName, setAddName] = useState('')
  const [addCaption, setAddCaption] = useState('')
  const [addChecking, setAddChecking] = useState(false)
  const [addVerifiedTitle, setAddVerifiedTitle] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const addVerifySeq = useRef(0)
  const addVerifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addEncryptedSession = useRef<EncryptedClientSession | null>(null)

  const addFolder = async () => {
    setNotice(null)
    if (accountTier !== 'pro') {
      setNotice('Local galleries are included with Visionary')
      return
    }
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

  // The verification contract is the web dashboard's: a plausible URL earns a
  // debounced check, a committed edit checks immediately, and the optional
  // name/caption fields only appear after the link scans clean.
  const resetAddVerification = () => {
    if (addVerifyTimer.current) {
      clearTimeout(addVerifyTimer.current)
      addVerifyTimer.current = null
    }
    addVerifySeq.current += 1
    addEncryptedSession.current?.dispose()
    addEncryptedSession.current = null
    setAddVerifiedTitle(null)
    setAddChecking(false)
  }

  const verifyAddUrl = async (url: string) => {
    if (!session) return
    const seq = ++addVerifySeq.current
    setAddChecking(true)
    try {
      if (isEncryptedSourceUrl(url)) {
        const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
        const encrypted = await openEncryptedSource(url)
        const { title } = await encrypted.listing
        if (seq !== addVerifySeq.current) { encrypted.dispose(); return }
        addEncryptedSession.current?.dispose()
        addEncryptedSession.current = encrypted
        setAddError(null)
        setAddVerifiedTitle(title)
        setAddName((current) => (current.trim() ? current : title))
        return
      }
      const result = await scanGalleryLink(base, session.token, url)
      if (seq !== addVerifySeq.current) return
      if (result.status < 200 || result.status >= 300 || !result.scan) {
        setAddVerifiedTitle(null)
        setAddError(result.error || 'That link could not be read')
        return
      }
      setAddError(null)
      const title = result.scan.title ?? ''
      setAddVerifiedTitle(title)
      // The scanned name pre-fills only an untouched field — a name typed
      // while the scan was in flight is never clobbered.
      setAddName((current) => (current.trim() ? current : title))
    } catch (error) {
      if (seq === addVerifySeq.current) setAddError(friendlySourceError(error))
    } finally {
      if (seq === addVerifySeq.current) setAddChecking(false)
    }
  }

  const onAddUrlChange = (value: string) => {
    setAddUrl(value)
    setAddError(null)
    resetAddVerification()
    const url = value.trim()
    if (/^https?:\/\/\S+\.\S+/.test(url)) {
      addVerifyTimer.current = setTimeout(() => void verifyAddUrl(url), 700)
    }
  }

  const onAddUrlCommit = (value: string) => {
    setAddUrl(value)
    setAddError(null)
    resetAddVerification()
    const url = value.trim()
    if (/^https?:\/\/\S+\.\S+/.test(url)) void verifyAddUrl(url)
  }

  const closeAddSheet = () => {
    setAddOpen(false)
    setAddUrl('')
    setAddName('')
    setAddCaption('')
    setAddError(null)
    resetAddVerification()
  }

  const refreshAccountGalleries = async (token: string) => {
    const galleries = await fetchAccountGalleries(base, token).catch(() => null)
    if (galleries) setAccountGalleries(galleries)
  }

  // Encrypted cards only produce a full link — the shareable form with the
  // fragment key — when this device holds it in custody. The map mirrors
  // the web dashboard's galleryHashes; a card without a hash shares its
  // keyless address and the sheet says so instead of pretending.
  useEffect(() => {
    let live = true
    for (const gallery of accountGalleries ?? []) {
      if (gallery.manifestVersion !== 2 || !gallery.id || !gallery.sourceUrl || !isEncryptedSourceUrl(gallery.sourceUrl)) continue
      void desktopKeyStore().get(gallery.id).then((source) => {
        if (!live || !gallery.id) return
        // A resolved check marks the gallery either way: keyed cards earn
        // their full link hash, keyless ones settle as locked rather than
        // staying an unexplained blank cover.
        setKeyChecked((previous) => previous.has(gallery.id!) ? previous : new Set(previous).add(gallery.id!))
        if (!source) return
        const hash = galleryHashForSource(source, gallery.id)
        setGalleryHashes((previous) => previous[gallery.id!] === hash ? previous : { ...previous, [gallery.id!]: hash })
      })
    }
    return () => { live = false }
  }, [accountGalleries])

  // The card menu's account actions — the same calls the web dashboard
  // issues, against manorama.xyz with the desktop session's bearer. Every
  // mutation refetches the summaries so strip/compact and pin flags move
  // together rather than drifting.
  const togglePin = async (gallery: GallerySummary) => {
    if (!session) return
    const pinning = !gallery.pinnedAt
    setCardMenu(null)
    setMenuRemove(false)
    setBusy(true)
    try {
      await setAccountGalleryPin(base, session.token, gallery.slug, pinning)
      await refreshAccountGalleries(session.token)
      setNotice(pinning ? `“${gallery.title || gallery.slug}” pinned` : `“${gallery.title || gallery.slug}” unpinned`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That gallery could not be pinned')
    } finally {
      setBusy(false)
    }
  }

  // The local pin — same display contract as the account pin (the card moves
  // between "Pinned galleries" and the compact grid) but persisted into
  // catalogue.json, not the API: a local record has no server row to PATCH.
  const toggleLocalPin = async (record: LocalGalleryRecord) => {
    if (!catalogue) return
    const pinning = !record.pinnedAt
    setCardMenu(null)
    setMenuRemove(false)
    setBusy(true)
    const next: LocalCatalogue = {
      ...catalogue,
      galleries: catalogue.galleries.map((gallery) =>
        gallery.id === record.id ? { ...gallery, pinnedAt: pinning ? new Date().toISOString() : null } : gallery
      ),
    }
    try {
      await writeCatalogueFile(serializeLocalCatalogue(next))
      setCatalogue(next)
      setNotice(pinning ? `“${record.title}” pinned` : `“${record.title}” unpinned`)
    } catch {
      setNotice('That gallery could not be pinned')
    } finally {
      setBusy(false)
    }
  }

  const refreshGallery = async (gallery: GallerySummary) => {
    if (!session || !gallery.sourceUrl) return
    setCardMenu(null)
    setMenuRemove(false)
    setBusy(true)
    setNotice(`Refreshing “${gallery.title || gallery.slug}”…`)
    try {
      const init = await refreshRequestInit({ id: gallery.id, sourceUrl: gallery.sourceUrl, keyStore: desktopKeyStore() })
      await refreshAccountGallery(base, session.token, gallery.slug, init)
      await refreshAccountGalleries(session.token)
      setNotice(`“${gallery.title || gallery.slug}” refreshed`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That gallery could not be refreshed')
    } finally {
      setBusy(false)
    }
  }

  const removeGalleryConfirmed = async (gallery: GallerySummary) => {
    if (!session) return
    setBusy(true)
    try {
      await deleteAccountGallery(base, session.token, gallery.slug)
      // The D1 row is gone; this device's copy of the key goes with it —
      // the provider's originals are never touched (invariant 9).
      if (gallery.id) await desktopKeyStore().remove(gallery.id).catch(() => {})
      setCardMenu(null)
      setMenuRemove(false)
      await refreshAccountGalleries(session.token)
      setNotice('Gallery removed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That gallery could not be removed')
    } finally {
      setBusy(false)
    }
  }

  const removeDeviceGalleryConfirmed = async (gallery: DeviceGallery) => {
    if (!session) return
    setBusy(true)
    try {
      await deleteDeviceGalleryRecord(base, session.token, gallery.id)
      setDeviceRows((current) => current.filter((row) => row.id !== gallery.id))
      setCardMenu(null)
      setMenuRemove(false)
      setNotice('Gallery removed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That gallery could not be removed')
    } finally {
      setBusy(false)
    }
  }

  // "Open source" resolves the full provider link for encrypted galleries —
  // the stored sourceUrl is keyless; this device's custody holds the key.
  const openSourceResolved = async (gallery: GallerySummary) => {
    if (!gallery.sourceUrl) return
    if (gallery.manifestVersion !== 2 || !gallery.id || !isEncryptedSourceUrl(gallery.sourceUrl)) return
    const source = await desktopKeyStore().get(gallery.id).catch(() => null)
    if (source) openExternal(source)
  }

  const addGallerySubmit = async (input: { url: string; name: string; caption: string }) => {
    const url = input.url.trim()
    if (!url || !session) return
    setAddError(null)
    setBusy(true)
    try {
      let body: Record<string, unknown> = {
        url,
        ...(input.name ? { title: input.name } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      }
      if (isEncryptedSourceUrl(url)) {
        const encrypted =
          addEncryptedSession.current ??
          (await (await import('../../app/lib/encrypted-client')).openEncryptedSource(url))
        addEncryptedSession.current = encrypted
        const listing = await encrypted.listing
        body = {
          manifest: {
            provider: encrypted.provider,
            sourceUrl: encrypted.sourceUrl,
            ...listing,
          },
          ...(input.name ? { title: input.name } : {}),
          ...(input.caption ? { caption: input.caption } : {}),
        }
      }
      const result = await createAccountGallery(base, session.token, body)
      // The pasted link's fragment is the gallery key — it never reached
      // the server (the manifest above carries the keyless source). Keep it
      // in this device's custody so the new card opens in-app rather than
      // on a locked web page.
      if (isEncryptedSourceUrl(url) && result.gallery?.id) {
        await desktopKeyStore().put(result.gallery.id, url).catch(() => {})
      }
      if (result.status === 409 && result.gallery) {
        await refreshAccountGalleries(session.token)
        closeAddSheet()
        scrollToGalleryCard(result.gallery.slug)
        setNotice(result.error || 'That link is already one of your galleries.')
        return
      }
      if (result.status < 200 || result.status >= 300 || !result.gallery) {
        setAddError(result.error || 'That gallery could not be added')
        return
      }
      await refreshAccountGalleries(session.token)
      closeAddSheet()
      scrollToGalleryCard(result.gallery.slug)
      setNotice(`${result.gallery.title ?? 'Gallery'} added.`)
    } catch (error) {
      setAddError(friendlySourceError(error))
    } finally {
      setBusy(false)
    }
  }

  const rescan = async (record: LocalGalleryRecord) => {
    if (!catalogue) return
    setNotice(`Refreshing “${record.title}”…`)
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
        // The persisted order is user data — the scan folds into it:
        // arranged items hold position, new files append in scan order.
        items: mergeRescannedItems(scan.items, record.items),
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
    setNotice(updated.items.length ? `“${record.title}” refreshed` : 'That source has no photos Manorama can display')
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

  const openShareForGallery = (id: string) => {
    setShareGalleryId(id)
    setShareStep('choose')
    setShareUploading(false)
    setShareOpen(true)
    shareStepRef.current = 'choose'
    shareUploadingRef.current = false
  }

  const openShareFromDetails = () => {
    if (!detailsId) return
    openShareForGallery(detailsId)
  }

  /** The card menu's "Open folder" — reveals the gallery's root in Finder
      through the grant-scoped bridge command. */
  const revealFolder = async (record: LocalGalleryRecord) => {
    setCardMenu(null)
    setMenuRemove(false)
    try {
      await revealGalleryRoot(record.rootPath)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That folder could not be opened')
    }
  }

  /** The card menu's "Share link" for an already-published local — the
      same share-or-copy contract the details sheet's link row keeps. */
  const shareLocalLink = async (record: LocalGalleryRecord, url: string) => {
    setCardMenu(null)
    setMenuRemove(false)
    setBusy(true)
    try {
      const shared = await shareGalleryOnWeb({ title: record.title, caption: '', url })
      if (shared === 'shared') setNotice('Link shared')
      else if (shared !== 'cancelled') {
        setNotice((await copyText(url)) ? 'Link copied — paste it anywhere' : url)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleShareStep = (step: ShareStep) => {
    // The link is already written server-side when the flow reaches done.
    // Routing the refresh through the normal sync keeps the session-change
    // guard of the account fetch (its abort drops stale results after a
    // sign-out or account switch) while an open Details gets Share link —
    // not a second publish — and the card collapses into its cloud gallery.
    // shareStepRef guards refires of onStepChange.
    const published = step === 'done' && shareStepRef.current !== 'done'
    setShareStep(step)
    setShareUploading(step === 'uploading')
    shareStepRef.current = step
    shareUploadingRef.current = step === 'uploading'
    if (published && session && catalogue) void runSync(catalogue, session)
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
    // Sign-out releases leases and stops fills, but the vault itself stays:
    // custody is the device's Keychain, not the account — same as iOS,
    // where only "Forget everything" destroys saved copies.
    vaultOpenAbortRef.current?.abort()
    disposeOpenLease()
    setSession(null)
    setSyncState('idle')
  }

  const openSettings = () => {
    if (!session) return
    setOwnerSlugDraft(ownerSlug ?? session.ownerSlug)
    setSettingsNote(null)
    setIdentityNote(null)
    setDeleteOpen(false)
    setDeleteConfirm('')
    setSettingsOpen(true)
  }

  // The sign-in methods load with the surface, like the web — a failed
  // read just leaves the list hidden.
  useEffect(() => {
    if (!settingsOpen || !session) { setIdentities(null); return }
    let live = true
    void fetchAccountIdentities(base, session.token)
      .then((list) => { if (live) setIdentities(list) })
      .catch(() => { if (live) setIdentities([]) })
    return () => { live = false }
  }, [settingsOpen, session, base])

  // Every anchor inside Settings opens in the system browser — the webview
  // itself never navigates away from the app. Relative hrefs resolve
  // against the API origin (privacy page, auth link flows). A Connect row
  // is the exception: the browser holds no manorama cookie, so it opens
  // `?link={handoff}&native=desktop` — the one-minute handoff binds the
  // flow to this account, and the ?linked= result lands back on our
  // scheme rather than the iOS one.
  const interceptSettingsLink = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    const href = anchor?.getAttribute('href') ?? ''
    if (!href) return
    event.preventDefault()
    const connect = /^\/auth\/([a-z]+)\?link=1$/.exec(href)
    if (connect && session) {
      void mintLinkHandoff(base, session.token)
        .then((linkToken) => openExternal(`${base}/auth/${connect[1]}?link=${encodeURIComponent(linkToken)}&native=desktop`))
        .catch(() => setIdentityNote('That sign-in method could not be connected.'))
      return
    }
    openExternal(/^(https?:|mailto:|sms:)/.test(href) ? href : `${base}${href}`)
  }

  const saveOwnerSlug = async () => {
    if (!session) return
    const value = ownerSlugDraft.trim().toLowerCase()
    if (value.length < 3 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      setSettingsNote('Use at least 3 lowercase letters, numbers, and single hyphens')
      return
    }
    if (value === (ownerSlug ?? session.ownerSlug)) return
    setBusy(true)
    setSettingsNote(null)
    try {
      const payload = await patchAccountOwnerSlug(base, session.token, value)
      setOwnerSlug(payload.ownerSlug)
      // The persisted session keeps the sign-in-time slug — every account
      // call already prefers the live ownerSlug state, and the next launch
      // re-resolves it anyway.
      setNotice(`Your address is now manorama.xyz/${payload.ownerSlug}`)
    } catch (error) {
      setSettingsNote(error instanceof Error ? error.message : 'That URL could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const unlinkIdentity = async (provider: AuthProvider) => {
    if (!session) return
    const result = await unlinkAccountIdentity(base, session.token, provider).catch(() => ({ status: 0, error: undefined as string | undefined }))
    if (result.status < 200 || result.status >= 300) {
      setIdentityNote(result.error === 'last-identity' ? 'Keep at least one way to sign in.' : 'That sign-in method could not be removed.')
      return
    }
    setIdentityNote(null)
    setIdentities(await fetchAccountIdentities(base, session.token).catch(() => identities))
  }

  const removeAccount = async () => {
    if (!session) return
    setDeleteNote(null)
    setDeleteBusy(true)
    try {
      const result = await deleteAccount(base, session.token, deleteConfirm.trim())
      if (result.status < 200 || result.status >= 300) throw new Error(result.error || 'Your account could not be deleted right now')
      // The account is gone — the local session is dead weight.
      signOut()
    } catch (error) {
      setDeleteNote(error instanceof Error ? error.message : 'Your account could not be deleted right now')
      setDeleteBusy(false)
    }
  }

  const recordDims = (itemId: string, w: number, h: number) => {
    if (w > 0 && h > 0) dimsRef.current.set(itemId, { w, h })
  }

  // A fetched cloud manifest rides the same Viewer as local records — the
  // app hosts the viewing it advertises rather than handing it to a browser.
  const accountGalleryUrl = (gallery: GallerySummary) => `${base}/${ownerSlug ?? session?.ownerSlug ?? ''}/${gallery.slug}`

  /** A cloud gallery opens in the app's own Viewer — the viewing experience
   *  is the product, not a browser tab. The network-first store decides the
   *  source: a complete vault copy opens offline, otherwise the online
   *  manifest mounts while the encrypted fill runs underneath it, per the
   *  owner's load policy and the gallery's stream-only override. Encrypted
   *  sources open sessions with this device's custody — a desktop-held key
   *  yields a resolver for the plain Viewer, while a missing key still
   *  mounts the shared EncryptedGallery island and its honest unlock form.
   *  Declared above the early return: the mounted viewer's continuations
   *  call this, and a binding declared below it never initializes on a
   *  viewer render. */
  const openAccountGallery = async (gallery: GallerySummary, index: number, edit = false, photoId?: string) => {
    const url = accountGalleryUrl(gallery)
    if (!session) {
      openExternal(url)
      return
    }
    const owner = ownerSlug ?? session.ownerSlug
    // A second open supersedes the first: aborting the earlier fill stops
    // new writes, and its lease is released before the next one mounts.
    vaultOpenAbortRef.current?.abort()
    const abort = new AbortController()
    vaultOpenAbortRef.current = abort
    const streamOnly = streamOnlyPolicies[galleryPolicyKey(owner, gallery.slug)] === true
    try {
      // A complete saved copy is the point of saving it: open straight
      // from the vault — no manifest fetch, no background fill, zero
      // bytes over the wire. `open` verifies completeness itself, so a
      // stale badge falls through to the online path rather than error.
      if (savedGalleryFor(gallery)) {
        const lease = await desktopOfflineStore.open({
          owner, slug: gallery.slug, galleryId: gallery.id, sourceUrl: gallery.sourceUrl ?? undefined,
        })
        if (lease) {
          if (abort.signal.aborted) { lease.dispose?.(); return }
          disposeOpenLease()
          openLeaseRef.current = lease
          setNotice('Opened from your encrypted vault — no network used.')
          setAccountViewer({
            manifest: lease.manifest,
            settings: lease.settings,
            index: photoId ? Math.max(0, lease.manifest.images.findIndex((image) => image.id === photoId)) : index,
            gallery,
            galleryId: gallery.id,
            edit,
          })
          return
        }
      }
      const result = await openGalleryNetworkFirst({
        selection: { owner, slug: gallery.slug, galleryId: gallery.id, sourceUrl: gallery.sourceUrl ?? undefined },
        fetchOnline: (signal) => fetchAccountGallery(base, owner, gallery.slug, session.token, fetch, signal),
        store: desktopOfflineStore,
        cachePolicy: streamOnly ? 'stream' : vaultLoadPolicy ?? 'vault',
        onProgress: (progress) => setNotice(`Saving ${progress.completed} of ${progress.total} photos to your encrypted vault…`),
        signal: abort.signal,
        openEncryptedSession: openDesktopEncryptedSession,
      })
      if (abort.signal.aborted) {
        result.dispose?.()
        return
      }
      disposeOpenLease()
      openLeaseRef.current = result
      const fill = result.cacheFill
      if (fill) {
        void fill.then((fillResult) => {
          if (abort.signal.aborted) return
          if (fillResult?.status === 'skipped-video') setNotice('This gallery includes video — offline saving is not supported for mixed galleries yet.')
          else if (fillResult?.status === 'over-cap') setNotice('This gallery is larger than the encrypted vault can hold — viewing stays online.')
          else if (fillResult?.status === 'complete') {
            setNotice('Offline copy saved in your encrypted vault.')
            void refreshSavedGalleries()
          }
        }).catch((error) => {
          const reason = error instanceof Error && error.message ? ` (${error.message})` : ''
          if (!abort.signal.aborted) setNotice(`Offline saving was interrupted${reason} — you can keep viewing online.`)
        })
      }
      if (result.source === 'offline') setNotice('Opened from your encrypted vault.')
      setAccountViewer({
        manifest: result.manifest,
        settings: result.settings,
        // A photoId resolves against the fresh manifest — it survives a
        // reorder where a saved index would land on the wrong frame.
        index: photoId ? Math.max(0, result.manifest.images.findIndex((image) => image.id === photoId)) : index,
        gallery,
        galleryId: gallery.id,
        edit,
        ...(result.encryptedResolver
          ? { encryptedResolver: result.encryptedResolver }
          : result.source === 'online' && gallery.sourceUrl && isEncryptedSourceUrl(gallery.sourceUrl)
            ? { encryptedSourceUrl: keylessSourceUrl(gallery.sourceUrl) }
            : {}),
      })
    } catch (error) {
      if (abort.signal.aborted) return
      if (error instanceof OfflineGalleryUnavailableError) {
        // Nothing saved on this Mac and the fetch failed — say why, then
        // hand the URL to the browser as the last resort it has always been.
        setNotice('This gallery is not saved on this Mac — connect to open it here.')
        openExternal(url)
        return
      }
      if (error instanceof EncryptedSourceLockedError || error instanceof EncryptedSourceMismatchError) {
        // The device holds no usable key — the island's unlock form opens
        // the gallery in place rather than a browser tab that misreports
        // the app as a stranger.
        try {
          const { manifest, settings } = await fetchAccountGallery(base, owner, gallery.slug, session.token)
          setAccountViewer({
            manifest,
            settings,
            index: photoId ? Math.max(0, manifest.images.findIndex((image) => image.id === photoId)) : index,
            gallery,
            galleryId: gallery.id,
            edit,
            encryptedSourceUrl: gallery.sourceUrl ? keylessSourceUrl(gallery.sourceUrl) : undefined,
          })
        } catch {
          openExternal(url)
        }
        return
      }
      openExternal(url)
    }
  }

  const refreshSavedGalleries = async () => {
    const [summaries, grid] = await Promise.all([
      desktopOfflineStore.listGalleries().catch(() => [] as OfflineGallerySummary[]),
      desktopOfflineStore.listGridGalleries().catch(() => [] as OfflineGridGallery[]),
    ])
    setSavedGalleries(summaries)
    setSavedGridGalleries(grid)
    const thumbs = new Map<string, string>()
    for (const saved of grid) {
      const frame = saved.frames.find((item) => !item.video) ?? saved.frames[0]
      if (!frame) continue
      const bytes = await desktopOfflineStore.readThumbnail(saved.galleryId, frame.entryId).catch(() => undefined)
      if (bytes) thumbs.set(saved.galleryId, URL.createObjectURL(new Blob([bytes.slice().buffer], { type: frame.mimeType })))
    }
    for (const url of savedThumbsRef.current.values()) URL.revokeObjectURL(url)
    savedThumbsRef.current = thumbs
    setSavedThumbs(thumbs)
  }

  /** The saved-copy record for a card, when a complete vault entry exists —
   *  partial or corrupt entries are not "saved" and never claim the badge. */
  const savedGalleryFor = (gallery: GallerySummary): OfflineGallerySummary | null => {
    const owner = ownerSlug ?? session?.ownerSlug
    if (!owner) return null
    return savedGalleries.find((saved) => saved.status === 'cached' && saved.owner === owner && saved.slug === gallery.slug) ?? null
  }

  /** A saved copy opens straight from the vault — no network, no account
   *  row required. The lease's materialized object URLs stay leased to the
   *  viewer until the next open or close releases them. */
  const openSavedGallery = async (saved: OfflineGridGallery) => {
    try {
      const lease = await desktopOfflineStore.open({ owner: saved.owner, slug: saved.slug, galleryId: saved.galleryId })
      if (!lease) throw new Error('missing lease')
      disposeOpenLease()
      openLeaseRef.current = lease
      setNotice('Opened from your encrypted vault.')
      setAccountViewer({ manifest: lease.manifest, settings: lease.settings, index: 0 })
    } catch {
      setNotice('That saved copy could not be opened — remove it from Settings')
    }
  }

  /** "Save to this Mac" — the card-menu twin of an open under the 'vault'
   *  load policy: downloads the gallery into the encrypted vault without
   *  mounting the Viewer. */
  const saveToVault = async (gallery: GallerySummary) => {
    if (!session) return
    const owner = ownerSlug ?? session.ownerSlug
    setNotice('Saving to your encrypted vault…')
    try {
      const fetched = await fetchAccountGallery(base, owner, gallery.slug, session.token)
      const result = await desktopOfflineStore.cache(
        { owner, slug: gallery.slug, galleryId: gallery.id, sourceUrl: gallery.sourceUrl ?? undefined },
        fetched,
        undefined,
        (progress) => setNotice(`Saving ${progress.completed} of ${progress.total} photos to your encrypted vault…`),
      )
      if (result.status === 'skipped-video') setNotice('This gallery includes video — offline saving is not supported for mixed galleries yet.')
      else if (result.status === 'skipped-encrypted') setNotice('This gallery cannot be saved on this Mac yet — its encrypted form predates the vault.')
      else if (result.status === 'over-cap') setNotice('This gallery is larger than the encrypted vault can hold — raise the limit in Settings.')
      else setNotice('Saved on this Mac — encrypted, viewable only in manorama.')
      await refreshSavedGalleries()
    } catch (error) {
      // The failure reason rides the toast — a vault failure needs its real
      // name (locked custody, too-large entry, transport) visible, not a shrug.
      const reason = error instanceof Error && error.message ? `: ${error.message}` : ''
      setNotice(`That gallery could not be saved on this Mac${reason}`)
    }
  }

  /** Crypto-erasure on demand: the record and ciphertext go, and the key is
   *  destroyed — a removed copy cannot be resurrected from leftover bytes. */
  const removeSavedCopy = async (galleryId: string) => {
    try {
      await desktopOfflineStore.purgeGallery(galleryId)
      await refreshSavedGalleries()
      setNotice('Saved copy removed from this Mac')
    } catch {
      setNotice('The saved copy could not be removed')
    }
  }

  /** Releases the mounted viewer's open lease — offline object URLs are
   *  revoked and an online resolver's session disposed, so nothing holds
   *  decrypted references after the gallery closes or is replaced. A fill
   *  shares the resolver's session, so while one is in flight disposal
   *  waits for it to settle — killing the session mid-fill would read back
   *  as corrupted entries rather than a clean interrupt. */
  const disposeOpenLease = () => {
    const lease = openLeaseRef.current
    openLeaseRef.current = null
    if (!lease) return
    const fill = lease.cacheFill
    if (fill) void fill.catch(() => {}).finally(() => lease.dispose?.())
    else lease.dispose?.()
  }

  /** A stream-only flag belongs to this gallery on this Mac — it cancels
   *  future fills but never deletes a copy the owner already saved. */
  const setGalleryStreamOnly = async (gallery: GallerySummary, streamOnly: boolean) => {
    const owner = ownerSlug ?? session?.ownerSlug
    if (!owner) return
    const next = { ...streamOnlyPolicies, [galleryPolicyKey(owner, gallery.slug)]: streamOnly }
    setStreamOnlyPolicies(next)
    await saveGalleryStreamOnly(next, desktopVaultPersistence).catch(() => {})
  }

  if (accountViewer) {
    const summary = accountViewer.gallery
    const viewerProps = {
      slug: accountViewer.manifest.slug,
      galleryTitle: accountViewer.manifest.title,
      images: accountViewer.manifest.images,
      settings: accountViewer.settings,
      plate,
      initialIndex: accountViewer.index,
      navigationRef,
      onPositionChange: (position: { index: number }) => {
        shellPost({ type: 'position', index: position.index, total: accountViewer.manifest.images.length })
      },
      apiBase: base,
      authToken: session?.token,
      initialEdit: accountViewer.edit ?? false,
      allowFullscreen: false,
      onReturnToGalleries: () => { disposeOpenLease(); setAccountViewer(null) },
      // The owner context the web route fills — the picker's Reorder
      // switch and the Settings popover's management panel both gate on
      // it. The panel's API calls need the shell's base + bearer, and its
      // continuations land here because location navigation is impossible.
      viewerRole: 'owner' as const,
      galleryOwner: ownerSlug ?? session?.ownerSlug,
      keyStore: desktopKeyStore(),
      ownerGallery: summary ? {
        title: summary.title,
        caption: summary.caption,
        sourceLabel: sourceLabelFor(summary.sourceUrl),
        sourceUrl: summary.sourceUrl,
        temporary: isLocked(summary),
        expiresAt: summary.expiresAt,
        mediaCount: summaryMediaCount(summary),
      } : undefined,
      shareHref: summary ? `${accountGalleryUrl(summary)}${summary.id ? galleryHashes[summary.id] ?? '' : ''}` : undefined,
      onEditSaved: (photoId: string | null) => {
        if (session) void refreshAccountGalleries(session.token)
        // Entered from the card menu, Save lands back on the Library like
        // the web's doneHref; entered from the picker it reopens at the
        // same photograph like the web's ?photo= reload.
        if (!summary || accountViewer.edit) { disposeOpenLease(); setAccountViewer(null); return }
        void openAccountGallery(summary, 0, false, photoId ?? undefined)
      },
      onGalleryRenamed: () => {
        disposeOpenLease()
        setAccountViewer(null)
        if (session) void refreshAccountGalleries(session.token)
      },
      onGalleryRefreshed: () => {
        if (session) void refreshAccountGalleries(session.token)
        if (summary) void openAccountGallery(summary, 0, false, accountViewer.manifest.images[accountViewer.index]?.id)
      },
      onGalleryRemoved: () => {
        if (summary?.id) void desktopKeyStore().remove(summary.id).catch(() => {})
        disposeOpenLease()
        setAccountViewer(null)
        if (session) void refreshAccountGalleries(session.token)
        setNotice('Gallery removed')
      },
    }
    return (
      <>
        <div class="desktop-titlebar" data-tauri-drag-region />
        <GalleryShell settings={accountViewer.settings}>
          {accountViewer.encryptedSourceUrl ? (
            // The same island the web route mounts: it resolves the key
            // from this device's custody, and when the device truly has
            // none it shows its own unlock form in place — never a
            // browser round-trip that misreports the app as a stranger.
            <EncryptedGallery
              key={`${accountViewer.manifest.slug}:${accountViewer.index}`}
              {...viewerProps}
              galleryId={accountViewer.galleryId ?? ''}
              sourceUrl={accountViewer.encryptedSourceUrl}
            />
          ) : (
            <Viewer
              key={`${accountViewer.manifest.slug}:${accountViewer.index}`}
              {...viewerProps}
              galleryId={accountViewer.galleryId}
              encryptedResolver={accountViewer.encryptedResolver}
            />
          )}
        </GalleryShell>
      </>
    )
  }

  // Full-screen viewing: the shared Viewer, fed by manifest items pointing
  // at convertFileSrc URLs. The viewer heals guessed dims to the real
  // natural size on load — nothing is upscaled or re-encoded.
  const viewableRecord = viewerState && catalogue && accountTier === 'pro'
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
      images: visibleItemsFor(record).map((item) => toGalleryMediaItem(withDims(item), assetUrl)),
    }
    const settings = defaultGallerySettings(manifest)
    // The picker's Edit mode for locals: same draft the API editor builds
    // (every item's orderKey, the hidden keys), persisted into the
    // catalogue instead of PATCHed to the Worker. orderKey is the item id —
    // the relative path, stable across rescans.
    const localEditStore = {
      load: async (): Promise<PickerEditItem[]> => {
        const hidden = new Set(record.hidden ?? [])
        return record.items.map((raw) => {
          const item = withDims(raw)
          return {
            id: item.id,
            orderKey: item.id,
            width: item.width && item.width > 0 ? item.width : 1200,
            height: item.height && item.height > 0 ? item.height : 800,
            src: assetUrl(item.path),
            preview: assetUrl(item.path),
            filename: item.name,
            label: item.name,
            hidden: hidden.has(item.id),
          }
        })
      },
      save: async (order: string[], hidden: string[]) => {
        if (!catalogue) throw new Error('The catalogue is not loaded')
        const byId = new Map(record.items.map((item) => [item.id, item]))
        const ordered = order.map((id) => byId.get(id)).filter((item): item is LocalGalleryItem => Boolean(item))
        const inOrder = new Set(order)
        const items = [...ordered, ...record.items.filter((item) => !inOrder.has(item.id))]
        const next: LocalCatalogue = {
          ...catalogue,
          galleries: catalogue.galleries.map((gallery) =>
            gallery.id === record.id ? { ...gallery, items, hidden: hidden.length ? hidden : undefined } : gallery
          ),
        }
        // Persist first, like rename/rescan — a failed private-store write
        // surfaces in the editor instead of pretending the order stuck.
        await writeCatalogueFile(serializeLocalCatalogue(next))
        setCatalogue(next)
      },
    }
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
            initialEdit={viewerState?.edit ?? false}
            editStore={localEditStore}
            allowFullscreen={false}
            navigationRef={navigationRef}
            onPositionChange={(position: { index: number }) => {
              shellPost({ type: 'position', index: position.index, total: manifest.images.length })
            }}
            onReturnToGalleries={() => setViewerState(null)}
            onEditSaved={(photoId: string | null) => {
              // Entered from the settings sheet — Save lands back on the
              // Library like the account flow's doneHref. Entered from the
              // picker it reopens at the saved photograph.
              if (viewerState?.edit) { setViewerState(null); return }
              const items = catalogue?.galleries.find((gallery) => gallery.id === record.id)
                ? visibleItemsFor(catalogue.galleries.find((gallery) => gallery.id === record.id)!)
                : []
              const index = photoId ? Math.max(0, items.findIndex((item) => item.id === photoId)) : 0
              setViewerState({ galleryId: record.id, index })
            }}
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
            <h1>Your shared folders, shown properly</h1>
            <p class="landing-brand-intro">Pick a folder on this Mac, or paste a shared Dropbox, Google Drive, iCloud or MEGA album link. manorama turns it into a quiet, full-screen gallery at your own address.</p>
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

  // The selected record's settings: a Sheet over the workbench — the same
  // presentation an account gallery's settings gets — with the shared
  // ShareFlow hosted alongside (Publish opens only from settings). The
  // viewer takes precedence when a photograph is open — Open leaves the
  // sheet first.
  const detailsRecord = detailsId && catalogue && accountTier === 'pro' ? catalogue.galleries.find((g) => g.id === detailsId) ?? null : null
  const shareRecord = shareGalleryId && catalogue ? catalogue.galleries.find((g) => g.id === shareGalleryId) ?? null : null
  // A published link exists only when this Mac's own synced row carries the
  // public slug; the local record id is the device-gallery row id.
  const publishedUrlFor = (record: LocalGalleryRecord | null): string | null => {
    if (!record) return null
    const slug = deviceRows.find((row) => row.id === record.id)?.publicGallerySlug
    const owner = ownerSlug ?? session?.ownerSlug
    return slug && owner ? `${base}/${owner}/${slug}` : null
  }
  const detailsPublishedUrl = publishedUrlFor(detailsRecord)
  const shareHost = shareOpen && shareRecord ? (
    <Sheet open={shareOpen} onClose={dismissShare} title={`Publish “${shareRecord.title}”`} dismissible={!shareUploading}>
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

  const galleries = catalogue.galleries
  // Dedupe at render so whichever feed lands last re-derives the list — a
  // device row published as a cloud gallery collapses the moment the account
  // read arrives, without waiting on the slower call.
  const remoteDeviceGalleries = standaloneDeviceGalleries(deviceRows, accountGalleries ?? [], catalogue.deviceId)
  // Partition the account galleries into pinned strips and compact cards,
  // mirroring the web Library's shared layout rule. Pinned rows lead by
  // pinnedAt; everything else collapses to a compact cover card.
  const liveAccountGalleries = accountGalleries ?? []
  // Locals join the same pinned/compact rule as account galleries — a pin
  // is a display choice on both kinds. Namespaced slugs keep the two
  // identity spaces distinct inside the shared layout.
  const accountLayout = libraryLayout(
    [
      ...liveAccountGalleries.map((gallery) => ({ slug: `account:${gallery.slug}`, pinnedAt: gallery.pinnedAt })),
      // Free sees no locals anywhere — an ungated pinned local would still
      // surface in "Pinned galleries" after a downgrade even though the
      // Local section is hidden (invariant 12).
      ...(accountTier === 'pro' ? galleries : []).map((record) => ({ slug: `local:${record.id}`, pinnedAt: record.pinnedAt })),
    ],
    accountTier,
  )
  const accountBySlug = new Map(liveAccountGalleries.map((gallery) => [`account:${gallery.slug}`, gallery]))
  const localByCardId = new Map(galleries.map((record) => [`local:${record.id}`, record]))
  const pinnedStrips = accountLayout.strips
    .map((key) => {
      const gallery = accountBySlug.get(key)
      if (gallery) return { kind: 'account' as const, gallery }
      const record = localByCardId.get(key)
      return record ? { kind: 'local' as const, record } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  const compactAccountGalleries = accountLayout.compact
    .map((key) => accountBySlug.get(key))
    .filter((gallery): gallery is GallerySummary => Boolean(gallery))
  const compactLocalGalleries = accountLayout.compact
    .map((key) => localByCardId.get(key))
    .filter((record): record is LocalGalleryRecord => Boolean(record))
  const galSettingsGallery = galSettingsSlug ? liveAccountGalleries.find((gallery) => gallery.slug === galSettingsSlug) ?? null : null

  // Saved copies are a device fact, not an account fact — a gallery whose
  // account row is gone (removed upstream, or the list never landed) still
  // owns its vault copy and still opens from it.
  const savedOnlyGalleries = savedGridGalleries.filter((saved) =>
    !(saved.owner === (ownerSlug ?? session?.ownerSlug) && (accountGalleries ?? []).some((gallery) => gallery.slug === saved.slug)))
  const accountNote = galleriesFailed || devicesFailed ? 'Your galleries could not be loaded — this Mac’s catalogue is unaffected.' : null
  const slugNote = slugFailed ? 'Gallery links may open at an older account address — the saved URL name could not be refreshed.' : null
  const retainedCount = (accountGalleries ?? []).filter((g) => g.retention !== 'pipeline').length
  const temporaryCount = (accountGalleries ?? []).filter((g) => g.retention === 'pipeline').length
  const retainedLimit = accountTier === 'pro' ? PAID_RETAINED_LIMIT : FREE_RETAINED_LIMIT

  const localStripCard = (record: LocalGalleryRecord) => {
    const state = availability[record.id] ?? 'available'
    const unavailable = state === 'unavailable'
    return <li key={`local-${record.id}`}><article class="lib-card" data-gallery-card={record.id} data-availability={state}>
      <div class="admin-gallery-strip-frame" onWheel={stripWheel}>
        <ul class="admin-gallery-strip" aria-label={`${record.title} photographs`}>
          {visibleItemsFor(record).map((item, index) => (
            <li class="admin-gallery-strip-item" key={item.id} data-image-id={item.id}>
              <button
                type="button"
                disabled={unavailable}
                aria-label={`Open ${item.name} — photograph ${index + 1} of ${visibleItemsFor(record).length} in ${record.title}`}
                onClick={() => openViewer(record.id, index)}
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
        <button
          type="button"
          class="lib-card-title"
          onClick={() => unavailable ? openDetails(record) : openViewer(record.id, 0)}
        >{record.title}{pinGlyph(record)}</button>
        <button type="button" class="lib-card-menu" aria-label={`${record.title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'local', record })}>···</button>
      </div>
      <p class="lib-card-sub">
        {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
      </p>
      {unavailable ? <p class="desktop-badge-unavailable">Unavailable — reconnect the source, then rescan.</p> : null}
    </article></li>
  }

  // The compact form a local gallery takes while unpinned — a cover card in
  // the Local section's grid, the same shape account galleries collapse to
  // in "Your galleries".
  const localCompactCard = (record: LocalGalleryRecord) => {
    const state = availability[record.id] ?? 'available'
    const unavailable = state === 'unavailable'
    const cover = visibleItemsFor(record)[0]
    return <li key={record.id} class="lib-compact-card" data-gallery-card={record.id} data-availability={state}>
      <a
        class="lib-compact-cover"
        href={`#local-${record.id}`}
        onClick={(event: MouseEvent) => { event.preventDefault(); if (!unavailable) openViewer(record.id, 0) }}
        draggable={false}
        aria-label={`${record.title} cover`}
        aria-disabled={unavailable ? true : undefined}
      >
        {cover ? (
          <img
            src={assetUrl(cover.path)}
            alt=""
            loading="lazy"
            draggable={false}
            onLoad={(event: Event) => {
              const img = event.currentTarget as HTMLImageElement
              img.classList.add('is-loaded')
              recordDims(cover.id, img.naturalWidth, img.naturalHeight)
              // A small original floats at its honest size rather than
              // upscaling to the card width — invariant 13.
              if (img.naturalWidth) img.style.maxWidth = `${img.naturalWidth}px`
            }}
          />
        ) : null}
      </a>
      <button type="button" class="lib-card-menu" aria-label={`${record.title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'local', record })}>···</button>
      <div class="lib-compact-body">
        <button
          type="button"
          class="lib-card-title"
          onClick={() => unavailable ? openDetails(record) : openViewer(record.id, 0)}
        >{record.title}{pinGlyph(record)}</button>
        <p class="lib-card-sub">
          {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
        </p>
        {unavailable ? <p class="desktop-badge-unavailable">Unavailable — reconnect the source, then rescan.</p> : null}
      </div>
    </li>
  }

  return (
    // `data-admin-ready` is the shell's own "catalogue restored" signal: the
    // island renders nothing above until the private files have been read, so
    // anything measuring the surface can wait for it instead of guessing.
    <main class="admin-page admin-page--selector desktop-catalogue" data-admin-ready="true">
      <div class="desktop-titlebar" data-tauri-drag-region />

      <div class="admin-content">
        {/* The same two-column anatomy as the web Library: the rail carries
            mark + build tag, the heading's actions (Add, Sync, Settings —
            the gear that opens the account drawer), the device line and
            copyright; the cards scroll beside it. */}
        {/* Anchors in the rail (the Free tier's upgrade mailto) open in the
            system browser — the same interception the Settings surface uses. */}
        <aside class="admin-rail" onClick={interceptSettingsLink}>
          <div class="admin-brand">
            <img class="admin-brand-mark" src="/manorama-merged-logo.png" alt="manorama" width="280" height="94" />
            <p class="admin-version">version {buildCommit}</p>
          </div>
          <div class="admin-library-heading">
            <h1 class="admin-galleries-heading" id="galleries-heading">Library</h1>
            <div class="admin-heading-actions">
              <button type="button" class="admin-button admin-button--solid admin-add-pill" onClick={() => setAddChooserOpen(true)} disabled={busy}><span aria-hidden="true">+</span> Add Gallery</button>
              <button
                type="button"
                class="admin-button admin-settings-pill"
                aria-label="Settings"
                onClick={openSettings}
              >
                <SettingsIcon />
              </button>
            </div>
          </div>
          {session ? (
            <p class="admin-library-sub">
              You are a manorama <strong>{accountTier === 'pro' ? 'Visionary' : 'Free User'}</strong> hosting{' '}
              <strong>{retainedCount}</strong> of {retainedLimit} permanent galleries
              {temporaryCount ? <> and <strong>{temporaryCount}</strong> temporary {temporaryCount === 1 ? 'gallery' : 'galleries'}</> : null}.
              {accountTier === 'free' ? <> <a class="admin-upgrade-link" href="mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade">Upgrade to Visionary?</a></> : null}
            </p>
          ) : null}
          {vaultSpace ? (() => {
            const figures = vaultSpace.cap === null
              ? `${formatBytes(vaultSpace.measuredBytes)} of Unlimited`
              : `${formatBytes(vaultSpace.measuredBytes)} of ${formatBytes(vaultSpace.cap)}`
            return (
              <div class="lib-vault-tracker">
                <p class="lib-vault-tracker-label">Vault on this Mac</p>
                <Meter
                  label={`Vault storage — ${figures}`}
                  value={vaultSpace.measuredBytes}
                  max={vaultSpace.cap ?? 0}
                  valueText={figures}
                />
                <p class="lib-vault-tracker-figures">{figures}</p>
              </div>
            )
          })() : null}
          {adsShow && accountAd ? (
            <aside class="account-ad" aria-label={`${accountAd.badge}: ${accountAd.advertiser}`}>
              <span class="account-ad-badge">{accountAd.badge}</span>
              <div class="account-ad-media">
                {accountAd.image ? (
                  accountAd.cta ? (
                    <a class="account-ad-media-link" href={accountAd.cta.url} target="_blank" rel="noopener" aria-label={accountAd.cta.label}>
                      <img src={accountAd.image.src} width={accountAd.image.width} height={accountAd.image.height} alt="" />
                    </a>
                  ) : (
                    <img src={accountAd.image.src} width={accountAd.image.width} height={accountAd.image.height} alt="" />
                  )
                ) : (
                  <span class="account-ad-placeholder">Vertical photograph, fit to height</span>
                )}
              </div>
              <div class="account-ad-copy">
                <strong class="account-ad-headline">{accountAd.headline ?? accountAd.advertiser}</strong>
                <span class="account-ad-sub">A placeholder until sponsored photographs arrive.</span>
                {accountAd.cta ? <a class="account-ad-cta" href={accountAd.cta.url} target="_blank" rel="noopener">{accountAd.cta.label}</a> : null}
              </div>
            </aside>
          ) : null}
          <p class="admin-copyright">© 2026 Mahesh Shantaram.<br />All platform rights reserved.</p>
        </aside>
        <section class="gallery-list" aria-labelledby="galleries-heading">
          {pinnedStrips.length ? (
            <section aria-labelledby="pinned-galleries-title">
              <h2 id="pinned-galleries-title" class="lib-section-title">Pinned galleries</h2>
              <ul class="lib-list">
                {pinnedStrips.map((entry) => {
                  if (entry.kind === 'local') return localStripCard(entry.record)
                  const gallery = entry.gallery
                  const title = gallery.title || gallery.slug
                  const galleryUrl = accountGalleryUrl(gallery)
                  const openCard = (index: number) => (event: MouseEvent) => {
                    event.preventDefault()
                    // A modified click explicitly asks for the browser;
                    // encrypted cards open in-app like every other source.
                    if (event.metaKey || event.ctrlKey) { openExternal(galleryUrl); return }
                    void openAccountGallery(gallery, index)
                  }
                  return <li key={`account-${gallery.slug}`} data-gallery-card={gallery.slug}><article class="lib-card" data-retention={gallery.retention}>
                    {gallery.images.length ? (
                      <div class="admin-gallery-strip-frame" aria-label={`${title} images`} onWheel={stripWheel}>
                        <ul class="admin-gallery-strip" aria-label={`${title} photographs`}>
                          {gallery.images.map((image, index) => (
                            <li class={`admin-gallery-strip-item${image.hidden ? ' is-hidden' : ''}`} key={image.id} data-image-id={image.id}>
                              <a
                                href={galleryUrl}
                                onClick={openCard(index)}
                                draggable={false}
                                aria-label={`${title}, ${image.hidden ? 'hidden ' : ''}${itemKind(image)} ${index + 1} of ${gallery.imageCount}`}
                              >
                                <HeicImg
                                  src={image.src || previewSrcFor(image)}
                                  preview={previewSrcFor(image)}
                                  media={image.media}
                                  previewMedia={image.variants?.[0]?.media}
                                  galleryId={gallery.id}
                                  filename={image.filename}
                                  alt=""
                                  loading="lazy"
                                  draggable={false}
                                  style={{ aspectRatio: `${Math.max(1, image.width)} / ${Math.max(1, image.height)}` }}
                                  onLoad={(event: Event) => {
                                    const img = event.currentTarget as HTMLImageElement
                                    // Stored dims are the placeholder's shape — the
                                    // decoded frame owns the real ratio once it lands.
                                    if (img.naturalWidth && img.naturalHeight) img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
                                    img.classList.add('is-loaded')
                                  }}
                                  onError={stripImgRetry}
                                />
                                {isVideoPreview(image) ? <span class="admin-strip-badge" aria-hidden="true">{videoBadge(image)}</span> : null}
                                {image.hidden
                                  ? <span class="admin-strip-badge admin-strip-badge--hidden" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="m4 4 16 16"/></svg></span>
                                  : null}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <div class="lib-card-head">
                      <a class="lib-card-title" href={galleryUrl} onClick={openCard(0)} draggable={false}>{title}{pinGlyph(gallery)}</a>
                      {isLocked(gallery) ? tempFlag(gallery) : null}
                      {savedGalleryFor(gallery) ? <span class="desktop-badge-saved">Saved on this Mac</span> : null}
                      <button type="button" class="lib-card-menu" aria-label={`${title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'account', gallery })}>···</button>
                    </div>
                    {gallery.id && keyChecked.has(gallery.id) && !galleryHashes[gallery.id] && gallery.manifestVersion === 2
                      ? <p class="desktop-badge-keyless">Locked — the key is not on this Mac</p>
                      : null}
                    <p class="lib-card-sub">
                      {cardCountSource(formatMediaCount(summaryMediaCount(gallery)), sourceLabelFor(gallery.sourceUrl))}
                      {tempWording(gallery)}
                    </p>
                    {gallery.caption?.trim() ? <p class="lib-card-caption">{gallery.caption}</p> : null}
                  </article></li>
                })}
              </ul>
            </section>
          ) : null}
          {accountTier === 'pro' && (remoteDeviceGalleries.length || compactLocalGalleries.length) ? (
            <section aria-labelledby="local-galleries-title">
              <h2 id="local-galleries-title" class="lib-section-title">Local galleries</h2>
              <p class="lib-section-sub">Folders on this Mac — the originals stay where they are, referenced in place.</p>
              {remoteDeviceGalleries.length ? (
                <ul class="lib-list">
                  {remoteDeviceGalleries.map((gallery) => (
                    <li key={`device-${gallery.id}`}><article class="lib-card" data-gallery-card={`device:${gallery.id}`}>
                      <div class="lib-card-head">
                        <span class="lib-card-title">{gallery.title}</span>
                        <button type="button" class="lib-card-menu" aria-label={`${gallery.title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'device', gallery })}>···</button>
                      </div>
                      <p class="lib-card-sub">
                        {gallery.itemCount} {gallery.itemCount === 1 ? 'photograph' : 'photographs'} · {gallery.deviceLabel} · synced — open it on that device
                      </p>
                    </article></li>
                  ))}
                </ul>
              ) : null}
              {compactLocalGalleries.length ? (
                <ul class="lib-compact-grid">
                  {compactLocalGalleries.map(localCompactCard)}
                </ul>
              ) : null}
            </section>
          ) : null}
          {compactAccountGalleries.length ? (
            <section aria-labelledby="lib-compact-title">
              <h2 id="lib-compact-title" class="lib-section-title lib-compact-title">Your galleries</h2>
              <ul class="lib-compact-grid">
                {compactAccountGalleries.map((gallery) => {
                  const title = gallery.title || gallery.slug
                  const galleryUrl = accountGalleryUrl(gallery)
                  const openCard = (event: MouseEvent) => {
                    event.preventDefault()
                    if (event.metaKey || event.ctrlKey) { openExternal(galleryUrl); return }
                    void openAccountGallery(gallery, 0)
                  }
                  // The cover is the first VISIBLE item — falling back to
                  // images[0] would leak a concealed photograph.
                  const cover = gallery.images.find((image) => !image.hidden)
                  return <li key={`account-${gallery.slug}`} class="lib-compact-card" data-gallery-card={gallery.slug} data-retention={gallery.retention}>
                    <a class="lib-compact-cover" href={galleryUrl} onClick={openCard} draggable={false} aria-label={`${title} cover`}>
                      {cover ? <HeicImg src={cover.src || previewSrcFor(cover)} preview={previewSrcFor(cover)} media={cover.media} previewMedia={cover.variants?.[0]?.media} galleryId={gallery.id} filename={cover.filename} alt="" loading="lazy" draggable={false} style={{ aspectRatio: `${Math.max(1, cover.width)} / ${Math.max(1, cover.height)}` }} onLoad={(event: Event) => {
                        const img = event.currentTarget as HTMLImageElement
                        img.classList.add('is-loaded')
                        // The card takes the thumbnail's own size — the image
                        // always fills it exactly, and a small rendition never
                        // stretches into mush. Stored dims are the placeholder's
                        // shape; the decoded frame owns the real ratio.
                        if (img.naturalWidth && img.naturalHeight) img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
                        const card = img.closest('.lib-compact-card') as HTMLElement | null
                        if (card && img.naturalWidth) card.style.maxWidth = `${img.naturalWidth}px`
                      }} onError={stripImgRetry} /> : null}
                    </a>
                    <button type="button" class="lib-card-menu lib-compact-menu" aria-label={`${title} actions`} aria-haspopup="dialog" onClick={() => setCardMenu({ kind: 'account', gallery })}>···</button>
                    <div class="lib-compact-body">
                      <a class="lib-card-title" href={galleryUrl} onClick={openCard} draggable={false}>{title}{pinGlyph(gallery)}</a>
                      {isLocked(gallery) ? tempFlag(gallery) : null}
                      {savedGalleryFor(gallery) ? <p class="desktop-badge-saved">Saved on this Mac</p> : null}
                      {gallery.id && keyChecked.has(gallery.id) && !galleryHashes[gallery.id] && gallery.manifestVersion === 2
                        ? <p class="desktop-badge-keyless">Locked — the key is not on this Mac</p>
                        : null}
                      <p class="lib-card-sub">
                        {cardCountSource(formatMediaCount(summaryMediaCount(gallery)), sourceLabelFor(gallery.sourceUrl))}
                        {tempWording(gallery)}
                      </p>
                    </div>
                  </li>
                })}
              </ul>
            </section>
          ) : null}
          {savedOnlyGalleries.length ? (
            <section aria-labelledby="lib-saved-title">
              <h2 id="lib-saved-title" class="lib-section-title lib-compact-title">Saved on this Mac</h2>
              <ul class="lib-compact-grid">
                {savedOnlyGalleries.map((saved) => (
                  <li key={`saved-${saved.galleryId}`} class="lib-compact-card" data-gallery-card={`saved:${saved.galleryId}`}>
                    <a
                      class="lib-compact-cover"
                      href={`#saved-${saved.slug}`}
                      onClick={(event) => { event.preventDefault(); void openSavedGallery(saved) }}
                      draggable={false}
                      aria-label={`${saved.title || saved.slug} cover`}
                    >
                      {savedThumbs.get(saved.galleryId)
                        ? <img src={savedThumbs.get(saved.galleryId)} alt="" loading="lazy" draggable={false} />
                        : null}
                    </a>
                    <div class="lib-compact-body">
                      <a
                        class="lib-card-title"
                        href={`#saved-${saved.slug}`}
                        onClick={(event) => { event.preventDefault(); void openSavedGallery(saved) }}
                        draggable={false}
                      >{saved.title || saved.slug}</a>
                      <p class="desktop-badge-saved">Saved on this Mac</p>
                      <p class="lib-card-sub">
                        {saved.frames.length} {saved.frames.length === 1 ? 'photograph' : 'photographs'}
                      </p>
                      <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => void removeSavedCopy(saved.galleryId)}>Remove saved copy</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {!galleries.length && !accountGalleries?.length && !remoteDeviceGalleries.length ? (
            <p class="desktop-empty">Choose a folder or a mounted memory card. Manorama references the originals in place — nothing is copied, uploaded, or moved.</p>
          ) : null}
        </section>
      </div>

      {/* "+ Add Gallery" is a fork, not a picker: a folder on this Mac goes
          through the local scan flow; a shared cloud link goes through the
          same sheet and verify-then-create contract as the web Library. */}
      <Sheet open={addChooserOpen} onClose={() => setAddChooserOpen(false)} title="Add a gallery">
        <ActionGroup note="Local folders stay on this Mac. Cloud links join your account galleries.">
          <ActionRow
            icon={<SourceIcon />}
            label="A folder on this Mac"
            value={accountTier === 'pro' ? undefined : 'Visionary'}
            onClick={() => { setAddChooserOpen(false); void addFolder() }}
            disabled={busy || accountTier !== 'pro'}
          />
          <ActionRow
            icon={<LinkIcon />}
            label="A shared cloud link"
            value={session ? undefined : 'Sign in first'}
            onClick={() => {
              if (!session) return
              setAddChooserOpen(false)
              setAddUrl('')
              setAddName('')
              setAddCaption('')
              setAddError(null)
              resetAddVerification()
              setAddOpen(true)
            }}
            disabled={!session}
          />
        </ActionGroup>
      </Sheet>
      <AddGallerySheet
        open={addOpen}
        url={addUrl}
        name={addName}
        caption={addCaption}
        checking={addChecking}
        verifiedTitle={addVerifiedTitle}
        busy={busy}
        error={addError}
        onUrlChange={onAddUrlChange}
        onVerify={onAddUrlCommit}
        onNameChange={setAddName}
        onCaptionChange={setAddCaption}
        onClose={closeAddSheet}
        onSubmit={addGallerySubmit}
      />
      {/* A local gallery's settings — the Sheet form, not a full page:
          whichever card the three-dots came from, settings look the same.
          The Publish flow (shareHost) stacks on top of it when it opens. */}
      {detailsRecord ? (
        <Sheet open onClose={closeDetails} title="Gallery settings">
          <LocalGalleryDetails
            record={detailsRecord}
            availability={availability[detailsRecord.id] ?? 'available'}
            onOpen={() => {
              closeDetails()
              openViewer(detailsRecord.id, 0)
            }}
            publishedUrl={detailsPublishedUrl}
            onShareLink={detailsPublishedUrl ? async () => {
              const shared = await shareGalleryOnWeb({ title: detailsRecord.title, caption: '', url: detailsPublishedUrl })
              if (shared === 'shared') return 'Link shared'
              if (shared === 'cancelled') return null
              // No system share in the webview — the clipboard keeps the same
              // contract, and a failed copy leaves the address visible.
              return (await copyText(detailsPublishedUrl)) ? 'Link copied — paste it anywhere' : detailsPublishedUrl
            } : undefined}
            onShare={openShareFromDetails}
            onReorder={() => {
              closeDetails()
              openViewer(detailsRecord.id, 0, true)
            }}
            onRescan={() => rescan(detailsRecord)}
            onRename={(title) => rename(detailsRecord, title)}
            onRemove={() => remove(detailsRecord)}
          />
        </Sheet>
      ) : null}
      {shareHost}
      {cardMenu ? (
        <Sheet open onClose={() => { setCardMenu(null); setMenuRemove(false) }} title={cardMenu.kind === 'account' ? cardMenu.gallery.title || cardMenu.gallery.slug : cardMenu.kind === 'local' ? cardMenu.record.title : cardMenu.gallery.title}>
          {menuRemove ? (
            <div class="lib-menu">
              <p>Remove “{cardMenu.kind === 'account' ? cardMenu.gallery.title || cardMenu.gallery.slug : cardMenu.kind === 'local' ? cardMenu.record.title : cardMenu.gallery.title}” from manorama?{cardMenu.kind === 'account' && cardMenu.gallery.sourceUrl ? ` Every photograph stays in ${sourceLabelFor(cardMenu.gallery.sourceUrl)}.` : cardMenu.kind === 'device' ? ` The folder on ${cardMenu.gallery.deviceLabel} is untouched.` : ' The folder on this Mac is untouched.'}</p>
              <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => {
                if (cardMenu.kind === 'account') void removeGalleryConfirmed(cardMenu.gallery)
                else if (cardMenu.kind === 'device') void removeDeviceGalleryConfirmed(cardMenu.gallery)
                else { const record = cardMenu.record; setCardMenu(null); setMenuRemove(false); void remove(record) }
              }}>Remove gallery</button>
              <button type="button" disabled={busy} onClick={() => setMenuRemove(false)}>Cancel</button>
            </div>
          ) : (
          /* Native buttons and links, not menu/menuitem roles: there is no
             arrow-key roving focus here, so the menu role would overpromise. */
          <div class="lib-menu">
            {cardMenu.kind === 'account' ? (<>
              {/* The pin moves the card between "Pinned galleries" and the
                  compact list — a display choice, never permanence. */}
              <button type="button" disabled={busy} onClick={() => { void togglePin(cardMenu.gallery) }}>{cardMenu.gallery.pinnedAt ? 'Unpin gallery' : 'Pin gallery'}</button>
              <button type="button" onClick={() => { setShareGallery(cardMenu.gallery); setCardMenu(null) }}>Share link</button>
              {/* The gallery's own Settings — the same panel the viewer's
                  Settings popover hosts, so the owner edits in place. */}
              <button type="button" onClick={() => { setGalSettingsSlug(cardMenu.gallery.slug); setCardMenu(null) }}>Gallery settings</button>
              <button
                type="button"
                disabled={busy || isLocked(cardMenu.gallery)}
                title={isLocked(cardMenu.gallery) ? PIPELINE_LOCK_MESSAGE : undefined}
                onClick={() => { const g = cardMenu.gallery; setCardMenu(null); void openAccountGallery(g, 0, true) }}
              >Reorder photographs</button>
              {cardMenu.gallery.sourceUrl ? <a href={cardMenu.gallery.sourceUrl} target="_blank" rel="noopener" onClick={(event) => {
                // Encrypted sourceUrl is stored keyless — the full provider
                // link is rebuilt from this device's custody before it
                // leaves for the browser, same as the web menu.
                event.preventDefault()
                const g = cardMenu.gallery
                setCardMenu(null)
                if (g.manifestVersion === 2 && g.id && isEncryptedSourceUrl(g.sourceUrl!)) void openSourceResolved(g)
                else openExternal(g.sourceUrl!)
              }}>Open source</a> : null}
              {cardMenu.gallery.sourceUrl ? (
                <button
                  type="button"
                  disabled={busy || isLocked(cardMenu.gallery)}
                  title={isLocked(cardMenu.gallery) ? PIPELINE_LOCK_MESSAGE : undefined}
                  onClick={() => { void refreshGallery(cardMenu.gallery) }}
                >Refresh gallery contents</button>
              ) : null}
              {/* The encrypted on-device copy — bytes stay on this Mac,
                  locked behind the Keychain, viewable only here. */}
              {savedGalleryFor(cardMenu.gallery) ? (
                <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => {
                  const saved = savedGalleryFor(cardMenu.gallery)
                  setCardMenu(null)
                  if (saved) void removeSavedCopy(saved.galleryId)
                }}>Delete from this Mac</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => { const g = cardMenu.gallery; setCardMenu(null); void saveToVault(g) }}>Save to this Mac</button>
              )}
              <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => setMenuRemove(true)}>Remove gallery</button>
            </>) : cardMenu.kind === 'device' ? (<>
              <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => setMenuRemove(true)}>Remove gallery</button>
            </>) : (<>
              {/* The same verbs the account menu carries, in the same order —
                  Share link swaps to Publish until a public slug exists,
                  Open folder is the local's Open source, and Save is absent
                  because a local is already on this Mac. */}
              <button type="button" disabled={busy} onClick={() => { void toggleLocalPin(cardMenu.record) }}>{cardMenu.record.pinnedAt ? 'Unpin gallery' : 'Pin gallery'}</button>
              {publishedUrlFor(cardMenu.record) ? (
                <button type="button" disabled={busy} onClick={() => { void shareLocalLink(cardMenu.record, publishedUrlFor(cardMenu.record)!) }}>Share link</button>
              ) : (
                <button
                  type="button"
                  disabled={busy || availability[cardMenu.record.id] === 'unavailable'}
                  onClick={() => { const record = cardMenu.record; setCardMenu(null); openShareForGallery(record.id) }}
                >Publish this gallery</button>
              )}
              <button type="button" onClick={() => { const record = cardMenu.record; setCardMenu(null); openDetails(record) }}>Gallery settings</button>
              <button
                type="button"
                disabled={busy || availability[cardMenu.record.id] === 'unavailable'}
                onClick={() => { const record = cardMenu.record; setCardMenu(null); openViewer(record.id, 0, true) }}
              >Reorder photographs</button>
              <button
                type="button"
                disabled={availability[cardMenu.record.id] === 'unavailable'}
                onClick={() => { void revealFolder(cardMenu.record) }}
              >Open folder</button>
              <button type="button" onClick={() => { const record = cardMenu.record; setCardMenu(null); rescanFromCard(record) }}>Refresh gallery contents</button>
              <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => setMenuRemove(true)}>Remove gallery</button>
            </>)}
          </div>
          )}
        </Sheet>
      ) : null}
      {shareGallery ? (
        <div onClick={interceptSettingsLink}>
          <GalleryShareSheet
            payload={{
              title: shareGallery.title || shareGallery.slug,
              caption: shareGallery.caption,
              url: `${accountGalleryUrl(shareGallery)}${shareGallery.id ? galleryHashes[shareGallery.id] ?? '' : ''}`,
            }}
            onClose={() => setShareGallery(null)}
            onCopy={copyText}
            shareDisabled={Boolean(shareGallery.manifestVersion === 2 && shareGallery.id && !galleryHashes[shareGallery.id])}
            shareWarning="This device does not hold the key. Open the full gallery link before sharing; a keyless address opens locked."
          />
        </div>
      ) : null}
      {galSettingsGallery ? (
        <Sheet open onClose={() => setGalSettingsSlug(null)} title="Gallery settings">
          <div class="m-dark" onClick={interceptSettingsLink}>
            <OwnerGalleryPanel
              owner={ownerSlug ?? session?.ownerSlug ?? ''}
              slug={galSettingsGallery.slug}
              title={galSettingsGallery.title}
              caption={galSettingsGallery.caption}
              sourceLabel={sourceLabelFor(galSettingsGallery.sourceUrl)}
              galleryId={galSettingsGallery.id}
              sourceUrl={galSettingsGallery.sourceUrl}
              temporary={isLocked(galSettingsGallery)}
              expiresAt={galSettingsGallery.expiresAt}
              mediaCount={summaryMediaCount(galSettingsGallery)}
              upgradeHref="mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade"
              onOpen={() => { const g = galSettingsGallery; setGalSettingsSlug(null); void openAccountGallery(g, 0) }}
              onReorder={() => { const g = galSettingsGallery; setGalSettingsSlug(null); void openAccountGallery(g, 0, true) }}
              currentPhotoId={() => ''}
              onTitleSaved={(next) => setAccountGalleries((previous) => previous?.map((item) => item.slug === galSettingsGallery.slug ? { ...item, title: next } : item) ?? previous)}
              onCaptionSaved={(next) => setAccountGalleries((previous) => previous?.map((item) => item.slug === galSettingsGallery.slug ? { ...item, caption: next } : item) ?? previous)}
              apiBase={base}
              authToken={session?.token}
              keyStore={desktopKeyStore()}
              shareHref={`${accountGalleryUrl(galSettingsGallery)}${galSettingsGallery.id ? galleryHashes[galSettingsGallery.id] ?? '' : ''}`}
              onRenamed={() => { setGalSettingsSlug(null); if (session) void refreshAccountGalleries(session.token) }}
              onRefreshed={() => { if (session) void refreshAccountGalleries(session.token) }}
              onRemoved={() => { setGalSettingsSlug(null); if (session) void refreshAccountGalleries(session.token); setNotice('Gallery removed') }}
            />
            {/* Device-local policy, deliberately outside the owner panel:
                it governs this Mac's encrypted vault, not the gallery the
                account publishes. */}
            <ActionGroup label="On this Mac" note="Stream only cancels future offline saving for this gallery; a copy already saved stays until removed.">
              <ActionRow
                label="Stream only"
                control={(
                  <Switch
                    checked={streamOnlyPolicies[galleryPolicyKey(ownerSlug ?? session?.ownerSlug ?? '', galSettingsGallery.slug)] === true}
                    label="Stream only — never keep an offline copy on this Mac"
                    onChange={(value) => void setGalleryStreamOnly(galSettingsGallery, value)}
                  />
                )}
              />
            </ActionGroup>
          </div>
        </Sheet>
      ) : null}
      {/* The shared Settings surface — the same groups and options the
          web dashboard shows. Its anchors (privacy, connect links, the
          upgrade mailto) all open in the system browser. */}
      {settingsOpen && session ? (
        <div onClick={interceptSettingsLink}>
          <WebSettings
            ownerSlug={ownerSlug ?? session.ownerSlug}
            ownerSlugDraft={ownerSlugDraft}
            onOwnerSlugDraft={(value) => { setOwnerSlugDraft(value); setSettingsNote(null) }}
            onSaveOwnerSlug={() => void saveOwnerSlug()}
            ownerSlugBusy={busy}
            ownerSlugNote={settingsNote}
            identities={identities}
            identityNote={identityNote}
            onUnlinkIdentity={(provider) => void unlinkIdentity(provider)}
            tier={accountTier}
            retainedCount={retainedCount}
            retainedLimit={retainedLimit}
            temporaryCount={temporaryCount}
            localCount={galleries.length + remoteDeviceGalleries.length}
            upgradeHref="mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade"
            theme={theme}
            onTheme={setTheme}
            deleteConfirm={deleteConfirm}
            onDeleteConfirmChange={setDeleteConfirm}
            deleteOpen={deleteOpen}
            onRequestDelete={() => { setDeleteOpen(true); setDeleteNote(null) }}
            onCancelDelete={() => { setDeleteOpen(false); setDeleteConfirm(''); setDeleteNote(null) }}
            deleteBusy={deleteBusy}
            deleteNote={deleteNote}
            onDeleteAccount={() => void removeAccount()}
            onBack={() => setSettingsOpen(false)}
            onSignOut={signOut}
            deviceSection={(
              <>
                <ActionGroup label="This Mac">
                  <ActionRow label="Device" value={catalogue?.deviceLabel} chevron={false} />
                  {/* Sync publishes local-gallery rows — a Visionary-only
                      feature, so the row simply isn't offered on Free. */}
                  {accountTier === 'pro' ? (
                    <>
                      <ActionRow
                        label="Catalogue sync"
                        value={syncState === 'synced' ? 'Up to date'
                          : syncState === 'partial' ? 'Partly synced'
                          : syncState === 'failed' ? 'Sync failed' : undefined}
                        control={(
                          <Button
                            variant="quiet"
                            disabled={syncState === 'syncing' || !catalogue}
                            onClick={() => catalogue && void runSync(catalogue, session)}
                          >
                            {syncState === 'syncing' ? 'Syncing…' : 'Sync now'}
                          </Button>
                        )}
                      />
                      {syncState === 'syncing' ? (
                        <div class="desktop-sync-progress" role="progressbar" aria-label="Syncing this Mac's catalogue" />
                      ) : null}
                      <p class="m-note m-panel-note">
                        Sends each local gallery's title and photograph count — never the photographs — so
                        your other devices can list this Mac's folders.
                      </p>
                    </>
                  ) : null}
                </ActionGroup>
                {/* The same vault card the iOS Settings hosts: usage, cap,
                    load policy, per-gallery purge, Forget everything. The
                    controller resolves the live tier on every call. */}
                <VaultSettings
                  controller={createDesktopVaultSettings(() => accountTier)}
                  tier={accountTier}
                  embedded
                  usageBreakdown={false}
                />
              </>
            )}
          />
        </div>
      ) : null}
      {/* Status notes toast over the surface like the web dashboard's —
          the rail stays clean of transient text. */}
      {notice || accountNote || slugNote ? (
        <div class="desktop-toast-stack">
          {notice ? <div class="admin-toast" role="status" aria-live="polite">{notice}</div> : null}
          {accountNote ? <div class="admin-toast" role="status">{accountNote}</div> : null}
          {slugNote ? <div class="admin-toast" role="status">{slugNote}</div> : null}
        </div>
      ) : null}
    </main>
  )
}
