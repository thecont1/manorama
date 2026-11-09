import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

/**
 * Desktop gallery-key custody through the bridge: the store must read,
 *  write and remove against the keychain seam (the same vault_key_*
 *  commands the vault uses), migrate legacy localStorage entries on first
 *  touch, and degrade to localStorage when no bridge answers.
 */

const keychain = new Map<string, string>()
let bridgeUp = true
const LEGACY_PREFIX = 'manorama.gallery-key.v1.'
const GALLERY_ID = '7410582470ff056c2d3beaff6eec9ac5'
const ACCOUNT = `${LEGACY_PREFIX}${GALLERY_ID}`
// A complete MEGA folder link — path identity plus the #key fragment.
const SOURCE = 'https://mega.nz/folder/AbCdEfGhIj#KlMnOpQrStUvWxYz0123'

const installTauri = () => {
  const win = new Window() as unknown as Record<string, unknown>
  const globals = globalThis as Record<string, unknown>
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement']) {
    if (win[key] !== undefined) globals[key] = win[key]
  }
  win.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (!bridgeUp) throw new Error('no bridge')
      const record = args as Record<string, unknown> | undefined
      if (command === 'vault_key_get') return keychain.get(String(record?.name)) ?? null
      if (command === 'vault_key_set') { keychain.set(String(record?.name), String(record?.value)); return null }
      if (command === 'vault_key_remove') { keychain.delete(String(record?.name)); return null }
      return null
    },
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
  globals.window = win
}

const storage = (): Storage => (globalThis as { localStorage: Storage }).localStorage

describe('desktop gallery-key custody', () => {
  beforeAll(installTauri)
  beforeEach(() => {
    keychain.clear()
    storage().clear()
    bridgeUp = true
  })

  test('put lands the complete source link in the keychain and clears the legacy slot', async () => {
    storage().setItem(ACCOUNT, SOURCE)
    const { desktopKeyStore } = await import('./key-store')
    await desktopKeyStore().put(GALLERY_ID, SOURCE)
    expect(keychain.get(ACCOUNT)).toBe(SOURCE)
    expect(storage().getItem(ACCOUNT)).toBeNull()
  })

  test('get reads the keychain first and normalizes the source', async () => {
    keychain.set(ACCOUNT, SOURCE)
    const { desktopKeyStore } = await import('./key-store')
    expect(await desktopKeyStore().get(GALLERY_ID)).toBe(SOURCE)
    expect(storage().getItem(ACCOUNT)).toBeNull()
  })

  test('get migrates a legacy localStorage entry into the keychain once', async () => {
    storage().setItem(ACCOUNT, SOURCE)
    const { desktopKeyStore } = await import('./key-store')
    expect(await desktopKeyStore().get(GALLERY_ID)).toBe(SOURCE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(keychain.get(ACCOUNT)).toBe(SOURCE)
    expect(storage().getItem(ACCOUNT)).toBeNull()
  })

  test('remove drops both the keychain item and any legacy copy', async () => {
    keychain.set(ACCOUNT, SOURCE)
    storage().setItem(ACCOUNT, SOURCE)
    const { desktopKeyStore } = await import('./key-store')
    await desktopKeyStore().remove(GALLERY_ID)
    expect(keychain.has(ACCOUNT)).toBe(false)
    expect(storage().getItem(ACCOUNT)).toBeNull()
  })

  test('without a bridge the store degrades to the legacy behaviour', async () => {
    bridgeUp = false
    const { desktopKeyStore } = await import('./key-store')
    await desktopKeyStore().put(GALLERY_ID, SOURCE)
    expect(keychain.has(ACCOUNT)).toBe(false)
    expect(storage().getItem(ACCOUNT)).toBe(SOURCE)
    expect(await desktopKeyStore().get(GALLERY_ID)).toBe(SOURCE)
  })

  test('an incomplete link still earns no custody', async () => {
    const { desktopKeyStore } = await import('./key-store')
    await expect(desktopKeyStore().put(GALLERY_ID, 'https://mega.nz/folder/AbCdEfGhIj')).rejects.toThrow()
  })
})
