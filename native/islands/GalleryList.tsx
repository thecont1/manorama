import { useEffect, useMemo, useReducer, useRef, useState } from 'hono/jsx'
import { canGoBack, initialOwnerNav, ownerNavReducer, type OwnerNavState } from '../../packages/core/owner-navigation'
import { closeTopOverlay, overlayDepth } from '../../app/lib/overlay-stack'
import { decideBack } from '../lib/back-decision'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem, mediaCountOf } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import type { Theme } from '../../app/lib/owner-theme'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import GalleryEditor from './GalleryEditor'
import GalleryDetails from './GalleryDetails'
import AddGallerySheet from '../../app/components/AddGallerySheet'
import GalleryShareSheet from '../../app/components/GalleryShareSheet'
import { CloseIcon } from '../../app/components/admin-icons'
import { Sheet } from '../../app/components/ui/Sheet'
import { BundledSource } from '../../app/lib/imagesource'
import type { AdFrame } from '../../app/lib/adframe'
import { createGalleryFromQuickAdd, createGalleryFromSource, deleteAccount, fetchAccountGalleries, fetchAccountIdentities, fetchAccountOwnerSlug, fetchDeviceGalleries, fetchGallery, normalizeApiBase, renameOwnerSlug, unlinkAccountIdentity, type AccountIdentity } from '../lib/api'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  offlineGalleryId,
  openGalleryNetworkFirst,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
  type OfflineGallerySummary,
  type OfflineGridGallery,
  type OfflineGalleryStore,
} from '../lib/offline-gallery'
import { computeCachedGallery, OnDeviceLocalCompute, readImageFeatures } from '../lib/local-compute'
import { thumbnailEntryId } from '../lib/thumbs'
import { mimeTypeForItem, sourceLabelFor, LibraryMediaLoader } from '../lib/library-media'
import { cacheFillRegistry } from '../lib/cache-fill'
import { copyText, type GallerySharePayload } from '../../app/lib/gallery-share'
import { shareGalleryNative } from '../lib/gallery-share'
import { LibraryRail } from './LibraryRail'
import { productionVault } from '../lib/vault'
import { adFrameFor, fetchAdVisibility, HOUSE_AD_FRAME, type AdPolicyInput, type AdVisibility } from '../lib/ads'
import { createAccountAdAdapter } from '../lib/admob-account-adapter'
import { loadGlobalViewEnabled, saveGlobalViewEnabled } from '../lib/global-view'
import { beginProviderSignIn, clearPendingQuickAdd, clearSessionToken, getOwnerSlug, getPendingQuickAdd, getSessionToken, setOwnerSlug as persistOwnerSlug, type AuthProvider, type NativeGallerySelection } from '../lib/session'
import { requestReorderClose } from '../lib/reorder-close-guard'
import { galleryPolicyKey, loadGalleryStreamOnly, saveGalleryStreamOnly, DEFAULT_VAULT_LOAD_POLICY, loadVaultLoadPolicy, saveVaultLoadPolicy, createVaultSettingsController, type VaultLoadPolicy } from '../lib/vault-settings'
import type { AdSuppression } from '../../app/lib/ads-visibility'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Privacy from './Privacy'
import Settings from './Settings'
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

/** The card's on-device status: "Streamed" when the owner declined a copy,
 *  a live meter while vault writes land, "Saved on this device" once the
 *  count is met. Cache-fill events advance the meter mid-fill so the word
 *  never waits on an account refresh; nothing here starts a download. */
export const LibraryDeviceStatus = ({
  galleryId,
  imageCount,
  streamOnly,
  summary,
}: {
  galleryId: string
  imageCount: number
  streamOnly: boolean
  summary: OfflineGallerySummary | undefined
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
      fillingRef.current = true
      setLiveSaved((saved) => Math.max(saved, item.index + 1))
    })
  }, [galleryId])

  if (streamOnly) return <p class="lib-card-device">Streamed — nothing saved on this device</p>
  if (summary?.status === 'corrupt') return <p class="lib-card-device">Saved copy unreadable</p>
  if (!galleryId || liveSaved <= 0) return null
  if (liveSaved < imageCount) {
    return (
      <p class="lib-card-device">
        Saving {liveSaved} of {imageCount}
        <progress class="lib-card-meter" value={liveSaved} max={imageCount} aria-label={`${liveSaved} of ${imageCount} photographs saved`} />
      </p>
    )
  }
  return <p class="lib-card-device">Saved on this device</p>
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

/** Legal and attribution links open in an in-app browser sheet — the same
 *  pattern the paywall and the OAuth flow use, because a Capacitor webview does
 *  not reliably act on a bare `target="_blank"` anchor. The href stays on the
 *  anchor, so the link still works, and still reads as a link, without JS. */
const openExternal = (url: string) => {
  void Browser.open({ url, toolbarColor: '#0a0a0a', presentationStyle: 'fullscreen' })
}

type Selection = { owner: string; slug: string }
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
export default function GalleryList({ apiBase, owner, slug, deepLinkSelection, onSignIn, authError, billing, billingState, ownerTheme = 'dark', onOwnerThemeChange = () => {}, accountAdLoader = adFrameFor, offlineStore = productionOfflineGalleryStore }: Props) {
  const initial = selectionFromLocation()
  const initialSelection = { owner: owner ?? initial.owner, slug: slug ?? initial.slug }
  const [selection, setSelection] = useState<Selection>(initialSelection)
  const [loadPolicy, setLoadPolicy] = useState<VaultLoadPolicy | null>(null)
  const [policySaving, setPolicySaving] = useState(false)
  const [galleryPolicies, setGalleryPolicies] = useState<Record<string, boolean> | null>(null)
  const [vaultNote, setVaultNote] = useState('Preparing offline copy…')
  const [vaultProgress, setVaultProgress] = useState<{ completed: number; total: number } | null>(null)
  const selectedPolicyKey = galleryPolicyKey(selection.owner, selection.slug)
  const streamOnly = galleryPolicies?.[selectedPolicyKey] === true
  useEffect(() => {
    void loadGalleryStreamOnly().then((policies) => {
      galleryPoliciesRef.current = policies
      setGalleryPolicies(policies)
    })
  }, [])
  const [globalViewEnabled, setGlobalViewEnabled] = useState<boolean | null>(null)
  const [globalViewSaving, setGlobalViewSaving] = useState(false)
  const [ownerInput, setOwnerInput] = useState(selection.owner)
  const [slugInput, setSlugInput] = useState(selection.slug)
  const [manifest, setManifest] = useState<GalleryManifest | null>(null)
  const [settings, setSettings] = useState<GallerySettings | null>(null)
  const [plate, setPlate] = useState<Awaited<ReturnType<typeof adFrameFor>>>(null)
  const [accountAd, setAccountAd] = useState<AdFrame | null>(null)
  // The master's day/region kill switch — answered by the Worker, failed open.
  const [visibility, setVisibility] = useState<AdVisibility | null>(null)
  // Suppressions are readable only with a session: a signed-in operator gets
  // the toggle; everyone else just gets the visibility answer applied.
  const [suppressions, setSuppressions] = useState<AdSuppression[] | null>(null)
  const [foldLayout, setFoldLayout] = useState<FoldLayout | null>(null)
  const [status, setStatus] = useState<GalleryStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // A gallery already open at mount (props or a restored URL selection)
  // must sit on the nav stack too — otherwise the first hardware back
  // press sees library at top and exits the app instead of returning.
  const [nav, dispatchNav] = useReducer(ownerNavReducer, initialOwnerNav(true), (base) =>
    initialSelection.owner && initialSelection.slug
      ? ownerNavReducer(base, { type: 'open-gallery', gallery: { kind: 'published', owner: initialSelection.owner, slug: initialSelection.slug } })
      : base)
  const [globalViewOpen, setGlobalViewOpen] = useState(false)
  // null while secure storage is still being asked; sign-in completes with a
  // full reload, so by the first paint the token is already on the device.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [pendingQuickAdd, setPendingQuickAdd] = useState<string | null>(null)
  const [quickAddBusy, setQuickAddBusy] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [galleryActionBusy, setGalleryActionBusy] = useState<string | null>(null)
  const [galleryActionNote, setGalleryActionNote] = useState<string | null>(null)
  const [removeGallerySlug, setRemoveGallerySlug] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [sharePayload, setSharePayload] = useState<GallerySharePayload | null>(null)
  // The editor a card's cover opens: the gallery it resequences, resolved
  // when the cover is tapped so the island owns its own read and write.
  const [editorGallery, setEditorGallery] = useState<{ owner: string; slug: string; title: string } | null>(null)
  const quickAddInFlight = useRef<string | null>(null)
  // The account actions used to be scattered through the greeting copy. They
  // live in one drawer now, closed on every mount and never encoded in the URL.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const accountDrawerRef = useRef<HTMLDivElement | null>(null)
  const [ownerSlug, setOwnerSlug] = useState<string | undefined>(undefined)
  const [ownerName, setOwnerName] = useState<string | undefined>(undefined)
  const [accountIdentities, setAccountIdentities] = useState<AccountIdentity[] | null>(null)
  const [identityNote, setIdentityNote] = useState<string | null>(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [ownerSlugDraft, setOwnerSlugDraft] = useState('')
  const [slugNote, setSlugNote] = useState<string | null>(null)
  const [accountGalleries, setAccountGalleries] = useState<GallerySummary[] | null>(null)
  const [accountListFailed, setAccountListFailed] = useState(false)
  const [deviceGalleries, setDeviceGalleries] = useState<DeviceGallery[] | null>(null)
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
  const [vaultGalleries, setVaultGalleries] = useState<ReadonlyMap<string, OfflineGallerySummary>>(new Map())
  const [cachedLibraryGalleries, setCachedLibraryGalleries] = useState<OfflineGridGallery[]>([])
  const [cachedMenuGallery, setCachedMenuGallery] = useState<OfflineGridGallery | null>(null)
  const [removeCachedGallery, setRemoveCachedGallery] = useState<OfflineGridGallery | null>(null)
  const [galleryIds, setGalleryIds] = useState<Record<string, string>>({})

  // One loader per mounted Library — its queue and budgets are the whole
  // surface's media ceiling, shared by every rail.
  const libraryLoader = useMemo(() => new LibraryMediaLoader({
    read: (galleryId, entryId) => offlineStore.readThumbnail(galleryId, entryId),
    objectUrls: {
      create: (bytes, mimeType) => URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType })),
      revoke: (url) => URL.revokeObjectURL(url),
    },
  }), [offlineStore])
  const vaultSettingsController = useMemo(() => createVaultSettingsController({
    vault: productionVault,
    store: offlineStore,
    tier: () => billingState?.tier,
  }), [offlineStore, billingState?.tier])
  useEffect(() => () => {
    libraryLoader.release()
    cacheFillRegistry.reset()
  }, [libraryLoader])
  const positionRef = useRef<{ imageId: string; index: number } | null>(null)
  const navRef = useRef<OwnerNavState>(null as unknown as OwnerNavState)
  navRef.current = nav
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const leaseRef = useRef<Pick<NetworkFirstGallery, 'dispose'> | null>(null)
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase])

  useEffect(() => {
    let active = true
    void loadVaultLoadPolicy().then((policy) => {
      if (active) setLoadPolicy(policy)
    }).catch(() => {
      if (active) setLoadPolicy(DEFAULT_VAULT_LOAD_POLICY)
    })
    return () => { active = false }
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
    setFrameKick({ index: 0, nonce: 0 })
    setOwnerInput(deepLinkSelection.owner)
    setSlugInput(deepLinkSelection.slug)
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
    void createGalleryFromQuickAdd(base, sourceUrl)
      .then((next) => {
        if (quickAddInFlight.current !== sourceUrl) return
        setPendingQuickAdd(null)
        setSourceUrl('')
        void clearPendingQuickAdd()
        setFrameKick({ index: 0, nonce: 0 })
        setOwnerInput(next.owner)
        setSlugInput(next.slug)
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
  }, [base, pendingQuickAdd, signedIn])

  useEffect(() => {
    if (!selection.owner || !selection.slug || loadPolicy === null || galleryPolicies === null) return
    setVaultProgress(null)
    setVaultNote(streamOnly || loadPolicy === 'stream' ? 'Streaming from cloud. No new offline copy is being downloaded.' : 'Preparing encrypted offline copy…')
    const controller = new AbortController()
    let active = true
    let currentManifest: GalleryManifest | null = null
    let currentStatus: GalleryStatus = 'idle'
    const disposeLease = () => {
      leaseRef.current?.dispose?.()
      leaseRef.current = null
    }
    const applyGallery = (gallery: NetworkFirstGallery) => {
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
          if (result?.status === 'skipped-video') {
            setVaultNote('This gallery includes video. Offline saving is not supported for mixed galleries yet; the picker is available online.')
            return
          }
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
        cachePolicy: streamOnly ? 'stream' : loadPolicy ?? DEFAULT_VAULT_LOAD_POLICY,
        onProgress: (progress) => {
          if (!active) return
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
        })
        .catch((reason: unknown) => {
          if (!active || controller.signal.aborted) return
          if (currentManifest && currentStatus === 'offline') return
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
  }, [base, offlineStore, loadPolicy, selection.owner, selection.slug, galleryPolicies === null, streamOnly])

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

  // The account area resolves once per base from secure storage; a failed
  // list keeps its section quiet rather than blocking the manual form.
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      const [token, slug] = await Promise.all([getSessionToken(), getOwnerSlug()])
      if (!active) return
      setOwnerSlug(slug)
      setOwnerSlugDraft(slug ?? '')
      setSignedIn(Boolean(token))
      if (!token) return
      const [account, device, identities] = await Promise.allSettled([
        fetchAccountGalleries(base, controller.signal),
        fetchDeviceGalleries(base, controller.signal),
        fetchAccountIdentities(base, controller.signal),
      ])
      if (!active) return
      setAccountGalleries(account.status === 'fulfilled' ? account.value : null)
      setAccountListFailed(account.status === 'rejected')
      setDeviceGalleries(device.status === 'fulfilled' ? device.value : null)
      setDeviceListFailed(device.status === 'rejected')
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

  // The encrypted catalog arrives independently of the account request: known
  // saved galleries can paint while the network list is pending or failed.
  useEffect(() => {
    let active = true
    void Promise.all([
      offlineStore.listGalleries(),
      offlineStore.listGridGalleries(),
    ])
      .then(([list, grid]) => {
        if (!active) return
        setVaultGalleries(new Map(list.map((summary) => [summary.galleryId, summary])))
        setCachedLibraryGalleries(grid)
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
    void adFrameFor({ tier: billingState?.isPro ? 'pro' : 'free', visible: visibility?.show }).then((frame) => {
      if (active) setPlate(frame)
    })
    return () => { active = false }
  }, [manifest, billingState?.isPro, visibility?.show])

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
    if (galleryOpen || !billingState?.tier) {
      setAccountAd(null)
      return
    }
    let active = true
    void accountAdLoader({
      tier: billingState.isPro ? 'pro' : 'free',
      visible: platesVisible,
    }).then((frame) => {
      if (active) setAccountAd(frame)
    })
    return () => {
      active = false
      // Leaving the account screen takes the rented rectangle down with it;
      // an overlay outliving its slot would cover a gallery.
      void accountAdAdapter.retire()
    }
  }, [galleryOpen, billingState?.tier, billingState?.isPro, platesVisible])

  useEffect(() => {
    // Account controls use the same safe regions as the viewer; they need
    // geometry before any photograph has been opened.
    const sync = () => setFoldLayout(readRuntimeFoldLayout())
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [])

  const enterGallery = (next: Selection) => {
    positionRef.current = null
    setSelection(next)
    dispatchNav({ type: 'open-gallery', gallery: { kind: 'published', owner: next.owner, slug: next.slug } })
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
    dispatchNav({ type: 'open-library' })
    positionRef.current = null
    setManifest(null)
    setSettings(null)
    setSelection({ owner: '', slug: '' })
    setStatus('idle')
    setFrameKick({ index: 0, nonce: 0 })
    setAccountRevision((revision) => revision + 1)
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
      const decision = decideBack({
        globalViewOpen,
        viewerModalOpen: document.querySelector('.m-sheet-host') !== null,
        overlayDepth: overlayDepth(),
        nav: navRef.current,
        accountMenuOpen,
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
      if (decision === 'close-account-menu') { setAccountMenuOpen(false); return }
      void App.exitApp()
    }).then((listener) => {
      if (active) remove = () => listener.remove()
      else void listener.remove()
    })
    return () => { active = false; void remove?.() }
  }, [globalViewOpen, accountMenuOpen])

  /** The newest intent per gallery, which is what a queued write persists.
   *  State alone lags a tap by a render, and a write that reads it can land
   *  behind a newer choice. */
  const galleryPoliciesRef = useRef<Record<string, boolean>>({})
  const streamOnlyWrites = useRef(new Map<string, Promise<void>>())
  const changeGalleryStreamOnly = async (enabled: boolean, target: Selection = selection) => {
    const key = galleryPolicyKey(target.owner, target.slug)
    const before = galleryPoliciesRef.current[key] === true
    // Optimistic: the checkbox follows the tap immediately.
    const next = { ...galleryPoliciesRef.current, [key]: enabled }
    galleryPoliciesRef.current = next
    setGalleryPolicies(next)
    // One write in flight per gallery, each persisting the newest intent
    // rather than a snapshot of a moment that has already passed.
    const queued = (streamOnlyWrites.current.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => saveGalleryStreamOnly({ ...galleryPoliciesRef.current }))
      .catch(() => {
        // Step back only if nothing newer has been chosen since.
        if (galleryPoliciesRef.current[key] === enabled) {
          const rolledBack = { ...galleryPoliciesRef.current, [key]: before }
          galleryPoliciesRef.current = rolledBack
          setGalleryPolicies(rolledBack)
        }
        setVaultNote('This device preference could not be saved. Please try again.')
      })
    streamOnlyWrites.current.set(key, queued)
    await queued
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
    const payload: GallerySharePayload = {
      title: galleryName(gallery),
      caption: gallery.caption ?? '',
      url: `https://manorama.xyz/${ownerSlug}/${gallery.slug}`,
    }
    const result = await shareGalleryNative(payload)
    if (result === 'fallback') setSharePayload(payload)
    if (result === 'shared') setGalleryActionNote('Gallery shared')
  }

  const purgeSavedCopy = async (gallery: GallerySummary) => {
    const galleryId = galleryIds[gallery.slug]
    if (!galleryId) return
    await offlineStore.purgeGallery(galleryId)
    libraryLoader.invalidate(galleryId)
    setVaultGalleries((previous) => {
      const next = new Map(previous)
      next.delete(galleryId)
      return next
    })
    setCachedLibraryGalleries((previous) => previous.filter((item) => item.galleryId !== galleryId))
    setAccountRevision((revision) => revision + 1)
  }

  const currentGallerySummary = accountGalleries?.find((gallery) => gallery.slug === selection.slug)
  const detailsSlug = nav.screen.kind === 'details' && nav.screen.gallery.kind === 'published' ? nav.screen.gallery.slug : undefined
  const detailsSummary = detailsSlug
    ? accountGalleries?.find((gallery) => gallery.slug === detailsSlug)
    : undefined
  const detailsGalleryId = detailsSummary ? galleryIds[detailsSummary.slug] : undefined
  const detailsView = detailsSummary && ownerSlug ? (
    <GalleryDetails
      apiBase={base}
      owner={ownerSlug}
      gallery={detailsSummary}
      streamOnly={galleryPolicies?.[galleryPolicyKey(ownerSlug, detailsSummary.slug)] === true}
      vaultNote={selection.slug === detailsSummary.slug ? vaultNote : undefined}
      vaultProgress={selection.slug === detailsSummary.slug ? vaultProgress : null}
      hasSavedCopy={detailsGalleryId ? vaultGalleries.get(detailsGalleryId)?.status === 'cached' : false}
      onBack={() => dispatchNav({ type: 'back' })}
      onOpen={() => {
        if (nav.screen.kind === 'details' && nav.screen.from === 'viewer') {
          dispatchNav({ type: 'back' })
          return
        }
        setFrameKick({ index: 0, nonce: 0 })
        enterGallery({ owner: ownerSlug, slug: detailsSummary.slug })
      }}
      onShare={() => { void shareGallery(detailsSummary) }}
      onReorder={() => openReorderFor({ owner: ownerSlug, slug: detailsSummary.slug, title: galleryName(detailsSummary) }, 'details')}
      onStreamOnlyChange={(next) => { void changeGalleryStreamOnly(next, { owner: ownerSlug, slug: detailsSummary.slug }) }}
      onChanged={galleryChanged}
      onRemoved={returnToGalleries}
      onPurge={() => purgeSavedCopy(detailsSummary)}
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
    const foldImages = source.list()
    const foldEligible = foldImages.length > 1 && foldImages.every((image) => !isVideoItem(image))
    const renderFold = ({ frames, activeIndex, segments, dpr }: {
      frames: readonly GalleryMediaItem[]
      activeIndex: number
      segments: NonNullable<FoldLayout>['segments']
      dpr: number
    }) => {
      const diptychFrames: DiptychFrame[] = frames.map((image) => ({
        id: image.id,
        src: image.src,
        width: image.width,
        height: image.height,
        alt: image.alt,
        placeholder: image.placeholder,
      }))
      return <Diptych frames={diptychFrames} segments={segments} dpr={dpr} activeIndex={activeIndex} />
    }
    return (
      <>
        <GalleryShell settings={settings} status={status === 'offline' ? galleryStatusMessage(status) : undefined} mediaCount={mediaCountOf(source.list())}>
          <Viewer
            key={`${manifest.slug}:${frameKick.nonce}`}
            slug={manifest.slug}
            galleryTitle={manifest.title}
            images={source.list()}
            settings={settings}
            plate={plate}
            onReturnToGalleries={returnToGalleries}
            allowFullscreen={false}
            suspended={suspendedViewer}
            onPositionChange={(position) => { positionRef.current = position }}
            onOpenDetails={currentGallerySummary && ownerSlug === selection.owner ? () => {
              dispatchNav({ type: 'open-details', gallery: { kind: 'published', owner: selection.owner, slug: selection.slug }, from: 'viewer' })
            } : undefined}
            onOpenGlobalView={(index = 0) => {
              setActivePhotoIndex(index)
              setGlobalViewOpen(true)
            }}
            initialIndex={frameKick.index}
            foldLayout={foldEligible ? foldLayout : null}
            foldRenderer={foldEligible ? renderFold : undefined}
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
            tier={globalViewEnabled === true ? billingState?.tier : 'free'}
            current={selection}
            active={{ selection, index: positionRef.current?.index ?? activePhotoIndex }}
            onOpenFrame={openGlobalFrame}
            onClose={() => setGlobalViewOpen(false)}
          />
        ) : null}
      </>
    )
  }

  if (nav.screen.kind === 'visionary' && billing) {
    return <Paywall billing={billing} onClose={() => dispatchNav({ type: 'back' })} onOpenPrivacy={() => dispatchNav({ type: 'open-privacy', from: 'visionary' })} />
  }

  if (nav.screen.kind === 'privacy') {
    return <Privacy
      onBack={() => dispatchNav({ type: 'back' })}
      onOpenExternal={openExternal}
      onPrint={typeof window !== 'undefined' && typeof window.print === 'function' ? () => window.print() : undefined}
    />
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

  const signOut = async () => {
    libraryLoader.release()
    cacheFillRegistry.reset()
    dispatchNav({ type: 'signed-out' })
    await clearSessionToken()
    try {
      await billing?.signOut()
    } catch {
      // A RevenueCat sign-out failure must not trap the manorama session.
    }
    if (typeof window !== 'undefined') window.location.reload()
  }

  const changeLoadPolicy = async (next: VaultLoadPolicy) => {
    const previous = loadPolicy ?? DEFAULT_VAULT_LOAD_POLICY
    setLoadPolicy(next)
    setPolicySaving(true)
    try {
      await saveVaultLoadPolicy(next)
    } catch {
      setLoadPolicy(previous)
      setError('That preference could not be saved on this device.')
    } finally {
      setPolicySaving(false)
    }
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
    try {
      // The API gates on the typed URL name; the app sends the slug it
      // already holds instead of making the owner retype it.
      const slug = ownerSlug ?? (await recoverOwnerSlug())
      if (!slug) {
        setDeleteError('Your URL name could not be recovered — sign out and back in, then try again.')
        setDeleting(false)
        return
      }
      if (!accountDeleted) {
        await deleteAccount(base, slug)
        setAccountDeleted(true)
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
        reason instanceof Error && reason.message.trim()
          ? reason.message
          : 'Your account could not be deleted right now',
      )
      setDeleting(false)
    }
  }

  const openGallery = (event: Event) => {
    event.preventDefault()
    const next = {
      owner: ownerInput.trim(),
      slug: slugInput.trim(),
    }
    if (!next.owner || !next.slug) {
      setStatus('error')
      setError('Enter both an owner and gallery slug')
      return
    }
    setFrameKick({ index: 0, nonce: 0 })
    enterGallery(next)
  }

  const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value
  const retryAccountLists = () => setAccountRevision((revision) => revision + 1)
  const importCloudGallery = async (input: { url: string; name: string }) => {
    const url = input.url.trim()
    // The in-flight ref also closes the gap before the disabled state paints.
    if (!url || quickAddBusy || pendingQuickAdd || quickAddInFlight.current) return
    const flight = `ordinary:${url}`
    quickAddInFlight.current = flight
    setQuickAddBusy(true)
    setError(null)
    try {
      const next = await createGalleryFromSource(base, url, { title: input.name })
      if (quickAddInFlight.current !== flight) return
      setSourceUrl('')
      setSourceName('')
      setAddOpen(false)
      setFrameKick({ index: 0, nonce: 0 })
      setOwnerInput(next.owner)
      setSlugInput(next.slug)
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
  const retainedAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention === 'retained') ?? []
  const temporaryAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention === 'pipeline') ?? []
  // Subscription limits control retention/editing, never whether an owner can see a gallery.
  const visibleAccountGalleries = accountGalleries ?? []
  const menuGallery = openMenuSlug ? visibleAccountGalleries.find((gallery) => gallery.slug === openMenuSlug) : undefined
  const standaloneDeviceGalleries = deviceGalleries?.filter((gallery) => !gallery.publicGallerySlug || !visibleAccountGalleries.some((published) => published.slug === gallery.publicGallerySlug)) ?? []
  const galleryLimit = billingState?.isPro ? 99 : 3
  const userType = billingState?.isPro ? 'Visionary' : 'Free'
  const accountName = ownerName ?? ownerSlug ?? 'friend'
  const closeAccountMenu = () => {
    setAccountMenuOpen(false)
    // WebKit can drop immediate focus while Hono removes the focused drawer
    // during a pending resize commit. Restore it on the surviving trigger.
    requestAnimationFrame(() => accountMenuButtonRef.current?.focus())
  }
  // Focus moves into the drawer, Tab stays inside it, and Esc hands the caret
  // back to the button that opened it — the contract the viewer's modal keeps.
  // None of this touches the stage.
  useEffect(() => {
    if (!accountMenuOpen) return
    const panel = accountDrawerRef.current
    panel?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeAccountMenu()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = panel.querySelectorAll<HTMLElement>('button, a[href], input')
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [accountMenuOpen])
  const message = authError ?? error ?? galleryStatusMessage(status)
  // The manual form stays as the secondary path for galleries outside the
  // signed-in account; the opening screen is the sign-in door alone.
  const openForm = (
    <form onSubmit={openGallery}>
      <label>
        Owner
        <input
          value={ownerInput}
          onInput={(event) => {
            setOwnerInput(
              (event.currentTarget as HTMLInputElement).value,
            )
          }}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>
      <label>
        Gallery slug
        <input
          value={slugInput}
          onInput={(event) => {
            setSlugInput(readInput(event))
          }}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>
      <button type="submit">Open gallery</button>
    </form>
  )
  const accountGallerySubtitle = (gallery: GallerySummary) => gallery.caption?.trim() || gallery.date?.trim() || ''
  const accountGalleryLink = (gallery: GallerySummary) => ownerSlug
    ? `manorama.xyz/${ownerSlug}/${gallery.slug}`
    : `manorama.xyz/${gallery.slug}`
  const leftRegion = foldLayout?.controlRegions[0]
  const rightRegion = foldLayout?.controlRegions[1]
  const accountFoldStyle = leftRegion && rightRegion && rightRegion.x > leftRegion.x + leftRegion.width
    ? { '--admin-pane-limit': `${leftRegion.x + leftRegion.width}px`, '--admin-left-end': `${leftRegion.x + leftRegion.width}px`, '--admin-right-start': `${rightRegion.x}px` }
    : undefined
  const mutateGallery = async (gallery: GallerySummary, action: 'refresh' | 'delete') => {
    if (galleryActionBusy) return
    setGalleryActionBusy(gallery.slug)
    setGalleryActionNote(action === 'refresh' ? 'Refreshing gallery…' : 'Removing gallery…')
    try {
      const token = await getSessionToken()
      if (!token) throw new Error('Sign in to manage this gallery.')
      const response = await fetch(`${base}/api/galleries/${encodeURIComponent(gallery.slug)}${action === 'refresh' ? '/refresh' : ''}`, {
        method: action === 'refresh' ? 'POST' : 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be updated.')
      const galleryId = galleryIds[gallery.slug]
      if (galleryId) libraryLoader.invalidate(galleryId)
      if (action === 'delete') setAccountGalleries((previous) => previous?.filter((item) => item.slug !== gallery.slug) ?? null)
      setRemoveGallerySlug(null)
      setAccountRevision((revision) => revision + 1)
      setGalleryActionNote(action === 'refresh' ? 'Gallery refreshed' : 'Gallery removed. Your cloud files were not changed.')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'That gallery could not be updated.')
    } finally { setGalleryActionBusy(null) }
  }
  const cachedOnlyGalleries = ownerSlug
    ? cachedLibraryGalleries.filter((cached) =>
        cached.owner === ownerSlug && !visibleAccountGalleries.some((gallery) => gallery.slug === cached.slug))
    : []
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
  const accountGalleryRow = (gallery: GallerySummary) => {
    const title = gallery.title || gallery.slug
    const caption = gallery.caption?.trim() ?? ''
    const galleryId = galleryIds[gallery.slug] ?? ''
    const vaultSummary = galleryId ? vaultGalleries.get(galleryId) : undefined
    const streamOnlyGallery = ownerSlug
      ? galleryPolicies?.[galleryPolicyKey(ownerSlug, gallery.slug)] === true
      : false
    return (
      <article class="lib-card" data-lib-card={gallery.slug}>
        {/* Every photograph the gallery holds, at its own proportions —
            only the visible window plus overscan materializes media. */}
        <LibraryRail
          galleryId={galleryId}
          images={gallery.images}
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
        <p class="lib-card-sub">
          {gallery.imageCount} {gallery.imageCount === 1 ? 'photograph' : 'photographs'}
          {' · '}{sourceLabelFor(gallery.sourceUrl)}
          {gallery.retention === 'pipeline' ? ` · Temporary gallery${gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : ''}` : ''}
        </p>
        <LibraryDeviceStatus
          galleryId={galleryId}
          imageCount={gallery.imageCount}
          streamOnly={streamOnlyGallery}
          summary={vaultSummary}
        />
        {caption ? <p class="native-gallery-caption">{caption}</p> : null}
        <span class="native-gallery-link">{accountGalleryLink(gallery)}</span>
        {removeGallerySlug === gallery.slug ? <div class="native-gallery-remove-confirm" role="group" aria-label={`Confirm removal of ${galleryName(gallery)}`}>
          <p>Remove “{galleryName(gallery)}” from manorama? This cannot be undone. Your cloud files and existing device vault copies are not deleted.</p>
          <button type="button" disabled={galleryActionBusy !== null} onClick={() => void mutateGallery(gallery, 'delete')}>Remove gallery</button>
          <button type="button" disabled={galleryActionBusy !== null} onClick={() => setRemoveGallerySlug(null)}>Cancel</button>
        </div> : null}
      </article>
    )
  }
  const cachedGalleryRow = (gallery: OfflineGridGallery) => (
    <article class="lib-card" data-cached-gallery={gallery.slug}>
      <LibraryRail
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
      <p class="lib-card-sub">{gallery.frames.length} {gallery.frames.length === 1 ? 'photograph' : 'photographs'} · Offline copy complete</p>
      <p class="native-gallery-link">Saved on this device{accountGalleries && !accountListFailed ? ' · not in the online account list' : ' · account list pending'}</p>
    </article>
  )
  // Render gate: an unresolved entitlement drops the slot in the same paint
  // that learns the tier, so no stale creative can outlive a change. The
  // master switch suppresses it outright.
  const accountAdFrame = billingState?.tier && visibility?.show !== false ? accountAd : null
  // The plate is reserved whenever the placement is allowed, not only once a
  // frame arrives: the live rectangle is positioned from this element's own
  // rect, so it has to exist before the fill is asked for. Until a rented
  // rectangle paints over it, the reserve carries the house creative.
  const accountAdCreative = accountAdFrame ?? HOUSE_AD_FRAME
  const accountAdAside = billingState?.tier && visibility?.show !== false ? (
    <aside
      class={`native-account-ad${accountAdFrame?.provider === 'admob-banner' ? ' native-account-ad--live' : ''}`}
      data-account-ad
      aria-label={`${accountAdCreative.badge}: ${accountAdCreative.advertiser}`}
    >
      <span class="native-account-ad-badge">{accountAdCreative.badge}</span>
      <strong class="native-account-ad-headline">
        {accountAdCreative.headline ?? accountAdCreative.advertiser}
      </strong>
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
    </aside>
  ) : null

  if (nav.screen.kind === 'settings') {
    return <Settings
      accountName={accountName}
      ownerSlug={ownerSlug ?? ''}
      ownerSlugDraft={ownerSlugDraft}
      onOwnerSlugDraft={(value) => { setSlugNote(null); setOwnerSlugDraft(value) }}
      onSaveOwnerSlug={() => { void saveOwnerSlug() }}
      identities={accountIdentities}
      identityNote={identityNote ?? slugNote}
      onUnlinkIdentity={(provider) => { void unlinkIdentity(provider) }}
      onLinkIdentity={(provider) => { void linkIdentity(provider) }}
      tier={billingState?.tier}
      retainedCount={retainedAccountGalleries.length}
      galleryLimit={galleryLimit}
      controller={vaultSettingsController}
      loadPolicy={loadPolicy}
      loadPolicyBusy={policySaving}
      onLoadPolicy={(policy) => { void changeLoadPolicy(policy) }}
      globalViewEnabled={globalViewEnabled}
      globalViewBusy={globalViewSaving}
      onGlobalView={(enabled) => { void changeGlobalView(enabled) }}
      onOpenPicker={() => setGlobalViewOpen(true)}
      deviceGalleries={standaloneDeviceGalleries}
      onOpenDeviceGallery={(gallery) => {
        if (gallery.publicGallerySlug && ownerSlug) enterGallery({ owner: ownerSlug, slug: gallery.publicGallerySlug })
      }}
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
      openAnotherGallery={openForm}
      onSignOut={() => { void signOut() }}
      deleteConfirming={deleteConfirming}
      deleting={deleting}
      deleteError={deleteError}
      onRequestDelete={() => { void openDeleteConfirm() }}
      onConfirmDelete={() => { void deleteAccountForever() }}
      onCancelDelete={() => { setDeleteConfirming(false); setDeleteError(null) }}
      onBack={() => dispatchNav({ type: 'back' })}
    />
  }

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
    <main class="m-owner native-list-shell native-account-shell" style={accountFoldStyle} data-admin-segmented={accountFoldStyle ? 'true' : undefined}>
          <button
            type="button"
            class="native-account-menu native-account-edge-tab"
            aria-label="Account menu"
            aria-expanded={accountMenuOpen}
            aria-controls="native-account-drawer"
            ref={accountMenuButtonRef}
            onClick={() => setAccountMenuOpen(true)}
          >
            <span class="native-account-tab-label" aria-hidden="true">Account <span>›</span></span>
            <svg class="native-account-hamburger" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </button>

      <div class="native-account-overview" aria-label="Account overview">
      {/* The brand column — same classes as the web's landing and dashboard,
          so logo, tagline, greeting and footer can't drift between platforms.
          Wide screens pin it left beside the account card; narrow screens
          stack it above. */}
      <div class="native-account-left">
      <div class="native-account-side">
        {/* The wordmark and the account menu share one row: the mark is the
            quiet opening gesture, the menu holds the account actions. */}
        <div class="native-account-head">
          <span class="brand-mark-wrap">
            <img
              src="/manorama-merged-logo.png"
              alt="manorama"
              class="landing-brand-mark"
            />
            <span class="brand-tld" aria-hidden="true">.xyz</span>
          </span>
        </div>
        <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
        <div class="admin-greeting">
          <p class="admin-greeting-url">manorama.xyz/<input
            class="admin-owner-slug-input"
            type="text"
            value={ownerSlugDraft}
            aria-label="Your URL — edit to change your address"
            spellcheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onInput={(event) => {
              setSlugNote(null)
              setOwnerSlugDraft((event.currentTarget as HTMLInputElement).value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOwnerSlugDraft(ownerSlug ?? '')
              if (event.key === 'Enter') { event.preventDefault(); void saveOwnerSlug() }
            }}
            onBlur={() => { void saveOwnerSlug() }}
          /></p>
          <p class="admin-greeting-hello">Hello, <mark class="admin-greeting-name">{accountName}</mark>. Welcome to manorama.xyz.</p>
          <p class="admin-greeting-plan">You are a {userType} User. {retainedAccountGalleries.length <= galleryLimit ? `You have used ${retainedAccountGalleries.length} of your ${galleryLimit} gallery limit.` : `You have ${retainedAccountGalleries.length} retained galleries. Your plan includes ${galleryLimit} editable gallery slots; all your galleries are listed below.`}</p>
          {slugNote ? <p class="native-account-note">{slugNote}</p> : null}
        </div>
      </div>
      </div>
      </div>
      <section class="native-list-card" aria-live="polite" aria-busy={status === 'loading'}>
        <div class="native-library-heading">
          <h1>Library</h1>
          <button type="button" class="m-btn m-btn--primary" onClick={() => { setError(null); setAddOpen(true) }}>Add</button>
        </div>
        {galleryActionNote ? <p role="status">{galleryActionNote}</p> : null}
        {authError ? <p role="alert">{authError}</p> : null}
        {quickAddBusy ? <p class="native-account-note" role="status">Reading the cloud folder and building your gallery…</p> : null}
        {error && !galleryOpen && !addOpen ? <p class="native-account-note" role="alert">{error}</p> : null}
        {/* The sponsored panel sits between the Library heading and the
            cards — 24px below the status block, 40px before the first
            gallery — never inside a card and never among the photographs. */}
        {accountAdAside}
        {signedIn ? (
          <div class="native-account" data-account>
            {accountListFailed ? (
              <p class="native-account-note">
                Your galleries could not be loaded.{' '}
                <button type="button" class="native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}
            {visibleAccountGalleries.length > 0 ? (
              <ul class="native-gallery-list">
                {visibleAccountGalleries.map((gallery) => (
                  <li key={gallery.slug}>
                    {accountGalleryRow(gallery)}
                  </li>
                ))}
              </ul>
            ) : accountGalleries && !accountListFailed && temporaryAccountGalleries.length === 0 ? (
              <p class="native-account-note">No galleries on this account yet.</p>
            ) : null}
          </div>
        ) : null}
        {cachedOnlyGalleries.length > 0 ? (
          <div class="native-account" data-cached-library>
            <h2>Saved on this device</h2>
            <ul class="native-gallery-list">
              {cachedOnlyGalleries.map((gallery) => <li key={gallery.galleryId}>{cachedGalleryRow(gallery)}</li>)}
            </ul>
          </div>
        ) : null}
      </section>
    </main>
    {detailsView}
    <AddGallerySheet
      open={addOpen}
      url={sourceUrl}
      name={sourceName}
      busy={quickAddBusy}
      error={error}
      onUrlChange={setSourceUrl}
      onNameChange={setSourceName}
      onClose={() => { if (!quickAddBusy) setAddOpen(false) }}
      onSubmit={(input) => { void importCloudGallery(input) }}
    />
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
          <button type="button" role="menuitem" onClick={() => { setOpenMenuSlug(null); void shareGallery(menuGallery) }}>Share link</button>
          <button type="button" role="menuitem" disabled={!ownerSlug} onClick={() => {
            if (!ownerSlug) return
            setOpenMenuSlug(null)
            dispatchNav({ type: 'open-details', gallery: { kind: 'published', owner: ownerSlug, slug: menuGallery.slug }, from: 'library' })
          }}>Gallery details</button>
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
            onClick={() => { setOpenMenuSlug(null); void mutateGallery(menuGallery, 'refresh') }}
          >Read the folder again</button>
          <button type="button" role="menuitem" class="lib-menu-danger" disabled={galleryActionBusy !== null} onClick={() => { setOpenMenuSlug(null); setRemoveGallerySlug(menuGallery.slug) }}>Remove gallery</button>
        </div>
      </Sheet>
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
    {accountMenuOpen ? (
      <div class="native-drawer" id="native-account-drawer" data-account-drawer style={accountFoldStyle}>
        <div class="native-drawer-scrim" aria-hidden="true" onClick={closeAccountMenu} />
        <div
          class="native-drawer-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Account"
          ref={accountDrawerRef}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            closeAccountMenu()
          }}
        >
          <div class="native-drawer-head">
            {/* The brand sits exactly where it sits on the account page, so the
                menu reads as the page unfolding rather than a second surface
                arriving, and everything else starts below it. */}
            <div class="native-drawer-brand native-account-side">
              {/* The page's own brand row: the wordmark keeps the account
                  page's cap, including the room the hamburger reserves. */}
              <div class="native-account-head">
                <span class="brand-mark-wrap">
                  <img
                    src="/manorama-merged-logo.png"
                    alt="manorama"
                    class="landing-brand-mark"
                  />
                  <span class="brand-tld" aria-hidden="true">.xyz</span>
                </span>
              </div>
              <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            </div>
            <button
              type="button"
              class="native-drawer-close"
              aria-label="Close account menu"
              onClick={closeAccountMenu}
            >
              <CloseIcon />
            </button>
          </div>
          <p class="native-drawer-hint">Add a gallery from a public Dropbox, Google Drive, iCloud, or MEGA link. Paste the folder or album link into the box on the main page and manorama will read it.</p>
          <p class="native-drawer-note">{accountName} · manorama.xyz/{ownerSlug ?? ''}</p>
            {deviceListFailed ? (
              <p class="native-account-note">
                The list from this device could not be loaded.{' '}
                <button type="button" class="native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}


        {signedIn ? (
          <>
            <button type="button" class="native-drawer-action" onClick={() => {
              closeAccountMenu()
              dispatchNav({ type: 'open-settings' })
            }}>Settings</button>
            {billingNote ? <p class="native-account-note">{billingNote}</p> : null}
          </>
        ) : null}

        {/* Legal ends the left column's own scroll region on wide screens;
            on narrow ones the wrapper dissolves (display:contents) and the
            footer's order puts it last in the stacked page. */}
        <footer class="site-footer native-legal">
          <a class="site-footer-link" href={PRIVACY_URL} onClick={(event) => { event.preventDefault(); openExternal(PRIVACY_URL) }}>Privacy Policy</a>
          <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href={AUTHOR_URL} onClick={(event) => { event.preventDefault(); openExternal(AUTHOR_URL) }}>thecontrarian.in</a></p>
        </footer>

          <button type="button" class="native-drawer-action" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    ) : null}
    {globalViewOpen ? (
      <GlobalView
        store={offlineStore}
        tier={billingState?.tier}
        current={manifest ? selection : null}
        onOpenFrame={openGlobalFrame}
        onClose={() => setGlobalViewOpen(false)}
      />
    ) : null}
    </>
  )
}
