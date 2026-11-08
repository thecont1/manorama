import { isEncryptedSourceUrl } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore, type WebGalleryKeyStore } from './key-store'

/** The refresh RequestInit for any gallery: a bare POST for ordinary
 *  sources; for encrypted ones the device holds the key, so the scan
 *  happens here and the submitted manifest is the keyless listing —
 *  the server stays blind to the source link. Custody defaults to the
 *  web's session-scoped store; shells with their own store inject it. */
export const refreshRequestInit = async (input: { id?: string | null; sourceUrl?: string | null; keyStore?: WebGalleryKeyStore }): Promise<RequestInit> => {
  if (!input.sourceUrl || !isEncryptedSourceUrl(input.sourceUrl)) return { method: 'POST' }
  const keys = input.keyStore ?? webGalleryKeyStore()
  const stored = input.id ? await keys.get(input.id) : null
  const source = stored ?? (input.sourceUrl.includes('#') ? input.sourceUrl : null)
  if (!source) throw new Error('This device does not hold the key. Open the full gallery link before refreshing.')
  const { openEncryptedSource } = await import('./encrypted-client')
  const session = await openEncryptedSource(source)
  try {
    const listing = await session.listing
    if (input.id) await keys.put(input.id, source)
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: {
        provider: session.provider,
        sourceUrl: session.sourceUrl,
        ...listing,
      } }),
    }
  } finally {
    session.dispose()
  }
}
