import type { DeviceGallery } from '../../../packages/core/device-gallery'
import SourceMark from '../home/SourceMark'
import { SectionChevron } from './SectionChevron'

/** The web form of a synced device gallery — a compact index tile: the
 *  local mark, the title, the count and the device the folder lives on.
 *  Still no thumbnail and no link: the synced row carries no paths, so
 *  there is nothing honest to render a cover from or open in a browser. */
export const deviceTileCard = (gallery: DeviceGallery) => (
  <li key={gallery.id} class="lib-device-card" data-gallery-card={`device:${gallery.id}`}>
    <span class="lib-device-mark"><SourceMark id="local" /></span>
    <div class="lib-device-text">
      <p class="lib-device-title" title={gallery.title}>{gallery.title}</p>
      <p class="lib-device-sub">{gallery.itemCount} {gallery.itemCount === 1 ? 'photograph' : 'photographs'}</p>
      <p class="lib-device-sub" title={gallery.deviceLabel}>{gallery.deviceLabel}</p>
    </div>
  </li>
)

/** The compact tile grid — the hidden-galleries fold reuses it so a
 *  concealed device row stays recoverable anywhere the account's hides
 *  are listed. */
export const DeviceGalleriesGrid = ({ galleries }: { galleries: readonly DeviceGallery[] }) => (
  <ul class="lib-device-grid">{galleries.map(deviceTileCard)}</ul>
)

/** The compact thumbnail-less Local section the web Library gets. The feed
 *  itself answers empty for Free, so no tier gate lives here.
 *
 *  `open`/`onToggle` make the section collapsible like the Cloud and Hidden
 *  sections around it — the host owns the state because this component is
 *  also rendered bare by the render tests, outside any hook context. */
export const DeviceGalleriesSection = ({ galleries, open = true, onToggle }: {
  galleries: readonly DeviceGallery[]
  open?: boolean
  onToggle?: () => void
}) =>
  galleries.length ? (
    <section aria-labelledby="lib-devices-title">
      <button
        type="button"
        id="lib-devices-title"
        class="lib-section-title lib-compact-title lib-hidden-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <SectionChevron open={open} />
        Local galleries <span class="lib-hidden-count">({galleries.length})</span>
      </button>
      {open ? (
        <>
          <p class="lib-section-sub">Folders on your devices — the originals stay there; open them in the app.</p>
          <DeviceGalleriesGrid galleries={galleries} />
        </>
      ) : null}
    </section>
  ) : null
