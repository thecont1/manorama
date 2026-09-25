import { Preferences } from '@capacitor/preferences'
import type { NativeTier } from './billing'
import type { OfflineGallerySummary, OfflineGalleryStore } from './offline-gallery'
import { DEFAULT_VAULT_CAP_BYTES, type EncryptedVault, type VaultUsage } from './vault'

export const VAULT_CAP_PREFERENCE_KEY = 'manorama.vault.cap'
/** The Free default and ceiling. Pro may hold any positive cap or unlimited. */
export const FREE_VAULT_CAP_BYTES = DEFAULT_VAULT_CAP_BYTES
const UNLIMITED_VALUE = 'unlimited'

/** The user's stored choice: a positive byte cap, or `null` for unlimited (Pro only). */
export type VaultCapPreference = number | null

/** On-device preferences seam. The cap is not a secret — it lives in ordinary
 *  app preferences, never in the vault and never on the server. */
export interface VaultCapPersistence {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export const preferencesPersistence: VaultCapPersistence = {
  async get(key) {
    return (await Preferences.get({ key })).value
  },
  async set(key, value) {
    await Preferences.set({ key, value })
  },
}

/** `undefined` means "no valid stored choice" — corrupt values fall back to the
 *  default rather than being trusted or crashing settings. */
const parseCapPreference = (raw: string | null): VaultCapPreference | undefined => {
  if (raw === null) return undefined
  if (raw === UNLIMITED_VALUE) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export const loadVaultCapPreference = async (
  persistence: VaultCapPersistence = preferencesPersistence,
): Promise<VaultCapPreference | undefined> => parseCapPreference(await persistence.get(VAULT_CAP_PREFERENCE_KEY))

export const saveVaultCapPreference = async (
  preference: VaultCapPreference,
  persistence: VaultCapPersistence = preferencesPersistence,
): Promise<void> =>
  persistence.set(VAULT_CAP_PREFERENCE_KEY, preference === null ? UNLIMITED_VALUE : String(preference))

/**
 * The cap the vault should hold right now. A stored choice survives tier
 * changes verbatim — it is only clamped at resolution time. Unknown
 * entitlement resolves at the Free ceiling: conservative, and safe because
 * resolving a cap never evicts on its own.
 */
export const resolveVaultCap = (
  tier: NativeTier | undefined,
  preference: VaultCapPreference | undefined,
): number | null => {
  if (preference === undefined) return FREE_VAULT_CAP_BYTES
  if (tier !== 'pro') return preference === null ? FREE_VAULT_CAP_BYTES : Math.min(preference, FREE_VAULT_CAP_BYTES)
  return preference
}

/** A stored cap survives a downgrade; choosing a cap above the Free ceiling
 *  while not Pro is rejected here too, so the UI is not the only gate. */
export const assertCapAllowed = (tier: NativeTier | undefined, preference: VaultCapPreference): void => {
  if (tier === 'pro') return
  if (preference === null || preference > FREE_VAULT_CAP_BYTES) {
    throw new Error('A larger or unlimited vault requires manorama Pro')
  }
}

export type VaultSettingsSnapshot = {
  /** The cap currently applied to the vault. */
  cap: number | null
  /** The user's stored choice (undefined = default). */
  preference: VaultCapPreference | undefined
  usage: VaultUsage
  galleries: OfflineGallerySummary[]
}

export interface VaultSettingsController {
  snapshot(): Promise<VaultSettingsSnapshot>
  /** Persist the choice and apply it. Lowering the cap evicts immediately —
    the control explains that offline copies may be removed. */
  selectCap(preference: VaultCapPreference): Promise<{ evictedBytes: number }>
  purgeGallery(galleryId: string): Promise<void>
  /** Cryptographic erasure of every cached gallery. Preferences and all
   *  non-vault credentials are deliberately left alone. */
  forgetEverything(): Promise<void>
}

export const createVaultSettingsController = (options: {
  vault: Pick<EncryptedVault, 'usage' | 'setCap' | 'evictToCap' | 'cap'>
  store: Pick<OfflineGalleryStore, 'listGalleries' | 'purgeGallery' | 'purgeAll'>
  /** Read at call time: a purchase or restore mid-session must take effect now. */
  tier: () => NativeTier | undefined
  persistence?: VaultCapPersistence
}): VaultSettingsController => {
  const persistence = options.persistence ?? preferencesPersistence
  return {
    async snapshot() {
      const preference = await loadVaultCapPreference(persistence)
      // Snapshot is the apply seam: the resolved cap reaches the vault on
      // every read — startup and post-purchase alike — before a later write
      // could evict under the stale default. Reporting vault.cap keeps the
      // UI honest about what is actually enforced.
      applyVaultCap(options.vault, options.tier(), preference)
      const [usage, galleries] = await Promise.all([options.vault.usage(), options.store.listGalleries()])
      return { cap: options.vault.cap, preference, usage, galleries }
    },
    async selectCap(preference) {
      assertCapAllowed(options.tier(), preference)
      await saveVaultCapPreference(preference, persistence)
      options.vault.setCap(resolveVaultCap(options.tier(), preference))
      const { removedBytes } = await options.vault.evictToCap()
      return { evictedBytes: removedBytes }
    },
    async purgeGallery(galleryId) {
      await options.store.purgeGallery(galleryId)
    },
    async forgetEverything() {
      await options.store.purgeAll()
    },
  }
}

/** Applies the resolved cap without evicting: the startup/entitlement-change
 *  path. A downgrade narrows the ceiling for future writes; removing existing
 *  offline copies is always the user's explicit action, never a tier side
 *  effect fired before entitlement is authoritative. */
export const applyVaultCap = (
  vault: Pick<EncryptedVault, 'setCap'>,
  tier: NativeTier | undefined,
  preference: VaultCapPreference | undefined,
): number | null => {
  const cap = resolveVaultCap(tier, preference)
  vault.setCap(cap)
  return cap
}
