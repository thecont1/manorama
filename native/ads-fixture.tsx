/** Test-only entry for #23's browser ad-safety coverage, served by
 *  vite.config.native-fixture.ts in dev mode. `vite build` emits only
 *  index.html — none of this ships in the Capacitor bundle.
 *
 *  The page mirrors the exact seam GalleryList uses to present a gallery:
 *  the manifest arrives through fetchGallery and the plate through the real
 *  adFrameFor policy; the Viewer places it on the seeded cadence.
 *  The only test seams are __MANORAMA_AD_FIXTURE__ (the tier to resolve,
 *  pinned before load so the fixture never needs a runtime switch) and
 *  __MANORAMA_AD_FIXTURE_STATE__, which lets the spec compare the stored
 *  manifest record after real viewing. */
import { render } from 'hono/jsx/dom'
import GalleryShell from '../app/components/GalleryShell'
import Viewer from '../app/islands/Viewer'
import { BundledSource } from '../app/lib/imagesource'
import type { GalleryManifest } from '../app/lib/imagesource'

import { adFrameFor } from './lib/ads'
import { fetchGallery } from './lib/api'
import './styles.css'

declare global {
  interface Window {
    __MANORAMA_AD_FIXTURE__?: { tier?: 'free' | 'pro' }
    __MANORAMA_AD_FIXTURE_STATE__?: {
      manifest: GalleryManifest
      imagesJsonAtOpen: string
    }
  }
}

const config = window.__MANORAMA_AD_FIXTURE__ ?? {}

const root = document.getElementById('app')
if (!root) throw new Error('Fixture root is missing')

const gallery = await fetchGallery(window.location.origin, 'fixture', 'ads-fixture')
const manifest = gallery.manifest
const plate = await adFrameFor({ tier: config.tier ?? 'free' })
const source = new BundledSource(manifest)

window.__MANORAMA_AD_FIXTURE_STATE__ = {
  manifest,
  imagesJsonAtOpen: JSON.stringify(manifest.images),
}

render(
  <GalleryShell settings={gallery.settings}>
    <Viewer slug={manifest.slug} images={source.list()} settings={gallery.settings} plate={plate} />
  </GalleryShell>,
  root,
)
