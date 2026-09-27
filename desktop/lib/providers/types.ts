/**
 * The shared shape of an upload provider — Dropbox and Google Drive both
 * implement this. A provider owns its own OAuth grant (kept in
 * `providers.json` by `oauth.ts`) and its own public-link creation; the
 * share flow in `../share.ts` only ever sees this interface.
 *
 * Everything an upload needs is on the interface: byte-faithful reads come
 * in through `readFile`, progress goes out through `onProgress`, and the
 * result is a public link. No provider call is destructive — uploads only
 * add content, and `disconnect` only forgets the local grant.
 */

export type UploadProviderId = 'dropbox' | 'drive'

export const UPLOAD_PROVIDER_IDS: readonly UploadProviderId[] = ['dropbox', 'drive']

export const uploadProviderLabel = (id: UploadProviderId): string =>
  id === 'dropbox' ? 'Dropbox' : 'Google Drive'

/** One file to upload. `name` is the sanitized basename that lands in the
 *  provider folder; `path` is the local absolute path, which never leaves
 *  the device — it is only handed to `readFile`. */
export type UploadFile = { name: string; path: string }

/** `id` is the catalogue record's stable identifier — providers use it to
 * keep the same gallery in the same remote folder across retries and to
 * keep two galleries that share a title in different folders. */
export type UploadAlbum = { name: string; id?: string; files: UploadFile[] }

export type UploadProgress = {
  /** 1-based index of the file currently uploading. */
  index: number
  total: number
  fileName: string
  bytesSent: number
  bytesTotal: number
}

export type ReadFileBytes = (path: string) => Promise<Uint8Array>

export type UploadProvider = {
  readonly id: UploadProviderId
  readonly label: string
  /** False when the build carries no OAuth client id — the UI shows the
   *  provider row disabled rather than failing at connect time. */
  configured(): boolean
  isConnected(): Promise<boolean>
  /** Runs the OAuth flow in the system browser and resolves once the
   *  redirect has been exchanged and the tokens stored. */
  connect(): Promise<void>
  /** Paste-the-link fallback for environments where the deep link or the
   *  loopback listener cannot deliver — dev builds and plain browsers. */
  completeConnect(redirectUrl: string): Promise<void>
  /**
   * Uploads every file byte-for-byte into the provider folder for `album`
   * and returns a public link to it. A failure aborts without deleting
   * partial provider content; retrying re-adds files (Dropbox autorenames
   * on conflict, Drive allows same-name files).
   */
  uploadAlbum(
    album: UploadAlbum,
    readFile: ReadFileBytes,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ shareUrl: string }>
  /** Forgets the local grant (providers.json). Revocation, if wanted, is
   *  the owner's action on the provider's site — never an API call. */
  disconnect(): Promise<void>
}
