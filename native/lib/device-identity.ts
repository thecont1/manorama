import { Capacitor } from '@capacitor/core'
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'
import { isDeviceId, type DeviceKind } from '../../packages/core/devices'
import { nativeDeviceKind } from './device-label'

/**
 * This phone's identity in the account's device list. One random UUID,
 * created on first use and kept in the platform secure store — Keychain on
 * iOS, Keystore on Android — marked `whenUnlockedThisDeviceOnly` so it never
 * rides an encrypted backup to another phone. Nothing identifying is read:
 * no name, no model, no serial, no advertising identifier.
 */

const DEVICE_ID_KEY = 'manorama.device-id.v1'

/** Injectable storage so the identity logic runs in `bun test` without the
 *  Capacitor plugin. */
export type DeviceIdentityStorage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

const secureStorage: DeviceIdentityStorage = {
  getItem: (key) => SecureStorage.getItem(key),
  async setItem(key, value) {
    await SecureStorage.setSynchronize(false)
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
    await SecureStorage.setItem(key, value)
  },
}

let fallback: string | null = null

/** The stable id for this install. A secure-store failure falls back to a
 *  per-launch id rather than inventing a persisted one: the account simply
 *  sees the device again next launch. */
export const nativeDeviceId = async (storage: DeviceIdentityStorage = secureStorage): Promise<string> => {
  try {
    const stored = await storage.getItem(DEVICE_ID_KEY)
    if (isDeviceId(stored)) return stored
    const created = crypto.randomUUID()
    await storage.setItem(DEVICE_ID_KEY, created)
    return created
  } catch {
    fallback ??= crypto.randomUUID()
    return fallback
  }
}

/** What this phone reports to the account: Android on the Android build,
 *  iPad or iPhone on iOS. Never a model or a name. */
export const nativeDeviceKindFor = (platform = Capacitor.getPlatform()): DeviceKind => {
  if (platform === 'android') return 'android'
  return nativeDeviceKind(platform) === 'ipad' ? 'ipad' : 'iphone'
}
