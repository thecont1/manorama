import { useEffect, useRef, useState } from 'hono/jsx'
import Viewer from '../islands/Viewer'
import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore, type WebGalleryKeyStore } from '../lib/key-store'
import { EncryptedMediaResolver, type EncryptedClientSession, type EncryptedListing } from '../lib/encrypted-resolver'
import { rewriteGalleryHistory } from '../lib/gallery-url'
import {
  cachedVaultKey, cacheVaultKey, ensureVaultKey, fetchGalleryKey, fetchVaultRecord,
  keySyncShouldPrompt, openVault, putGalleryKey, unwrapSourceForVault, wrapSourceForVault,
  type WrappedGalleryKey,
} from '../lib/key-vault'

type Props = Parameters<typeof Viewer>[0] & {
  galleryId: string
  sourceUrl: string
  /** Owner-only transitional capability. Public legacy pages never receive it. */
  legacySourceUrl?: string
  /** Device shells pass a durable store — an app is not a tab, so custody
   *  survives a relaunch. The web keeps the default session-scoped store. */
  keyStore?: Pick<WebGalleryKeyStore, 'get' | 'put' | 'remove'>
}
type MigrationState = { verifiedDevices: number; keyRetired: boolean; note: string }
type ClientManifest = Pick<EncryptedClientSession, 'provider' | 'sourceUrl'> & EncryptedListing

const sourceFromUnlockInput = (value: string): string | null => {
  try {
    const url = new URL(value.trim())
    const fromManorama = encryptedSourceFromGalleryHash(url.hash)
    if (fromManorama) return fromManorama
    return isEncryptedSourceUrl(value.trim()) && url.hash ? value.trim() : null
  } catch {
    return null
  }
}

let fallbackDeviceId: string | null = null
const migrationDeviceId = (): string => {
  try {
    const key = 'manorama.migration-device.v1'
    const existing = window.localStorage.getItem(key)
    if (existing && /^[0-9A-Za-z-]{8,128}$/.test(existing)) return existing
    const created = crypto.randomUUID()
    window.localStorage.setItem(key, created)
    return created
  } catch {
    fallbackDeviceId ??= crypto.randomUUID()
    return fallbackDeviceId
  }
}

/** "Not now" is a preference flag, not key material, so it lives in
 *  localStorage like the migration device id — keyed by immutable gallery
 *  id and scoped to this device. */
const keySyncDismissed = (galleryId: string): boolean => {
  try { return window.localStorage.getItem(`manorama.key-sync-dismissed.v1.${galleryId}`) === '1' } catch { return false }
}
const dismissKeySync = (galleryId: string) => {
  try { window.localStorage.setItem(`manorama.key-sync-dismissed.v1.${galleryId}`, '1') } catch { /* private mode */ }
}

/** SSR renders the normal dimensioned Viewer shell. Hydration supplies the
 * client resolver, or replaces it with a visible locked/error state. */
export default function EncryptedGallery({ galleryId, sourceUrl, legacySourceUrl, keyStore, ...viewerProps }: Props) {
  const galleryKeys = keyStore ?? webGalleryKeyStore()
  const [resolver, setResolver] = useState<EncryptedMediaResolver | null>(null)
  const [scan, setScan] = useState<ClientManifest | null>(null)
  const [migration, setMigration] = useState<MigrationState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [unlockValue, setUnlockValue] = useState('')
  /** A synced wrapped key waiting on the owner's passphrase — the alternative
   *  to pasting a link on a device that has never held this key. */
  const [pendingWrapped, setPendingWrapped] = useState<WrappedGalleryKey | null>(null)
  /** The passphrase card — shown only when syncing would do something this
   *  device cannot do silently (keySyncShouldPrompt decides). */
  const [keySync, setKeySync] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [keySyncNote, setKeySyncNote] = useState<string | null>(null)
  const heldSourceRef = useRef<string | null>(null)

  const submitMigration = async (manifest: ClientManifest, optOut: boolean) => {
    const response = await fetch(`/api/galleries/${encodeURIComponent(viewerProps.slug)}/migrate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest, deviceId: migrationDeviceId(), optOut }),
    })
    const payload = await response.json() as { error?: string; verifiedDevices?: number; keyRetired?: boolean; warning?: string }
    if (!response.ok) throw new Error(payload.error || 'This device could not be verified')
    setMigration({
      verifiedDevices: payload.verifiedDevices ?? 1,
      keyRetired: payload.keyRetired === true,
      note: payload.warning ?? 'This device is verified. Open the gallery on one more device before the server key is removed.',
    })
  }

  /** Best-effort escrow once a tab holds the key: a session-cached vault key
   *  syncs silently; otherwise the owner gets the passphrase card. Ciphertext
   *  only — the source never reaches the server. */
  const syncHeldKey = async (source: string) => {
    if (viewerProps.viewerRole !== 'owner') return
    try {
      const vaultKey = await cachedVaultKey()
      if (vaultKey) {
        await putGalleryKey(viewerProps.slug, await wrapSourceForVault(vaultKey, source))
        return
      }
      const [record, wrapped] = await Promise.all([fetchVaultRecord(), fetchGalleryKey(viewerProps.slug)])
      if (keySyncShouldPrompt({ vaultExists: !!record, alreadyEscrowed: !!wrapped, dismissed: keySyncDismissed(galleryId) })) {
        setKeySync(true)
      }
    } catch {
      // Escrow is an upgrade, not a gate — a failed sync never blocks viewing.
    }
  }

  const submitKeySync = async (event: Event) => {
    event.preventDefault()
    const source = heldSourceRef.current
    if (!source || !passphrase) return
    setKeySyncNote(null)
    try {
      const vaultKey = await ensureVaultKey(passphrase)
      await putGalleryKey(viewerProps.slug, await wrapSourceForVault(vaultKey, source))
      setKeySync(false)
      setPassphrase('')
    } catch {
      setKeySyncNote('That passphrase did not unlock the vault.')
    }
  }

  const submitVaultUnlock = async (event: Event) => {
    event.preventDefault()
    const wrapped = pendingWrapped
    if (!wrapped || !passphrase) return
    try {
      const record = await fetchVaultRecord()
      if (!record) { setPendingWrapped(null); setProblem('No synced key vault exists on this account. Paste the full link instead.'); return }
      const vaultKey = await openVault(passphrase, record)
      await cacheVaultKey(vaultKey)
      const source = await unwrapSourceForVault(vaultKey, wrapped)
      // Wrong-album ciphertext still unwraps to *something* — bind the result
      // to this gallery's identity before it enters custody.
      if (keylessSourceUrl(source) !== keylessSourceUrl(sourceUrl)) throw new Error('That synced key belongs to a different source album')
      await galleryKeys.put(galleryId, source)
      setPendingWrapped(null)
      setPassphrase('')
      setProblem(null)
      setAttempt((value) => value + 1)
    } catch {
      setProblem('That passphrase did not unlock the vault.')
    }
  }

  useEffect(() => {
    let live = true
    let owned: EncryptedMediaResolver | null = null
    setProblem(null)
    setMigration(null)
    setPendingWrapped(null)
    const fragment = encryptedSourceFromGalleryHash(window.location.hash)
    void Promise.resolve(fragment ?? galleryKeys.get(galleryId).catch(() => null)).then(async (stored) => {
      // The keystore read must settle before the legacy fallback applies —
      // a pending promise is truthy, so chaining `?? legacySourceUrl` would
      // never reach it and the owner's migration path would show "locked".
      let source: string | null | undefined = stored ?? legacySourceUrl
      if (!source && viewerProps.viewerRole === 'owner') {
        // Escrowed unlock: the server holds ciphertext written by another of
        // the owner's devices. A session-cached vault key opens it without
        // prompting; otherwise the passphrase form replaces the paste form.
        const wrapped = await fetchGalleryKey(viewerProps.slug).catch(() => null)
        if (wrapped) {
          const vaultKey = await cachedVaultKey()
          if (vaultKey) source = await unwrapSourceForVault(vaultKey, wrapped).catch(() => null)
          // A cached VK that cannot unwrap the blob is no better than none —
          // the vault may have been re-created elsewhere, so the passphrase
          // path (which re-derives from the current record) still applies.
          if (!source && live) {
            setPendingWrapped(wrapped)
            setProblem('This gallery is synced to your account. Enter your Manorama sync passphrase to unlock it on this device.')
            return
          }
        }
      }
      if (!source) {
        if (live) setProblem('This device does not hold the gallery key. Paste the full Manorama link, or the original provider link.')
        return
      }
      if (keylessSourceUrl(source) !== keylessSourceUrl(sourceUrl)) throw new Error('That key belongs to a different source album')
      const { openEncryptedSource } = await import('../lib/encrypted-client')
      const session = await openEncryptedSource(source)
      if (session.sourceUrl !== keylessSourceUrl(sourceUrl)) {
        session.dispose()
        throw new Error('The decrypted listing belongs to a different source album')
      }
      // Custody follows verification: a key that opened the wrong listing
      // must never reach the store. Best-effort — quota or private-mode
      // failures must not block opening with a key this session already has.
      await galleryKeys.put(galleryId, source).catch(() => undefined)
      heldSourceRef.current = source
      if (!live) { session.dispose(); return }
      // The resolver goes up off the folder listing alone — first media
      // materializes while the probe pass is still walking items.
      owned = new EncryptedMediaResolver(session)
      setResolver(owned)
      void syncHeldKey(source)
      void session.listing.then((listing) => {
        if (!live) return
        const manifest: ClientManifest = { provider: session.provider, sourceUrl: session.sourceUrl, ...listing }
        setScan(manifest)
        if (legacySourceUrl) {
          void submitMigration(manifest, false).catch((error) => {
            if (live) setMigration({ verifiedDevices: 0, keyRetired: false, note: error instanceof Error ? error.message : 'This device could not be verified' })
          })
        }
      }).catch(() => {
        // A probe-pass failure must not lock a gallery that already
        // decrypts — materialize needs the listed keys, never the scan.
      })
    }).catch((error) => {
      if (live) setProblem(error instanceof Error ? error.message : 'The encrypted album could not be opened')
    })
    return () => {
      live = false
      owned?.dispose()
      setResolver(null)
      setScan(null)
    }
  }, [galleryId, sourceUrl, legacySourceUrl, attempt])

  // The curtain's dismiss handler lives in Viewer's effect, which the
  // locked panel replaces — without this it dead-ends visitors over an
  // unreachable locked panel.
  useEffect(() => {
    if (!problem) return
    const curtain = document.querySelector<HTMLElement>('[data-curtain]')
    if (curtain) {
      curtain.classList.remove('fading')
      curtain.hidden = true
    }
    document.body.classList.add('gallery-entered')
  }, [problem])

  if (problem) {
    const unlock = (event: Event) => {
      event.preventDefault()
      const source = sourceFromUnlockInput(unlockValue)
      if (!source) {
        setProblem('Paste a complete Manorama or provider link including its fragment key.')
        return
      }
      rewriteGalleryHistory(window, 'replace', null, `${window.location.pathname}${window.location.search}${galleryHashForSource(source, galleryId)}`)
      setUnlockValue('')
      setAttempt((value) => value + 1)
    }
    return (
      <section class="encrypted-locked" role="alert" aria-labelledby="encrypted-lock-title">
        <h1 id="encrypted-lock-title">This gallery is locked on this device</h1>
        <p>{problem}</p>
        <p>Manorama cannot recover the key or decrypt this gallery on the server.</p>
        {pendingWrapped ? (
          <form onSubmit={submitVaultUnlock}>
            <label for="encrypted-unlock-passphrase">Manorama sync passphrase</label>
            <input id="encrypted-unlock-passphrase" type="password" required autocomplete="current-password" value={passphrase} onInput={(event) => setPassphrase((event.currentTarget as HTMLInputElement).value)} />
            <button class="m-btn m-btn--primary" type="submit">Unlock with passphrase</button>
          </form>
        ) : (
          <form onSubmit={unlock}>
            <label for="encrypted-unlock-url">Full Manorama or provider link</label>
            <input id="encrypted-unlock-url" type="url" required value={unlockValue} onInput={(event) => setUnlockValue((event.currentTarget as HTMLInputElement).value)} placeholder="https://…#…" />
            <button class="m-btn m-btn--primary" type="submit">Unlock gallery</button>
          </form>
        )}
      </section>
    )
  }
  // Once a client scan resolves, its media refs replace the SSR props' srcs
  // (retired server URLs or stripped) — but never its membership: the stored
  // manifest owns order and hidden flags, and a scan-only item is either
  // hidden or not yet refreshed, so it stays out until a refresh persists it.
  const scanByKey = scan ? new Map(scan.images.map((image) => [image.ref ?? image.filename, image])) : null
  const images = scanByKey
    ? viewerProps.images.map((item) => {
      const scanned = scanByKey.get(item.ref ?? item.filename)
      return scanned ? { ...scanned, ...(item.hidden ? { hidden: true as const } : {}) } : item
    })
    : viewerProps.images
  const viewer = <Viewer {...viewerProps} images={images} encryptedResolver={resolver} galleryId={galleryId} keyStore={keyStore} />
  if (!legacySourceUrl && !keySync) return viewer
  return (
    <>
      {viewer}
      {legacySourceUrl && migration ? (
        <aside class="encrypted-migration" role="status">
          <p>{migration.note}</p>
          {!migration.keyRetired && scan ? (
            <button class="m-btn m-btn--secondary" type="button" onClick={() => { void submitMigration(scan, true).catch((error) => setMigration({ ...migration, note: error instanceof Error ? error.message : 'The server key could not be removed' })) }}>
              Remove server key now
            </button>
          ) : null}
        </aside>
      ) : null}
      {keySync ? (
        <aside class="encrypted-migration" role="status">
          <p>Enter your Manorama sync passphrase to make this gallery available on your other devices.</p>
          <form onSubmit={submitKeySync}>
            <label class="sr-only" for="key-sync-passphrase">Manorama sync passphrase</label>
            <input id="key-sync-passphrase" type="password" required autocomplete="current-password" value={passphrase} onInput={(event) => setPassphrase((event.currentTarget as HTMLInputElement).value)} placeholder="Sync passphrase" />
            <button class="m-btn m-btn--primary" type="submit">Sync to my devices</button>
            <button class="m-btn m-btn--secondary" type="button" onClick={() => { dismissKeySync(galleryId); setKeySync(false) }}>Not now</button>
          </form>
          {keySyncNote ? <p role="alert">{keySyncNote}</p> : null}
        </aside>
      ) : null}
    </>
  )
}
