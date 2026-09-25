import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { BundledSource } from '../../app/lib/imagesource'
import type { AdFrame } from '../../app/lib/adframe'
import { fetchGallery, normalizeApiBase } from '../lib/api'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  openGalleryNetworkFirst,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
} from '../lib/offline-gallery'
import { adFrameFor, fetchAdVisibility, type AdPolicyInput, type AdVisibility } from '../lib/ads'
import { getSessionToken } from '../lib/session'
import type { AdSuppression } from '../../app/lib/ads-visibility'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Diptych, { type DiptychFrame } from './Diptych'
import '../styles/account-ad.css'

type Props = {
  apiBase: string
  owner?: string
  slug?: string
  onSignIn?: () => void
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
      <GalleryShell settings={settings} status={status === 'offline' ? galleryStatusMessage(status) : undefined}>
        <Viewer
          slug={manifest.slug}
          images={source.list()}
          settings={settings}
          plate={plate}
          foldLayout={foldEligible ? foldLayout : null}
          foldRenderer={foldEligible ? renderFold : undefined}
        />
      </GalleryShell>
    )
  }

  if (paywallOpen && billing) {
    return <Paywall billing={billing} onClose={() => setPaywallOpen(false)} />
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
    setSelection(next)
  }

  const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value
  const message = authError ?? error ?? galleryStatusMessage(status)
  // Render gate: an unresolved entitlement drops the slot in the same paint
  // that learns the tier, so no stale creative can outlive a change. The
  // master switch suppresses it outright.
  const accountAdFrame = billingState?.tier && visibility?.show !== false ? accountAd : null
  return (
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
        <h1>Open a gallery</h1>
        <p>{message}</p>
        {onSignIn && (
          <button type="button" onClick={onSignIn}>
            Sign in with Dropbox
          </button>
        )}
        {billing && (
          <button type="button" onClick={() => setPaywallOpen(true)}>
            View subscription options
          </button>
        )}
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
      </section>
    </main>
  )
}
