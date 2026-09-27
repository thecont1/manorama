import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readDir, readFile } from '@tauri-apps/plugin-fs'
import type { LocalScanEntry } from './local-scan'

/**
 * The Tauri-facing adapter — the only desktop module that touches plugin
 * imports at module scope. UI code imports this; tests never do.
 */

/** True inside the Tauri webview; false in a plain browser/bun context. */
export const isDesktopRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const pickGalleryFolder = async (): Promise<string | null> => {
  const picked = await open({ directory: true, multiple: false })
  return typeof picked === 'string' && picked.trim() ? picked : null
}

/**
 * Grants the fs-plugin and asset-protocol scopes access to one picked root.
 * Must run after every pick AND on every launch for each saved root — both
 * scopes are runtime state and reset when the app restarts.
 */
export const registerGalleryRoot = async (path: string): Promise<void> =>
  invoke('register_gallery_root', { path })

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
