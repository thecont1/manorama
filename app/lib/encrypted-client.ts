import { encryptedProviderForUrl } from '../../packages/core/encrypted-source'
import type { EncryptedClientSession } from './encrypted-resolver'

/** Client-only provider entry. Dynamic imports keep crypto out of the Worker
 * graph; callers submit only `session`'s keyless scan fields to the API. */
export const openEncryptedSource = async (sourceUrl: string): Promise<EncryptedClientSession> => {
  const provider = encryptedProviderForUrl(sourceUrl)
  if (provider === 'mega') {
    const { openMegaSession } = await import('./mega-client')
    const mega = await openMegaSession(sourceUrl)
    return {
      provider: 'mega',
      sourceUrl: mega.scan.sourceUrl,
      title: mega.scan.title,
      images: mega.scan.images,
      ...(mega.scan.truncated ? { truncated: mega.scan.truncated } : {}),
      materialize: (reference, preview, signal) => {
        if (reference.kind !== 'encrypted' || reference.provider !== 'mega') throw new Error('MEGA media reference is invalid')
        return mega.materialize(reference.nodeId, preview ? reference.previewId : undefined, signal)
      },
      dispose: () => mega.dispose(),
    }
  }
  // Ente album parsing stays — the deferred adapter lands here — but no
  // Ente network path exists yet, so the link is refused before one opens.
  if (provider === 'ente') throw new Error('Ente public albums are not supported yet. Use a complete MEGA link.')
  throw new Error('Use a complete MEGA public album link')
}
