/**
 * The native shell's channel.
 *
 * The desktop bundle is the app: the Library, the gallery grid, the vault
 * meter, the local catalogue. It runs under Tauri and under the native
 * macOS shell, and the shell wants two things the bundle does not otherwise
 * expose — the committed photograph, so the shell can show a position, and a
 * way to move the stage from the native menu.
 *
 * Everything here is a no-op when no shell is present, so the Tauri build
 * behaves exactly as it did before this file existed.
 */

export type ShellMessage =
  | { type: 'ready' }
  | { type: 'position'; index: number; total: number }
  | { type: 'gallery'; open: boolean; title?: string }
  | { type: 'escape' }

type ShellOutbound = { post: (message: ShellMessage) => void }

const outbound = (): ShellOutbound | undefined =>
  (window as unknown as { __MANORAMA_SHELL__?: ShellOutbound }).__MANORAMA_SHELL__

/** Tell the shell something. Silently ignored when there is no shell. */
export const shellPost = (message: ShellMessage) => {
  outbound()?.post(message)
}

/**
 * The handle the shell's Gallery menu drives.
 *
 * The Viewer keeps sole ownership of the index — this asks it to move, it
 * never sets it. The handle is published to the shell rather than to a
 * global, so the Tauri build never sees it.
 */
export type NavigationHandle = { current: { goTo(index: number): void } | null }

/**
 * Publish a navigation handle to the shell.
 *
 * The shell calls this rather than reaching into the page: it needs one
 * entry point, and the page needs one place where the mounted Viewer's
 * handle lives.
 */
export const publishNavigation = (handle: NavigationHandle) => {
  ;(window as unknown as { __manoramaGoTo?: (index: number) => void }).__manoramaGoTo = (index: number) => {
    handle.current?.goTo(index)
  }
}

/**
 * Publish the way back to the Library.
 *
 * The shell's Gallery menu has a Close Gallery item, and the page owns the
 * state that decides what closing means — so the shell asks the page rather
 * than reaching into it.
 */
export const publishClose = (close: () => void) => {
  ;(window as unknown as { __manoramaCloseGallery?: () => void }).__manoramaCloseGallery = close
}

/**
 * Publish the way to add a gallery.
 *
 * The native menu's "Open Folder…" item runs the Library's own add flow —
 * the page picks the folder, scans it and records it — rather than a
 * second, native path that would leave the two catalogues disagreeing.
 */
export const publishAddGallery = (add: () => void) => {
  ;(window as unknown as { __manoramaAddGallery?: () => void }).__manoramaAddGallery = add
}

/**
 * Publish the add flow itself — the one that picks, scans and records.
 *
 * The chooser sheet is the human way in; this is the same flow without the
 * sheet, so a test run can add a folder without clicking through a dialog.
 */
export const publishAddFolder = (add: () => void) => {
  ;(window as unknown as { __manoramaAddFolder?: () => void }).__manoramaAddFolder = add
}
