import { useEffect, useMemo, useState } from 'hono/jsx'
import type { GalleryManifest } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { BundledSource } from '../../app/lib/imagesource'
import { fetchGallery, normalizeApiBase } from '../lib/api'
import type { RevenueCatBilling } from '../lib/billing'
import Paywall from './Paywall'

type Props = {
  apiBase: string
  owner?: string
  slug?: string
  onSignIn?: () => void
  billing?: RevenueCatBilling
}

type Selection = { owner: string; slug: string }

const selectionFromLocation = (): Selection => {
  if (typeof window === 'undefined') return { owner: '', slug: '' }
  const params = new URLSearchParams(window.location.search)
  const path = window.location.pathname.split('/').filter(Boolean)
  return {
    owner: params.get('owner')?.trim() || path[0] || '',
    slug: params.get('slug')?.trim() || path[1] || '',
  }
}

export default function GalleryList({ apiBase, owner, slug, onSignIn, billing }: Props) {
  const initial = selectionFromLocation()
  const [selection, setSelection] = useState<Selection>({
    owner: owner ?? initial.owner,
    slug: slug ?? initial.slug,
  })
  const [ownerInput, setOwnerInput] = useState(selection.owner)
  const [slugInput, setSlugInput] = useState(selection.slug)
  const [manifest, setManifest] = useState<GalleryManifest | null>(null)
  const [settings, setSettings] = useState<GallerySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paywallOpen, setPaywallOpen] = useState(false)
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase])

  useEffect(() => {
    if (!selection.owner || !selection.slug) return
    const controller = new AbortController()
    setError(null)
    setManifest(null)
    setSettings(null)
    fetchGallery(
      base,
      selection.owner,
      selection.slug,
      controller.signal,
    )
      .then((payload) => {
        setManifest(payload.manifest)
        setSettings(payload.settings)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'That gallery could not be opened',
          )
        }
      })
    return () => controller.abort()
  }, [base, selection.owner, selection.slug])

  if (manifest && settings) {
    const source = new BundledSource(manifest)
    return (
      <GalleryShell settings={settings}>
        <Viewer
          slug={manifest.slug}
          images={source.list()}
          settings={settings}
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
      setError('Enter both an owner and gallery slug')
      return
    }
    setSelection(next)
  }

  const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value
  return (
    <main class="native-list-shell">
      <section class="native-list-card" aria-live="polite">
        <span class="brand-mark-wrap">
          <img
            src="/manorama-merged-logo.png"
            alt="manorama"
            class="native-list-logo"
          />
        </span>
        <h1>Open a gallery</h1>
        <p>{error ?? 'Connect to manorama to view a public gallery.'}</p>
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
