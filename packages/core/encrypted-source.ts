export const ENCRYPTED_MANIFEST_VERSION = 2
export const CONTENT_VERSION_PATTERN = /^[0-9a-f]{64}$/
export const MAX_PUBLISHED_DIMENSION = 100_000
export const MAX_PUBLISHED_ASPECT = 10

export type EncryptedSourceProvider = 'mega' | 'ente'
export type MegaMediaReference = {
  kind: 'encrypted'
  provider: 'mega'
  sourceKind: 'folder' | 'collection'
  sourceId: string
  nodeId: string
  previewId?: string
}
export type EnteMediaReference = {
  kind: 'encrypted'
  provider: 'ente'
  sourceKind: 'album'
  sourceId: string
  nodeId: string
  previewId?: string
}
export type HttpMediaReference = { kind: 'http'; url: string }
export type MediaReference = HttpMediaReference | MegaMediaReference | EnteMediaReference

const HANDLE = /^[0-9A-Za-z_-]{1,256}$/
const SAFE_NODE = /^[0-9A-Za-z_-]{1,256}$/

export const megaIdentityFromUrl = (input: string): { kind: 'folder' | 'collection'; id: string } | null => {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:') return null
    const host = url.hostname.replace(/^www\./, '')
    if (host !== 'mega.nz' && host !== 'mega.co.nz') return null
    const modern = url.pathname.match(/^\/(folder|collection)\/([0-9A-Za-z_-]+)/)
    if (modern) return { kind: modern[1] as 'folder' | 'collection', id: modern[2]! }
    const legacy = url.hash.match(/^#([FC])!([0-9A-Za-z_-]+)[!#]/i)
    return legacy ? { kind: legacy[1]!.toUpperCase() === 'C' ? 'collection' : 'folder', id: legacy[2]! } : null
  } catch {
    return null
  }
}

export const enteIdentityFromUrl = (input: string): { kind: 'album'; id: string } | null => {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:' || !['albums.ente.com', 'albums.ente.io'].includes(url.hostname)) return null
    const token = url.searchParams.get('t')?.trim()
    return token && HANDLE.test(token) ? { kind: 'album', id: token } : null
  } catch {
    return null
  }
}

export const encryptedProviderForUrl = (input: string): EncryptedSourceProvider | null => {
  if (megaIdentityFromUrl(input)) return 'mega'
  if (enteIdentityFromUrl(input)) return 'ente'
  return null
}

export const isEncryptedSourceUrl = (input: string): boolean => encryptedProviderForUrl(input) !== null

export const keylessSourceUrl = (input: string): string => {
  const url = new URL(input.trim())
  if (!isEncryptedSourceUrl(input)) throw new Error('Not an encrypted source URL')
  url.hash = ''
  if (megaIdentityFromUrl(input)) {
    url.hostname = 'mega.nz'
    url.search = ''
  }
  return url.toString()
}

/** The complete provider URL lives only in the fragment. Its own '#key' is
 * percent-encoded, so neither the server nor crawlers receive the secret. */
export const galleryHashForSource = (sourceUrl: string, galleryId?: string): string =>
  `#source=${encodeURIComponent(sourceUrl)}${galleryId ? `&gallery=${encodeURIComponent(galleryId)}` : ''}`

/** Immutable public identity for native key custody. Older links may omit it;
 * they can open online but cannot adopt a key into persistent native storage. */
export const galleryIdFromGalleryHash = (hash: string): string | null => {
  if (!hash.startsWith('#')) return null
  const id = new URLSearchParams(hash.slice(1)).get('gallery')
  return id && /^[0-9A-Za-z-]{16,64}$/.test(id) ? id : null
}

export const encryptedSourceFromGalleryHash = (hash: string): string | null => {
  if (!hash.startsWith('#')) return null
  const source = new URLSearchParams(hash.slice(1)).get('source')
  if (!source) return null
  try {
    const url = new URL(source)
    if (url.protocol !== 'https:' || !isEncryptedSourceUrl(source) || !url.hash) return null
    return source
  } catch {
    return null
  }
}

/** Build a next URL without silently dropping the capability fragment. */
export const galleryUrlWithPreservedHash = (nextUrl: string, currentHash: string, explicitUrl?: string): string => {
  const target = explicitUrl ?? nextUrl
  const hashAt = target.indexOf('#')
  if (hashAt >= 0) return target
  return `${target}${currentHash}`
}

export const validatePublishedDimensions = (width: number, height: number): boolean => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false
  if (width < 1 || height < 1 || width > MAX_PUBLISHED_DIMENSION || height > MAX_PUBLISHED_DIMENSION) return false
  const aspect = width / height
  return aspect >= 1 / MAX_PUBLISHED_ASPECT && aspect <= MAX_PUBLISHED_ASPECT
}

export const contentVersionIsValid = (value: unknown): value is string =>
  typeof value === 'string' && CONTENT_VERSION_PATTERN.test(value)

const validHttpUrl = (value: string): boolean => {
  if (value.startsWith('/')) return !value.startsWith('//') && !value.includes('\\')
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    // Server-fetchable absolute media is restricted to known provider hosts.
    return /(?:^|\.)((?:dropbox|dropboxapi)\.com|googleapis\.com|googleusercontent\.com|icloud\.com|mega\.co\.nz|ente\.io|ente\.com)$/.test(url.hostname)
  } catch {
    return false
  }
}

export const mediaReferenceIsValid = (value: unknown): value is MediaReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'http') return typeof candidate.url === 'string' && validHttpUrl(candidate.url)
  if (candidate.kind !== 'encrypted') return false
  if (candidate.provider === 'mega') {
    return (candidate.sourceKind === 'folder' || candidate.sourceKind === 'collection') &&
      typeof candidate.sourceId === 'string' && HANDLE.test(candidate.sourceId) &&
      typeof candidate.nodeId === 'string' && SAFE_NODE.test(candidate.nodeId) &&
      (candidate.previewId === undefined || (typeof candidate.previewId === 'string' && SAFE_NODE.test(candidate.previewId)))
  }
  if (candidate.provider === 'ente') {
    return candidate.sourceKind === 'album' && typeof candidate.sourceId === 'string' && HANDLE.test(candidate.sourceId) &&
      typeof candidate.nodeId === 'string' && /^\d{1,20}$/.test(candidate.nodeId) &&
      (candidate.previewId === undefined || candidate.previewId === candidate.nodeId)
  }
  return false
}
