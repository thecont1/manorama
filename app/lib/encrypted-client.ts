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
      sourceUrl: mega.sourceUrl,
      listing: mega.scan.then((scan) => ({
        title: scan.title,
        images: scan.images,
        ...(scan.truncated ? { truncated: scan.truncated } : {}),
      })),
      materialize: (reference, preview, signal) => {
        if (reference.kind !== 'encrypted' || reference.provider !== 'mega') throw new Error('MEGA media reference is invalid')
        return mega.materialize(reference.nodeId, preview ? reference.previewId : undefined, signal)
      },
      dispose: () => mega.dispose(),
    }
  }
  if (provider === 'ente') {
    const { openEnteSession } = await import('./ente-client')
    const ente = await openEnteSession(sourceUrl)
    return {
      provider: 'ente',
      sourceUrl: ente.sourceUrl,
      listing: ente.scan.then((scan) => ({
        title: scan.title,
        images: scan.images,
        ...(scan.truncated ? { truncated: scan.truncated } : {}),
      })),
      materialize: (reference, preview, signal) => {
        if (reference.kind !== 'encrypted' || reference.provider !== 'ente') throw new Error('Ente media reference is invalid')
        return ente.materialize(reference.nodeId, preview, signal)
      },
      dispose: () => ente.dispose(),
    }
  }
  throw new Error('Use a complete MEGA or Ente public album link')
}
