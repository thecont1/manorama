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

/**
 * Opens the gallery's root in Finder. The bridge grants the reveal only
 * for a path that is — or sits inside — a picker-approved root, so the
 * renderer cannot point Finder at arbitrary directories.
 */
export const revealGalleryRoot = async (path: string): Promise<void> =>
  invoke('reveal_gallery_root', { path })

export const readDirEntries = async (dir: string): Promise<LocalScanEntry[]> => {
  // The native shell adds displayed-pixel dims to image entries — beyond the
  // plugin's typed shape, so the seam is widened here rather than upstream.
  const entries = (await readDir(dir)) as ({ name: string; isDirectory: boolean; isFile: boolean } & Pick<LocalScanEntry, 'width' | 'height'>)[]
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory,
    isFile: entry.isFile,
    ...(typeof entry.width === 'number' && entry.width > 0 ? { width: entry.width } : {}),
    ...(typeof entry.height === 'number' && entry.height > 0 ? { height: entry.height } : {}),
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

/** True when an invoke rejection says the shell has no such command —
 *  the macOS bridge answers "the native shell does not implement X" and
 *  a real Tauri runtime reports the missing method by name. Errors that
 *  merely mention the path (scope, IO, decode) are real failures. */
const isUnsupportedCommand = (error: unknown, command: string): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (!message.includes(command)) return false
  return (
    message.includes('does not implement') ||
    message.includes('not implemented') ||
    message.includes('not found') ||
    message.includes('unknown') ||
    message.includes('no such') ||
    message.includes('invalid invoke')
  )
}

/**
 * A bounded window of a granted file's bytes — the embedded-metadata probe
 * asks for the head and a few ranged extents, never whole photographs.
 * The macOS shell answers `read_file_range` with `__bytes`, which the
 * shell bridge revives to a Uint8Array before invoke resolves; a raw
 * `{__bytes}` reply is decoded here for shells that skip that step.
 * Shells without the command fall back to a full read sliced to the
 * window — correct, just heavier. On a shell that HAS the command a real
 * failure (scope, IO, decode) propagates: silently reading the whole file
 * would defeat the byte bound exactly when something is already wrong.
 */
export const readFileRange = async (path: string, start: number, length: number): Promise<Uint8Array> => {
  let reply: Uint8Array | ArrayBuffer | { __bytes?: string } | null | undefined
  try {
    reply = await invoke<Uint8Array | ArrayBuffer | { __bytes?: string }>('read_file_range', { path, start, length })
  } catch (error) {
    if (isUnsupportedCommand(error, 'read_file_range')) {
      const whole = await readFileBytes(path)
      return whole.slice(start, start + length)
    }
    throw error
  }
  if (reply instanceof Uint8Array) return reply
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply)
  const encoded = reply?.__bytes
  if (typeof encoded !== 'string') throw new Error('read_file_range returned no bytes')
  const bin = atob(encoded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * "Post to X": the prepared JPEGs, the post text and the gallery's address,
 * handed to the shell in one call. The shell stages the files where the OS
 * can reach them — the macOS shell puts them on the pasteboard and opens
 * the X composer; the photographs exist only for the post, they are never
 * a saved copy. A shell with no `share_post` rejects, which the caller
 * reports instead of pretending the post went out.
 */
export const sharePost = async (
  files: readonly { name: string; data: string }[],
  text: string,
  url: string,
  title: string,
): Promise<string> => {
  const note = await invoke<string | null>('share_post', { files, text, url, title })
  return typeof note === 'string' ? note : ''
}

// MARK: - Drag-and-drop folder add
//
// The macOS shell scopes dragged directories on drop and holds them pending
// until the page commits or discards — a path the page names is only a
// lookup key; a path that is not pending grants nothing. Under real Tauri
// (Windows) none of these commands exist yet and the events never fire, so
// every call degrades quietly.

/** Commit the selected pending roots into the folder store. Answers the
 *  paths actually committed — the shell may hold fewer than were asked. */
export const commitDroppedRoots = async (paths: string[]): Promise<string[]> => {
  const committed = await invoke<unknown>('commit_dropped_roots', { paths })
  return Array.isArray(committed) ? committed.filter((path): path is string => typeof path === 'string') : []
}

/** Release pending scopes — all of them when `paths` is absent, else just
 *  the named ones. Cleanup is best-effort: a rejected discard still leaves
 *  the shell's own expiry to collect the scopes. */
export const discardDroppedRoots = async (paths?: string[]): Promise<void> => {
  try {
    await invoke('discard_dropped_roots', paths ? { paths } : {})
  } catch {
    // The pending set expires on its own; nothing else to do here.
  }
}

type FolderDropHandlers = {
  onDragEnter?: (folders: number, files: number) => void
  onDragLeave?: () => void
  onDrop?: (paths: string[], files: number) => void
}

/**
 * The shell's three folder-drag events. Returns an async unlisten; under a
 * runtime with no emitter the subscription simply never fires.
 *
 * `__manoramaFolderDropArmed` is the shell emit's readiness flag: the
 * native side retries a seeded drop until the page says it is listening,
 * so a `--seed-drop` launch cannot lose its event to a mount race.
 */
export const onFolderDrop = async (handlers: FolderDropHandlers): Promise<() => void> => {
  const win = typeof window === 'undefined' ? undefined : (window as unknown as { __manoramaFolderDropArmed?: boolean })
  const disarm = () => { if (win) win.__manoramaFolderDropArmed = false }
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlistens = await Promise.all([
      listen<{ folders?: number; files?: number }>('manorama://folder-drag-enter', (event) => {
        handlers.onDragEnter?.(event.payload?.folders ?? 0, event.payload?.files ?? 0)
      }),
      listen('manorama://folder-drag-leave', () => handlers.onDragLeave?.()),
      listen<{ paths?: string[]; files?: number }>('manorama://folders-dropped', (event) => {
        handlers.onDrop?.(event.payload?.paths ?? [], event.payload?.files ?? 0)
      }),
    ])
    // Armed only once the listeners exist — the shell's emit retries while
    // the flag is false, so a `--seed-drop` fired at page-ready cannot land
    // in the gap before the dynamic import and the three listens resolve.
    if (win) win.__manoramaFolderDropArmed = true
    return async () => {
      disarm()
      for (const unlisten of unlistens) {
        try { unlisten() } catch { /* a dead emitter must not stall teardown */ }
      }
    }
  } catch {
    disarm()
    return async () => {}
  }
}
