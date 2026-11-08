import { WebGalleryKeyStore } from '../../app/lib/key-store'

/** Encrypted-gallery key custody on the desktop: durable localStorage, not a
 *  session-scoped store — an app is not a tab, so custody survives relaunch. */
export const desktopKeyStore = (): WebGalleryKeyStore => new WebGalleryKeyStore(localStorage)
