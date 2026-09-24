import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { FoldLayout } from '../../packages/core/fold'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { BundledSource } from '../../app/lib/imagesource'
import { isAdFrame } from '../../app/lib/adframe'
import { fetchGallery, normalizeApiBase } from '../lib/api'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import {
  OfflineGalleryUnavailableError,
  openGalleryNetworkFirst,
  productionOfflineGalleryStore,
  type NetworkFirstGallery,
} from '../lib/offline-gallery'
import { adFrameFor } from '../lib/ads'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../lib/fold'
import Paywall from './Paywall'
import Diptych, { type DiptychFrame } from './Diptych'

type Props = {
  apiBase: string
  owner?: string
  slug?: string
  onSignIn?: () => void
  authError?: string | null
  billing?: RevenueCatBilling
  billingState?: BillingState
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

export default function GalleryList({ apiBase, owner, slug, onSignIn, authError, billing, billingState }: Props) {
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
  const [plateReady, setPlateReady] = useState(false)
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

  useEffect(() => {
    if (!manifest) return
    let active = true
    setPlateReady(false)
    void adFrameFor({ tier: billingState?.isPro ? 'pro' : 'free' }).then((frame) => {
      if (active) {
        setPlate(frame)
        setPlateReady(true)
      }
    })
    return () => { active = false }
  }, [manifest, billingState?.isPro])

  useEffect(() => {
    if (!manifest) return
    const sync = () => setFoldLayout(readRuntimeFoldLayout())
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [manifest])

  if (manifest && settings) {
    const source = new BundledSource(manifest)
    const runtimePlate = source.listWithPlate(plate).find(isAdFrame)
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
          plate={runtimePlate ?? null}
          foldLayout={foldEligible && plateReady && !runtimePlate ? foldLayout : null}
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
  return (
    <main class="native-list-shell">
      <section class="native-list-card" aria-live="polite" aria-busy={status === 'loading'}>
        <span class="brand-mark-wrap">
          <img
            src="/manorama-merged-logo.png"
            alt="manorama"
            class="native-list-logo"
          />
        </span>
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
