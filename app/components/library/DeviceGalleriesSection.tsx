import type { Child } from 'hono/jsx'
import type { DeviceGallery } from '../../../packages/core/device-gallery'
import { findDevice, type Device } from '../../../packages/core/devices'
import { DevicePill } from './DevicePill'
import { SectionChevron } from './SectionChevron'

/** A synced device gallery as a super-compact tile: the title, the count and
 *  the pill of the device the folder lives on. No cover and no link — the
 *  synced row carries no paths and no bytes, so there is nothing honest to
 *  render an image from. A row whose device is no longer on the account
 *  wears the neutral "Another device" pill rather than a stale name. */
export const deviceTileCard = (gallery: DeviceGallery, devices: readonly Device[], options: { action?: Child; onOpen?: () => void } = {}) => {
  const device = findDevice(devices, gallery.deviceId)
  return (
    <li key={gallery.id} class="lib-device-card" data-gallery-card={`device:${gallery.id}`}>
      {options.onOpen ? (
        <button type="button" class="lib-device-title lib-device-open" title={gallery.title} onClick={options.onOpen}>{gallery.title}</button>
      ) : (
        <p class="lib-device-title" title={gallery.title}>{gallery.title}</p>
      )}
      <p class="lib-device-meta">
        <span>{gallery.itemCount} {gallery.itemCount === 1 ? 'photograph' : 'photographs'}</span>
        <DevicePill device={device} devices={devices} />
      </p>
      {options.action ?? null}
    </li>
  )
}

/** The compact tile grid — the hidden-galleries fold reuses it so a
 *  concealed device row stays recoverable anywhere the account's hides
 *  are listed. `action` is the surface's own per-row control (the desktop
 *  card menu); the web and the phone pass nothing. */
export const DeviceGalleriesGrid = ({ galleries, devices, action, onOpen }: {
  galleries: readonly DeviceGallery[]
  devices: readonly Device[]
  action?: (gallery: DeviceGallery) => Child
  /** Only a published row opens elsewhere; a naked mirror has nowhere to go. */
  onOpen?: (gallery: DeviceGallery) => void
}) => (
  <ul class="lib-device-grid">
    {galleries.map((gallery) => deviceTileCard(gallery, devices, {
      action: action?.(gallery),
      onOpen: onOpen && gallery.publicGallerySlug ? () => onOpen(gallery) : undefined,
    }))}
  </ul>
)

/** The compact thumbnail-less Local section the web Library gets. The feed
 *  itself answers empty for Free, so no tier gate lives here.
 *
 *  `open`/`onToggle` make the section collapsible like the Cloud and Hidden
 *  sections around it — the host owns the state because this component is
 *  also rendered bare by the render tests, outside any hook context. */
export const DeviceGalleriesSection = ({ galleries, devices = [], open = true, onToggle }: {
  galleries: readonly DeviceGallery[]
  devices?: readonly Device[]
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
          <DeviceGalleriesGrid galleries={galleries} devices={devices} />
        </>
      ) : null}
    </section>
  ) : null
