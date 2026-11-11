import { encryptedProviderForUrl } from '../../packages/core/encrypted-source'
import type { EncryptedClientSession, EncryptedListing } from './encrypted-resolver'

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
  if (provider === 'proton') {
    const { openProtonSession } = await import('./proton-client')
    const proton = await openProtonSession(sourceUrl)
    // Defer the listing through the wrapper too — `proton.scan` starts on
    // first `then`, so an open that only materializes media never runs the
    // dims probe pass against the SDK's download queue.
    let listingPromise: Promise<EncryptedListing> | null = null
    const listing = {
      then: <TResult1 = EncryptedListing, TResult2 = never>(
        onFulfilled?: ((value: EncryptedListing) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => (listingPromise ??= proton.scan.then((scan) => ({
        title: scan.title,
        images: scan.images,
        ...(scan.truncated ? { truncated: scan.truncated } : {}),
      }))).then(onFulfilled, onRejected),
    } as Promise<EncryptedListing>
    return {
      provider: 'proton',
      sourceUrl: proton.sourceUrl,
      listing,
      materialize: (reference, preview, signal) => {
        if (reference.kind !== 'encrypted' || reference.provider !== 'proton') throw new Error('Proton Drive media reference is invalid')
        return proton.materialize(reference.nodeId, preview, signal)
      },
      dispose: () => proton.dispose(),
    }
  }
  throw new Error('Use a complete MEGA, Ente or Proton Drive public link')
}
