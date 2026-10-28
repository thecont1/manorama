/** P2 seam fixture: the real GalleryShell + Viewer with a deterministic
 *  fixture manifest, an external toggle that suspends the stage behind an
 *  opaque layer, and a readout of the last onPositionChange payload. */
import { render, useState } from 'hono/jsx/dom'
import GalleryShell from '../app/components/GalleryShell'
import Viewer from '../app/islands/Viewer'
import { BundledSource } from '../app/lib/imagesource'
import { adFrameFor } from './lib/ads'
import { fetchGallery } from './lib/api'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Fixture root is missing')

const gallery = await fetchGallery(window.location.origin, 'fixture', 'ads-fixture')
const manifest = gallery.manifest
const plate = await adFrameFor({ tier: 'free' })
const source = new BundledSource(manifest)

const Fixture = () => {
  const [suspended, setSuspended] = useState(false)
  const [last, setLast] = useState('')
  return (
    <>
      <div style="position:fixed;top:0;left:0;right:0;z-index:60;display:flex;gap:8px;padding:8px;background:#111">
        <button id="toggle-details" type="button" onClick={() => setSuspended((s) => !s)}>Toggle details</button>
        <output id="position-readout" data-position={last}>{last}</output>
      </div>
      <GalleryShell settings={gallery.settings} mediaCount={{ stills: source.list().filter((item) => item.type !== 'video').length, videos: source.list().filter((item) => item.type === 'video').length }}>
        <Viewer
          slug={manifest.slug}
          images={source.list()}
          settings={gallery.settings}
          plate={plate}
          suspended={suspended}
          onPositionChange={(p) => setLast(`${p.imageId}@${p.index}`)}
        />
      </GalleryShell>
      {suspended ? (
        <div data-screen="details" style="position:fixed;inset:0;background:#161616;z-index:50">
          <p style="padding:20px">Details screen placeholder</p>
        </div>
      ) : null}
    </>
  )
}

render(<Fixture />, root)
