import { useEffect, useState } from 'hono/jsx'
import Viewer from '../islands/Viewer'
import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore } from '../lib/key-store'
import { EncryptedMediaResolver, type EncryptedClientSession } from '../lib/encrypted-resolver'
import { rewriteGalleryHistory } from '../lib/gallery-url'

type Props = Parameters<typeof Viewer>[0] & {
  galleryId: string
  sourceUrl: string
  /** Owner-only transitional capability. Public legacy pages never receive it. */
  legacySourceUrl?: string
}
type MigrationState = { verifiedDevices: number; keyRetired: boolean; note: string }
type ClientManifest = Pick<EncryptedClientSession, 'provider' | 'sourceUrl' | 'title' | 'images' | 'truncated'>

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

/** SSR renders the normal dimensioned Viewer shell. Hydration supplies the
 * client resolver, or replaces it with a visible locked/error state. */
export default function EncryptedGallery({ galleryId, sourceUrl, legacySourceUrl, ...viewerProps }: Props) {
  const [resolver, setResolver] = useState<EncryptedMediaResolver | null>(null)
  const [scan, setScan] = useState<ClientManifest | null>(null)
  const [migration, setMigration] = useState<MigrationState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [unlockValue, setUnlockValue] = useState('')

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

  useEffect(() => {
    let live = true
    let owned: EncryptedMediaResolver | null = null
    setProblem(null)
    setMigration(null)
    const fragment = encryptedSourceFromGalleryHash(window.location.hash)
    void Promise.resolve(fragment ?? webGalleryKeyStore().get(galleryId)).then(async (stored) => {
      // The keystore read must settle before the legacy fallback applies —
      // a pending promise is truthy, so chaining `?? legacySourceUrl` would
      // never reach it and the owner's migration path would show "locked".
      const source = stored ?? legacySourceUrl
      if (!source) {
        if (live) setProblem('This device does not hold the gallery key. Paste the full Manorama link, or the original MEGA/Ente link.')
        return
      }
      if (keylessSourceUrl(source) !== keylessSourceUrl(sourceUrl)) throw new Error('That key belongs to a different source album')
      await webGalleryKeyStore().put(galleryId, source)
      const { openEncryptedSource } = await import('../lib/encrypted-client')
      const session = await openEncryptedSource(source)
      if (session.sourceUrl !== keylessSourceUrl(sourceUrl)) {
        session.dispose()
        throw new Error('The decrypted listing belongs to a different source album')
      }
      if (!live) { session.dispose(); return }
      owned = new EncryptedMediaResolver(session)
      setResolver(owned)
      const manifest: ClientManifest = { provider: session.provider, sourceUrl: session.sourceUrl, title: session.title, images: session.images, ...(session.truncated ? { truncated: session.truncated } : {}) }
      setScan(manifest)
      if (legacySourceUrl) {
        void submitMigration(manifest, false).catch((error) => {
          if (live) setMigration({ verifiedDevices: 0, keyRetired: false, note: error instanceof Error ? error.message : 'This device could not be verified' })
        })
      }
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
        <form onSubmit={unlock}>
          <label for="encrypted-unlock-url">Full Manorama, MEGA, or Ente link</label>
          <input id="encrypted-unlock-url" type="url" required value={unlockValue} onInput={(event) => setUnlockValue((event.currentTarget as HTMLInputElement).value)} placeholder="https://…#…" />
          <button class="m-btn m-btn--primary" type="submit">Unlock gallery</button>
        </form>
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
  const viewer = <Viewer {...viewerProps} images={images} encryptedResolver={resolver} />
  if (!legacySourceUrl || !migration) return viewer
  return (
    <>
      {viewer}
      <aside class="encrypted-migration" role="status">
        <p>{migration.note}</p>
        {!migration.keyRetired && scan ? (
          <button class="m-btn m-btn--secondary" type="button" onClick={() => { void submitMigration(scan, true).catch((error) => setMigration({ ...migration, note: error instanceof Error ? error.message : 'The server key could not be removed' })) }}>
            Remove server key now
          </button>
        ) : null}
      </aside>
    </>
  )
}
