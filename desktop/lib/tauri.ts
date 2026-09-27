import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { exists, readDir, readFile } from '@tauri-apps/plugin-fs'
import type { LocalScanEntry } from './local-scan'

/**
 * The Tauri-facing adapter — the only desktop module that touches plugin
 * imports at module scope. UI code imports this; tests never do.
 */

/** True inside the Tauri webview; false in a plain browser/bun context. */
export const isDesktopRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Opens the native folder picker in Rust and grants the fs-plugin and
 * asset-protocol scopes to the picked root in the same call. The renderer
 * never supplies a path, so a scope can only ever cover what was picked.
 */
export const pickGalleryFolder = async (): Promise<string | null> => {
  const picked = await invoke<string | null>('pick_gallery_root')
  return typeof picked === 'string' && picked.trim() ? picked : null
}

/**
 * Re-grants both scopes to every picker-approved root on launch and after a
 * remount — both scopes are runtime state and reset when the app restarts.
 * Rust keeps the list itself: the renderer-writable catalogue is never the
 * source of a grant.
 */
export const registerSavedGalleryRoots = async (): Promise<void> =>
  invoke('register_saved_gallery_roots')

export const readDirEntries = async (dir: string): Promise<LocalScanEntry[]> => {
  const entries = await readDir(dir)
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory,
    isFile: entry.isFile,
  }))
}

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    return await exists(path)
  } catch {
    // Outside the granted scope or gone — the caller treats both as absent.
    return false
  }
}

/** Display URL for a referenced original — the asset protocol, never a copy. */
export const assetUrl = (path: string): string => convertFileSrc(path)

/**
 * The raw bytes of a file inside a granted root — used ONLY by the
 * explicit share flow, which uploads them byte-for-byte to the chosen
 * provider. The same runtime scope that gates `readDir` gates this: a
 * path outside a picked root rejects.
 */
export const readFileBytes = async (path: string): Promise<Uint8Array> => readFile(path)
