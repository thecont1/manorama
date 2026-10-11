import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { BundledSource } from '../../app/lib/imagesource'
import type { AdFrame } from '../../app/lib/adframe'
import { createGalleryFromQuickAdd, deleteAccount, fetchAccountGalleries, fetchAccountIdentities, fetchAccountOwnerSlug, fetchDeviceGalleries, fetchGallery, normalizeApiBase, renameOwnerSlug } from '../lib/api'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  offlineGalleryId,
  openGalleryNetworkFirst,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
} from '../lib/offline-gallery'
import { computeCachedGallery, OnDeviceLocalCompute, readImageFeatures } from '../lib/local-compute'
import { thumbnailEntryId } from '../lib/thumbs'
import { productionVault } from '../lib/vault'
import { adFrameFor, fetchAdVisibility, type AdPolicyInput, type AdVisibility } from '../lib/ads'
import { loadGlobalViewEnabled, saveGlobalViewEnabled } from '../lib/global-view'
import { clearPendingQuickAdd, clearSessionToken, getOwnerSlug, getPendingQuickAdd, getSessionToken, setOwnerSlug as persistOwnerSlug, type AuthProvider, type NativeGallerySelection } from '../lib/session'
import { galleryPolicyKey, loadGalleryStreamOnly, saveGalleryStreamOnly, DEFAULT_VAULT_LOAD_POLICY, loadVaultLoadPolicy, saveVaultLoadPolicy, type VaultLoadPolicy } from '../lib/vault-settings'
import type { AdSuppression } from '../../app/lib/ads-visibility'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Diptych, { type DiptychFrame } from './Diptych'
import GlobalView from './GlobalView'
import { Browser } from '@capacitor/browser'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { SIGN_IN_PROVIDERS } from '../../app/lib/signin'
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
  /** House-policy loader for the account slot. Production never passes this;
   *  tests inject it to stage a slow resolution against an entitlement change. */
  accountAdLoader?: (input: AdPolicyInput) => Promise<AdFrame | null>
}

const PRIVACY_URL = 'https://manorama.xyz/privacy'
const AUTHOR_URL = 'https://thecontrarian.in'

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

const mimeTypeForImage = (image: GalleryMediaItem): string => {
  const format = image.variants?.[0]?.format?.toLowerCase().replace(/^image\//, '') ?? image.filename.split('.').pop()?.toLowerCase()
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
  if (format === 'png' || format === 'webp' || format === 'avif' || format === 'gif') return `image/${format}`
  if (format === 'heic' || format === 'heif') return `image/${format}`
  return 'application/octet-stream'
}

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
export default function GalleryList({ apiBase, owner, slug, deepLinkSelection, onSignIn, authError, billing, billingState, accountAdLoader = adFrameFor }: Props) {
  const initial = selectionFromLocation()
  const [selection, setSelection] = useState<Selection>({
    owner: owner ?? initial.owner,
    slug: slug ?? initial.slug,
  })
  const [loadPolicy, setLoadPolicy] = useState<VaultLoadPolicy | null>(null)
  const [policySaving, setPolicySaving] = useState(false)
  const [galleryPolicies, setGalleryPolicies] = useState<Record<string, boolean> | null>(null)
  const [vaultNote, setVaultNote] = useState('Preparing offline copy…')
  const [vaultProgress, setVaultProgress] = useState<{ completed: number; total: number } | null>(null)
  const selectedPolicyKey = galleryPolicyKey(selection.owner, selection.slug)
  const streamOnly = galleryPolicies?.[selectedPolicyKey] === true
  useEffect(() => { void loadGalleryStreamOnly().then(setGalleryPolicies) }, [])
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
  const [paywallOpen, setPaywallOpen] = useState(false)
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
  const quickAddInFlight = useRef<string | null>(null)
  // The account actions used to be scattered through the greeting copy. They
  // live in one drawer now, closed on every mount and never encoded in the URL.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const accountDrawerRef = useRef<HTMLDivElement | null>(null)
  const [ownerSlug, setOwnerSlug] = useState<string | undefined>(undefined)
  const [ownerName, setOwnerName] = useState<string | undefined>(undefined)
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
    setSelection(deepLinkSelection)
  }, [deepLinkSelection])

  useEffect(() => {
    let active = true
    void getPendingQuickAdd().then((sourceUrl) => {
      if (active && sourceUrl) setPendingQuickAdd(sourceUrl)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!pendingQuickAdd || signedIn !== true || quickAddInFlight.current === pendingQuickAdd) return
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
        setSelection(next)
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
          setVaultNote(gallery.source === 'offline' ? 'Opened from your encrypted vault.' : 'Offline copy saved in your encrypted vault.')
          const stillImages = gallery.manifest.images.filter((image) => !isVideoItem(image))
          if (stillImages.length === 0) return
          const galleryId = await offlineGalleryId(selection)
          if (!active) return
          await computeCachedGallery({
            engine: localCompute,
            galleryId,
            images: stillImages.map((image) => ({ id: image.id, entryId: thumbnailEntryId(image.id), mimeType: mimeTypeForImage(image) })),
            read: (currentGalleryId, entryId) => productionOfflineGalleryStore.readThumbnail(currentGalleryId, entryId),
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
        store: productionOfflineGalleryStore,
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
  }, [base, loadPolicy, selection.owner, selection.slug, galleryPolicies === null, streamOnly])

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
        setOwnerName(identities.value.find((identity) => identity.displayName)?.displayName)
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [base, accountRevision])

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
    void accountAdLoader({ tier: billingState.isPro ? 'pro' : 'free', visible: platesVisible }).then((frame) => {
      if (active) setAccountAd(frame)
    })
    return () => { active = false }
  }, [galleryOpen, billingState?.tier, billingState?.isPro, platesVisible])

  useEffect(() => {
    // Account controls use the same safe regions as the viewer; they need
    // geometry before any photograph has been opened.
    const sync = () => setFoldLayout(readRuntimeFoldLayout())
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [])

  const openGlobalFrame = (next: Selection, index: number) => {
    setGlobalViewOpen(false)
    setActivePhotoIndex(index)
    if (next.owner === selection.owner && next.slug === selection.slug) {
      // Same gallery: bump the remount nonce so the viewer re-seeds at index.
      setFrameKick((kick) => ({ index, nonce: kick.nonce + 1 }))
      return
    }
    setFrameKick({ index, nonce: 0 })
    setSelection(next)
  }

  const returnToGalleries = () => {
    setGlobalViewOpen(false)
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
      if (globalViewOpen) { setGlobalViewOpen(false); return }
      if (manifest) {
        const modal = document.querySelector<HTMLElement>('.controls-modal:not([hidden]), .info-sheet:not([hidden])')
        if (modal) { modal.querySelector<HTMLButtonElement>('button[data-close], button[aria-label^="Close"]')?.click(); return }
        returnToGalleries()
        return
      }
      if (accountMenuOpen) { setAccountMenuOpen(false); return }
      void App.exitApp()
    }).then((listener) => {
      if (active) remove = () => listener.remove()
      else void listener.remove()
    })
    return () => { active = false; void remove?.() }
  }, [manifest, globalViewOpen, accountMenuOpen])

  const changeGalleryStreamOnly = async (enabled: boolean) => {
    const previous = galleryPolicies ?? {}
    const next = { ...previous, [selectedPolicyKey]: enabled }
    try {
      await saveGalleryStreamOnly(next)
      setGalleryPolicies(next)
    } catch { setVaultNote('This device preference could not be saved. Please try again.') }
  }

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
        <GalleryShell settings={settings} status={status === 'offline' ? galleryStatusMessage(status) : undefined}>
          <Viewer
            key={`${manifest.slug}:${frameKick.nonce}`}
            slug={manifest.slug}
            galleryTitle={manifest.title}
            images={source.list()}
            settings={settings}
            plate={plate}
            onReturnToGalleries={returnToGalleries}
            deviceControls={<section class="panel-section" aria-label="On this device">
              <h3>On this device</h3>
              <label><input type="checkbox" checked={streamOnly} onChange={(event) => { void changeGalleryStreamOnly((event.currentTarget as HTMLInputElement).checked) }} /> Don’t download this gallery</label>
              <p class="quiet-copy">Existing saved photos are kept. This choice applies only to this gallery on this device.</p>
              <p class="quiet-copy" role="status" aria-live="polite">{vaultNote}</p>
              {vaultProgress && !streamOnly ? <progress value={vaultProgress.completed} max={vaultProgress.total} aria-label="Photos saved to encrypted vault" /> : null}
            </section>}
            onOpenGlobalView={(index = 0) => {
              setActivePhotoIndex(index)
              setGlobalViewOpen(true)
            }}
            initialIndex={frameKick.index}
            foldLayout={foldEligible ? foldLayout : null}
            foldRenderer={foldEligible ? renderFold : undefined}
          />
        </GalleryShell>
        {globalViewOpen ? (
          <GlobalView
            store={productionOfflineGalleryStore}
            onlineGallery={{ selection, manifest }}
            downloadNote={vaultNote}
            tier={globalViewEnabled === true ? billingState?.tier : 'free'}
            current={selection}
            active={{ selection, index: activePhotoIndex }}
            onOpenFrame={openGlobalFrame}
            onClose={() => setGlobalViewOpen(false)}
          />
        ) : null}
      </>
    )
  }

  if (paywallOpen && billing) {
    return <Paywall billing={billing} onClose={() => setPaywallOpen(false)} />
  }

  const openSelection = (owner: string, slug: string) => {
    setFrameKick({ index: 0, nonce: 0 })
    setSelection({ owner, slug })
  }

  const signOut = async () => {
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

  // RevenueCat may be configured yet have no sellable offerings right now,
  // and that deserves a sentence rather than a paywall that can only fail.
  const openSubscriptions = async () => {
    if (!billing) return
    setBillingNote(null)
    try {
      const offering = await billing.offerings()
      if (!offering || offering.availablePackages.length === 0) {
        setBillingNote('Subscriptions are unavailable right now. Please try again shortly.')
        return
      }
    } catch {
      setBillingNote('Subscriptions are unavailable right now. Please try again shortly.')
      return
    }
    setPaywallOpen(true)
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
    setSelection(next)
  }

  const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value
  const retryAccountLists = () => setAccountRevision((revision) => revision + 1)
  const importCloudGallery = (event: Event) => {
    event.preventDefault()
    const url = sourceUrl.trim()
    // The in-flight ref also closes the gap before the disabled state paints.
    if (!url || quickAddBusy || pendingQuickAdd || quickAddInFlight.current) return
    setError(null)
    setPendingQuickAdd(url)
  }
  const retainedAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention === 'retained') ?? []
  const temporaryAccountGalleries = accountGalleries?.filter((gallery) => gallery.retention === 'pipeline') ?? []
  // Subscription limits control retention/editing, never whether an owner can see a gallery.
  const visibleAccountGalleries = accountGalleries ?? []
  const standaloneDeviceGalleries = deviceGalleries?.filter((gallery) => !gallery.publicGallerySlug || !visibleAccountGalleries.some((published) => published.slug === gallery.publicGallerySlug)) ?? []
  const galleryLimit = billingState?.isPro ? 99 : 3
  const userType = billingState?.isPro ? 'Pro' : 'Free'
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
  const deviceMeta = (gallery: DeviceGallery) =>
    `${gallery.itemCount} ${gallery.itemCount === 1 ? 'item' : 'items'} · ${gallery.sourceKind} · on ${gallery.deviceLabel}`
  const accountGallerySubtitle = (gallery: GallerySummary) => gallery.caption?.trim() || gallery.date?.trim() || ''
  const accountGalleryLink = (gallery: GallerySummary) => ownerSlug
    ? `manorama.xyz/${ownerSlug}/${gallery.slug}`
    : `manorama.xyz/${gallery.slug}`
  const leftRegion = foldLayout?.controlRegions[0]
  const rightRegion = foldLayout?.controlRegions[1]
  const accountFoldStyle = leftRegion && rightRegion && rightRegion.x > leftRegion.x + leftRegion.width
    ? { '--admin-pane-limit': `${leftRegion.x + leftRegion.width}px`, '--admin-left-end': `${leftRegion.x + leftRegion.width}px`, '--admin-right-start': `${rightRegion.x}px` }
    : undefined
  // The first variant is the provider's own thumbnail, and for a film it is the
  // poster — `src` would be the video itself, which no <img> can show. This is
  // the same `variants?.[0]?.src ?? src` the web dashboard's row previews use.
  const imagePreview = (image: GallerySummary['images'][number]) =>
    image.variants?.[0]?.src ?? ('poster' in image ? image.poster.src : image.src)
  const copyGalleryLink = async (gallery: GallerySummary) => {
    const url = `https://${accountGalleryLink(gallery)}`
    try {
      await navigator.clipboard.writeText(url)
      setGalleryActionNote('Gallery link copied')
    } catch {
      const field = document.createElement('textarea')
      field.value = url
      field.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(field)
      field.select()
      const copied = document.execCommand('copy')
      field.remove()
      setGalleryActionNote(copied ? 'Gallery link copied' : `Copy this gallery link: ${url}`)
    }
  }
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
      if (action === 'delete') setAccountGalleries((previous) => previous?.filter((item) => item.slug !== gallery.slug) ?? null)
      setRemoveGallerySlug(null)
      setAccountRevision((revision) => revision + 1)
      setGalleryActionNote(action === 'refresh' ? 'Gallery refreshed' : 'Gallery removed. Your cloud files were not changed.')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'That gallery could not be updated.')
    } finally { setGalleryActionBusy(null) }
  }
  const accountGalleryRow = (gallery: GallerySummary) => {
    const cover = gallery.images[0]
    return (
      <>
        {/* The cover is its own opener so it can hold a column of the card
          across both text rows; the actions then sit beside the photograph
          instead of under the whole card on a narrow screen. */}
        {cover ? (
          <button
            type="button"
            class="native-gallery-cover-open"
            onClick={() => ownerSlug && openSelection(ownerSlug, gallery.slug)}
            disabled={!ownerSlug}
            aria-label={`Open ${gallery.title || gallery.slug}`}
          >
            <span class="native-gallery-cover-row" aria-hidden="true">
              <span class="native-gallery-thumb">
                <img
                  src={imagePreview(cover)}
                  width={cover.width}
                  height={cover.height}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
              </span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          class="native-gallery-row native-gallery-row-with-thumb"
          onClick={() => ownerSlug && openSelection(ownerSlug, gallery.slug)}
          disabled={!ownerSlug}
        >
        <span class="native-gallery-heading">
          <span class="native-gallery-title">{gallery.title || gallery.slug}</span>
          <span class="native-gallery-meta">({gallery.imageCount} {gallery.imageCount === 1 ? 'item' : 'items'})</span>
        </span>
        {accountGallerySubtitle(gallery) ? <span class="native-gallery-subtitle">{accountGallerySubtitle(gallery)}</span> : null}
        <span class="native-gallery-link">{accountGalleryLink(gallery)}</span>
        {gallery.retention === 'pipeline' ? <span class="native-account-note">Temporary gallery{gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : ''}</span> : null}
        </button>
      </>
    )
  }
  // Render gate: an unresolved entitlement drops the slot in the same paint
  // that learns the tier, so no stale creative can outlive a change. The
  // master switch suppresses it outright.
  const accountAdFrame = billingState?.tier && visibility?.show !== false ? accountAd : null
  const accountAdAside = accountAdFrame ? (
    <aside
      class="native-account-ad"
      data-account-ad
      aria-label={`${accountAdFrame.badge}: ${accountAdFrame.advertiser}`}
    >
      <span class="native-account-ad-badge">{accountAdFrame.badge}</span>
      <strong class="native-account-ad-headline">
        {accountAdFrame.headline ?? accountAdFrame.advertiser}
      </strong>
      {accountAdFrame.cta ? (
        // The account page has no strip in motion, so the same CTA the
        // viewer renders is always actionable here; _blank keeps the
        // tap out of the app's own webview.
        <a
          class="native-account-ad-cta"
          href={accountAdFrame.cta.url}
          target="_blank"
          rel="noopener"
        >
          {accountAdFrame.cta.label}
        </a>
      ) : null}
    </aside>
  ) : null

  // Signed out is the landing page itself — same classes, same stylesheet
  // rules, same type as manorama.xyz's door. The icon row is the only
  // native adaptation: bare glyphs instead of the web's text links.
  if (signedIn !== true) {
    return (
      <main class="landing-page native-landing" aria-live="polite">
        <div class="landing-brand">
          <header class="native-account-header">
            <span class="brand-mark-wrap">
              <img
                src="/manorama-merged-logo.png"
                alt="manorama"
                class="landing-brand-mark"
              />
              <span class="brand-tld" aria-hidden="true">.xyz</span>
            </span>
            {accountAdAside}
          </header>
          <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
          {signedIn === false && onSignIn ? (
            // App Review 4.8: a third-party sign-in must sit beside Sign in
            // with Apple, given no less prominence — Apple leads the row.
            <div class="signin">
              <span class="signin-lead">Continue with</span>
              <div class="signin-icons">
                {[...SIGN_IN_PROVIDERS]
                  .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
                  .map(({ id, label, Glyph }) => (
                    <button
                      key={id}
                      type="button"
                      class="signin-icon"
                      aria-label={`Continue with ${label}`}
                      onClick={() => onSignIn(id)}
                    >
                      <Glyph />
                      <span class="signin-label">{label}</span>
                    </button>
                  ))}
              </div>
            </div>
          ) : null}
          {authError ? <p class="landing-note">{authError}</p> : null}
          {pendingQuickAdd ? <p class="landing-note">Sign in to turn this supported cloud folder into a Manorama gallery.</p> : null}
        </div>
        {/* The same legal footer the web landing and the account screen carry.
            The opening screen is the only surface a signed-out viewer sees, so
            without it the privacy policy is unreachable before sign-in. */}
        <footer class="site-footer">
          <a class="site-footer-link" href={PRIVACY_URL} onClick={(event) => { event.preventDefault(); openExternal(PRIVACY_URL) }}>Privacy Policy</a>
          <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href={AUTHOR_URL} onClick={(event) => { event.preventDefault(); openExternal(AUTHOR_URL) }}>thecontrarian.in</a></p>
        </footer>
      </main>
    )
  }

  return (
    <>
    <main class="native-list-shell native-account-shell" style={accountFoldStyle} data-admin-segmented={accountFoldStyle ? 'true' : undefined}>
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
        {accountAdAside}
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
        <section class="native-gallery-import" aria-labelledby="native-import-heading">
          <h2 id="native-import-heading">Add a gallery</h2>
          <form onSubmit={importCloudGallery} aria-busy={quickAddBusy}>
            <label htmlFor="native-source-url">Public Dropbox, Google Drive, iCloud, or MEGA link</label>
            <input
              id="native-source-url"
              type="url"
              value={sourceUrl}
              onInput={(event) => setSourceUrl(readInput(event))}
              placeholder="Paste a public folder or album link"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              required
              disabled={quickAddBusy}
            />
            <button type="submit" disabled={quickAddBusy || pendingQuickAdd !== null}>
              {quickAddBusy ? 'Working…' : 'Manorama-fy it!'}
            </button>
          </form>
        </section>
      </div>
      <section class="native-list-card" aria-live="polite" aria-busy={status === 'loading'}>
        <h1>Your galleries</h1>
        {galleryActionNote ? <p role="status">{galleryActionNote}</p> : null}
        {authError ? <p role="alert">{authError}</p> : null}
        {quickAddBusy ? <p class="native-account-note" role="status">Reading the cloud folder and building your gallery…</p> : null}
        {error && !galleryOpen ? <p class="native-account-note" role="alert">{error}</p> : null}
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
                {/* Successive galleries swap the cover from one edge to the
                    other, so a phone column of cards zig-zags instead of
                    leaning and every cover stays beside its copy. */}
                {visibleAccountGalleries.map((gallery, index) => (
                  <li key={gallery.slug} class={index % 2 === 1 ? 'is-cover-right' : 'is-cover-left'}>
                    {accountGalleryRow(gallery)}
                    <div class="native-gallery-actions" role="group" aria-label={`${gallery.title} actions`}>
                      <button type="button" aria-label={`Copy ${gallery.title} link`} onClick={() => void copyGalleryLink(gallery)}>Copy link</button>
                      {gallery.sourceUrl ? <button type="button" aria-label={`Open ${gallery.title} source`} onClick={() => openExternal(gallery.sourceUrl!)}>Open source</button> : null}
                      {gallery.sourceUrl ? <button type="button" aria-label={`Refresh ${gallery.title} from source`} disabled={galleryActionBusy !== null || gallery.retention === 'pipeline'} title={gallery.retention === 'pipeline' ? 'Temporary galleries cannot be edited on this plan' : 'Refresh from source'} onClick={() => void mutateGallery(gallery, 'refresh')}>Refresh</button> : null}
                      <button type="button" aria-label={`Delete ${gallery.title}`} disabled={galleryActionBusy !== null} onClick={() => setRemoveGallerySlug(gallery.slug)}>Delete</button>
                    </div>
                    {removeGallerySlug === gallery.slug ? <div class="native-gallery-remove-confirm" role="group" aria-label={`Confirm removal of ${gallery.title}`}>
                      <p>Remove “{gallery.title}” from manorama? This cannot be undone. Your cloud files and existing device vault copies are not deleted.</p>
                      <button type="button" disabled={galleryActionBusy !== null} onClick={() => void mutateGallery(gallery, 'delete')}>Remove gallery</button>
                      <button type="button" disabled={galleryActionBusy !== null} onClick={() => setRemoveGallerySlug(null)}>Cancel</button>
                    </div> : null}
                  </li>
                ))}
              </ul>
            ) : accountGalleries && !accountListFailed && temporaryAccountGalleries.length === 0 ? (
              <p class="native-account-note">No galleries on this account yet.</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
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
            <h2>Account</h2>
            <button
              type="button"
              class="native-drawer-close"
              aria-label="Close account menu"
              onClick={closeAccountMenu}
            >
              ×
            </button>
          </div>
          <p class="native-drawer-note">{accountName} · manorama.xyz/{ownerSlug ?? ''}</p>
            {deviceListFailed ? (
              <p class="native-account-note">
                The list from this device could not be loaded.{' '}
                <button type="button" class="native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}
            {standaloneDeviceGalleries.length > 0 ? (
              <section class="native-device" aria-label="This device">
                <h2>This device</h2>
                <ul class="native-device-list">
                  {standaloneDeviceGalleries.map((gallery) => (
                    <li key={gallery.id}>
                      {gallery.publicGallerySlug && ownerSlug ? (
                        <button type="button" onClick={() => openSelection(ownerSlug, gallery.publicGallerySlug!)}>
                          <span class="native-gallery-title">{gallery.title}</span>
                          <span class="native-gallery-meta">{deviceMeta(gallery)}</span>
                        </button>
                      ) : (
                        <span class="native-gallery-row">
                          <span class="native-gallery-title">{gallery.title}</span>
                          <span class="native-gallery-meta">{deviceMeta(gallery)}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}


        {signedIn ? (
          <>
            {billing && billingState ? (
              <button type="button" onClick={() => void openSubscriptions()}>
                View subscription options
              </button>
            ) : null}
            {billingNote ? <p class="native-account-note">{billingNote}</p> : null}
            {suppressions ? (
              <section class="native-house-cards" aria-labelledby="native-house-cards-title">
                <h2 id="native-house-cards-title">House cards</h2>
                <p class="native-account-note">
                  House cards are manorama's own, shown occasionally between photographs. They are never counted in the position readout.
                </p>
                <div class="native-house-cards-actions">
                  <span class="native-house-cards-status">
                    {visibility?.show === false ? 'House cards hidden' : 'House cards shown'}
                    {visibility?.day ? ` · ${visibility.day}` : ''}
                    {visibility?.region ? ` · ${regionName(visibility.region)}` : ''}
                  </span>
                  <button
                    type="button"
                    disabled={!visibility?.day}
                    onClick={() => {
                      const day = visibility?.day
                      if (!day) return
                      const off = suppressions.some((item) => item.kind === 'day' && item.value === day)
                      void toggleSuppression('day', day, !off)
                    }}
                  >
                    {suppressions.some((item) => item.kind === 'day' && item.value === visibility?.day)
                      ? 'Show again today'
                      : 'Hide for the rest of today'}
                  </button>
                  <button
                    type="button"
                    disabled={!visibility?.region}
                    onClick={() => {
                      const region = visibility?.region
                      if (!region) return
                      const off = suppressions.some((item) => item.kind === 'region' && item.value === region)
                      void toggleSuppression('region', region, !off)
                    }}
                  >
                    {suppressions.some((item) => item.kind === 'region' && item.value === visibility?.region)
                      ? `Show in ${regionName(visibility?.region)}`
                      : `Hide in ${visibility?.region ? regionName(visibility.region) : 'this region'}`}
                  </button>
                </div>
              </section>
            ) : null}
            <section class="native-load-policy" aria-labelledby="native-load-policy-title">
              <h2 id="native-load-policy-title">How galleries load</h2>
              <label>
                <span>When you open an online gallery</span>
                <select
                  value={loadPolicy ?? DEFAULT_VAULT_LOAD_POLICY}
                  disabled={policySaving || loadPolicy === null}
                  onChange={(event: Event) => void changeLoadPolicy((event.currentTarget as HTMLSelectElement).value as VaultLoadPolicy)}
                >
                  <option value="vault">Download to encrypted vault (default)</option>
                  <option value="stream">Stream from cloud when needed</option>
                </select>
              </label>
              <p class="native-account-note">
                Vault copies are encrypted and visible only inside the manorama app — not in Files or another image viewer.
                Streaming does not save new image bytes on this device.
              </p>
            </section>
            <section class="native-global-setting" aria-labelledby="native-global-setting-title">
              <h2 id="native-global-setting-title">Photo picker</h2>
              <label>
                <input
                  type="checkbox"
                  checked={globalViewEnabled === true}
                  disabled={globalViewSaving || globalViewEnabled === null}
                  onChange={(event: Event) => void changeGlobalView((event.currentTarget as HTMLInputElement).checked)}
                />
                  <span>Keep photos from this device ready to choose in galleries</span>
              </label>
              <p class="native-account-note">
                Everything stays encrypted and on this device. Turn it on here once; the photo picker can then show photographs already saved here.
              </p>
              {globalViewEnabled ? (
                <button type="button" onClick={() => setGlobalViewOpen(true)}>
                  Open photo picker
                </button>
              ) : null}
            </section>
            <details class="native-another">
              <summary>Open another gallery</summary>
              {openForm}
            </details>
          </>
        ) : null}

            <div class="native-account-delete">
              {deleteConfirming ? (
                <>
                  <p class="native-account-note">
                    This removes your galleries, device catalogue and sign-in methods from manorama. Nothing in
                    your Dropbox, Google Drive, iCloud or MEGA is touched. If you subscribe, cancel first —
                    App Store: Settings › Subscriptions; web: your Stripe receipt.
                  </p>
                  <div class="native-account-delete-actions">
                    <button type="button" disabled={deleting || !ownerSlug} onClick={() => void deleteAccountForever()}>
                      {deleting ? 'Deleting…' : 'Delete permanently'}
                    </button>
                    <button
                      type="button"
                      class="native-account-signout"
                      disabled={deleting}
                      onClick={() => {
                        setDeleteConfirming(false)
                        setDeleteError(null)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" class="native-account-signout" onClick={openDeleteConfirm}>
                  Delete account
                </button>
              )}
              {deleteError ? <p class="native-account-note">{deleteError}</p> : null}
            </div>
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
        store={productionOfflineGalleryStore}
        tier={billingState?.tier}
        current={manifest ? selection : null}
        onOpenFrame={openGlobalFrame}
        onClose={() => setGlobalViewOpen(false)}
      />
    ) : null}
    </>
  )
}
