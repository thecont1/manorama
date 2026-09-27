import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { BundledSource } from '../../app/lib/imagesource'
import type { AdFrame } from '../../app/lib/adframe'
import { fetchAccountGalleries, fetchDeviceGalleries, fetchGallery, normalizeApiBase } from '../lib/api'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  openGalleryNetworkFirst,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
} from '../lib/offline-gallery'
import { adFrameFor, fetchAdVisibility, type AdPolicyInput, type AdVisibility } from '../lib/ads'
import { clearSessionToken, getOwnerSlug, getSessionToken, type AuthProvider } from '../lib/session'
import type { AdSuppression } from '../../app/lib/ads-visibility'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Diptych, { type DiptychFrame } from './Diptych'
import GlobalView from './GlobalView'
import '../styles/account-ad.css'

type Props = {
  apiBase: string
  owner?: string
  slug?: string
  onSignIn?: (provider: AuthProvider) => void
  authError?: string | null
  billing?: RevenueCatBilling
  billingState?: BillingState
  /** House-policy loader for the account slot. Production never passes this;
   *  tests inject it to stage a slow resolution against an entitlement change. */
  accountAdLoader?: (input: AdPolicyInput) => Promise<AdFrame | null>
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

export const galleryStatusMessage = (status: GalleryStatus): string => {
  if (status === 'loading') return 'Opening gallery…'
  if (status === 'offline') return 'Available offline. Full resolution returns with your connection.'
  if (status === 'online') return 'Gallery connected.'
  if (status === 'error') return 'That gallery could not be opened.'
  return 'Connect to manorama to view a public gallery.'
}

/** Opens native galleries from the network or local vault and presents eligible
 *  photo pairs in the fold layout when the device has two usable segments. */
export default function GalleryList({ apiBase, owner, slug, onSignIn, authError, billing, billingState, accountAdLoader = adFrameFor }: Props) {
  const initial = selectionFromLocation()
  const [selection, setSelection] = useState<Selection>({
    owner: owner ?? initial.owner,
    slug: slug ?? initial.slug,
  })
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
  const [ownerSlug, setOwnerSlug] = useState<string | undefined>(undefined)
  const [accountGalleries, setAccountGalleries] = useState<GallerySummary[] | null>(null)
  const [accountListFailed, setAccountListFailed] = useState(false)
  const [deviceGalleries, setDeviceGalleries] = useState<DeviceGallery[] | null>(null)
  const [deviceListFailed, setDeviceListFailed] = useState(false)
  const [accountRevision, setAccountRevision] = useState(0)
  const [billingNote, setBillingNote] = useState<string | null>(null)
  // Global-grid frame entry: index is the Viewer mount seed, nonce forces a
  // remount when the same gallery is re-entered at a different frame.
  const [frameKick, setFrameKick] = useState({ index: 0, nonce: 0 })
  const leaseRef = useRef<Pick<NetworkFirstGallery, 'dispose'> | null>(null)
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase])

  useEffect(() => {
    if (!selection.owner || !selection.slug) return
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
      void gallery.cacheFill?.catch(() => {
        // Viewing stays online if a background cache fill is interrupted or full.
      })
    }
    const open = () => {
      setError(null)
      setStatus((previous) => previous === 'offline' ? previous : 'loading')
      setPlate(null)
      return openGalleryNetworkFirst({
        selection,
        store: productionOfflineGalleryStore,
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
  }, [base, selection.owner, selection.slug])

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
      setSignedIn(Boolean(token))
      if (!token) return
      const [account, device] = await Promise.allSettled([
        fetchAccountGalleries(base, controller.signal),
        fetchDeviceGalleries(base, controller.signal),
      ])
      if (!active) return
      setAccountGalleries(account.status === 'fulfilled' ? account.value : null)
      setAccountListFailed(account.status === 'rejected')
      setDeviceGalleries(device.status === 'fulfilled' ? device.value : null)
      setDeviceListFailed(device.status === 'rejected')
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
  useEffect(() => {
    if (galleryOpen || !billingState?.tier) {
      setAccountAd(null)
      return
    }
    let active = true
    void accountAdLoader({ tier: billingState.isPro ? 'pro' : 'free', visible: visibility?.show }).then((frame) => {
      if (active) setAccountAd(frame)
    })
    return () => { active = false }
  }, [galleryOpen, billingState?.tier, billingState?.isPro, visibility?.show])

  useEffect(() => {
    if (!manifest) return
    const sync = () => setFoldLayout(readRuntimeFoldLayout())
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [manifest])

  const openGlobalFrame = (next: Selection, index: number) => {
    setGlobalViewOpen(false)
    if (next.owner === selection.owner && next.slug === selection.slug) {
      // Same gallery: bump the remount nonce so the viewer re-seeds at index.
      setFrameKick((kick) => ({ index, nonce: kick.nonce + 1 }))
      return
    }
    setFrameKick({ index, nonce: 0 })
    setSelection(next)
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
            images={source.list()}
            settings={settings}
            plate={plate}
            initialIndex={frameKick.index}
            foldLayout={foldEligible ? foldLayout : null}
            foldRenderer={foldEligible ? renderFold : undefined}
          />
        </GalleryShell>
        <button
          type="button"
          class="native-global-open"
          onClick={() => setGlobalViewOpen(true)}
          aria-label="Global view — every frame on this device"
        >
          Index
        </button>
        {globalViewOpen ? (
          <GlobalView
            store={productionOfflineGalleryStore}
            tier={billingState?.tier}
            current={selection}
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

  // Beta-honest purchase entry: RevenueCat may be configured yet have no
  // sellable offerings in this build, and that deserves a sentence rather
  // than a paywall that can only fail.
  const openSubscriptions = async () => {
    if (!billing) return
    setBillingNote(null)
    try {
      const offering = await billing.offerings()
      if (!offering || offering.availablePackages.length === 0) {
        setBillingNote("Subscriptions aren't available in this test build.")
        return
      }
    } catch {
      setBillingNote("Subscriptions aren't available in this test build.")
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
  const message = authError ?? error ?? galleryStatusMessage(status)
  // The manual form stays as the secondary path for galleries outside the
  // signed-in account; signed out it remains the only way in.
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
  // Render gate: an unresolved entitlement drops the slot in the same paint
  // that learns the tier, so no stale creative can outlive a change. The
  // master switch suppresses it outright.
  const accountAdFrame = billingState?.tier && visibility?.show !== false ? accountAd : null
  return (
    <>
    <main class="native-list-shell">
      <section class="native-list-card" aria-live="polite" aria-busy={status === 'loading'}>
        <header class="native-account-header">
          <span class="brand-mark-wrap">
            <img
              src="/manorama-merged-logo.png"
              alt="manorama"
              class="native-list-logo"
            />
          </span>
          {accountAdFrame ? (
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
          ) : null}
        </header>
        <h1>{signedIn ? 'Your galleries' : 'Open a gallery'}</h1>
        <p>{message}</p>
        {signedIn ? (
          <div class="native-account" data-account>
            <div class="native-account-line">
              <span class="native-account-identity">
                {ownerSlug ? `manorama.xyz/${ownerSlug}` : 'Signed in'}
              </span>
              <button type="button" class="native-account-signout" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
            {accountListFailed ? (
              <p class="native-account-note">
                Your galleries could not be loaded.{' '}
                <button type="button" class="native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}
            {accountGalleries && accountGalleries.length > 0 ? (
              <ul class="native-gallery-list">
                {accountGalleries.map((gallery) => (
                  <li key={gallery.slug}>
                    {ownerSlug ? (
                      <button type="button" onClick={() => openSelection(ownerSlug, gallery.slug)}>
                        <span class="native-gallery-title">{gallery.title || gallery.slug}</span>
                        <span class="native-gallery-meta">
                          {gallery.slug} · {gallery.imageCount} {gallery.imageCount === 1 ? 'item' : 'items'}
                        </span>
                      </button>
                    ) : (
                      <span class="native-gallery-row">
                        <span class="native-gallery-title">{gallery.title || gallery.slug}</span>
                        <span class="native-gallery-meta">{gallery.slug}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : accountGalleries && !accountListFailed ? (
              <p class="native-account-note">No galleries on this account yet.</p>
            ) : null}
            {deviceListFailed ? (
              <p class="native-account-note">
                The list from your Mac could not be loaded.{' '}
                <button type="button" class="native-retry" onClick={retryAccountLists}>
                  Try again
                </button>
              </p>
            ) : null}
            {deviceGalleries && deviceGalleries.length > 0 ? (
              <section class="native-device" aria-label="On your Mac">
                <h2>On your Mac</h2>
                <ul class="native-device-list">
                  {deviceGalleries.map((gallery) => (
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
          </div>
        ) : null}
        {signedIn === false && onSignIn ? (
          // App Review 4.8: a third-party sign-in must sit beside Sign in
          // with Apple, given no less prominence — Apple leads the list.
          <>
            <button type="button" onClick={() => onSignIn('apple')}>
              Sign in with Apple
            </button>
            <button type="button" onClick={() => onSignIn('google')}>
              Continue with Google
            </button>
            <button type="button" onClick={() => onSignIn('dropbox')}>
              Continue with Dropbox
            </button>
          </>
        ) : null}
        {billing && billingState ? (
          <button type="button" onClick={() => void openSubscriptions()}>
            View subscription options
          </button>
        ) : null}
        {billingNote ? <p class="native-account-note">{billingNote}</p> : null}
        {suppressions ? (
          <div class="native-plate-switch" aria-label="Plate visibility">
            <span class="native-plate-switch-state">
              {visibility?.show === false ? 'Plates hidden' : 'Plates shown'}
              {visibility?.day ? ` · ${visibility.day}` : ''}
              {visibility?.region ? ` · ${visibility.region}` : ''}
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
                ? 'Show today'
                : 'Hide today'}
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
                ? `Show in ${visibility?.region}`
                : `Hide in ${visibility?.region ?? 'this region'}`}
            </button>
          </div>
        ) : null}
        <button type="button" onClick={() => setGlobalViewOpen(true)}>
          Global view
        </button>
        {signedIn ? (
          <details class="native-another">
            <summary>Open another gallery</summary>
            {openForm}
          </details>
        ) : (
          openForm
        )}
      </section>
    </main>
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
