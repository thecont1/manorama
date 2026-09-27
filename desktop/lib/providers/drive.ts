import {
  accessTokenFor,
  clearProviderTokens,
  completeProviderConnect,
  connectProvider,
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
 * Google Drive upload lane. Uploads go to a `manorama/<album>` folder tree
 * the app creates inside the user's Drive — `drive.file` scope can only see
 * files and folders this app created, which is exactly the least-privilege
 * grant an upload lane needs.
 *
 * Upload protocol: resumable sessions (uploadType=resumable → session URI
 * → PUT the original bytes). Files land under their sanitized basenames —
 * Drive permits same-name siblings, so retries never need renames; the
 * in-album dedupe in share.ts still keeps names deterministic.
 *
 * The public link is the folder's webViewLink after `permissions.create`
 * marks it anyone-with-link reader — the shape the Worker's Drive scanner
 * already understands. `webViewLink` is constructed from the folder id
 * rather than read back, since the API returns it verbatim on create.
 */

const API_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MANORAMA_FOLDER = 'manorama'

export const driveFolderLink = (folderId: string): string =>
  `https://drive.google.com/drive/folders/${folderId}`

// --- Pure request shapes (asserted directly by tests) ----------------------

/** `files.list` query for a folder by name. Only ever asked for names this
 *  app created (drive.file scope), so the query is bounded by design. */
export const driveFindFolderRequest = (
  token: string,
  name: string,
  parentId?: string,
): { url: string; init: RequestInit } => {
  const query = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    ...(parentId ? [`'${parentId}' in parents`] : []),
  ].join(' and ')
  const url = new URL(`${API_BASE}/files`)
  url.searchParams.set('q', query)
  url.searchParams.set('fields', 'files(id,name)')
  return { url: url.toString(), init: { headers: { Authorization: `Bearer ${token}` } } }
}

export const driveCreateFolderRequest = (
  token: string,
  name: string,
  parentId?: string,
): { url: string; init: RequestInit } => ({
  url: `${API_BASE}/files`,
  init: {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  },
})

export const driveResumableInitRequest = (
  token: string,
  file: { name: string; parents: string[] },
): { url: string; init: RequestInit } => ({
  url: `${UPLOAD_BASE}?uploadType=resumable`,
  init: {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ name: file.name, parents: file.parents }),
  },
})

export const driveSessionUploadRequest = (
  sessionUri: string,
  bytes: Uint8Array,
): { url: string; init: RequestInit } => ({
  url: sessionUri,
  init: {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    // Byte-for-byte: the resumable PUT body is the untouched original.
    body: bytes as unknown as BodyInit,
  },
})

export const drivePermissionRequest = (
  token: string,
  folderId: string,
): { url: string; init: RequestInit } => ({
  url: `${API_BASE}/files/${encodeURIComponent(folderId)}/permissions`,
  init: {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  },
})

// --- The provider ------------------------------------------------------------

type DriveFileResponse = { id?: string }
type DriveListResponse = { files?: { id?: string }[] }

const driveError = async (response: Response, fallback: string): Promise<Error> => {
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  const message = payload.error?.message?.trim()
  return new Error(message ? `Google Drive: ${message}` : fallback)
}

export const createDriveUploadProvider = (deps?: {
  fetcher?: typeof fetch
  /** Token seam — production omits it and accessTokenFor refreshes the
   *  stored grant; tests inject a fixed token. */
  getToken?: () => Promise<string>
}): UploadProvider => {
  const fetcher = deps?.fetcher ?? fetch

  const createFolder = async (token: string, name: string, parentId?: string): Promise<string> => {
    const create = driveCreateFolderRequest(token, name, parentId)
    const created = await fetcher(create.url, create.init)
    const payload = (await created.json().catch(() => ({}))) as DriveFileResponse
    if (!created.ok || !payload.id) throw await driveError(created, `The ${name} folder could not be created.`)
    return payload.id
  }

  const ensureFolder = async (token: string, name: string, parentId?: string): Promise<string> => {
    const find = driveFindFolderRequest(token, name, parentId)
    const found = await fetcher(find.url, find.init)
    if (found.ok) {
      const payload = (await found.json().catch(() => ({}))) as DriveListResponse
      const id = payload.files?.[0]?.id
      if (id) return id
    }
    return createFolder(token, name, parentId)
  }

  const uploadAlbum = async (
    album: UploadAlbum,
    readFile: ReadFileBytes,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ shareUrl: string }> => {
    const token = await (deps?.getToken?.() ?? accessTokenFor('drive', fetcher))
    const manoramaId = await ensureFolder(token, MANORAMA_FOLDER)
    // A fresh folder per upload — reusing a name-matched folder would let
    // two galleries that share a title commingle their files.
    const albumId = await createFolder(token, album.name, manoramaId)
    for (let index = 0; index < album.files.length; index += 1) {
      const file = album.files[index]!
      const bytes = await readFile(file.path)
      onProgress?.({ index: index + 1, total: album.files.length, fileName: file.name, bytesSent: 0, bytesTotal: bytes.byteLength })
      const init = driveResumableInitRequest(token, { name: file.name, parents: [albumId] })
      const session = await fetcher(init.url, init.init)
      const sessionUri = session.headers.get('Location') ?? session.headers.get('location')
      if (!session.ok || !sessionUri) throw await driveError(session, `The upload session for ${file.name} could not be started.`)
      const upload = driveSessionUploadRequest(sessionUri, bytes)
      const done = await fetcher(upload.url, upload.init)
      if (!done.ok) throw await driveError(done, `Google Drive upload failed for ${file.name}.`)
      onProgress?.({ index: index + 1, total: album.files.length, fileName: file.name, bytesSent: bytes.byteLength, bytesTotal: bytes.byteLength })
    }
    const permission = drivePermissionRequest(token, albumId)
    const granted = await fetcher(permission.url, permission.init)
    if (!granted.ok) throw await driveError(granted, 'The folder could not be made linkable.')
    return { shareUrl: driveFolderLink(albumId) }
  }

  return {
    id: 'drive',
    label: 'Google Drive',
    configured: () => providerConfigured('drive'),
    isConnected: async () => (await loadProviderTokens('drive')) !== null,
    connect: () => connectProvider('drive'),
    completeConnect: (url) => completeProviderConnect(url),
    uploadAlbum,
    disconnect: () => clearProviderTokens('drive'),
  }
}
