import {
  accessTokenFor,
  clearProviderTokens,
  completeProviderConnect,
  connectProvider,
  DROPBOX_MAX_SINGLE_UPLOAD_BYTES,
  loadProviderTokens,
  providerConfigured,
} from './oauth'
import type {
  ReadFileBytes,
  UploadAlbum,
  UploadProgress,
  UploadProvider,
} from './types'

/**
 * Dropbox upload lane. Reads originals through the injected `readFile`
 * (the scoped fs plugin in production) and POSTs the raw bytes to
 * content.dropboxapi.com — nothing re-encodes, crops, or renames on our
 * side. `files/upload` creates parent folders implicitly, so there is no
 * separate mkdir call.
 *
 * Conflict policy — Dropbox `mode: "add"` + `autorename: true`: a retry
 * after a partial upload re-adds files under provider-renamed names rather
 * than overwriting or erroring. The folder shared link is created once and
 * reused on conflict (`shared_link_already_exists` → list_shared_links),
 * so a re-share publishes the same public folder.
 *
 * Byte cap: `files/upload` tops out near 150 MB; this lane hard-caps at
 * DROPBOX_MAX_SINGLE_UPLOAD_BYTES with a named-file error. Upload sessions
 * (files/upload_session/*) are the documented extension for larger files.
 */

const RPC_BASE = 'https://api.dropboxapi.com/2'
const CONTENT_BASE = 'https://content.dropboxapi.com/2'

/** The gallery's stable id pins the folder so two galleries that share a
 * title land in different folders, and a retry resolves to the same folder
 * (and its existing shared link) instead of a renamed duplicate. */
const albumFolderPath = (albumName: string, albumId?: string): string =>
  `/manorama/${albumName}${albumId ? `-${albumId.slice(0, 8)}` : ''}`

// --- Pure request shapes (asserted directly by tests) ----------------------

export const dropboxUploadRequest = (
  token: string,
  dropboxPath: string,
  bytes: Uint8Array,
): { url: string; init: RequestInit } => ({
  url: `${CONTENT_BASE}/files/upload`,
  init: {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'add',
        autorename: true,
        mute: true,
        strict_conflict: false,
      }),
      'Content-Type': 'application/octet-stream',
    },
    // The body is the file itself, byte-for-byte — never JSON, never a
    // re-encode, never a transformed copy.
    body: bytes as unknown as BodyInit,
  },
})

export const dropboxSharedLinkRequest = (
  token: string,
  dropboxPath: string,
): { url: string; init: RequestInit } => ({
  url: `${RPC_BASE}/sharing/create_shared_link_with_settings`,
  init: {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: dropboxPath,
      settings: {
        requested_visibility: { '.tag': 'public' },
        audience: { '.tag': 'public' },
        access: { '.tag': 'viewer' },
      },
    }),
  },
})

export const dropboxListSharedLinksRequest = (
  token: string,
  dropboxPath: string,
): { url: string; init: RequestInit } => ({
  url: `${RPC_BASE}/sharing/list_shared_links`,
  init: {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dropboxPath, direct_only: true }),
  },
})

// --- Error decoding ---------------------------------------------------------

type DropboxErrorPayload = { error?: { '.tag'?: string }; error_summary?: string }

const dropboxError = async (response: Response, fallback: string): Promise<Error> => {
  const payload = (await response.json().catch(() => ({}))) as DropboxErrorPayload
  const summary = typeof payload.error_summary === 'string' ? payload.error_summary.trim() : ''
  return new Error(summary ? `Dropbox: ${summary.replace(/\.+$/, '')}.` : fallback)
}

const sharedLinkAlreadyExists = async (response: Response): Promise<boolean> => {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { '.tag'?: string }
    error_summary?: string
  }
  return (
    payload.error?.['.tag'] === 'shared_link_already_exists' ||
    (payload.error_summary ?? '').includes('shared_link_already_exists')
  )
}

// --- The provider ------------------------------------------------------------

export const createDropboxUploadProvider = (deps?: {
  fetcher?: typeof fetch
  /** Token seam — production omits it and accessTokenFor refreshes the
   *  stored grant; tests inject a fixed token. */
  getToken?: () => Promise<string>
}): UploadProvider => {
  const fetcher = deps?.fetcher ?? fetch
  const token = () => deps?.getToken?.() ?? accessTokenFor('dropbox', fetcher)

  const uploadAlbum = async (
    album: UploadAlbum,
    readFile: ReadFileBytes,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ shareUrl: string }> => {
    const accessToken = await token()
    const folder = albumFolderPath(album.name, album.id)
    for (let index = 0; index < album.files.length; index += 1) {
      const file = album.files[index]!
      const bytes = await readFile(file.path)
      if (bytes.byteLength > DROPBOX_MAX_SINGLE_UPLOAD_BYTES) {
        throw new Error(
          `${file.name} is over the 140 MB single-upload limit — Dropbox upload sessions are not implemented yet.`,
        )
      }
      onProgress?.({ index: index + 1, total: album.files.length, fileName: file.name, bytesSent: 0, bytesTotal: bytes.byteLength })
      const request = dropboxUploadRequest(accessToken, `${folder}/${file.name}`, bytes)
      const response = await fetcher(request.url, request.init)
      if (!response.ok) throw await dropboxError(response, `Dropbox upload failed for ${file.name}.`)
      onProgress?.({ index: index + 1, total: album.files.length, fileName: file.name, bytesSent: bytes.byteLength, bytesTotal: bytes.byteLength })
    }

    const linkRequest = dropboxSharedLinkRequest(accessToken, folder)
    const linkResponse = await fetcher(linkRequest.url, linkRequest.init)
    if (linkResponse.ok) {
      const payload = (await linkResponse.json().catch(() => ({}))) as { url?: string }
      if (typeof payload.url === 'string' && payload.url) return { shareUrl: payload.url }
    }
    if (linkResponse.ok || (await sharedLinkAlreadyExists(linkResponse.clone()))) {
      // Re-share of a previously uploaded album: reuse the existing link so
      // the same public folder backs the Manorama gallery.
      const listRequest = dropboxListSharedLinksRequest(accessToken, folder)
      const listResponse = await fetcher(listRequest.url, listRequest.init)
      const payload = (await listResponse.json().catch(() => ({}))) as { links?: { url?: string }[] }
      const url = listResponse.ok ? payload.links?.[0]?.url : undefined
      if (typeof url === 'string' && url) return { shareUrl: url }
    }
    if (!linkResponse.ok) throw await dropboxError(linkResponse, 'The Dropbox share link could not be created.')
    throw new Error('The Dropbox share link could not be created.')
  }

  return {
    id: 'dropbox',
    label: 'Dropbox',
    configured: () => providerConfigured('dropbox'),
    isConnected: async () => (await loadProviderTokens('dropbox')) !== null,
    connect: () => connectProvider('dropbox'),
    completeConnect: (url) => completeProviderConnect(url),
    uploadAlbum,
    disconnect: () => clearProviderTokens('dropbox'),
  }
}
