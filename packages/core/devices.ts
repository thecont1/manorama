import { DEVICE_GALLERY_ID_PATTERN } from './device-gallery'

/** The kinds a device can report. Deliberately coarse: a phone model or a
 *  machine name would identify the owner's hardware, which is exactly what
 *  the server is not allowed to hold. */
export const DEVICE_KINDS = ['mac', 'windows', 'linux', 'iphone', 'ipad', 'android'] as const
export type DeviceKind = typeof DEVICE_KINDS[number]

export const DEVICE_KIND_NAME: Record<DeviceKind, string> = {
  mac: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  iphone: 'iPhone',
  ipad: 'iPad',
  android: 'Android',
}

/** A device unseen for this long drops off the account's list — and its
 *  synced mirrors go with it. */
export const DEVICE_EXPIRY_DAYS = 180

/** One pill colour per live device. The palette is twelve slots wide; a
 *  thirteenth live device is refused rather than repeating a colour. */
export const DEVICE_COLOUR_SLOTS = 12

/** The label a gallery wears when its device is no longer on the account —
 *  forgotten, expired, or an older build that never registered. */
export const UNKNOWN_DEVICE_LABEL = 'Another device'

export type Device = {
  id: string
  kind: DeviceKind
  /** The number that names it: "Mac 2" is ordinal 2. Never reused. */
  ordinal: number
  /** Palette slot, 0–11. Unique among an owner's live devices. */
  colour: number
  firstSeenAt: string
  lastSeenAt: string
}

export type DeviceRegistration = { kind: DeviceKind }

export const isDeviceKind = (value: unknown): value is DeviceKind =>
  typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value)

/** The register call is the only thing a device says about itself: its kind.
 *  Strict like every other wire parse — an unknown key is a rejected body. */
export const parseDeviceRegistration = (value: unknown): DeviceRegistration | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => key !== 'kind')) return null
  if (!isDeviceKind(body.kind)) return null
  return { kind: body.kind }
}

export const isDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && DEVICE_GALLERY_ID_PATTERN.test(value)

/** Kind first (Mac before iPhone), then the device's own number, so the
 *  legend reads the same on every device of the account. */
export const sortDevices = (devices: readonly Device[]): Device[] =>
  [...devices].sort((left, right) =>
    DEVICE_KINDS.indexOf(left.kind) - DEVICE_KINDS.indexOf(right.kind) || left.ordinal - right.ordinal)

/** "Mac" while it is the only Mac, "Mac 2" once a second one joins. The
 *  ordinal never changes, so a forgotten device leaves a gap rather than
 *  renumbering someone else's pill. */
export const deviceShortName = (device: Device, devices: readonly Device[]): string => {
  const name = DEVICE_KIND_NAME[device.kind] ?? DEVICE_KIND_NAME.mac
  return devices.some((other) => other.kind === device.kind && other.id !== device.id)
    ? `${name} ${device.ordinal}`
    : name
}

/** The first palette slot no live device of this owner is wearing, or null
 *  when the palette is full. */
export const lowestFreeColour = (devices: readonly Device[]): number | null => {
  const used = new Set(devices.map((device) => device.colour))
  for (let slot = 0; slot < DEVICE_COLOUR_SLOTS; slot += 1) if (!used.has(slot)) return slot
  return null
}

/** Read-time expiry: the list hides stale devices and a register call sweeps
 *  them, so no cron is needed to keep the account honest. */
export const isDeviceExpired = (device: Pick<Device, 'lastSeenAt'>, now = Date.now()): boolean => {
  const seen = Date.parse(device.lastSeenAt)
  if (Number.isNaN(seen)) return true
  return now - seen > DEVICE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
}

export const findDevice = (devices: readonly Device[], id: string | null | undefined): Device | null =>
  id ? devices.find((device) => device.id === id) ?? null : null
