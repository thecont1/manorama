import type { DeviceGallery } from '../../../packages/core/device-gallery'

/** The web form of a synced device gallery — title, count and the device
 *  the folder lives on, deliberately no thumbnail: the synced row carries
 *  no paths, so there is nothing honest to render a cover from. */
export const deviceRowCard = (gallery: DeviceGallery) => (
  <li key={gallery.id}><article class="lib-card" data-gallery-card={`device:${gallery.id}`}>
    <div class="lib-card-head">
      <span class="lib-card-title">{gallery.title}</span>
    </div>
    <p class="lib-card-sub">
      {gallery.itemCount} {gallery.itemCount === 1 ? 'photograph' : 'photographs'} · {gallery.deviceLabel} · synced — open it in the app
    </p>
  </article></li>
)

/** The bare rows list — the hidden-galleries fold reuses it so a concealed
 *  device row stays recoverable anywhere the account's hides are listed. */
export const DeviceGalleriesRows = ({ galleries }: { galleries: readonly DeviceGallery[] }) => (
  <ul class="lib-list">{galleries.map(deviceRowCard)}</ul>
)

/** The compact thumbnail-less Local section the web Library gets. The feed
 *  itself answers empty for Free, so no tier gate lives here. */
export const DeviceGalleriesSection = ({ galleries }: { galleries: readonly DeviceGallery[] }) =>
  galleries.length ? (
    <section aria-labelledby="lib-devices-title">
      <h2 id="lib-devices-title" class="lib-section-title lib-compact-title">Local galleries <span class="lib-section-count">({galleries.length})</span></h2>
      <p class="lib-section-sub">Folders on your devices — the originals stay there; open them in the app.</p>
      <DeviceGalleriesRows galleries={galleries} />
    </section>
  ) : null
