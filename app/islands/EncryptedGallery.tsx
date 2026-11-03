import { useEffect, useState } from 'hono/jsx'
import Viewer from '../islands/Viewer'
import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore } from '../lib/key-store'
import { EncryptedMediaResolver } from '../lib/encrypted-resolver'
import { rewriteGalleryHistory } from '../lib/gallery-url'

type Props = Parameters<typeof Viewer>[0] & { galleryId: string; sourceUrl: string }

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

/** SSR renders the normal dimensioned Viewer shell. Hydration supplies the
 * client resolver, or replaces it with a visible locked/error state. */
export default function EncryptedGallery({ galleryId, sourceUrl, ...viewerProps }: Props) {
  const [resolver, setResolver] = useState<EncryptedMediaResolver | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [unlockValue, setUnlockValue] = useState('')

  useEffect(() => {
    let live = true
    let owned: EncryptedMediaResolver | null = null
    setProblem(null)
    const fragment = encryptedSourceFromGalleryHash(window.location.hash)
    void Promise.resolve(fragment ?? webGalleryKeyStore().get(galleryId)).then(async (source) => {
      if (!source) {
        if (live) setProblem('This device does not hold the gallery key. Paste the full Manorama link, or the original MEGA/Ente link.')
        return
      }
      if (keylessSourceUrl(source) !== sourceUrl) throw new Error('That key belongs to a different source album')
      if (fragment) await webGalleryKeyStore().put(galleryId, source)
      const { openEncryptedSource } = await import('../lib/encrypted-client')
      const session = await openEncryptedSource(source)
      if (session.sourceUrl !== sourceUrl) {
        session.dispose()
        throw new Error('The decrypted listing belongs to a different source album')
      }
      if (!live) { session.dispose(); return }
      owned = new EncryptedMediaResolver(session)
      setResolver(owned)
    }).catch((error) => {
      if (live) setProblem(error instanceof Error ? error.message : 'The encrypted album could not be opened')
    })
    return () => {
      live = false
      owned?.dispose()
      setResolver(null)
    }
  }, [galleryId, sourceUrl, attempt])

  if (problem) {
    const unlock = (event: Event) => {
      event.preventDefault()
      const source = sourceFromUnlockInput(unlockValue)
      if (!source) {
        setProblem('Paste a complete Manorama or provider link including its fragment key.')
        return
      }
      rewriteGalleryHistory(window, 'replace', null, `${window.location.pathname}${window.location.search}${galleryHashForSource(source)}`)
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
          <button type="submit">Unlock gallery</button>
        </form>
      </section>
    )
  }
  return <Viewer {...viewerProps} encryptedResolver={resolver} />
}
