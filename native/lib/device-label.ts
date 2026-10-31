import { Capacitor } from '@capacitor/core'

export type NativeDeviceKind = 'iphone' | 'ipad' | 'device'

type NavigatorLike = { userAgent?: string; platform?: string; maxTouchPoints?: number }

/** Wording only: platform detection never changes gallery or vault behavior.
 *  iPadOS can report a desktop Mac UA, so touch points are part of that check. */
export const nativeDeviceKind = (
  platform = Capacitor.getPlatform(),
  navigatorLike?: NavigatorLike,
): NativeDeviceKind => {
  if (platform !== 'ios') return 'device'
  const nav = navigatorLike ?? (typeof navigator === 'undefined' ? {} : navigator)
  const ua = nav.userAgent ?? ''
  if (/iPad/i.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)) return 'ipad'
  return 'iphone'
}

const DEVICE_NAME: Record<NativeDeviceKind, string> = { iphone: 'iPhone', ipad: 'iPad', device: 'device' }

export const nativeDeviceLabel = (kind = nativeDeviceKind()): string => `this ${DEVICE_NAME[kind]}`

/** Sentence-start form for headings and row labels: "This iPad". */
export const nativeDeviceTitle = (kind = nativeDeviceKind()): string => `This ${DEVICE_NAME[kind]}`
