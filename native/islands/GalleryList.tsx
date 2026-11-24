import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'hono/jsx'
import { canGoBack, initialOwnerNav, ownerNavReducer, type OwnerNavAction, type OwnerNavState } from '../../packages/core/owner-navigation'
import { closeTopOverlay, overlayDepth } from '../../app/lib/overlay-stack'
import { expiryCountdownText } from '../../app/lib/gallery-policy'
import { decideBack } from '../lib/back-decision'
import { nativeDeviceLabel } from '../lib/device-label'
import { formatBytes } from './VaultSettings'
import type { GalleryManifest, GalleryMediaItem, VideoItem } from '../../app/lib/imagesource'
import { formatMediaCount, isVideoItem, mediaCountOf, summaryMediaCount } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import { loadGallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import type { Theme } from '../../app/lib/owner-theme'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer, { type ViewerChromeControl, type ViewerChromeHandle } from '../../app/islands/Viewer'
import GalleryEditor from './GalleryEditor'
import GalleryDetails from './GalleryDetails'
import PostToX from './PostToX'
import AddGallerySheet from '../../app/components/AddGallerySheet'
import GalleryShareSheet from '../../app/components/GalleryShareSheet'
import { CloseIcon, QuietIcon, SettingsIcon } from '../../app/components/admin-icons'
import { Sheet } from '../../app/components/ui/Sheet'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { BundledSource } from '../../app/lib/imagesource'
import type { AdFrame } from '../../app/lib/adframe'
import { adoptGallery, createGalleryFromQuickAdd, createGalleryFromSource, deleteAccount, fetchAccountGalleries, fetchAccountIdentities, fetchAccountOwnerSlug, fetchAccountTier, fetchDeviceGalleries, fetchDevices, fetchGallery, forgetDevice, normalizeApiBase, probeAccountGallery, refreshGallery, refreshGalleryWithManifest, registerDevice, renameOwnerSlug, scanSourceUrl, setGalleryHidden, unlinkAccountIdentity, type AccountIdentity } from '../lib/api'
import { nativeDeviceId, nativeDeviceKindFor } from '../lib/device-identity'
import { hasIosGlass, installIosShellBridge, iosPost, publishIosChrome } from '../lib/ios-shell'
import { isEncryptedSourceUrl, manifestIsEncryptedSource, galleryHashForSource } from '../../packages/core/encrypted-source'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { Device } from '../../packages/core/devices'
import { DeviceGalleriesGrid, deviceTileCard } from '../../app/components/library/DeviceGalleriesSection'
import { SectionChevron } from '../../app/components/library/SectionChevron'
import { syncQuietFade } from '../../app/components/library/quiet'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  offlineGalleryId,
  openGalleryNetworkFirst,
  offlineManifestMatches,
  openNativeEncryptedSession,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
  type OfflineCacheResult,
  type OfflineGallerySummary,
  type OfflineGridGallery,
  type OfflineGalleryStore,
} from '../lib/offline-gallery'
import { computeCachedGallery, OnDeviceLocalCompute, readImageFeatures } from '../lib/local-compute'
import { isCoverEntryId, thumbnailEntryId } from '../lib/thumbs'
import { mimeTypeForItem, LibraryMediaLoader } from '../lib/library-media'
import { cacheFillRegistry } from '../lib/cache-fill'
import { copyText, type GallerySharePayload } from '../../app/lib/gallery-share'
import type { EncryptedClientSession } from '../../app/lib/encrypted-resolver'
import type { PostToXPhoto } from '../lib/post-to-x'
import type { PostPhotoBytes } from '../lib/post-export'
import { LibraryCover, LibraryRail } from './LibraryRail'
import { libraryLayout } from '../../packages/core/library-layout'
import { FREE_PIPELINE_LIMIT, retainedAllowanceCounts, retainedGalleryLimit, type AccountTier } from '../../packages/core/account'
import { productionVault } from '../lib/vault'
import { adFrameFor, fetchAdVisibility, HOUSE_AD_FRAME, type AdPolicyInput, type AdVisibility } from '../lib/ads'
import { createAccountAdAdapter } from '../lib/admob-account-adapter'
import { createEncryptedGallery, clearAllEncryptedSources, refreshEncryptedGallery, removeEncryptedSourceForSelection, resolveEncryptedSourceForSelection, EncryptedSourceLockedError, EncryptedSourceMismatchError } from '../lib/encrypted-gallery'
import { deviceListingOutcome, sourceCheckDue } from '../../app/lib/source-freshness'
import { checkAppUpdate, dismissAppUpdate, dismissedUpdateVersion, type AppUpdate } from '../lib/app-update'
import { loadGlobalViewEnabled, saveGlobalViewEnabled } from '../lib/global-view'
import { beginProviderSignIn, clearPendingQuickAdd, clearSessionToken, getOwnerSlug, getPendingQuickAdd, getSessionToken, setOwnerSlug as persistOwnerSlug, type AuthProvider, type NativeGallerySelection } from '../lib/session'
import { requestReorderClose } from '../lib/reorder-close-guard'
import { addLocalGallery, loadLocalCatalogue, localGalleriesRootUri, localGalleryManifest, removeLocalGallery } from '../lib/local-gallery'
import { readEmbeddedMetadata } from '../../packages/core/embedded-metadata'
import { fetchRangeReader } from '../../app/lib/embedded-metadata-client'
import type { LocalCatalogue, LocalGalleryRecord } from '../../desktop/lib/catalogue'
import { galleryPolicyKey, loadGalleryStreamOnly, saveGalleryStreamOnly, DEFAULT_VAULT_LOAD_POLICY, createVaultSettingsController, type GalleryLoadOverride } from '../lib/vault-settings'
import type { AdSuppression } from '../../app/lib/ads-visibility'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Privacy from './Privacy'
import Settings from './Settings'
import CameraRoll, { CameraRollPill } from './CameraRoll'
import Welcome from './Welcome'
import Diptych, { type DiptychFrame } from './Diptych'
import GlobalView from './GlobalView'
import { Browser } from '@capacitor/browser'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import '../styles/account-ad.css'

type Props = {
  apiBase: string
  owner?: string
  slug?: string
  /** A public HTTPS gallery link delivered while the app is cold or running. */
  deepLinkSelection?: NativeGallerySelection | null
  onSignIn?: (provider: AuthProvider) => void
  authError?: string | null
  linkConflict?: string | null
  onClearLinkConflict?: () => void
  billing?: RevenueCatBilling
  billingState?: BillingState
  ownerTheme?: Theme
  onOwnerThemeChange?: (theme: Theme) => void
  /** House-policy loader for the account slot. Production never passes this;
   *  tests inject it to stage a slow resolution against an entitlement change. */
  accountAdLoader?: (input: AdPolicyInput) => Promise<AdFrame | null>
  /** Test/fixture seam for cached-first Library states. Production uses the
   *  encrypted device store; no web bundle receives an alternate store. */
  offlineStore?: OfflineGalleryStore
}

/** What a gallery calls itself in labels and confirmations. The card shows
 *  the slug when a title is missing, and every control that speaks about the
 *  gallery says the same thing. */
const galleryName = (gallery: { title?: string; slug: string }): string =>
  gallery.title || gallery.slug

/** A saved copy counts as complete only when its committed manifest covers
 *  every published item. `imageCount` counts concealed photographs too, and
 *  those never reach the vault manifest — comparing against it would fail a
 *  copy that honestly holds everything a viewer can open. */
const savedCopyComplete = (
  summary: OfflineGallerySummary | undefined,
  gallery: Pick<GallerySummary, 'imageCount' | 'mediaCount'>,
): boolean => {
  if (summary?.status !== 'cached') return false
  const published = summaryMediaCount(gallery)
  return summary.images >= published.stills + published.videos
}

/** The card's on-device status: "Streamed" when the owner declined a copy,
 *  a live meter while vault writes land. Once the vault record commits, the
 *  card's green saved badge states the copy instead — the meter only narrates
 *  states not yet committed. Cache-fill events advance the meter mid-fill so
 *  the word never waits on an account refresh; nothing here starts a download. */
export const LibraryDeviceStatus = ({
  galleryId,
  imageCount,
  streamOnly,
  summary,
  savedAnnounced = false,
}: {
  galleryId: string
  imageCount: number
  streamOnly: boolean
  summary: OfflineGallerySummary | undefined
  /** The caller prints the saved badge itself — the grey "On this iPhone"
   *  word would only repeat it. Partial commits still narrate their fill. */
  savedAnnounced?: boolean
}) => {
  const seeded = summary?.status === 'cached' ? summary.images : 0
  const [liveSaved, setLiveSaved] = useState(seeded)
  const previousGalleryRef = useRef(galleryId)
  const fillingRef = useRef(false)
  useEffect(() => {
    const changed = previousGalleryRef.current !== galleryId
    previousGalleryRef.current = galleryId
    if (changed || summary?.status) fillingRef.current = false
    // A catalog refresh can arrive before the fill's commit-last metadata.
    // Preserve the meter only during that active-fill gap; a later purge or
    // unreadable summary is authoritative and may reset it.
    setLiveSaved((saved) => changed ? seeded : fillingRef.current ? Math.max(saved, seeded) : seeded)
  }, [seeded, galleryId, summary?.status])
  useEffect(() => {
    if (!galleryId) return
    return cacheFillRegistry.subscribe(galleryId, (item) => {
      // Cover caches publish on the same registry — a cover landing is not
      // saved progress and must never light the meter.
      if (isCoverEntryId(item.entryId)) return
      fillingRef.current = true
      setLiveSaved((saved) => Math.max(saved, item.index + 1))
    })
  }, [galleryId])

  if (streamOnly) return <span class="lib-card-device"> · Streams</span>
  if (summary?.status === 'corrupt') return <span class="lib-card-device"> · Saved copy unreadable</span>
  if (!galleryId || liveSaved <= 0) return null
  if (liveSaved < imageCount) {
    return (<>
      <span class="lib-card-device"> · Saving {liveSaved} of {imageCount}</span>
      {/* The pink data hue marks progress; the bar itself is the measure,
          so it carries the progressbar role rather than a native progress. */}
      <span
        class="lib-card-meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={imageCount}
        aria-valuenow={liveSaved}
        aria-label={`${liveSaved} of ${imageCount} photographs saved`}
      ><i style={{ width: `${(liveSaved / imageCount) * 100}%` }} /></span>
    </>)
  }
  if (savedAnnounced) return null
  return <span class="lib-card-device"> · On {nativeDeviceLabel()}</span>
}

/** The Library's resting place: each scrolling region's offset and a stable
 *  address for the control that last held focus. The gallery viewer removes
 *  the whole layout from the DOM and `hidden` zeroes the pane's scroll box,
 *  so this has to be remembered in state — the browser does not. */
type LibraryViewMemory = { pane: number; rail: number; layout: number; focus: string | null }

const attrSelector = (name: string, value: string): string =>
  `[${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`

/** A selector that re-finds the focused control after the Library remounts.
 *  Cards are addressed by slug, labelled buttons by their label; a rail
 *  thumbnail returns focus to its card's title rather than an index that may
 *  have shifted under a refreshed list. */
const libraryFocusSelector = (el: HTMLElement): string | null => {
  const card = el.closest('[data-lib-card],[data-cached-gallery]') as HTMLElement | null
  if (card) {
    const slug = card.dataset.libCard ?? card.dataset.cachedGallery
    if (!slug) return null
    const base = attrSelector(card.dataset.libCard !== undefined ? 'data-lib-card' : 'data-cached-gallery', slug)
    // A slug is not unique on the page — a pinned gallery sits in the
    // "Pinned galleries" section *and* in its home section. Qualify with
    // the enclosing section's identity so restore lands on the occurrence
    // the user was actually on, not the earlier copy.
    const sectionId = card.closest('section[aria-labelledby]')?.getAttribute('aria-labelledby')
    const scope = sectionId ? `section${attrSelector('aria-labelledby', sectionId)} ` : ''
    return `${scope}${base} ${el.classList.contains('lib-card-menu') ? '.lib-card-menu' : '.lib-card-title'}`
  }
  const label = el.getAttribute('aria-label')
  if (label) return `button${attrSelector('aria-label', label)}`
  if (el.classList.contains('native-lib-foot-open')) return '.native-lib-foot-open'
  return null
}

const PRIVACY_URL = 'https://manorama.xyz/privacy'
const AUTHOR_URL = 'https://thecontrarian.in'

/** A legacy native rectangle may still be mounted when an older viewer or
 *  account surface transitions into the redesigned Library. The Library never
 *  hands this adapter to its policy; the transition only retires old work. */
const accountAdAdapter = createAccountAdAdapter({
  isNative: Capacitor.isNativePlatform(),
  unitId: import.meta.env.VITE_ADMOB_ACCOUNT_UNIT,
})

/** Print stays a desktop utility: `window.print` exists in a phone webview
 *  but produces nothing useful, so the control only appears where a real
 *  hovering pointer is present. */
const printSupported = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
  typeof window.print === 'function' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches

/** Legal and attribution links open in an in-app browser sheet — the same
 *  pattern the paywall and the OAuth flow use, because a Capacitor webview does
 *  not reliably act on a bare `target="_blank"` anchor. The href stays on the
 *  anchor, so the link still works, and still reads as a link, without JS. */
const openExternal = (url: string) => {
  void Browser.open({ url, toolbarColor: '#0a0a0a', presentationStyle: 'fullscreen' })
}

type Selection = { owner: string; slug: string; galleryId?: string; sourceUrl?: string }
type GalleryStatus = 'idle' | 'loading' | 'online' | 'offline' | 'error'

const selectionFromLocation = (): Selection => {
  if (typeof window === 'undefined') return { owner: '', slug: '' }
  const params = new URLSearchParams(window.location.search)
  const path = window.location.pathname.split('/').filter(Boolean)
  return {
    owner: params.get('owner')?.trim() || path[0] || '',
    slug: params.get('slug')?.trim() || path[1] || '',
  }
}

const localCompute = new OnDeviceLocalCompute({ vault: productionVault })

const mimeTypeForImage = mimeTypeForItem

export const galleryStatusMessage = (status: GalleryStatus): string => {
  if (status === 'loading') return 'Opening gallery…'
  if (status === 'offline') return 'Available offline. Full resolution returns with your connection.'
  if (status === 'online') return 'Gallery connected.'
  if (status === 'error') return 'That gallery could not be opened.'
  return 'Connect to manorama to view a public gallery.'
}

/** The visibility endpoint answers with an ISO-3166 alpha-2 code, and a button
 *  reading "Hide in IN" explains nothing. The platform's own region names turn
 *  it into a place; a runtime without them keeps the code rather than guessing. */
export const regionName = (code: string | null | undefined): string => {
  if (!code) return ''
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/** Opens native galleries from the network or local vault and presents eligible
 *  photo pairs in the fold layout when the device has two usable segments. */
export default function GalleryList({ apiBase, owner, slug, deepLinkSelection, onSignIn, authError, linkConflict, onClearLinkConflict, billing, billingState: liveBilling, ownerTheme = 'dark', onOwnerThemeChange = () => {}, accountAdLoader = adFrameFor, offlineStore = productionOfflineGalleryStore }: Props) {
  // Browser previews have no RevenueCat to configure. The capture harness
  // can stand the account surface in a billing state through
  // window.__demoBilling so every tier-bearing element can be reviewed.
  const billingState = liveBilling ?? (globalThis as { __demoBilling?: BillingState }).__demoBilling
  const initial = selectionFromLocation()
  const initialSelection = { owner: owner ?? initial.owner, slug: slug ?? initial.slug }
  const [selection, setSelection] = useState<Selection>(initialSelection)
  const [galleryPolicies, setGalleryPolicies] = useState<Record<string, GalleryLoadOverride> | null>(null)
  const [vaultNote, setVaultNote] = useState('Preparing offline copy…')
  const [vaultProgress, setVaultProgress] = useState<{ completed: number; total: number } | null>(null)
  /** A vault fill started by the Keep-copy switch itself — the gallery need
   *  not be open for the owner to watch it land. */
  const [vaultSave, setVaultSave] = useState<{ owner: string; slug: string; completed: number; total: number; note: string | null } | null>(null)
  const selectedPolicyKey = galleryPolicyKey(selection.owner, selection.slug)
  const effectiveLoadPolicy = galleryPolicies?.[selectedPolicyKey] ?? DEFAULT_VAULT_LOAD_POLICY
  const streamOnly = effectiveLoadPolicy === 'stream'
  useEffect(() => {
    void loadGalleryStreamOnly().then((policies) => {
      galleryPoliciesRef.current = policies
      setGalleryPolicies(policies)
    })
  }, [])
  const [globalViewEnabled, setGlobalViewEnabled] = useState<boolean | null>(null)
  const [globalViewSaving, setGlobalViewSaving] = useState(false)
  // Sections collapse like the Mac's Catalogue: everything open at launch,
  // Hidden closed. Plain toggles — the Mac's password gate lives in its
  // library-prefs.json and has no native analogue.
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [cloudOpen, setCloudOpen] = useState(true)
  const [localOpen, setLocalOpen] = useState(true)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [manifest, setManifest] = useState<GalleryManifest | null>(null)
  const [settings, setSettings] = useState<GallerySettings | null>(null)
  const [plate, setPlate] = useState<Awaited<ReturnType<typeof adFrameFor>>>(null)
  const [accountAd, setAccountAd] = useState<AdFrame | null>(null)
  const [accountAdDimensions, setAccountAdDimensions] = useState<{ src: string; width: number; height: number } | null>(null)
  // The master's day/region kill switch — answered by the Worker, failed open.
  const [visibility, setVisibility] = useState<AdVisibility | null>(null)
  // Suppressions are readable only with a session: a signed-in operator gets
  // the toggle; everyone else just gets the visibility answer applied.
  const [suppressions, setSuppressions] = useState<AdSuppression[] | null>(null)
  const [foldLayout, setFoldLayout] = useState<FoldLayout | null>(null)
  // Below this content width a compact cover is a postage stamp — every
  // card carries its own filmstrip instead (the miniature of the viewer it
  // opens into). The grid collapses with it in CSS at the same measure.
  const [narrowLibrary, setNarrowLibrary] = useState(false)
  const libraryPaneObserverRef = useRef<ResizeObserver | null>(null)
  const [status, setStatus] = useState<GalleryStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // A gallery already open at mount (props or a restored URL selection)
  // must sit on the nav stack too — otherwise the first hardware back
  // press sees library at top and exits the app instead of returning.
  const [nav, dispatchNavBase] = useReducer(ownerNavReducer, initialOwnerNav(true), (base) =>
    initialSelection.owner && initialSelection.slug
      ? ownerNavReducer(base, { type: 'open-gallery', gallery: { kind: 'published', owner: initialSelection.owner, slug: initialSelection.slug } })
      : base)
  // Opening a Local gallery awaits the bridge for its root URI. Any nav
  // action meanwhile — another open, a back, a panel switch — must win over
  // the stale open, so every dispatch bumps the generation an in-flight
  // open captured.
  const openGenerationRef = useRef(0)
  const dispatchNav = (action: OwnerNavAction) => {
    openGenerationRef.current += 1
    dispatchNavBase(action)
  }
  const [globalViewOpen, setGlobalViewOpen] = useState(false)
  // null while secure storage is still being asked; sign-in completes with a
  // full reload, so by the first paint the token is already on the device.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [pendingQuickAdd, setPendingQuickAdd] = useState<string | null>(null)
  const [quickAddBusy, setQuickAddBusy] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [galleryActionBusy, setGalleryActionBusy] = useState<string | null>(null)
  const [galleryActionNote, setGalleryActionNote] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [sourceCaption, setSourceCaption] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [cameraRollOpen, setCameraRollOpen] = useState(false)
  const cameraRollTriggerRef = useRef<HTMLElement | null>(null)
  const closeCameraRoll = () => {
    setCameraRollOpen(false)
    requestAnimationFrame(() => cameraRollTriggerRef.current?.focus())
  }
  // The link is verified before the optional fields appear — the scanned
  // title doubles as the flag and the Name placeholder.
  const [addVerifiedTitle, setAddVerifiedTitle] = useState<string | null>(null)
  const [addChecking, setAddChecking] = useState(false)
  const [sharePayload, setSharePayload] = useState<GallerySharePayload | null>(null)
  // The temporary-gallery countdown is live like the web rail's — a one-
  // minute tick keeps "expires in N days M hours" honest while the Library
  // stays mounted, and stops with it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])
  // The editor a card's cover opens: the gallery it resequences, resolved
  // when the cover is tapped so the island owns its own read and write.
  const [editorGallery, setEditorGallery] = useState<{ owner: string; slug: string; title: string } | null>(null)
  const quickAddInFlight = useRef<string | null>(null)
  // The account actions used to be scattered through the greeting copy. They
  // live in one drawer now, closed on every mount and never encoded in the URL.
  const [ownerSlug, setOwnerSlug] = useState<string | undefined>(undefined)
  const [ownerName, setOwnerName] = useState<string | undefined>(undefined)
  const [accountIdentities, setAccountIdentities] = useState<AccountIdentity[] | null>(null)
  const [identityNote, setIdentityNote] = useState<string | null>(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [ownerSlugDraft, setOwnerSlugDraft] = useState('')
  const [slugNote, setSlugNote] = useState<string | null>(null)
  const [accountGalleries, setAccountGalleries] = useState<GallerySummary[] | null>(null)
  const [accountListFailed, setAccountListFailed] = useState(false)
  // The account-record tier. Web purchases and support grants live only
  // here — RevenueCat never hears about them, so a store read alone would
  // call a paying owner a Free User. `null` is unanswered, not free.
  const [accountTier, setAccountTier] = useState<AccountTier | null>(null)
  const [deviceGalleries, setDeviceGalleries] = useState<DeviceGallery[] | null>(null)
  // This phone's own local catalogue — the records the Local section shows
  // before the synced mirror feed even answers. Paths never leave the device.
  const [localCatalogue, setLocalCatalogue] = useState<LocalCatalogue | null>(null)
  const [addChooserOpen, setAddChooserOpen] = useState(false)
  const [localAddBusy, setLocalAddBusy] = useState(false)
  const [localMenuRecord, setLocalMenuRecord] = useState<LocalGalleryRecord | null>(null)
  const [removeLocalRecord, setRemoveLocalRecord] = useState<LocalGalleryRecord | null>(null)
  // The account's device list — anonymous ids, kinds, numbers and pill
  // colours. This phone's own row is the one whose id the secure store holds.
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [forgetDeviceBusy, setForgetDeviceBusy] = useState(false)
  // Quiet view: sinks every word on the Library to a whisper so only the
  // photographs remain. Session-level — a launch opens with the words on.
  const [quiet, setQuiet] = useState(false)
  const [deviceListFailed, setDeviceListFailed] = useState(false)
  const [accountRevision, setAccountRevision] = useState(0)
  const [billingNote, setBillingNote] = useState<string | null>(null)
  // App Review 5.1.1(v): a self-serve deletion path behind a second tap.
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Once the server deletes the account a retry only owes billing cleanup —
  // the API call must not run again against a 404.
  const [accountDeleted, setAccountDeleted] = useState(false)
  // Global-grid frame entry: index is the Viewer mount seed, nonce forces a
  // remount when the same gallery is re-entered at a different frame.
  const [frameKick, setFrameKick] = useState({ index: 0, nonce: 0 })
  const [activePhotoIndex, setActivePhotoIndex] = useState(0)
  const [openMenuSlug, setOpenMenuSlug] = useState<string | null>(null)
  // The gallery whose photographs are being posted to X, and the address the
  // post carries back to it.
  const [postToX, setPostToX] = useState<{ gallery: GallerySummary; url: string; galleryId: string } | null>(null)
  const [vaultGalleries, setVaultGalleries] = useState<ReadonlyMap<string, OfflineGallerySummary>>(new Map())
  /** Queued Keep/purge operations run after the render that queued them —
   *  completeness and the account summary must be re-read, not captured. */
  const vaultGalleriesRef = useRef(vaultGalleries)
  vaultGalleriesRef.current = vaultGalleries
  const accountGalleriesRef = useRef(accountGalleries)
  accountGalleriesRef.current = accountGalleries
  /** The last tier this session actually answered — a stalled or missing
   *  plan response never hides it. A session change clears the memory. */
  const answeredTierRef = useRef<{ token: string; tier: AccountTier } | null>(null)
  const [vaultUsageBytes, setVaultUsageBytes] = useState<number | undefined>(undefined)
  const [cachedLibraryGalleries, setCachedLibraryGalleries] = useState<OfflineGridGallery[]>([])
  const [cachedMenuGallery, setCachedMenuGallery] = useState<OfflineGridGallery | null>(null)
  const [removeCachedGallery, setRemoveCachedGallery] = useState<OfflineGridGallery | null>(null)
  const [galleryIds, setGalleryIds] = useState<Record<string, string>>({})

  // The entitlement surfaces read two sources: the account record, which is
  // the truth for web purchases and grants, and the store, which covers the
  // window between an in-app purchase and its webhook landing. Either one
  // answering pro makes the account pro.
  const isPro = accountTier === 'pro' || billingState?.isPro === true
  const effectiveTier: AccountTier = isPro ? 'pro' : 'free'
  const tierKnown = accountTier !== null || billingState?.tier !== undefined

  // One loader per mounted Library — its queue and budgets are the whole
  // surface's media ceiling, shared by every rail.
  const libraryLoader = useMemo(() => new LibraryMediaLoader({
    read: (galleryId, entryId) => offlineStore.readThumbnail(galleryId, entryId),
    objectUrls: {
      create: (bytes, mimeType) => URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType })),
      revoke: (url) => URL.revokeObjectURL(url),
    },
    // A cover miss is a one-time fetch: the vault keeps it so every later
    // Library render resolves locally instead of paying the network again.
    onRemoteFallback: (cell) => {
      if (!cell.galleryId || !cell.coverId || !cell.remote) return
      void offlineStore.ensureCover({
        galleryId: cell.galleryId,
        entryId: cell.coverId,
        remote: cell.remote,
        mimeType: cell.mimeType,
      }).catch(() => {})
    },
  }), [offlineStore])
  const vaultSettingsController = useMemo(() => createVaultSettingsController({
    vault: productionVault,
    store: offlineStore,
    tier: () => effectiveTier,
  }), [offlineStore, effectiveTier])
  useEffect(() => () => {
    libraryLoader.release()
    cacheFillRegistry.reset()
  }, [libraryLoader])
  const positionRef = useRef<{ imageId: string; index: number } | null>(null)
  // The iOS 26+ glass overlay drives the mounted Viewer through this handle —
  // the same contract the macOS shell uses. Without the data-ios-glass stamp
  // the props and the published handle simply never come into play.
  const chromeRef = useRef<ViewerChromeHandle | null>(null)
  const chromeProps = hasIosGlass()
    ? {
        chromeRef,
        onChromeFocus: (control: ViewerChromeControl) => iosPost({ type: 'focus', control }),
        // Global View lives outside the Viewer tree; the viewer treats its
        // open state as its own modal so dismissal runs the native
        // focus-restore path (the observer reports picker open/close too).
        nativePickerOpen: globalViewOpen,
      }
    : {}
  const navRef = useRef<OwnerNavState>(null as unknown as OwnerNavState)
  navRef.current = nav
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const leaseRef = useRef<Pick<NetworkFirstGallery, 'dispose' | 'encryptedResolver'> | null>(null)
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase])

  useEffect(() => {
    installIosShellBridge()
    publishIosChrome(chromeRef)
  }, [])

  useEffect(() => {
    let active = true
    void loadGlobalViewEnabled().then((enabled) => {
      if (active) setGlobalViewEnabled(enabled)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!deepLinkSelection) return
    if (!('owner' in deepLinkSelection)) {
      setPendingQuickAdd(deepLinkSelection.sourceUrl)
      return
    }
    // An encrypted deep link carries the provider key in its fragment.
    // Custody adoption happens inside openNativeEncryptedSession after the
    // fragment's source identity compares equal to the published manifest —
    // never here, where a mismatched link could poison the key store.
    setFrameKick({ index: 0, nonce: 0 })
    enterGallery(deepLinkSelection)
  }, [deepLinkSelection])

  useEffect(() => {
    let active = true
    void getPendingQuickAdd().then((sourceUrl) => {
      if (active && sourceUrl) setPendingQuickAdd(sourceUrl)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!pendingQuickAdd || signedIn !== true || quickAddInFlight.current) return
    const sourceUrl = pendingQuickAdd
    quickAddInFlight.current = sourceUrl
    setQuickAddBusy(true)
    setError(null)
    void (isEncryptedSourceUrl(sourceUrl) ? createEncryptedGallery(base, sourceUrl, { quick: true }) : createGalleryFromQuickAdd(base, sourceUrl))
      .then((next) => {
        if (quickAddInFlight.current !== sourceUrl) return
        setPendingQuickAdd(null)
        setSourceUrl('')
        void clearPendingQuickAdd()
        setFrameKick({ index: 0, nonce: 0 })
        enterGallery(next)
      })
      .catch((reason: unknown) => {
        if (quickAddInFlight.current !== sourceUrl) return
        setPendingQuickAdd(null)
        void clearPendingQuickAdd()
        setError(reason instanceof Error ? reason.message : 'That cloud folder could not be turned into a gallery')
      })
      .finally(() => {
        if (quickAddInFlight.current !== sourceUrl) return
        quickAddInFlight.current = null
        setQuickAddBusy(false)
        setAccountRevision((revision) => revision + 1)
      })
  }, [base, pendingQuickAdd, quickAddBusy, signedIn])

  useEffect(() => {
    if (!selection.owner || !selection.slug || galleryPolicies === null) return
    setVaultProgress(null)
    setVaultNote(streamOnly ? 'Streaming from cloud. No new offline copy is being downloaded.' : 'Preparing encrypted offline copy…')
    const controller = new AbortController()
    let active = true
    let currentManifest: GalleryManifest | null = null
    let currentStatus: GalleryStatus = 'idle'
    const disposeLease = () => {
      leaseRef.current?.dispose?.()
      leaseRef.current = null
    }
    // The web handoff carries the key fragment when this device holds it —
    // the browser sheet can then unlock without asking for the full link.
    const externalGalleryUrl = async () => {
      const stored = selection.galleryId
        ? await resolveEncryptedSourceForSelection(selection.galleryId).catch(() => null)
        : null
      const hash = stored && selection.galleryId ? galleryHashForSource(stored, selection.galleryId) : ''
      return `${normalizeApiBase(base)}/${encodeURIComponent(selection.owner)}/${encodeURIComponent(selection.slug)}${hash}`
    }
    const openExternally = () => { void externalGalleryUrl().then(openExternal) }
    const applyGallery = (gallery: NetworkFirstGallery) => {
      // Version-2 manifests decrypt on-device through the lease's resolver.
      // What native still cannot render is a *legacy* manifest — an encrypted
      // source whose items carry only server-mediated refs — so that one
      // shape delegates to the web's client path in the browser sheet.
      const legacyEncrypted = manifestIsEncryptedSource(gallery.manifest) &&
        !gallery.manifest.images.some((image) => !isVideoItem(image) && image.media?.kind === 'encrypted')
      if (gallery.source === 'online' && legacyEncrypted) {
        disposeLease()
        gallery.dispose?.()
        openExternally()
        returnToGalleries()
        return
      }
      disposeLease()
      leaseRef.current = gallery
      currentManifest = gallery.manifest
      currentStatus = gallery.source
      setManifest(gallery.manifest)
      setSettings(gallery.settings)
      setStatus(gallery.source)
      setError(null)
          // Streaming mode deliberately does not start a cache fill. Existing
          // encrypted galleries may still be opened offline, but a fresh
          // online link never writes image bytes when the policy is stream.
          if (gallery.source === 'online' && !gallery.cacheFill) return
          const cacheReady = gallery.cacheFill ?? Promise.resolve(undefined)
      void cacheReady
        .then(async (result) => {
          if (!active) return
          if (result?.status === 'over-cap') {
            setVaultNote('This gallery is larger than your encrypted vault can hold. You can keep viewing online.')
            return
          }
          setVaultNote(gallery.source === 'offline' ? 'Opened from your encrypted vault.' : 'Offline copy saved in your encrypted vault.')
          const stillImages = gallery.manifest.images.filter((image) => !isVideoItem(image))
          if (stillImages.length === 0) return
          const galleryId = await offlineGalleryId(selection)
          if (!active) return
          await computeCachedGallery({
            engine: localCompute,
            galleryId,
            images: stillImages.map((image) => ({ id: image.id, entryId: thumbnailEntryId(image.id), mimeType: mimeTypeForImage(image) })),
            read: (currentGalleryId, entryId) => offlineStore.readThumbnail(currentGalleryId, entryId),
            readFeatures: (currentGalleryId, imageId) => readImageFeatures(productionVault, currentGalleryId, imageId),
            isCancelled: () => !active,
          })
        })
        .catch(() => {
          if (active) setVaultNote('Offline saving or local indexing was interrupted. You can keep viewing online; reopen the gallery to retry.')
        })
    }
    const open = () => {
      setError(null)
      setStatus((previous) => previous === 'offline' ? previous : 'loading')
      setPlate(null)
      return openGalleryNetworkFirst({
        selection,
        store: offlineStore,
        cachePolicy: effectiveLoadPolicy,
        preferVault: true,
        onProgress: (progress) => {
          if (!active) return
          if (progress.total === 0) { setVaultProgress(null); return }
          setVaultProgress(progress)
          setVaultNote(`Saving ${progress.completed} of ${progress.total} photos to your encrypted vault…`)
        },
        signal: controller.signal,
        fetchOnline: (signal) => fetchGallery(base, selection.owner, selection.slug, signal),
      })
        .then((gallery) => {
          if (!active) {
            gallery.dispose?.()
            return
          }
          applyGallery(gallery)
          // A kept copy won the open from the device; the network answer was
          // still in flight. An unchanged manifest re-commits quietly — a
          // drifted one swaps in, keeping the frame the owner is on.
          if (!gallery.revalidate) return
          void gallery.revalidate.then((fresh) => {
            if (!active || !fresh || (gallery.committedManifest && offlineManifestMatches(gallery.committedManifest, fresh.manifest, gallery.settings, fresh.settings))) {
              // A discarded replacement still opened its resolver session
              // and may still be filling — quiet the fill, then release
              // what it opened once the writes settle.
              if (fresh) {
                void (fresh.cacheFill ?? Promise.resolve(undefined))
                  .catch(() => {})
                  .finally(() => fresh.dispose?.())
              }
              return
            }
            applyGallery(fresh)
            const currentId = positionRef.current?.imageId
            const matched = currentId ? fresh.manifest.images.findIndex((image) => image.id === currentId) : -1
            setFrameKick((kick) => ({ index: matched >= 0 ? matched : 0, nonce: kick.nonce + 1 }))
          }).catch((reason: unknown) => {
            // The revalidation only rejects on an authoritative deletion —
            // the stale copy is already invalidated, so the viewer stops
            // presenting a gallery that no longer exists.
            if (!active) return
            disposeLease()
            currentManifest = null
            currentStatus = 'error'
            setManifest(null)
            setSettings(null)
            setStatus('error')
            setError(reason instanceof Error ? reason.message : 'This gallery is no longer available.')
          })
        })
        .catch((reason: unknown) => {
          if (!active || controller.signal.aborted) return
          if (currentManifest && currentStatus === 'offline') return
          // A keyless encrypted gallery cannot be unlocked in-app; the web
          // sheet shows its locked panel and accepts a pasted full link. A
          // mismatched link lands the same way — the page renders the real
          // gallery's locked state rather than trusting the wrong fragment.
          if (reason instanceof EncryptedSourceLockedError || reason instanceof EncryptedSourceMismatchError) {
            openExternally()
            returnToGalleries()
            return
          }
          currentManifest = null
          currentStatus = 'error'
          setManifest(null)
          setSettings(null)
          setStatus('error')
          setError(
            reason instanceof OfflineGalleryUnavailableError
              ? reason.message
              : reason instanceof Error
                ? reason.message
                : galleryStatusMessage('error'),
          )
        })
    }

    void open()
    const upgradeWhenOnline = () => {
      if (currentStatus === 'offline') void open()
    }
    window.addEventListener('online', upgradeWhenOnline)
    return () => {
      active = false
      controller.abort()
      window.removeEventListener('online', upgradeWhenOnline)
      disposeLease()
    }
  }, [base, offlineStore, selection.owner, selection.slug, selection.galleryId, selection.sourceUrl, galleryPolicies === null, streamOnly])

  // Visibility resolves once per base — it is a day/region answer, not a
  // per-gallery one.
  useEffect(() => {
    let active = true
    void fetchAdVisibility(base).then((answer) => {
      if (active) setVisibility(answer)
    })
    return () => { active = false }
  }, [base])

  // The suppression list is session-gated: only a signed-in operator sees the
  // toggle state. No session quietly means no switch.
  useEffect(() => {
    let active = true
    void (async () => {
      const token = await getSessionToken()
      if (!token || !active) return
      const response = await fetch(`${base}/api/ads/suppressions`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.ok && active) {
        const body = (await response.json()) as { suppressions?: AdSuppression[] }
        setSuppressions(body.suppressions ?? [])
      }
    })().catch(() => {})
    return () => { active = false }
  }, [base])

  /** Commits a tier answer for this session. An omitted or failed response
   *  keeps the last tier this token earned — an explicit Free answer is a
   *  real answer and applies normally. Only a session change clears it. */
  const applyTierAnswer = (token: string, tier: AccountTier | null | undefined) => {
    if (tier) {
      answeredTierRef.current = { token, tier }
      setAccountTier(tier)
      return
    }
    setAccountTier(answeredTierRef.current?.token === token ? answeredTierRef.current.tier : null)
  }

  // An entitlement flip means setUserTier is promoting or demoting rows
  // behind the cached list. The promotion rides a webhook that lands a
  // beat after the store confirms the purchase, so re-pull now for what
  // has already settled and once more past the webhook's usual latency —
  // without this the footer flips to Visionary while the rows keep their
  // Free-era "Temporary gallery" badges until a remount.
  const billingProRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const now = billingState?.isPro
    if (now === undefined || billingProRef.current === undefined) {
      billingProRef.current = now
      return
    }
    if (now === billingProRef.current) return
    billingProRef.current = now
    setAccountRevision((revision) => revision + 1)
    const late = [2000, 6000].map((ms) => setTimeout(() => setAccountRevision((revision) => revision + 1), ms))
    return () => late.forEach(clearTimeout)
  }, [billingState?.isPro])

  // The account area resolves once per base from secure storage; a failed
  // list keeps its section quiet rather than blocking the manual form.
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      const [token, slug] = await Promise.all([getSessionToken(), getOwnerSlug()])
      if (!active) return
      // The local catalogue is on-device state — it reads even while the
      // account calls above are still in flight.
      void loadLocalCatalogue().then((catalogue) => { if (active) setLocalCatalogue(catalogue) }).catch(() => {})
      setOwnerSlug(slug)
      setOwnerSlugDraft(slug ?? '')
      setSignedIn(Boolean(token))
      if (!token) {
        answeredTierRef.current = null
        setAccountTier(null)
        return
      }
      // Register this phone before reading the list, so the response already
      // carries its own pill. Only a device token can register, so a web
      // sign-in never records a device.
      const ownId = await nativeDeviceId()
      if (!active) return
      setDeviceId(ownId)
      await registerDevice(base, ownId, nativeDeviceKindFor()).catch(() => null)
      if (!active) return
      // The plan answer publishes on its own clock — a stalled or missing
      // tier must not hold the gallery lists, the saved-copy pending gate
      // or the list's retry state behind it.
      void fetchAccountTier(base, controller.signal)
        .then((tier) => { if (active) applyTierAnswer(token, tier) })
        .catch(() => { if (active) applyTierAnswer(token, null) })
      const [account, device, identities, deviceList] = await Promise.allSettled([
        fetchAccountGalleries(base, controller.signal),
        fetchDeviceGalleries(base, controller.signal),
        fetchAccountIdentities(base, controller.signal),
        fetchDevices(base, controller.signal),
      ])
      if (!active) return
      setAccountGalleries(account.status === 'fulfilled' ? account.value : null)
      setAccountListFailed(account.status === 'rejected')
      setDeviceGalleries(device.status === 'fulfilled' ? device.value : null)
      setDeviceListFailed(device.status === 'rejected')
      setDevices(deviceList.status === 'fulfilled' ? deviceList.value : [])
      // The greeting borrows the first name the providers handed over; when
      // none came back the URL name stands in.
      if (identities.status === 'fulfilled') {
        setAccountIdentities(identities.value)
        setOwnerName(identities.value.find((identity) => identity.displayName)?.displayName)
      } else {
        setAccountIdentities(null)
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [base, accountRevision])

  // Library-load source freshness (#208): probe each retained source
  // gallery whose check is older than a day and refresh the ones that
  // moved — the same contract the web and desktop Libraries run. 'device'
  // answers run the compare on this shell when it holds the source key
  // and report the verdict back, stamping the shared check. Sequential,
  // every failure swallowed; the server stamp keeps the refetch the loop
  // triggers from re-probing.
  useEffect(() => {
    if (!accountGalleries?.length) return
    const due = accountGalleries.filter((gallery) =>
      gallery.sourceUrl && gallery.retention !== 'pipeline' && sourceCheckDue(gallery.lastSourceCheckAt))
    if (!due.length) return
    let live = true
    const probeEncrypted = async (gallery: GallerySummary): Promise<boolean> => {
      if (!gallery.id) return false
      const source = await resolveEncryptedSourceForSelection(gallery.id)
      // This device holds no key — the honest skip, nothing is reported.
      if (!source) return false
      const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
      const enc = await openEncryptedSource(source)
      try {
        const listing = await enc.listing
        const outcome = deviceListingOutcome(gallery.images, listing)
        await probeAccountGallery(base, gallery.slug, { reported: outcome }).catch(() => null)
        if (outcome !== 'changed') return false
        await refreshGalleryWithManifest(base, gallery.slug, { provider: enc.provider, sourceUrl: enc.sourceUrl, ...listing })
        const galleryId = galleryIds[gallery.slug]
        if (galleryId) libraryLoader.invalidate(galleryId)
        return true
      } finally {
        enc.dispose()
      }
    }
    const probeOne = async (gallery: GallerySummary): Promise<boolean> => {
      const probe = await probeAccountGallery(base, gallery.slug)
      if (!probe?.status) return false
      if (probe.status === 'device') return probeEncrypted(gallery)
      if (probe.status !== 'changed') return false
      await refreshGallery(base, gallery.slug)
      const galleryId = galleryIds[gallery.slug]
      if (galleryId) libraryLoader.invalidate(galleryId)
      return true
    }
    void (async () => {
      let touched = false
      for (const gallery of due) {
        if (!live) return
        try { touched = (await probeOne(gallery)) || touched } catch { /* one gallery's failure never stalls the rest */ }
      }
      if (touched && live) setAccountRevision((revision) => revision + 1)
    })()
    return () => { live = false }
  }, [accountGalleries])

  // App freshness: one release-pointer check on launch — a newer published
  // version becomes the dismissible banner and the Settings row. Dismissal
  // is per-version, so the next release re-arms the notice.
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all([checkAppUpdate(), dismissedUpdateVersion()])
      .then(([update, dismissed]) => { if (live) { setAppUpdate(update); setUpdateDismissed(dismissed) } })
      .catch(() => {})
    return () => { live = false }
  }, [])
  const pendingUpdate = appUpdate && appUpdate.version !== updateDismissed ? appUpdate : null
  const dismissUpdate = () => {
    if (!appUpdate) return
    setUpdateDismissed(appUpdate.version)
    void dismissAppUpdate(appUpdate.version)
  }

  // The encrypted catalog arrives independently of the account request: known
  // saved galleries can paint while the network list is pending or failed.
  useEffect(() => {
    let active = true
    void Promise.all([
      offlineStore.listGalleries(),
      offlineStore.listGridGalleries(),
      productionVault.usage().catch(() => undefined),
    ])
      .then(([list, grid, usage]) => {
        if (!active) return
        setVaultGalleries(new Map(list.map((summary) => [summary.galleryId, summary])))
        setCachedLibraryGalleries(grid)
        setVaultUsageBytes(usage?.measuredBytes)
      })
      .catch(() => {})
    return () => { active = false }
  }, [accountRevision, offlineStore])

  // Each card's vault identity is a digest of owner+slug — computed once per
  // list revision so rail cells can ask for saved bytes by their real key.
  useEffect(() => {
    if (!ownerSlug || !accountGalleries?.length) {
      setGalleryIds({})
      return
    }
    let active = true
    void (async () => {
      const entries = await Promise.all(accountGalleries.map(async (gallery) =>
        [gallery.slug, await offlineGalleryId({ owner: ownerSlug, slug: gallery.slug })] as const))
      if (active) setGalleryIds(Object.fromEntries(entries))
    })().catch(() => {})
    return () => { active = false }
  }, [ownerSlug, accountGalleries])

  const toggleSuppression = async (kind: 'day' | 'region', value: string, suppressed: boolean) => {
    const token = await getSessionToken()
    if (!token) return
    await fetch(`${base}/api/ads/suppressions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, value, suppressed }),
    })
    const [list, answer] = await Promise.all([
      fetch(`${base}/api/ads/suppressions`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => response.ok ? ((await response.json()) as { suppressions?: AdSuppression[] }).suppressions ?? [] : [])
        .catch(() => suppressions ?? []),
      fetchAdVisibility(base),
    ])
    setSuppressions(list)
    setVisibility(answer)
  }

  useEffect(() => {
    if (!manifest) return
    let active = true
    void adFrameFor({ tier: isPro ? 'pro' : 'free', visible: visibility?.show, seedKey: selection.slug }).then((frame) => {
      if (active) setPlate(frame)
    })
    return () => { active = false }
  }, [manifest, isPro, visibility?.show])

  // The account slot asks once per entitlement state, so ordinary re-renders
  // can never rotate the creative while the page is open. Unresolved
  // entitlement makes no request at all: defaulting unknown to Free would
  // flash a returning subscriber an ad they paid to remove. The card's render
  // gate drops the slot the instant Pro is known, and this cleanup marks any
  // resolution still in flight stale — including after an unmount.
  const galleryOpen = Boolean(manifest && settings)
  // Fail-open *and stable*. `fetchAdVisibility` always answers, so an
  // unresolved visibility is not a third state — treating it as `undefined`
  // made the answer landing (undefined -> true) look like a change of
  // entitlement state and asked the loader a second time, rotating the
  // creative under a viewer who had not asked for anything. Only a real
  // suppression moves this value.
  const platesVisible = visibility?.show ?? true
  useEffect(() => {
    if (galleryOpen || !tierKnown) {
      setAccountAd(null)
      return
    }
    let active = true
    void accountAdLoader({
      tier: isPro ? 'pro' : 'free',
      visible: platesVisible,
      seedKey: 'library',
    }).then((frame) => {
      if (active) setAccountAd(frame)
    })
    return () => {
      active = false
      // Leaving the account screen takes the rented rectangle down with it;
      // an overlay outliving its slot would cover a gallery.
      void accountAdAdapter.retire()
    }
  }, [galleryOpen, tierKnown, isPro, platesVisible])

  useEffect(() => {
    // Account controls use the same safe regions as the viewer; they need
    // geometry before any photograph has been opened.
    const sync = () => setFoldLayout(readRuntimeFoldLayout())
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [])

  // The rail swap measures the same box the container queries read — the
  // gallery pane's content width — so a narrow pane (a phone, or one half
  // of a divided fold layout) gets the same filmstrip treatment without
  // guessing from the whole viewport. A callback ref: hono re-invokes it on
  // every prop application, so a stale observer is dropped and re-armed
  // only when the element actually changes.
  const libraryPaneElementRef = useRef<HTMLElement | null>(null)
  const observeLibraryPane = (element: HTMLElement | null) => {
    if (element === libraryPaneElementRef.current) return
    libraryPaneElementRef.current = element
    libraryPaneObserverRef.current?.disconnect()
    libraryPaneObserverRef.current = null
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const style = getComputedStyle(element)
      const inner = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      // Zero is an unlaid-out DOM (hidden pane, non-layout mount) — hold
      // the wide cover treatment until a real measure arrives.
      if (inner > 0) setNarrowLibrary(inner <= 560)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    libraryPaneObserverRef.current = observer
  }
  useEffect(() => () => {
    libraryPaneObserverRef.current?.disconnect()
    libraryPaneObserverRef.current = null
    libraryPaneElementRef.current = null
  }, [])

  // The Library remembers where it was: a live ref tracks the scrolling
  // regions and the last focused control while it is on screen, a saved
  // snapshot freezes them when a surface replaces it, and returning puts
  // them back — plan §1 keeps the exact gallery and scroll position after
  // Settings or a gallery. 'welcome' is a session boundary, not a surface
  // the user can back out of, so its snapshot is dropped.
  const libraryLayoutElementRef = useRef<HTMLElement | null>(null)
  const libraryLiveViewRef = useRef<LibraryViewMemory | null>(null)
  const librarySavedViewRef = useRef<LibraryViewMemory | null>(null)
  const libraryVisible = nav.screen.kind === 'library' && !galleryOpen
  useEffect(() => {
    const onScroll = (event: Event) => {
      const live = libraryLiveViewRef.current
      const target = event.target as HTMLElement | null
      if (!live || !target?.classList) return
      if (target === libraryPaneElementRef.current) live.pane = target.scrollTop
      else if (target.classList.contains('native-library-rail')) live.rail = target.scrollTop
      else if (target.classList.contains('native-library-layout')) live.layout = target.scrollTop
    }
    const onFocusIn = (event: Event) => {
      const live = libraryLiveViewRef.current
      const target = event.target
      if (!live || !(target instanceof HTMLElement)) return
      if (!libraryLayoutElementRef.current?.contains(target)) return
      const selector = libraryFocusSelector(target)
      if (selector) live.focus = selector
    }
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
  // Layout effect: the pane's scroll box has to be re-seated before paint,
  // or the user watches the list land at the top and jump back down.
  useLayoutEffect(() => {
    if (!libraryVisible) {
      if (libraryLiveViewRef.current) {
        librarySavedViewRef.current = nav.screen.kind === 'welcome' ? null : { ...libraryLiveViewRef.current }
        libraryLiveViewRef.current = null
      }
      return
    }
    const saved = librarySavedViewRef.current
    librarySavedViewRef.current = null
    libraryLiveViewRef.current = saved ?? { pane: 0, rail: 0, layout: 0, focus: null }
    const pane = libraryPaneElementRef.current
    const layout = libraryLayoutElementRef.current
    if (!saved || !pane || !layout) return
    pane.scrollTop = saved.pane
    const rail = layout.querySelector('.native-library-rail') as HTMLElement | null
    if (rail) rail.scrollTop = saved.rail
    layout.scrollTop = saved.layout
    // The recorded control may be gone from a refreshed list — land on the
    // pane itself so a screen reader hears where it arrived rather than
    // falling to body.
    const focusTarget = saved.focus ? layout.querySelector(saved.focus) as HTMLElement | null : null
    ;(focusTarget ?? pane).focus({ preventScroll: true })
  }, [libraryVisible, nav.screen.kind])
  // A screen change is a focus change: Settings' own back control is the
  // landing, the same place Back returns from.
  useEffect(() => {
    if (nav.screen.kind !== 'settings') return
    ;(libraryLayoutElementRef.current?.querySelector('[aria-label="Back to the library"]') as HTMLElement | null)?.focus()
  }, [nav.screen.kind])

  useEffect(() => {
    const body = document.body
    const [left, right] = foldLayout?.controlRegions ?? []
    const sideBySide = Boolean(left && right && right.x > left.x + left.width)
    const stacked = Boolean(left && right && right.y > left.y + left.height)
    const divided = Boolean(foldLayout && (sideBySide || stacked))
    const properties = ['--native-fold-x', '--native-fold-y', '--native-fold-width', '--native-fold-height', '--native-fold-right']
    const clear = () => {
      body.removeAttribute('data-native-fold-divided')
      for (const property of properties) body.style.removeProperty(property)
    }
    if (!divided || !foldLayout || !right) return clear
    body.setAttribute('data-native-fold-divided', '')
    body.style.setProperty('--native-fold-x', `${right.x}px`)
    body.style.setProperty('--native-fold-y', `${right.y}px`)
    body.style.setProperty('--native-fold-width', `${right.width}px`)
    body.style.setProperty('--native-fold-height', `${right.height}px`)
    body.style.setProperty('--native-fold-right', `${Math.max(0, foldLayout.viewport.width - right.x - right.width)}px`)
    return clear
  }, [foldLayout])

  const enterGallery = (next: Selection) => {
    positionRef.current = null
    // A bare owner/slug selection still needs custody context for encrypted
    // galleries: resolve the published gallery id from the account list so
    // the key store can find this device's key. Explicit metadata wins, and
    // only the owner's own list can answer — a foreign slug may collide.
    let resolved = next
    if (!resolved.galleryId && !resolved.sourceUrl && resolved.owner === ownerSlug) {
      const summary = accountGalleries?.find((gallery) => gallery.slug === resolved.slug && gallery.manifestVersion === 2 && gallery.id)
      if (summary?.id) resolved = { ...next, galleryId: summary.id }
    }
    setSelection(resolved)
    dispatchNav({ type: 'open-gallery', gallery: { kind: 'published', owner: resolved.owner, slug: resolved.slug } })
  }

  // "Add to Library" on someone else's gallery: the server copies it into
  // this account, the account list refetches, and the copy opens in place.
  const [adoptState, setAdoptState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const adoptResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const adoptOpenGallery = () => {
    if (adoptState === 'busy' || !selection.owner || !selection.slug) return
    if (adoptResetRef.current) clearTimeout(adoptResetRef.current)
    setAdoptState('busy')
    void adoptGallery(base, selection.owner, selection.slug)
      .then((adopted) => {
        setAccountRevision((revision) => revision + 1)
        setAdoptState('idle')
        enterGallery({ owner: adopted.owner, slug: adopted.slug })
      })
      .catch(() => {
        setAdoptState('failed')
        adoptResetRef.current = setTimeout(() => setAdoptState('idle'), 3200)
      })
  }

  const openGlobalFrame = (next: Selection, index: number) => {
    setGlobalViewOpen(false)
    setActivePhotoIndex(index)
    if (next.owner === selection.owner && next.slug === selection.slug) {
      // Same gallery: bump the remount nonce so the viewer re-seeds at index.
      setFrameKick((kick) => ({ index, nonce: kick.nonce + 1 }))
      return
    }
    setFrameKick({ index, nonce: 0 })
    enterGallery(next)
  }

  const returnToGalleries = () => {
    setGlobalViewOpen(false)
    setCameraRollOpen(false)
    dispatchNav({ type: 'open-library' })
    positionRef.current = null
    setManifest(null)
    setSettings(null)
    setSelection({ owner: '', slug: '' })
    setStatus('idle')
    // The fill keeps running after leaving the gallery, but its progress is
    // keyed to the cleared selection — drop it so the status line falls back
    // to the gallery count instead of naming an empty slug.
    setVaultProgress(null)
    setFrameKick({ index: 0, nonce: 0 })
    setAccountRevision((revision) => revision + 1)
  }

  // A local gallery mounts the same shared Viewer: the manifest is built
  // from the on-device record — originals over the file scheme — so the
  // cloud fetch effect never runs for it (the selection stays empty). The
  // root URI is resolved at open because the app container moves between
  // launches; the record itself only ever holds relative paths.
  const enterLocalGallery = async (record: LocalGalleryRecord) => {
    // Claim a generation before the await: a second local open supersedes
    // this one, and dispatchNav bumps it for every other navigation intent,
    // so a stale continuation can neither install its manifest nor surface
    // its error over the newer screen.
    const openToken = ++openGenerationRef.current
    let built: GalleryManifest
    try {
      built = localGalleryManifest(record, await localGalleriesRootUri())
    } catch {
      if (openGenerationRef.current === openToken) setError('The gallery could not be opened.')
      return
    }
    if (openGenerationRef.current !== openToken) return
    positionRef.current = null
    setSelection({ owner: '', slug: '' })
    setVaultProgress(null)
    setManifest(built)
    setSettings(loadGallerySettings(record.id, built))
    setStatus('idle')
    setError(null)
    dispatchNav({ type: 'open-gallery', gallery: { kind: 'local', galleryId: record.id } })
  }

  const addLocalFolder = async () => {
    setAddChooserOpen(false)
    if (localAddBusy) return
    setLocalAddBusy(true)
    setError(null)
    try {
      const result = await addLocalGallery(base)
      if (result.kind === 'added') {
        setLocalCatalogue(await loadLocalCatalogue())
        setAccountRevision((revision) => revision + 1)
      } else if (result.kind === 'empty') {
        setError(`That folder has no photographs manorama can show on ${nativeDeviceLabel()}.`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That folder could not be added')
    } finally {
      setLocalAddBusy(false)
    }
  }

  const confirmRemoveLocal = async () => {
    const record = removeLocalRecord
    if (!record || localAddBusy) return
    setLocalAddBusy(true)
    try {
      await removeLocalGallery(base, record)
      setLocalCatalogue(await loadLocalCatalogue())
      setRemoveLocalRecord(null)
      setAccountRevision((revision) => revision + 1)
    } catch {
      setError('The gallery could not be removed. Try again.')
    } finally {
      setLocalAddBusy(false)
    }
  }

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return
    let active = true
    let remove: (() => Promise<void>) | undefined
    void App.addListener('backButton', () => {
      // A dirty Reorder confirmation owns the back button while it is
      // presented — and asking again while edits are unsaved opens it.
      // Either way the press is swallowed so the editor underneath never
      // closes silently with a draft on screen.
      if (requestReorderClose()) return
      if (cameraRollOpen && navRef.current.screen.kind === 'library' && overlayDepth() === 0) {
        closeCameraRoll()
        return
      }
      const decision = decideBack({
        globalViewOpen,
        viewerModalOpen: document.querySelector('.m-sheet-host') !== null,
        overlayDepth: overlayDepth(),
        nav: navRef.current,
      })
      if (decision === 'close-global') { setGlobalViewOpen(false); return }
      if (decision === 'close-viewer-modal') {
        document.querySelector<HTMLElement>('.m-sheet-host')
          ?.querySelector<HTMLButtonElement>('button[data-close], button[aria-label^="Close"]')?.click()
        return
      }
      if (decision === 'close-overlay') { closeTopOverlay(); return }
      if (decision === 'return-to-library') { returnToGalleries(); return }
      if (decision === 'nav-back') { dispatchNav({ type: 'back' }); return }
      void App.exitApp()
    }).then((listener) => {
      if (active) remove = () => listener.remove()
      else void listener.remove()
    })
    return () => { active = false; void remove?.() }
  }, [globalViewOpen, cameraRollOpen])

  /** The newest intent per gallery, which is what a queued write persists.
   *  State alone lags a tap by a render, and a write that reads it can land
   *  behind a newer choice. */
  const galleryPoliciesRef = useRef<Record<string, GalleryLoadOverride>>({})
  const streamOnlyWrites = useRef(new Map<string, Promise<void>>())
  const vaultSaveAborts = useRef(new Map<string, AbortController>())
  const vaultGalleryOps = useRef(new Map<string, Promise<void>>())
  /** Keep ON means the copy should exist — fetch the manifest and start the
   *  fill now, with progress the switch row and the Library finding can both
   *  report. A newer tap replaces the controller, so only one fill per
   *  gallery ever runs. */
  const saveGalleryToVault = async (target: Selection, galleryId: string) => {
    vaultSaveAborts.current.get(target.slug)?.abort()
    const controller = new AbortController()
    vaultSaveAborts.current.set(target.slug, controller)
    const note = (completed: number, total: number) =>
      total > 0 ? `Saving ${completed} of ${total} photos to your encrypted vault…` : 'Preparing offline copy…'
    setVaultSave({ owner: target.owner, slug: target.slug, completed: 0, total: 0, note: note(0, 0) })
    try {
      const gallery = await fetchGallery(base, target.owner, target.slug, controller.signal)
      // Custody is indexed by the immutable server id — the selection's
      // digest id only names the vault record, and the summary's sourceUrl
      // is keyless and can never open a session on its own.
      const serverGalleryId = accountGalleriesRef.current?.find((item) => item.slug === target.slug)?.id
      const custodyUrl = serverGalleryId ? await resolveEncryptedSourceForSelection(serverGalleryId).catch(() => null) : null
      const selection = { owner: target.owner, slug: target.slug, galleryId, sourceUrl: custodyUrl ?? target.sourceUrl }
      const encryptedSession = gallery.manifest.images.some((image) => !isVideoItem(image) && image.media?.kind === 'encrypted')
        ? await openNativeEncryptedSession(selection, gallery.manifest.sourceUrl)
        : undefined
      let result: OfflineCacheResult
      try {
        result = await offlineStore.cache(
          selection,
          gallery,
          controller.signal,
          (progress) => setVaultSave({ owner: target.owner, slug: target.slug, completed: progress.completed, total: progress.total, note: note(progress.completed, progress.total) }),
          undefined,
          encryptedSession,
        )
      } finally {
        // A session opened only for this fill closes when it settles —
        // success, failure and cancellation alike.
        encryptedSession?.dispose()
      }
      if (result.status === 'complete') {
        // Re-list the vault so the saved badge, the Keep row's Saved value
        // and the footer count all pick the copy up.
        setAccountRevision((revision) => revision + 1)
        setGalleryActionNote(`Saved on ${nativeDeviceLabel()} — encrypted, viewable only in manorama.`)
      } else if (result.status === 'skipped-encrypted') {
        setGalleryActionNote('This gallery cannot be saved on this device — its encrypted form predates the vault.')
      } else if (result.status === 'over-cap') {
        setGalleryActionNote('This gallery is larger than the encrypted vault can hold — raise the limit in Settings.')
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setGalleryActionNote(error instanceof Error ? error.message : 'That gallery could not be saved on this device')
      }
    } finally {
      if (vaultSaveAborts.current.get(target.slug) === controller) {
        vaultSaveAborts.current.delete(target.slug)
        setVaultSave((current) => (current?.slug === target.slug ? null : current))
      }
    }
  }
  const changeGalleryStreamOnly = async (enabled: boolean, target: Selection = selection) => {
    const key = galleryPolicyKey(target.owner, target.slug)
    const before = galleryPoliciesRef.current[key]
    const override: GalleryLoadOverride = enabled ? 'stream' : 'vault'
    // Optimistic: the checkbox follows the tap immediately.
    const next = { ...galleryPoliciesRef.current, [key]: override }
    galleryPoliciesRef.current = next
    setGalleryPolicies(next)
    // One write in flight per gallery, each persisting the newest intent
    // rather than a snapshot of a moment that has already passed.
    const queued = (streamOnlyWrites.current.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => saveGalleryStreamOnly({ ...galleryPoliciesRef.current }))
      .catch(() => {
        // Step back only if nothing newer has been chosen since.
        if (galleryPoliciesRef.current[key] === override) {
          const rolledBack = { ...galleryPoliciesRef.current }
          if (before === undefined) delete rolledBack[key]
          else rolledBack[key] = before
          galleryPoliciesRef.current = rolledBack
          setGalleryPolicies(rolledBack)
        }
        setVaultNote('This device preference could not be saved. Please try again.')
      })
    streamOnlyWrites.current.set(key, queued)
    await queued
    // Stream is a deletion choice, not just a future-downloads one: the
    // copy the vault was keeping goes with the policy, as the switch's
    // supporting text states. Skipped when a newer choice already moved
    // the key back to vault.
    // The vault mutation serialises per gallery behind the policy write:
    // a purge a queued OFF tap ordered must finish before this save runs,
    // and the save re-reads intent and completeness when its turn comes —
    // state read inside the chain comes from the refs, never this render.
    const vaultOp = (vaultGalleryOps.current.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const galleryId = target.galleryId ?? galleryIds[target.slug]
          ?? await offlineGalleryId({ owner: target.owner, slug: target.slug }).catch(() => undefined)
        if (enabled) {
          vaultSaveAborts.current.get(target.slug)?.abort()
          setVaultSave((current) => (current?.slug === target.slug ? null : current))
          if (galleryId && galleryPoliciesRef.current[key] === 'stream') {
            try {
              await offlineStore.purgeGallery(galleryId)
              libraryLoader.invalidate(galleryId)
              setCachedLibraryGalleries((previous) => previous.filter((item) => item.galleryId !== galleryId))
              setVaultGalleries((previous) => {
                const next = new Map(previous)
                next.delete(galleryId)
                return next
              })
              setVaultNote('Saved copy removed from this device')
            } catch {
              setVaultNote('The saved copy could not be removed')
            }
          }
        } else if (galleryPoliciesRef.current[key] === 'vault') {
          // Keep is a save choice, not only a future-opens one — start the
          // fill now unless a complete copy already sits in the vault. A
          // copy the queued purge just removed no longer counts, and one
          // already covering every published item skips the download.
          const cached = galleryId ? vaultGalleriesRef.current.get(galleryId) : undefined
          const summary = accountGalleriesRef.current?.find((item) => item.slug === target.slug)
          const complete = cached && summary ? savedCopyComplete(cached, summary) : cached?.status === 'cached'
          if (galleryId && !complete) void saveGalleryToVault(target, galleryId)
        }
      })
    vaultGalleryOps.current.set(key, vaultOp)
    await vaultOp
  }

  const openReorderFor = (
    gallery: { owner: string; slug: string; title: string },
    from: 'library' | 'details' = 'library',
  ) => {
    setEditorGallery(gallery)
    dispatchNav({ type: 'open-reorder', gallery: { kind: 'published', owner: gallery.owner, slug: gallery.slug }, from })
  }

  const reloadOpenGallery = async () => {
    if (!manifest) return
    const opening = { ...selection }
    const next = await fetchGallery(base, opening.owner, opening.slug)
    const current = selectionRef.current
    if (current.owner !== opening.owner || current.slug !== opening.slug) return
    const currentId = positionRef.current?.imageId
    const currentIndex = positionRef.current?.index ?? 0
    const matched = currentId ? next.manifest.images.findIndex((image) => image.id === currentId) : -1
    const nextIndex = matched >= 0 ? matched : Math.min(currentIndex, Math.max(0, next.manifest.images.length - 1))
    setManifest(next.manifest)
    setSettings(next.settings)
    // Remount only to re-seed the changed manifest. The body remains entered,
    // so Back from Details never produces another curtain.
    setFrameKick((kick) => ({ index: nextIndex, nonce: kick.nonce + 1 }))
  }

  const galleryChanged = async (updated: GallerySummary) => {
    setAccountGalleries((previous) => previous?.map((item) => item.slug === updated.slug ? updated : item) ?? null)
    if (manifest && selection.slug === updated.slug) {
      try { await reloadOpenGallery() } catch { /* the server write already landed */ }
    }
  }

  const shareGallery = async (gallery: GallerySummary) => {
    if (!ownerSlug) return
    let hash = ''
    if (gallery.manifestVersion === 2 && gallery.id) {
      const source = await resolveEncryptedSourceForSelection(gallery.id)
      if (!source) {
        setGalleryActionNote('This device does not hold the key. Open the full gallery link before sharing it.')
        return
      }
      hash = galleryHashForSource(source, gallery.id)
    }
    const payload: GallerySharePayload = {
      title: galleryName(gallery),
      caption: gallery.caption ?? '',
      url: `https://manorama.xyz/${ownerSlug}/${gallery.slug}${hash}`,
    }
    const copied = await copyText(payload.url)
    if (!copied) setSharePayload(payload)
    else setGalleryActionNote('Link copied')
  }

  /** Opens the photograph picker for a post to X. The post carries the
   *  gallery's own address, so the gallery has to be reachable — an encrypted
   *  gallery needs the key this device already holds. */
  const openPostToX = async (gallery: GallerySummary) => {
    if (!ownerSlug) return
    postToXIdRef.current++
    let hash = ''
    if (gallery.manifestVersion === 2 && gallery.id) {
      const source = await resolveEncryptedSourceForSelection(gallery.id)
      if (!source) {
        setGalleryActionNote('This device does not hold the key. Open the full gallery link before posting to X.')
        return
      }
      hash = galleryHashForSource(source, gallery.id)
    }
    setPostToX({
      gallery,
      url: `https://manorama.xyz/${ownerSlug}/${gallery.slug}${hash}`,
      // The device's own vault identity for this gallery — the copies an
      // encrypted source keeps on the phone.
      galleryId: galleryIds[gallery.slug] ?? '',
    })
  }

  /** The decryption session for an encrypted gallery's source, opened once and
   *  held for the length of the picker. The provider SDK arrives behind a
   *  dynamic import, so it never enters the Worker graph.
   *
   *  The open is asynchronous and the picker is not: a close or a new picker
   *  while the session is still being negotiated must retire the late one
   *  rather than keep it, and a session is handed out only to the picker
   *  that asked for it — `postToXIdRef` marks which launch is live. */
  const encryptedSessionRef = useRef<EncryptedClientSession | null>(null)
  const encryptedSessionOpeningRef = useRef<{ galleryId: string; promise: Promise<EncryptedClientSession | null> } | null>(null)
  const postToXIdRef = useRef(0)
  const encryptedSession = async (): Promise<EncryptedClientSession | null> => {
    const galleryId = postToX?.gallery.id
    if (!galleryId) return null
    const picker = postToXIdRef.current
    if (encryptedSessionRef.current) return encryptedSessionRef.current
    let opening = encryptedSessionOpeningRef.current
    if (!opening || opening.galleryId !== galleryId) {
      const promise = (async () => {
        const source = await resolveEncryptedSourceForSelection(galleryId).catch(() => null)
        if (!source) return null
        const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
        return openEncryptedSource(source)
      })()
      opening = { galleryId, promise }
      encryptedSessionOpeningRef.current = opening
      void promise.finally(() => {
        if (encryptedSessionOpeningRef.current === opening) encryptedSessionOpeningRef.current = null
      })
    }
    const session = await opening.promise
    if (postToXIdRef.current !== picker) {
      session?.dispose()
      return null
    }
    encryptedSessionRef.current = session
    return session
  }

  /** Decrypts one photograph for a post. An encrypted source has no address,
   *  so this is the only way its bytes reach the export. */
  const materializeEncryptedPhoto = async (photo: PostToXPhoto): Promise<PostPhotoBytes | undefined> => {
    if (!photo.media || photo.media.kind !== 'encrypted') return undefined
    const session = await encryptedSession().catch(() => null)
    if (!session) return undefined
    const materialized = await session.materialize(photo.media, false)
    return { bytes: materialized.bytes, mimeType: materialized.mimeType }
  }

  const closePostToX = () => {
    postToXIdRef.current++
    encryptedSessionRef.current?.dispose()
    encryptedSessionRef.current = null
    // A later launch opens its own session rather than inheriting this
    // in-flight promise — its waiter would otherwise install a session the
    // stale waiter is about to dispose.
    encryptedSessionOpeningRef.current = null
    setPostToX(null)
  }

  /** "View source" opens the provider folder in the in-app browser. An
   *  encrypted gallery's stored URL is keyless, so the provider link is
   *  resolved from this device's key custody — the same rule the macOS
   *  settings sheet applies. */
  const viewGallerySource = async (gallery: GallerySummary) => {
    if (gallery.manifestVersion === 2 && gallery.id) {
      const source = await resolveEncryptedSourceForSelection(gallery.id).catch(() => null)
      if (!source) {
        setGalleryActionNote('This device does not hold the key; the source cannot be opened here.')
        return
      }
      openExternal(source)
      return
    }
    if (gallery.sourceUrl) openExternal(gallery.sourceUrl)
  }

  const currentGallerySummary = accountGalleries?.find((gallery) => gallery.slug === selection.slug)
  const detailsSlug = nav.screen.kind === 'details' && nav.screen.gallery.kind === 'published' ? nav.screen.gallery.slug : undefined
  const detailsSummary = detailsSlug
    ? accountGalleries?.find((gallery) => gallery.slug === detailsSlug)
    : undefined
  const detailsGalleryId = detailsSummary ? galleryIds[detailsSummary.slug] : undefined
  const detailsFromViewer = nav.screen.kind === 'details' && nav.screen.from === 'viewer'
  const detailsStreamOnly = detailsSummary && ownerSlug
    ? (galleryPolicies?.[galleryPolicyKey(ownerSlug, detailsSummary.slug)] ?? DEFAULT_VAULT_LOAD_POLICY) === 'stream'
    : false
  /** The one removal path — the card menu no longer deletes; Gallery
   *  settings' "Remove from Library" row lands here after its sheet
   *  confirms, so the server row, the encrypted key, the media loader and
   *  the account list all move together. Declared before the conditional
   *  Viewer return so its onDelete callback resolves on that path too. */
  const deleteAccountGallery = async (gallery: GallerySummary) => {
    const token = await getSessionToken()
    if (!token) throw new Error('Sign in to manage this gallery.')
    const response = await fetch(`${base}/api/galleries/${encodeURIComponent(gallery.slug)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    const payload = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(payload.error || 'The gallery could not be removed')
    // The server row is already gone at this point — a key-removal
    // failure must not skip the list updates below or masquerade as a
    // failed delete. Its outcome only changes the closing note.
    let keyRemoved = true
    if (gallery.id) {
      try {
        await removeEncryptedSourceForSelection(gallery.id)
      } catch {
        keyRemoved = false
      }
    }
    const galleryId = galleryIds[gallery.slug]
    if (galleryId) libraryLoader.invalidate(galleryId)
    setAccountGalleries((previous) => previous?.filter((item) => item.slug !== gallery.slug) ?? null)
    setAccountRevision((revision) => revision + 1)
    setGalleryActionNote(keyRemoved
      ? 'Gallery removed. Your cloud files were not changed.'
      : 'Gallery removed, but its key could not be removed from this device — sign out to clear remaining keys.')
  }
  const openSelection = (owner: string, slug: string) => {
    setFrameKick({ index: 0, nonce: 0 })
    enterGallery({ owner, slug })
  }

  /** A rail tap opens at the tapped photograph, not at the first. */
  const openSelectionAt = (owner: string, slug: string, index: number) => {
    setFrameKick({ index, nonce: 0 })
    enterGallery({ owner, slug })
  }

  const detailsView = detailsSummary && ownerSlug ? (
    <GalleryDetails
      apiBase={base}
      owner={ownerSlug}
      gallery={detailsSummary}
      streamOnly={detailsStreamOnly}
      vaultNote={
        selection.slug === detailsSummary.slug ? vaultNote
        : vaultSave?.slug === detailsSummary.slug ? vaultSave.note ?? undefined
        : undefined
      }
      vaultProgress={
        selection.slug === detailsSummary.slug ? vaultProgress
        : vaultSave?.slug === detailsSummary.slug && vaultSave.total > 0 ? { completed: vaultSave.completed, total: vaultSave.total }
        : null
      }
      hasSavedCopy={detailsGalleryId ? savedCopyComplete(vaultGalleries.get(detailsGalleryId), detailsSummary) : false}
      backLabel={detailsFromViewer ? 'Back' : 'Library'}
      backAriaLabel={detailsFromViewer ? `Back to ${galleryName(detailsSummary)}` : undefined}
      rail={(
        <LibraryRail
          preview
          galleryId={detailsGalleryId ?? ''}
          images={detailsSummary.images}
          loader={libraryLoader}
          title={galleryName(detailsSummary)}
          onOpen={(index) => openSelectionAt(ownerSlug, detailsSummary.slug, index)}
        />
      )}
      deviceStatus={(
        <LibraryDeviceStatus
          galleryId={detailsGalleryId ?? ''}
          imageCount={(() => { const published = summaryMediaCount(detailsSummary); return published.stills + published.videos })()}
          streamOnly={detailsStreamOnly}
          summary={detailsGalleryId ? vaultGalleries.get(detailsGalleryId) : undefined}
        />
      )}
      onBack={() => dispatchNav({ type: 'back' })}
      onOpen={() => {
        if (nav.screen.kind === 'details' && nav.screen.from === 'viewer') {
          dispatchNav({ type: 'back' })
          return
        }
        setFrameKick({ index: 0, nonce: 0 })
        enterGallery({ owner: ownerSlug, slug: detailsSummary.slug })
      }}
      onOpenSource={detailsSummary.sourceUrl ? () => { void viewGallerySource(detailsSummary) } : undefined}
      onReorder={() => openReorderFor({ owner: ownerSlug, slug: detailsSummary.slug, title: galleryName(detailsSummary) }, 'details')}
      onStreamOnlyChange={(next) => { void changeGalleryStreamOnly(next, { owner: ownerSlug, slug: detailsSummary.slug, galleryId: detailsGalleryId, sourceUrl: detailsSummary.sourceUrl ?? undefined }) }}
      onChanged={galleryChanged}
      onDelete={() => deleteAccountGallery(detailsSummary)}
      onRemoved={returnToGalleries}
    />
  ) : null
  const shareFallback = sharePayload ? (
    <GalleryShareSheet
      payload={sharePayload}
      onClose={() => setSharePayload(null)}
      onCopy={async (url) => {
        const copied = await copyText(url)
        if (copied) setGalleryActionNote('Gallery link copied')
        return copied
      }}
    />
  ) : null

  /** Forget a device: the account drops it and so do the Local gallery rows
   *  it published — they are the same fact. A device still in use registers
   *  again on its next launch with a fresh number and colour. */
  const forgetDeviceRow = async (device: Device) => {
    if (forgetDeviceBusy) return
    setForgetDeviceBusy(true)
    try {
      await forgetDevice(base, device.id)
      setDevices((current) => current.filter((row) => row.id !== device.id))
      setDeviceGalleries((current) => current ? current.filter((row) => row.deviceId !== device.id) : current)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That device could not be forgotten.')
    } finally {
      setForgetDeviceBusy(false)
    }
  }

  const unlinkIdentity = async (provider: string) => {
    if (identityBusy) return
    if (accountIdentities && accountIdentities.length <= 1) {
      setIdentityNote('Keep at least one way to sign in.')
      return
    }
    setIdentityBusy(true)
    setIdentityNote(null)
    try {
      await unlinkAccountIdentity(base, provider)
      const remaining = (accountIdentities ?? []).filter((identity) => identity.provider !== provider)
      setAccountIdentities(remaining)
      setOwnerName(remaining.find((identity) => identity.displayName)?.displayName)
      setIdentityNote(`${provider === 'google' ? 'Google' : provider === 'apple' ? 'Apple' : 'Dropbox'} unlinked.`)
    } catch (reason) {
      setIdentityNote(reason instanceof Error ? reason.message : 'That sign-in method could not be removed.')
    } finally {
      setIdentityBusy(false)
    }
  }

  const linkIdentity = async (provider: string) => {
    if (identityBusy) return
    setIdentityNote(null)
    // A fresh attempt retires the previous link's result, so the conflict
    // line it left behind clears here rather than outliving its context.
    onClearLinkConflict?.()
    setIdentityBusy(true)
    let listener: { remove: () => Promise<void> } | undefined
    try {
      listener = await Browser.addListener('browserFinished', () => {
        setAccountRevision((revision) => revision + 1)
        void listener?.remove()
      })
      await beginProviderSignIn(provider as AuthProvider, base, true)
    } catch (reason) {
      void listener?.remove()
      setIdentityNote(reason instanceof Error ? reason.message : 'That sign-in method could not be connected.')
    } finally {
      setIdentityBusy(false)
    }
  }

  const suspendedViewer =
    (nav.screen.kind === 'details' ||
      (nav.screen.kind === 'reorder' && nav.screen.detailsFrom === 'viewer')) &&
    nav.viewer !== null

  if (manifest && settings) {
    const source = new BundledSource(manifest)
    const renderFold = ({ frames, activeIndex, segments, dpr, renderVideo, onImageLoad }: {
      frames: readonly GalleryMediaItem[]
      activeIndex: number
      segments: NonNullable<FoldLayout>['segments']
      dpr: number
      renderVideo: (video: VideoItem, context: { width: number; height: number; active: boolean }) => unknown
      onImageLoad: (id: string, src: string, width: number, height: number) => void
    }) => {
      const diptychFrames: DiptychFrame[] = frames.map((image) => ({
        id: image.id,
        src: image.src,
        width: image.width,
        height: image.height,
        alt: image.alt,
        placeholder: image.placeholder,
        video: isVideoItem(image) ? image : undefined,
      }))
      return <Diptych frames={diptychFrames} segments={segments} dpr={dpr} activeIndex={activeIndex} background="transparent" renderVideo={renderVideo} onImageLoad={onImageLoad} />
    }
    return (
      <>
        <GalleryShell settings={settings} status={status === 'offline' ? galleryStatusMessage(status) : undefined} mediaCount={mediaCountOf(source.list())}>
          <Viewer
            key={`${manifest.slug}:${frameKick.nonce}`}
            slug={manifest.slug}
            galleryTitle={manifest.title}
            images={source.list()}
            encryptedResolver={leaseRef.current?.encryptedResolver ?? null}
            settings={settings}
            plate={plate}
            onReturnToGalleries={returnToGalleries}
            allowFullscreen={false}
            suspended={suspendedViewer}
            onPositionChange={(position) => { positionRef.current = position }}
            onOpenDetails={currentGallerySummary && ownerSlug === selection.owner ? () => {
              dispatchNav({ type: 'open-details', gallery: { kind: 'published', owner: selection.owner, slug: selection.slug }, from: 'viewer' })
            } : undefined}
            onAddToLibrary={ownerSlug && selection.owner && selection.owner !== ownerSlug ? adoptOpenGallery : undefined}
            addToLibraryBusy={adoptState === 'busy'}
            addToLibraryLabel={adoptState === 'busy' ? 'Adding…' : adoptState === 'failed' ? 'Couldn’t add — try again' : undefined}
            onOpenGlobalView={(index = 0) => {
              setActivePhotoIndex(index)
              setGlobalViewOpen(true)
            }}
            // Embedded IPTC/XMP is read lazily from the file scheme when a
            // still's Info sheet opens — local galleries only; the range
            // handler answers 206 for these URLs (Capacitor WebViewAssetHandler).
            readMetadata={nav.viewer?.gallery.kind === 'local'
              ? (image) => readEmbeddedMetadata(fetchRangeReader(image.src))
              : undefined}
            initialIndex={frameKick.index}
            foldLayout={foldLayout}
            foldRenderer={renderFold}
            {...chromeProps}
          />
        </GalleryShell>
        {suspendedViewer && nav.screen.kind === 'details' ? detailsView : null}
        {suspendedViewer && nav.screen.kind === 'reorder' && editorGallery ? (
          <GalleryEditor
            owner={editorGallery.owner}
            slug={editorGallery.slug}
            title={editorGallery.title}
            apiBase={apiBase}
            onClose={() => { setEditorGallery(null); dispatchNav({ type: 'back' }) }}
            onSaved={() => {
              setAccountRevision((revision) => revision + 1)
              void reloadOpenGallery()
            }}
          />
        ) : null}
        {shareFallback}
        {globalViewOpen ? (
          <GlobalView
            store={offlineStore}
            onlineGallery={{ selection, manifest }}
            downloadNote={vaultNote}
            tier={globalViewEnabled === true ? effectiveTier : 'free'}
            current={selection}
            active={{ selection, index: positionRef.current?.index ?? activePhotoIndex }}
            onOpenFrame={openGlobalFrame}
            onClose={() => setGlobalViewOpen(false)}
          />
        ) : null}
        {/* Action notes must reach the owner in the Viewer branch too —
            a View-source or Keep failure reported from inside gallery
            settings cannot wait for a return to Library. */}
        {galleryActionNote ? <div class="admin-toast" role="status">{galleryActionNote}</div> : null}
      </>
    )
  }

  if (nav.screen.kind === 'visionary' && billing) {
    return <Paywall billing={billing} onClose={() => dispatchNav({ type: 'back' })} onOpenPrivacy={() => dispatchNav({ type: 'open-privacy', from: 'visionary' })} />
  }

  if (nav.screen.kind === 'privacy') {
    return <Privacy
      onBack={() => dispatchNav({ type: 'back' })}
      backLabel={nav.screen.from === 'settings' ? 'Settings' : 'Back'}
      onOpenExternal={openExternal}
      onPrint={printSupported() ? () => window.print() : undefined}
    />
  }

  const signOut = async () => {
    libraryLoader.release()
    cacheFillRegistry.reset()
    dispatchNav({ type: 'signed-out' })
    try {
      await clearAllEncryptedSources()
    } catch {
      // A failed verified purge must not trap sign-out — surviving keys
      // stay in the registry and are retried by the next purge.
    }
    await clearSessionToken()
    try {
      await billing?.signOut()
    } catch {
      // A RevenueCat sign-out failure must not trap the manorama session.
    }
    if (typeof window !== 'undefined') window.location.reload()
  }

  const changeGlobalView = async (next: boolean) => {
    const previous = globalViewEnabled
    setGlobalViewEnabled(next)
    setGlobalViewSaving(true)
    try {
      await saveGlobalViewEnabled(next)
    } catch {
      setGlobalViewEnabled(previous)
      setError('The photo picker preference could not be saved on this device.')
    } finally {
      setGlobalViewSaving(false)
    }
  }

  /** Secure storage normally holds the URL name, but a session minted before
   *  slug persistence (or a wiped store) leaves it empty — ask the identities
   *  endpoint before letting the confirm ride blank. */
  const recoverOwnerSlug = async (): Promise<string | undefined> => {
    const slug = await fetchAccountOwnerSlug(base).catch(() => undefined)
    if (slug) {
      try { await persistOwnerSlug(slug) } catch { /* persistence is nice-to-have */ }
      setOwnerSlug(slug)
      setOwnerSlugDraft(slug)
    }
    return slug
  }

  /** The dashboard's custom-URL edit: typing a new address PATCHes the
   *  account, then the stored slug and the greeting both follow. */
  const saveOwnerSlug = async () => {
    const value = ownerSlugDraft.trim().toLowerCase()
    if (!value || value === ownerSlug) {
      setOwnerSlugDraft(ownerSlug ?? '')
      return
    }
    // The conflict note sits ahead of slugNote in Settings — clear it when a
    // real save begins so its answer is not masked by a stale link result.
    onClearLinkConflict?.()
    try {
      const saved = await renameOwnerSlug(base, value)
      setOwnerSlug(saved)
      setOwnerSlugDraft(saved)
      try { await persistOwnerSlug(saved) } catch { /* persistence is nice-to-have */ }
      setSlugNote(`Your address is now manorama.xyz/${saved}`)
    } catch (reason) {
      setSlugNote(reason instanceof Error ? reason.message : 'That URL could not be saved')
      setOwnerSlugDraft(ownerSlug ?? '')
    }
  }

  const openDeleteConfirm = () => {
    setDeleteConfirming(true)
    setDeleteError(null)
    if (!ownerSlug) void recoverOwnerSlug().then((slug) => {
      if (!slug) setDeleteError('Your URL name could not be recovered — sign out and back in, then try again.')
    })
  }

  const deleteAccountForever = async () => {
    setDeleteError(null)
    setDeleting(true)
    // The account row may already be gone from an earlier attempt — the
    // error below must not report "could not be deleted" in that state.
    let deletedNow = accountDeleted
    try {
      // The API gates on the typed URL name; the app sends the slug it
      // already holds instead of making the owner retype it.
      const slug = ownerSlug ?? (await recoverOwnerSlug())
      if (!slug) {
        setDeleteError('Your URL name could not be recovered — sign out and back in, then try again.')
        setDeleting(false)
        return
      }
      if (!deletedNow) {
        await deleteAccount(base, slug)
        setAccountDeleted(true)
        deletedNow = true
      }
      try {
        await clearAllEncryptedSources()
      } catch {
        // Same rule as sign-out: a failed verified purge must not trap the
        // session teardown — surviving keys stay in the registry for the
        // next purge.
      }
      await clearSessionToken()
      try {
        await billing?.signOut()
      } catch {
        // The account is already gone, but the subscription obligation may
        // live on — say so and let the owner retry the cleanup instead of
        // reloading as though it finished.
        setDeleteError('Your account is deleted, but billing sign-out did not finish — cancel any subscription (App Store: Settings › Subscriptions; web: your Stripe receipt) and try again.')
        setDeleting(false)
        return
      }
      if (typeof window !== 'undefined') window.location.reload()
    } catch (reason) {
      setDeleteError(
        deletedNow
          ? 'Your account is deleted, but removing its data from this device did not finish — try again.'
          : reason instanceof Error && reason.message.trim()
            ? reason.message
            : 'Your account could not be deleted right now',
      )
      setDeleting(false)
    }
  }

  const retryAccountLists = () => setAccountRevision((revision) => revision + 1)
  // Verify runs the same dry scan the create endpoint will run again —
  // a second provider call is the price of not asking for metadata on a
  // link that was never going to work.
  const addVerifySeq = useRef(0)
  const addVerifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resetAddVerification = () => {
    if (addVerifyTimer.current) clearTimeout(addVerifyTimer.current)
    addVerifySeq.current += 1
    setAddVerifiedTitle(null)
    setAddChecking(false)
  }
  const verifyAddUrl = async (url: string) => {
    const seq = ++addVerifySeq.current
    setAddChecking(true)
    try {
      const scan = await (async () => {
        if (!isEncryptedSourceUrl(url)) return scanSourceUrl(base, url)
        const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
        const session = await openEncryptedSource(url)
        try { return { title: (await session.listing).title } } finally { session.dispose() }
      })()
      if (seq !== addVerifySeq.current) return
      setError(null)
      setAddVerifiedTitle(scan.title)
      // The scanned name pre-fills only an untouched field — a name the
      // owner typed while the scan was in flight is never clobbered.
      setSourceName((current) => current.trim() ? current : scan.title)
    } catch (reason) {
      if (seq === addVerifySeq.current) {
        setAddVerifiedTitle(null)
        setError(reason instanceof Error ? reason.message : 'That link could not be checked — try again')
      }
    } finally {
      if (seq === addVerifySeq.current) setAddChecking(false)
    }
  }
  const onAddUrlChange = (value: string) => {
    setSourceUrl(value)
    setError(null)
    resetAddVerification()
    const url = value.trim()
    // A plausible URL earns a debounced verify; anything shorter still
    // reads as "typing" and costs no request.
    if (/^https?:\/\/\S+\.\S+/.test(url)) {
      addVerifyTimer.current = setTimeout(() => void verifyAddUrl(url), 700)
    }
  }
  const onAddUrlCommit = (value: string) => {
    setSourceUrl(value)
    setError(null)
    resetAddVerification()
    const url = value.trim()
    if (/^https?:\/\/\S+\.\S+/.test(url)) void verifyAddUrl(url)
  }

  const importCloudGallery = async (input: { url: string; name: string; caption: string }) => {
    const url = input.url.trim()
    // The in-flight ref also closes the gap before the disabled state paints.
    if (!url || quickAddBusy || pendingQuickAdd || quickAddInFlight.current) return
    const flight = `ordinary:${url}`
    quickAddInFlight.current = flight
    setQuickAddBusy(true)
    setError(null)
    try {
      const next = await (isEncryptedSourceUrl(url)
        ? createEncryptedGallery(base, url, { title: input.name, caption: input.caption })
        : createGalleryFromSource(base, url, { title: input.name, caption: input.caption }))
      if (quickAddInFlight.current !== flight) return
      setSourceUrl('')
      setSourceName('')
      setSourceCaption('')
      resetAddVerification()
      setAddOpen(false)
      setFrameKick({ index: 0, nonce: 0 })
      enterGallery(next)
      setAccountRevision((revision) => revision + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That cloud folder could not be turned into a gallery')
    } finally {
      if (quickAddInFlight.current === flight) {
        quickAddInFlight.current = null
        setQuickAddBusy(false)
      }
    }
  }
  // Missing retention is retained — the server's retentionOf and
  // countRetainedGalleries agree that only an explicit 'pipeline' is
  // temporary.
  const retainedAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention !== 'pipeline') ?? []
  const temporaryAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention === 'pipeline') ?? []
  // Subscription limits control retention/editing, never whether an owner can see a gallery.
  const visibleAccountGalleries = accountGalleries?.filter((gallery) => !gallery.hiddenAt) ?? []
  const hiddenAccountGalleries = accountGalleries?.filter((gallery) => gallery.hiddenAt) ?? []
  const accountLayout = libraryLayout(visibleAccountGalleries, effectiveTier)
  const accountBySlug = new Map(visibleAccountGalleries.map((gallery) => [gallery.slug, gallery]))
  const menuGallery = openMenuSlug ? accountGalleries?.find((gallery) => gallery.slug === openMenuSlug) : undefined
  // This phone's own records render from the catalogue, so their synced
  // mirror rows must not double as standalone tiles.
  const localIds = new Set(localCatalogue?.galleries.map((gallery) => gallery.id) ?? [])
  const ownLocalGalleries = localCatalogue?.galleries.filter((gallery) => !gallery.hiddenAt) ?? []
  const standaloneDeviceGalleries = deviceGalleries?.filter((gallery) =>
    !localIds.has(gallery.id) &&
    (!gallery.publicGallerySlug || !accountGalleries?.some((published) => published.slug === gallery.publicGallerySlug))) ?? []
  const galleryLimit = retainedGalleryLimit(effectiveTier)
  // A downgrade never evicts retained galleries, so the count can exceed the
  // tier's cap — the allowance sentence clamps permanent to the cap and
  // reads the overflow as temporary rather than "7 of 3".
  const allowance = retainedAllowanceCounts(effectiveTier, retainedAccountGalleries.length, temporaryAccountGalleries.length)
  const accountName = ownerName ?? ownerSlug ?? 'friend'
  const galleryRegion = foldLayout?.controlRegions[0]
  const libraryControlRegion = foldLayout?.controlRegions[1]
  const dividedLibrary = foldLayout?.mode === 'diptych' && Boolean(galleryRegion && libraryControlRegion)
  const libraryRegionStyle = (region: NonNullable<typeof galleryRegion> | undefined) => dividedLibrary && region ? {
    position: 'absolute', left: `${region.x}px`, top: `${region.y}px`,
    width: `${region.width}px`, height: `${region.height}px`,
  } : undefined
  const librarySafeStyle = !dividedLibrary && galleryRegion && foldLayout ? {
    paddingTop: `${galleryRegion.y}px`, paddingLeft: `${galleryRegion.x}px`,
    paddingRight: `${Math.max(0, foldLayout.viewport.width - galleryRegion.x - galleryRegion.width)}px`,
    paddingBottom: `${Math.max(0, foldLayout.viewport.height - galleryRegion.y - galleryRegion.height)}px`,
  } : undefined
  const toggleGalleryPin = async (gallery: GallerySummary) => {
    if (galleryActionBusy) return
    setOpenMenuSlug(null)
    setGalleryActionBusy(gallery.slug)
    try {
      const token = await getSessionToken()
      if (!token) throw new Error('Sign in to manage this gallery.')
      const response = await fetch(`${base}/api/galleries/${encodeURIComponent(gallery.slug)}/pin`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !gallery.pinnedAt }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be pinned')
      setAccountRevision((revision) => revision + 1)
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'That gallery could not be pinned')
    } finally { setGalleryActionBusy(null) }
  }
  const mutateGallery = async (gallery: GallerySummary) => {
    if (galleryActionBusy) return
    setGalleryActionBusy(gallery.slug)
    setGalleryActionNote('Refreshing gallery…')
    try {
      const token = await getSessionToken()
      if (!token) throw new Error('Sign in to manage this gallery.')
      if (gallery.manifestVersion === 2 && gallery.id) {
        await refreshEncryptedGallery(base, gallery.slug, gallery.id)
      } else {
        const response = await fetch(`${base}/api/galleries/${encodeURIComponent(gallery.slug)}/refresh`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        })
        const payload = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) throw new Error(payload.error || 'That gallery could not be updated.')
      }
      const galleryId = galleryIds[gallery.slug]
      if (galleryId) libraryLoader.invalidate(galleryId)
      setAccountRevision((revision) => revision + 1)
      setGalleryActionNote('Gallery refreshed')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'That gallery could not be updated.')
    } finally { setGalleryActionBusy(null) }
  }

  // Action notes toast over the surface like the Mac's — a status note, not
  // a banner; it clears itself so a stale "Hidden…" never lingers.
  useEffect(() => {
    if (!galleryActionNote) return
    const timer = setTimeout(() => setGalleryActionNote(null), 5000)
    return () => clearTimeout(timer)
  }, [galleryActionNote])

  /** Conceal/reveal like the Mac: the flag moves the card between its
   *  section and the collapsed Hidden galleries run — display only, so no
   *  retention, expiry or pin bookkeeping changes hands. */
  const toggleGalleryHidden = async (gallery: GallerySummary) => {
    if (galleryActionBusy) return
    setGalleryActionBusy(gallery.slug)
    setGalleryActionNote(gallery.hiddenAt ? 'Unhiding gallery…' : 'Hiding gallery…')
    try {
      await setGalleryHidden(base, gallery.slug, !gallery.hiddenAt)
      setAccountGalleries((previous) => previous?.map((item) => item.slug === gallery.slug
        ? { ...item, hiddenAt: gallery.hiddenAt ? null : new Date().toISOString() }
        : item) ?? null)
      setAccountRevision((revision) => revision + 1)
      setGalleryActionNote(gallery.hiddenAt
        ? 'Gallery back in the Library'
        : 'Hidden — it waits in the Hidden galleries section')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'The gallery could not be hidden')
    } finally { setGalleryActionBusy(null) }
  }

  // Saved copies are a device fact, not an account fact: show them even when
  // the owner slug or the account list is unavailable — only a gallery the
  // account list actually returned drops out of this section. While the
  // account list is still in flight a same-owner copy's row may yet land
  // and claim it with the saved badge, so it stays out of the visible
  // Library rather than flicker into this section first (the Catalogue's
  // savedOnlyGalleries contract).
  const cachedOnlyGalleries = cachedLibraryGalleries.filter((cached) => {
    if (cached.owner !== ownerSlug) return true
    if (accountGalleries === null && !accountListFailed) return false
    return !(accountGalleries ?? []).some((gallery) => gallery.slug === cached.slug)
  })
  const purgeCachedLibraryGallery = async (gallery: OfflineGridGallery) => {
    if (galleryActionBusy) return
    setGalleryActionBusy(gallery.galleryId)
    setGalleryActionNote(null)
    try {
      await offlineStore.purgeGallery(gallery.galleryId)
      libraryLoader.invalidate(gallery.galleryId)
      setCachedLibraryGalleries((previous) => previous.filter((item) => item.galleryId !== gallery.galleryId))
      setVaultGalleries((previous) => {
        const next = new Map(previous)
        next.delete(gallery.galleryId)
        return next
      })
      setRemoveCachedGallery(null)
      setCachedMenuGallery(null)
      setGalleryActionNote('Saved copy removed from this device')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'The saved copy could not be removed')
    } finally {
      setGalleryActionBusy(null)
    }
  }
  // `rail` marks the Pinned section's strip cards — a pinned gallery also
  // keeps a compact card back in "Cloud galleries", where it must take
  // the cover form like every other home card.
  const accountGalleryRow = (gallery: GallerySummary, rail = false) => {
    const title = gallery.title || gallery.slug
    const caption = gallery.caption?.trim() ?? ''
    const galleryId = galleryIds[gallery.slug] ?? ''
    const vaultSummary = galleryId ? vaultGalleries.get(galleryId) : undefined
    const streamOnlyGallery = ownerSlug
      ? (galleryPolicies?.[galleryPolicyKey(ownerSlug, gallery.slug)] ?? DEFAULT_VAULT_LOAD_POLICY) === 'stream'
      : false
    const mediaCount = summaryMediaCount(gallery)
    const useRail = narrowLibrary || rail
    const GalleryPreview = useRail ? LibraryRail : LibraryCover
    return (
      <article class={useRail ? 'lib-card' : 'lib-card native-library-compact-card'} data-lib-card={gallery.slug}>
        <GalleryPreview
          galleryId={galleryId}
          images={gallery.images.filter((image) => !image.hidden)}
          loader={libraryLoader}
          title={title}
          onOpen={(index) => ownerSlug && openSelectionAt(ownerSlug, gallery.slug, index)}
        />
        <div class="lib-card-head">
          <button
            type="button"
            class="lib-card-title"
            onClick={() => ownerSlug && openSelectionAt(ownerSlug, gallery.slug, 0)}
            disabled={!ownerSlug}
          >
            {title}
          </button>
          <button
            type="button"
            class="lib-card-menu"
            aria-label={`${title} actions`}
            aria-haspopup="dialog"
            onClick={() => setOpenMenuSlug(gallery.slug)}
          >···</button>
        </div>
        {savedCopyComplete(vaultSummary, gallery) ? <p class="lib-badge-saved">Saved on this device</p> : null}
        <p class="lib-card-sub">
          {formatMediaCount({ stills: mediaCount.stills, videos: mediaCount.videos })}
          {gallery.retention === 'pipeline' ? ` · Temporary gallery${gallery.expiresAt ? ` · expires in ${expiryCountdownText(gallery.expiresAt, now)}` : ''}` : ''}
          <LibraryDeviceStatus
            galleryId={galleryId}
            imageCount={mediaCount.stills + mediaCount.videos}
            streamOnly={streamOnlyGallery}
            summary={vaultSummary}
            savedAnnounced={savedCopyComplete(vaultSummary, gallery)}
          />
        </p>
        {caption ? <p class="native-gallery-caption">{caption}</p> : null}
      </article>
    )
  }
  const cachedGalleryRow = (gallery: OfflineGridGallery) => {
    const GalleryPreview = narrowLibrary ? LibraryRail : LibraryCover
    return (
      <article class={narrowLibrary ? 'lib-card' : 'lib-card native-library-compact-card'} data-cached-gallery={gallery.slug}>
        <GalleryPreview
          galleryId={gallery.galleryId}
          images={gallery.frames.map((frame) => ({
            id: frame.id,
            filename: frame.id,
            src: '',
            width: frame.width,
            height: frame.height,
            alt: frame.alt,
            placeholder: '',
          }))}
          loader={libraryLoader}
          title={gallery.title}
          onOpen={(index) => openSelectionAt(gallery.owner, gallery.slug, index)}
        />
        <div class="lib-card-head">
          <button type="button" class="lib-card-title" onClick={() => openSelectionAt(gallery.owner, gallery.slug, 0)}>{gallery.title}</button>
          <button type="button" class="lib-card-menu" aria-label={`${gallery.title} saved-copy actions`} aria-haspopup="dialog" onClick={() => setCachedMenuGallery(gallery)}>···</button>
        </div>
        <p class="lib-card-sub">{formatMediaCount({ stills: gallery.frames.length - gallery.frames.filter((frame) => frame.video).length, videos: gallery.frames.filter((frame) => frame.video).length })} · Saved on this device{accountListFailed ? ' · account list unavailable' : accountGalleries ? ' · not in the online account list' : ' · account list pending'}</p>
      </article>
    )
  }
  // Render gate: an unresolved entitlement drops the slot in the same paint
  // that learns the tier, so no stale creative can outlive a change. The
  // master switch suppresses it outright.
  const accountAdFrame = tierKnown && visibility?.show !== false ? accountAd : null
  // The plate is reserved whenever the placement is allowed, not only once a
  // frame arrives: the live rectangle is positioned from this element's own
  // rect, so it has to exist before the fill is asked for. Until a rented
  // rectangle paints over it, the reserve carries the house creative.
  const accountAdCreative = accountAdFrame ?? HOUSE_AD_FRAME
  const accountAdImage = accountAdCreative.image
  const accountAdSize = accountAdDimensions && accountAdDimensions.src === accountAdImage?.src ? accountAdDimensions : accountAdImage
  // The status line under the title reports vault activity first, then how
  // many galleries live on the device. Kept means what the cards mean: not
  // stream-only, with a committed vault copy holding every image.
  const keptOnDevice = ownerSlug
    ? retainedAccountGalleries.filter((gallery) => {
        if ((galleryPolicies?.[galleryPolicyKey(ownerSlug, gallery.slug)] ?? DEFAULT_VAULT_LOAD_POLICY) === 'stream') return false
        const summary = galleryIds[gallery.slug] ? vaultGalleries.get(galleryIds[gallery.slug]) : undefined
        return savedCopyComplete(summary, gallery)
      }).length
    : 0
  const vaultFillActive = vaultProgress && vaultProgress.total > 0
    ? vaultProgress
    : vaultSave
  const libraryFinding = vaultProgress && vaultProgress.total > 0
    ? `${selection.slug} is saving to ${nativeDeviceLabel()}, ${vaultProgress.completed} of ${vaultProgress.total}.`
    : vaultSave
      ? vaultSave.note ?? `${vaultSave.slug} is saving to ${nativeDeviceLabel()}…`
      : ''

  const accountAdAside = tierKnown && visibility?.show !== false ? (
    <aside
      class={`native-account-ad${accountAdFrame?.provider === 'admob-banner' ? ' native-account-ad--live' : ''}`}
      data-account-ad
      aria-label={`${accountAdCreative.badge}: ${accountAdCreative.advertiser}`}
    >
      <span class="native-account-ad-badge">{accountAdCreative.badge}</span>
      {/* House creative is chrome, not a photograph — the honest-pixel cap
          does not apply; it takes the same media treatment the shared slot
          gives it everywhere else (caps, never a crop). */}
      <div class="native-account-ad-frame" style={accountAdSize ? { aspectRatio: `${accountAdSize.width} / ${accountAdSize.height}` } : undefined}>
        {accountAdImage ? (
          <img src={accountAdImage.src} width={accountAdImage.width} height={accountAdImage.height} alt=""
            onLoad={(event: Event) => {
            const image = event.currentTarget as HTMLImageElement
            setAccountAdDimensions({ src: accountAdImage.src, width: image.naturalWidth, height: image.naturalHeight })
          }} />
        ) : (
          <span class="native-account-ad-placeholder">Vertical photograph, fit to height</span>
        )}
      </div>
      <div class="native-account-ad-copy">
        <strong class="native-account-ad-headline">
          {accountAdCreative.headline ?? accountAdCreative.advertiser}
        </strong>
        {accountAdCreative.provider === 'manorama-house' ? (
          <span class="native-account-ad-sub">A placeholder until sponsored photographs arrive.</span>
        ) : null}
        {accountAdCreative.cta ? (
          // The account page has no strip in motion, so the same CTA the
          // viewer renders is always actionable here; _blank keeps the
          // tap out of the app's own webview.
          <a
            class="native-account-ad-cta"
            href={accountAdCreative.cta.url}
            target="_blank"
            rel="noopener"
          >
            {accountAdCreative.cta.label}
          </a>
        ) : null}
      </div>
    </aside>
  ) : null

  // Settings takes over the list column — the topbar stays mounted and the
  // gear becomes the way back.
  const settingsView = nav.screen.kind === 'settings' ? (
    <Settings
      presentation="pane"
      accountName={accountName}
      ownerSlug={ownerSlug ?? ''}
      ownerSlugDraft={ownerSlugDraft}
      onOwnerSlugDraft={(value) => { setSlugNote(null); setOwnerSlugDraft(value) }}
      onSaveOwnerSlug={() => { void saveOwnerSlug() }}
      identities={accountIdentities}
      identityNote={identityNote ?? linkConflict ?? slugNote}
      onUnlinkIdentity={(provider) => { void unlinkIdentity(provider) }}
      onLinkIdentity={(provider) => { void linkIdentity(provider) }}
      tier={effectiveTier}
      retainedCount={retainedAccountGalleries.length}
      galleryLimit={galleryLimit}
      controller={vaultSettingsController}
      globalViewEnabled={globalViewEnabled}
      globalViewBusy={globalViewSaving}
      onGlobalView={(enabled) => { void changeGlobalView(enabled) }}
      onOpenPicker={() => { dispatchNav({ type: 'back' }); setGlobalViewOpen(true) }}
      devices={devices}
      deviceId={deviceId}
      onForgetDevice={(device) => { void forgetDeviceRow(device) }}
      forgetDeviceBusy={forgetDeviceBusy}
      theme={ownerTheme}
      onTheme={onOwnerThemeChange}
      houseCards={suppressions ? {
        status: `${visibility?.show === false ? 'House cards hidden' : 'House cards shown'}${visibility?.day ? ` · ${visibility.day}` : ''}${visibility?.region ? ` · ${regionName(visibility.region)}` : ''}`,
        actions: [
          {
            label: suppressions.some((item) => item.kind === 'day' && item.value === visibility?.day) ? 'Show again today' : 'Hide for the rest of today',
            disabled: !visibility?.day,
            onClick: () => {
              const day = visibility?.day
              if (!day) return
              const off = suppressions.some((item) => item.kind === 'day' && item.value === day)
              void toggleSuppression('day', day, !off)
            },
          },
          {
            label: suppressions.some((item) => item.kind === 'region' && item.value === visibility?.region) ? `Show in ${regionName(visibility?.region ?? '')}` : `Hide in ${visibility?.region ? regionName(visibility.region) : 'this region'}`,
            disabled: !visibility?.region,
            onClick: () => {
              const region = visibility?.region
              if (!region) return
              const off = suppressions.some((item) => item.kind === 'region' && item.value === region)
              void toggleSuppression('region', region, !off)
            },
          },
        ],
      } : undefined}
      onOpenVisionary={() => dispatchNav({ type: 'open-visionary', from: 'settings' })}
      onOpenPrivacy={() => dispatchNav({ type: 'open-privacy', from: 'settings' })}
      onOpenAuthor={() => openExternal(AUTHOR_URL)}
      appUpdate={appUpdate}
      onOpenUpdate={() => { if (appUpdate) openExternal(appUpdate.url) }}
      onSignOut={() => { void signOut() }}
      deleteConfirming={deleteConfirming}
      deleting={deleting}
      deleteError={deleteError}
      onRequestDelete={() => { void openDeleteConfirm() }}
      onConfirmDelete={() => { void deleteAccountForever() }}
      onCancelDelete={() => { setDeleteConfirming(false); setDeleteError(null) }}
      onBack={() => dispatchNav({ type: 'back' })}
    />
  ) : null

  // Signed out gets one clear door; quick-add resumes after the same auth flow.
  if (signedIn !== true) {
    return <Welcome
      signedIn={signedIn}
      onSignIn={onSignIn}
      authError={authError}
      pendingQuickAdd={Boolean(pendingQuickAdd)}
      accountAdAside={accountAdAside}
      onPrivacy={() => dispatchNav({ type: 'open-privacy', from: 'welcome' })}
      onAuthor={() => openExternal(AUTHOR_URL)}
    />
  }

  return (
    <>
    <main ref={libraryLayoutElementRef} class="m-owner native-list-shell native-account-shell native-library-layout" style={librarySafeStyle} data-library-divided={dividedLibrary || undefined} data-library-settings={nav.screen.kind === 'settings' || undefined}>
      <aside class="native-library-rail" style={libraryRegionStyle(libraryControlRegion)} aria-label="Library controls">
        <div class="native-library-tools">
        <img class="m-topbar-logo" src="/manorama-merged-logo.png" alt="manorama" width="140" height="47" />
        <div class="native-library-heading"><h1>Library</h1></div>
        <div class="native-library-actions">
        <button type="button" class="m-btn m-btn--primary" onClick={() => { setError(null); setAddChooserOpen(true) }}><svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Add Gallery</button>
        <CameraRollPill active={cameraRollOpen} onActivate={(trigger) => {
          cameraRollTriggerRef.current = trigger
          if (cameraRollOpen) closeCameraRoll()
          else setCameraRollOpen(true)
        }} />
        {/* Quiet view: sinks every word on the Library to a whisper so only
            the photographs remain. The topbar carries it and stays legible —
            it is the way back. */}
        <button
          type="button"
          class="m-btn m-btn--quiet m-iconbtn lib-quiet-toggle"
          aria-pressed={quiet ? 'true' : 'false'}
          aria-label={quiet ? 'Show the words' : 'Quiet view — hide the words'}
          title={quiet ? 'Show the words' : 'Quiet view — hide the words'}
          onClick={() => { syncQuietFade(document.querySelector('.native-list-card')); setQuiet((on) => !on) }}
        >
          <QuietIcon />
        </button>
        <button
          type="button"
          class="m-btn m-btn--quiet m-iconbtn"
          aria-label="Settings"
          aria-expanded={nav.screen.kind === 'settings' ? 'true' : 'false'}
          onClick={() => dispatchNav(nav.screen.kind === 'settings' ? { type: 'back' } : { type: 'open-settings' })}
        >
          <SettingsIcon />
        </button>
        </div>
        {libraryFinding ? (
          <p class="native-library-finding">
            {libraryFinding}
            <span
              class="native-vault-meter"
              role="progressbar"
              aria-label={`Saving to ${nativeDeviceLabel()}`}
              aria-valuemin={0}
              aria-valuemax={vaultFillActive?.total ?? 0}
              aria-valuenow={vaultFillActive?.completed ?? 0}
            >
              <span
                class="native-vault-meter-fill"
                style={{ width: vaultFillActive && vaultFillActive.total > 0 ? `${Math.min(100, Math.round((vaultFillActive.completed / vaultFillActive.total) * 100))}%` : '0%' }}
              />
            </span>
          </p>
        ) : null}
        {signedIn && tierKnown && accountGalleries ? (
          <footer class={quiet ? 'native-lib-foot lib-quiet' : 'native-lib-foot'} hidden={nav.screen.kind === 'settings' || undefined}>
            <button type="button" class="native-lib-foot-open" onClick={() => dispatchNav({ type: 'open-settings' })}>
              <span class="native-lib-foot-copy">
                <span class="native-lib-foot-line">
                  You are a manorama {isPro ? 'Visionary' : 'Free User'} hosting{' '}
                  <><span class="num">{allowance.permanent}</span> of <span class="num">{galleryLimit}</span> Cloud galleries</>
                  {isPro ? null : <> and <span class="num">{allowance.temporary}</span> of <span class="num">{FREE_PIPELINE_LIMIT}</span> Temporary galleries</>}.
                </span>
                <span class="native-lib-foot-line native-lib-foot-meta">
                  {vaultUsageBytes !== undefined ? `${formatBytes(vaultUsageBytes)} in vault · ` : null}
                  {keptOnDevice} {keptOnDevice === 1 ? 'gallery' : 'galleries'} on {nativeDeviceLabel()}
                </span>
                <span class="m-sr-only">, opens Settings</span>
              </span>
              <svg class="m-actionrow-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            {!isPro && retainedAccountGalleries.length >= galleryLimit ? (
              <button type="button" class="m-btn m-btn--quiet" onClick={() => dispatchNav({ type: 'open-visionary', from: 'library' })}>Go Visionary</button>
            ) : null}
          </footer>
        ) : null}
        {accountAdAside}
        </div>
        <div class="native-library-sponsor">
        <footer class="site-footer native-library-footer">
          <button type="button" class="site-footer-link" onClick={() => dispatchNav({ type: 'open-privacy', from: 'library' })}>Privacy Policy</button>
          <p class="site-footer-copy">© 2026 Mahesh Shantaram / <button type="button" onClick={() => openExternal(AUTHOR_URL)}>thecontrarian.in</button><br />Photographs in galleries belong to their respective owners.</p>
        </footer>
        </div>
      </aside>
      <section ref={observeLibraryPane} tabIndex={-1} class={quiet ? 'native-list-card lib-quiet' : 'native-list-card'} style={libraryRegionStyle(galleryRegion)} aria-label={cameraRollOpen ? 'Camera Roll events' : 'Galleries'} aria-live="polite" aria-busy={status === 'loading'} hidden={nav.screen.kind === 'settings' || undefined} data-library-mode={cameraRollOpen ? 'camera-roll' : 'galleries'}>
        {cameraRollOpen && nav.screen.kind === 'library' ? <CameraRoll onClose={closeCameraRoll} onOpenSettings={() => dispatchNav({ type: 'open-settings' })} /> : <>
        {pendingUpdate ? (
          <div class="app-update-banner" role="status">
            <span class="app-update-text">manorama <strong>v{pendingUpdate.version}</strong> is available.</span>
            <button type="button" class="m-btn m-btn--primary" onClick={() => openExternal(pendingUpdate.url)}>Update</button>
            <button type="button" class="app-update-dismiss" aria-label="Dismiss this update notice" onClick={dismissUpdate}>×</button>
          </div>
        ) : null}
        {authError ? <p role="alert">{authError}</p> : null}
        {/* A link result can arrive on a cold start, before Settings has
            ever mounted — it needs a line on the Library too. */}
        {linkConflict ? <p class="native-account-note" role="alert">{linkConflict}</p> : null}
        {error && !galleryOpen && !addOpen ? <p class="native-account-note" role="alert">{error}</p> : null}
        {/* A vaulted open decrypts every entry before the first frame — the
            gap reads as a hang unless the surface says it is working. */}
        {status === 'loading' && !manifest ? <p class="native-account-note" role="status">{galleryStatusMessage('loading')}</p> : null}
        {signedIn ? (
          <div class="native-account" data-account>
            {accountListFailed ? (
              <p class="native-account-note">
                Your galleries could not be loaded.{' '}
                <button type="button" class="m-btn m-btn--quiet native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}
            {visibleAccountGalleries.length > 0 ? (<>
              {accountLayout.strips.length > 0 ? <section aria-labelledby="native-pinned-title">
                <button type="button" id="native-pinned-title" class="lib-section-title lib-compact-title lib-hidden-toggle" aria-expanded={pinnedOpen ? 'true' : 'false'} onClick={() => setPinnedOpen((open) => !open)}>
                  <SectionChevron open={pinnedOpen} />
                  Pinned galleries <span class="lib-hidden-count">({accountLayout.strips.length})</span>
                </button>
                {pinnedOpen ? <ul class="native-gallery-list">
                  {accountLayout.strips.map((slug) => <li key={slug}>{accountGalleryRow(accountBySlug.get(slug)!, true)}</li>)}
                </ul> : null}
              </section> : null}
              {accountLayout.compact.length > 0 ? <section aria-labelledby="native-cloud-title">
                <button type="button" id="native-cloud-title" class="lib-section-title lib-compact-title lib-hidden-toggle" aria-expanded={cloudOpen ? 'true' : 'false'} onClick={() => setCloudOpen((open) => !open)}>
                  <SectionChevron open={cloudOpen} />
                  Cloud galleries <span class="lib-hidden-count">({accountLayout.compact.length})</span>
                </button>
                {cloudOpen ? <ul class="native-gallery-list native-library-grid">
                  {accountLayout.compact.map((slug) => <li key={slug}>{accountGalleryRow(accountBySlug.get(slug)!)}</li>)}
                </ul> : null}
              </section> : null}
            </>) : accountGalleries && !accountListFailed && temporaryAccountGalleries.length === 0 && !cachedOnlyGalleries.length && !hiddenAccountGalleries.length ? (
              <div class="lib-empty">
                <h3>No galleries yet</h3>
                <p>Paste a link to a folder or album you already share. Nothing is copied or moved.</p>
                <button type="button" class="m-btn m-btn--primary" onClick={() => { setError(null); setAddChooserOpen(true) }}>Add a gallery</button>
              </div>
            ) : null}
          </div>
        ) : null}
        {isPro && (ownLocalGalleries.length + standaloneDeviceGalleries.length) > 0 ? (
          /* This phone's own records open the shared viewer over the copied
             originals; mirror rows are title, count and the device pill.
             Visionary only, like the feature itself (invariant 12). */
          <div class="native-account" data-local-galleries>
            <button type="button" class="lib-section-title lib-hidden-toggle" aria-expanded={localOpen ? 'true' : 'false'} onClick={() => setLocalOpen((open) => !open)}>
              <SectionChevron open={localOpen} />
              Local galleries <span class="lib-hidden-count">({ownLocalGalleries.length + standaloneDeviceGalleries.length})</span>
            </button>
            {localOpen ? <>
            {ownLocalGalleries.length > 0 && localCatalogue ? (
              <ul class="lib-device-grid">
                {ownLocalGalleries.map((record) => deviceTileCard(
                  {
                    id: record.id,
                    title: record.title,
                    itemCount: record.itemCount,
                    deviceId: localCatalogue.deviceId,
                    sourceKind: record.sourceKind,
                    updatedAt: record.lastSeenAt,
                  },
                  devices,
                  {
                    onOpen: () => void enterLocalGallery(record),
                    action: (
                      <button
                        type="button"
                        class="lib-card-menu"
                        aria-label={`${record.title} actions`}
                        aria-haspopup="dialog"
                        onClick={() => setLocalMenuRecord(record)}
                      >···</button>
                    ),
                  },
                ))}
              </ul>
            ) : null}
            <DeviceGalleriesGrid
              galleries={standaloneDeviceGalleries}
              devices={devices}
              onOpen={(gallery) => {
                if (gallery.publicGallerySlug && ownerSlug) enterGallery({ owner: ownerSlug, slug: gallery.publicGallerySlug })
              }}
            />
            </> : null}
          </div>
        ) : null}
        {cachedOnlyGalleries.length > 0 ? (
          <div class="native-account" data-cached-library>
            <h2 class="lib-section-title">Saved on this device <span class="lib-section-count">({cachedOnlyGalleries.length})</span></h2>
            <ul class="native-gallery-list native-library-grid">
              {cachedOnlyGalleries.map((gallery) => <li key={gallery.galleryId}>{cachedGalleryRow(gallery)}</li>)}
            </ul>
          </div>
        ) : null}
        {hiddenAccountGalleries.length > 0 ? (
          <section aria-labelledby="native-hidden-title">
            <button type="button" id="native-hidden-title" class="lib-section-title lib-compact-title lib-hidden-toggle" aria-expanded={hiddenOpen ? 'true' : 'false'} onClick={() => setHiddenOpen((open) => !open)}>
              <SectionChevron open={hiddenOpen} />
              Hidden galleries <span class="lib-hidden-count">({hiddenAccountGalleries.length})</span>
            </button>
            {hiddenOpen ? <ul class="native-gallery-list native-library-grid">
              {hiddenAccountGalleries.map((gallery) => <li key={gallery.slug}>{accountGalleryRow(gallery)}</li>)}
            </ul> : null}
          </section>
        ) : null}
        </>}
      </section>
      {settingsView}
    </main>
    {detailsView}
    {/* "Add Gallery" is a fork like the desktop's: a folder on this device
        goes through the local pick-copy flow; a shared cloud link opens the
        same verify-then-create sheet as the web Library. Free owners see the
        folder row named for the tier it needs — gated here on the client and
        again at /api/device-galleries (invariant 12). */}
    <Sheet open={addChooserOpen} onClose={() => { if (!localAddBusy) setAddChooserOpen(false) }} title="Add a gallery">
      <ActionGroup note={isPro
        ? `Local folders stay on ${nativeDeviceLabel()}. Cloud links join your account galleries.`
        : 'Local galleries are only for Visionary members. Cloud links join your account galleries.'}>
        <ActionRow
          label={`A folder on ${nativeDeviceLabel()}`}
          value={isPro ? undefined : 'Visionary'}
          onClick={() => { void addLocalFolder() }}
          disabled={!isPro || localAddBusy}
        />
        <ActionRow
          label="A shared cloud link"
          onClick={() => {
            setAddChooserOpen(false)
            setError(null)
            resetAddVerification()
            setAddOpen(true)
          }}
        />
      </ActionGroup>
      {localAddBusy ? <p class="m-note" role="status">Copying the folder's photographs to {nativeDeviceLabel()}…</p> : null}
    </Sheet>
    <AddGallerySheet
      open={addOpen}
      url={sourceUrl}
      name={sourceName}
      caption={sourceCaption}
      checking={addChecking}
      verifiedTitle={addVerifiedTitle}
      busy={quickAddBusy}
      error={error}
      onUrlChange={onAddUrlChange}
      onVerify={onAddUrlCommit}
      onNameChange={setSourceName}
      onCaptionChange={setSourceCaption}
      onClose={() => { if (!quickAddBusy) { setAddOpen(false); resetAddVerification() } }}
      onSubmit={(input) => { void importCloudGallery(input) }}
    />
    {localMenuRecord ? (
      <Sheet open onClose={() => setLocalMenuRecord(null)} title={localMenuRecord.title}>
        <div class="lib-menu">
          <button type="button" onClick={() => {
            const record = localMenuRecord
            setLocalMenuRecord(null)
            void enterLocalGallery(record)
          }}>Open gallery</button>
          <button type="button" class="lib-menu-danger" onClick={() => {
            const record = localMenuRecord
            setLocalMenuRecord(null)
            setRemoveLocalRecord(record)
          }}>Remove from {nativeDeviceLabel()}</button>
        </div>
      </Sheet>
    ) : null}
    {removeLocalRecord ? (
      <Sheet open onClose={() => { if (!localAddBusy) setRemoveLocalRecord(null) }} title={`Remove “${removeLocalRecord.title}” from ${nativeDeviceLabel()}?`} dismissible={!localAddBusy}>
        <p>This removes the copied photographs and the gallery from this device. The originals stay where they were picked from.</p>
        <div class="m-form-inline">
          <button type="button" class="m-btn m-btn--destructive" disabled={localAddBusy} onClick={() => void confirmRemoveLocal()}>
            {localAddBusy ? 'Removing…' : 'Remove gallery'}
          </button>
          <button type="button" class="m-btn m-btn--secondary" disabled={localAddBusy} onClick={() => setRemoveLocalRecord(null)}>Cancel</button>
        </div>
      </Sheet>
    ) : null}
    {shareFallback}
    {cachedMenuGallery ? (
      <Sheet open onClose={() => setCachedMenuGallery(null)} title={cachedMenuGallery.title}>
        <div class="lib-menu">
          <button type="button" onClick={() => {
            const gallery = cachedMenuGallery
            setCachedMenuGallery(null)
            openSelectionAt(gallery.owner, gallery.slug, 0)
          }}>Open gallery</button>
          <p class="m-note">This is a complete saved copy. Online editing, refresh and sharing are unavailable while it is absent from the account list.</p>
          <button type="button" class="lib-menu-danger" onClick={() => {
            setCachedMenuGallery(null)
            setRemoveCachedGallery(cachedMenuGallery)
          }}>Remove saved copy</button>
        </div>
      </Sheet>
    ) : null}
    {removeCachedGallery ? (
      <Sheet open onClose={() => { if (!galleryActionBusy) setRemoveCachedGallery(null) }} title={`Remove the saved copy of “${removeCachedGallery.title}”?`} dismissible={!galleryActionBusy}>
        <p>This removes the encrypted copy from this device. Originals remain at their source.</p>
        <div class="m-form-inline">
          <button type="button" class="m-btn m-btn--destructive" disabled={galleryActionBusy !== null} onClick={() => void purgeCachedLibraryGallery(removeCachedGallery)}>
            {galleryActionBusy ? 'Removing…' : 'Remove saved copy'}
          </button>
          <button type="button" class="m-btn m-btn--secondary" disabled={galleryActionBusy !== null} onClick={() => setRemoveCachedGallery(null)}>Cancel</button>
        </div>
      </Sheet>
    ) : null}
    {menuGallery ? (
      <Sheet
        open
        onClose={() => setOpenMenuSlug(null)}
        title={galleryName(menuGallery)}
      >
        <div class="lib-menu" role="menu" aria-label={`${galleryName(menuGallery)} actions`}>
          <button type="button" role="menuitem" disabled={galleryActionBusy !== null} onClick={() => void toggleGalleryPin(menuGallery)}>{menuGallery.pinnedAt ? 'Unpin gallery' : 'Pin gallery'}</button>
          <button type="button" role="menuitem" disabled={galleryActionBusy !== null} onClick={() => { setOpenMenuSlug(null); void toggleGalleryHidden(menuGallery) }}>{menuGallery.hiddenAt ? 'Unhide gallery' : 'Hide this gallery'}</button>
          <button type="button" role="menuitem" onClick={() => { setOpenMenuSlug(null); void shareGallery(menuGallery) }}>Copy link</button>
          <button type="button" role="menuitem" disabled={!ownerSlug} onClick={() => { setOpenMenuSlug(null); void openPostToX(menuGallery) }}>Post to X</button>
          <button
            type="button"
            role="menuitem"
            disabled={!ownerSlug || menuGallery.retention === 'pipeline'}
            title={menuGallery.retention === 'pipeline' ? 'Temporary galleries cannot be edited on this plan' : undefined}
            onClick={() => {
              if (!ownerSlug) return
              setOpenMenuSlug(null)
              openReorderFor({ owner: ownerSlug, slug: menuGallery.slug, title: galleryName(menuGallery) })
            }}
          >Reorder photographs</button>
          <button
            type="button"
            role="menuitem"
            disabled={galleryActionBusy !== null || menuGallery.retention === 'pipeline' || !menuGallery.sourceUrl}
            title={menuGallery.retention === 'pipeline' ? 'Temporary galleries cannot be edited on this plan' : undefined}
            onClick={() => { setOpenMenuSlug(null); void mutateGallery(menuGallery) }}
          >Refresh gallery</button>
          <button type="button" role="menuitem" disabled={!ownerSlug} onClick={() => {
            if (!ownerSlug) return
            setOpenMenuSlug(null)
            dispatchNav({ type: 'open-details', gallery: { kind: 'published', owner: ownerSlug, slug: menuGallery.slug }, from: 'library' })
          }}>More settings…</button>
        </div>
      </Sheet>
    ) : null}
    {postToX && ownerSlug ? (
      <PostToX
        apiBase={apiBase}
        owner={ownerSlug}
        slug={postToX.gallery.slug}
        title={galleryName(postToX.gallery)}
        galleryUrl={postToX.url}
        savedPhotos={postToX.galleryId ? {
          galleryId: postToX.galleryId,
          entryIdFor: (photoId) => thumbnailEntryId(photoId),
          read: (entryId) => offlineStore.readThumbnail(postToX.galleryId, entryId),
        } : undefined}
        materialize={materializeEncryptedPhoto}
        onClose={closePostToX}
        onPosted={(note) => setGalleryActionNote(note)}
      />
    ) : null}
    {nav.screen.kind === 'reorder' && editorGallery ? (
      <GalleryEditor
        owner={editorGallery.owner}
        slug={editorGallery.slug}
        title={editorGallery.title}
        apiBase={apiBase}
        onClose={() => { setEditorGallery(null); dispatchNav({ type: 'back' }) }}
        onSaved={() => {
          setAccountRevision((revision) => revision + 1)
          void reloadOpenGallery()
        }}
      />
    ) : null}
    {globalViewOpen ? (
      <GlobalView
        store={offlineStore}
        tier={effectiveTier}
        current={manifest ? selection : null}
        onOpenFrame={openGlobalFrame}
        onClose={() => setGlobalViewOpen(false)}
      />
    ) : null}
    {/* Status notes toast over the surface — a quiet pill docked at the
        bottom edge like the Mac's, never an in-flow line that shifts the
        sections when it lands. */}
    {(galleryActionNote || quickAddBusy) ? (
      <div class="native-toast-stack">
        {quickAddBusy ? <div class="admin-toast" role="status">Reading the cloud folder and building your gallery…</div> : null}
        {galleryActionNote ? <div class="admin-toast" role="status">{galleryActionNote}</div> : null}
      </div>
    ) : null}
    </>
  )
}
