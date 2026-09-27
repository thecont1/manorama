import { MAX_GALLERY_ITEMS } from './imagesource'

export type DeviceGalleryInput = {
  title: string
  sourceKind: 'folder' | 'card'
  itemCount: number
  deviceId: string
  deviceLabel: string
  publicGallerySlug?: string
}

export type DeviceGallery = DeviceGalleryInput & { id: string; updatedAt: string }

export const DEVICE_GALLERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAX_GALLERY_TITLE_LENGTH = 120

export const parseDeviceGalleryInput = (value: unknown): DeviceGalleryInput | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const allowed = new Set(['title', 'sourceKind', 'itemCount', 'deviceId', 'deviceLabel', 'publicGallerySlug'])
  if (Object.keys(body).some((key) => !allowed.has(key))) return null
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > MAX_GALLERY_TITLE_LENGTH) return null
  if (body.sourceKind !== 'folder' && body.sourceKind !== 'card') return null
  if (typeof body.itemCount !== 'number' || !Number.isInteger(body.itemCount) || body.itemCount < 0 || body.itemCount > MAX_GALLERY_ITEMS) return null
  if (typeof body.deviceId !== 'string' || !DEVICE_GALLERY_ID_PATTERN.test(body.deviceId)) return null
  if (typeof body.deviceLabel !== 'string' || !body.deviceLabel.trim() || body.deviceLabel.trim().length > 80) return null
  if (body.publicGallerySlug !== undefined && (typeof body.publicGallerySlug !== 'string' || body.publicGallerySlug.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.publicGallerySlug))) return null
  return { title: body.title.trim(), sourceKind: body.sourceKind, itemCount: body.itemCount, deviceId: body.deviceId, deviceLabel: body.deviceLabel.trim(), ...(typeof body.publicGallerySlug === 'string' ? { publicGallerySlug: body.publicGallerySlug } : {}) }
}
