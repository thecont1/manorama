/** Owner-shell navigation as a pure reducer — no DOM, no Capacitor, shared
 *  by every surface so back-button, deep-link and screen transitions are
 *  derived, never negotiated. `viewer` holds the live viewer session a shell
 *  keeps mounted underneath Details (and a Reorder reached from such a
 *  Details): returning to it must restore the identical session object so
 *  the mounted instance — position, decoded frames, curtain state — is the
 *  one the user left. */

export type GalleryIdentity =
  | { kind: 'published'; owner: string; slug: string }
  | { kind: 'local'; galleryId: string }

export type OwnerScreen =
  | { kind: 'welcome' }
  | { kind: 'library' }
  | { kind: 'viewer'; gallery: GalleryIdentity; photoId?: string }
  | { kind: 'details'; gallery: GalleryIdentity; from: 'library' | 'viewer' }
  | {
      kind: 'reorder'
      gallery: GalleryIdentity
      from: 'library' | 'details'
      detailsFrom?: 'library' | 'viewer'
    }
  | { kind: 'settings' }
  | { kind: 'privacy'; from: 'welcome' | 'library' | 'settings' | 'visionary' }
  | { kind: 'visionary'; from: 'library' | 'settings' }

export type OwnerNavState = {
  screen: OwnerScreen
  /** The live viewer session kept mounted underneath Details (and Reorder
   *  opened from such a Details). */
  viewer: { gallery: GalleryIdentity; photoId?: string } | null
}

export type OwnerNavAction =
  | { type: 'signed-in' }
  | { type: 'signed-out' }
  | { type: 'open-library' }
  | { type: 'open-gallery'; gallery: GalleryIdentity; photoId?: string }
  | { type: 'open-details'; gallery: GalleryIdentity; from: 'library' | 'viewer' }
  | { type: 'open-reorder'; gallery: GalleryIdentity; from: 'library' | 'details' }
  | { type: 'open-settings' }
  | { type: 'open-visionary'; from: 'library' | 'settings' }
  | { type: 'open-privacy'; from: 'welcome' | 'library' | 'settings' | 'visionary' }
  | { type: 'back' }

export const initialOwnerNav = (signedIn: boolean): OwnerNavState => ({
  screen: signedIn ? { kind: 'library' } : { kind: 'welcome' },
  viewer: null,
})

export const sameGallery = (a: GalleryIdentity, b: GalleryIdentity): boolean =>
  a.kind === 'published' && b.kind === 'published'
    ? a.owner === b.owner && a.slug === b.slug
    : a.kind === 'local' && b.kind === 'local'
      ? a.galleryId === b.galleryId
      : false

export const canGoBack = (state: OwnerNavState): boolean =>
  state.screen.kind !== 'library' && state.screen.kind !== 'welcome'

const detailsFrom = (screen: OwnerScreen): 'library' | 'viewer' =>
  screen.kind === 'details' ? screen.from : 'library'

export const ownerNavReducer = (state: OwnerNavState, action: OwnerNavAction): OwnerNavState => {
  switch (action.type) {
    case 'signed-in':
      return { screen: { kind: 'library' }, viewer: null }
    case 'signed-out':
      return { screen: { kind: 'welcome' }, viewer: null }
    case 'open-library':
      return { screen: { kind: 'library' }, viewer: null }
    case 'open-gallery':
      return {
        screen: { kind: 'viewer', gallery: action.gallery, photoId: action.photoId },
        viewer: { gallery: action.gallery, photoId: action.photoId },
      }
    case 'open-details': {
      const keepsViewer =
        action.from === 'viewer' && state.viewer !== null && sameGallery(state.viewer.gallery, action.gallery)
      return {
        screen: { kind: 'details', gallery: action.gallery, from: action.from },
        viewer: keepsViewer ? state.viewer : null,
      }
    }
    case 'open-reorder': {
      const fromViewerDetails =
        action.from === 'details' &&
        state.viewer !== null &&
        sameGallery(state.viewer.gallery, action.gallery)
      return {
        screen: {
          kind: 'reorder',
          gallery: action.gallery,
          from: action.from,
          detailsFrom: action.from === 'details' ? detailsFrom(state.screen) : undefined,
        },
        viewer: fromViewerDetails ? state.viewer : null,
      }
    }
    case 'open-settings':
      return { screen: { kind: 'settings' }, viewer: null }
    case 'open-visionary':
      return { screen: { kind: 'visionary', from: action.from }, viewer: null }
    case 'open-privacy':
      return { screen: { kind: 'privacy', from: action.from }, viewer: null }
    case 'back': {
      const { screen, viewer } = state
      switch (screen.kind) {
        case 'viewer':
          return { screen: { kind: 'library' }, viewer: null }
        case 'details':
          if (screen.from === 'viewer' && viewer) return { screen: { kind: 'viewer', ...viewer }, viewer }
          return { screen: { kind: 'library' }, viewer: null }
        case 'reorder':
          if (screen.from === 'details')
            return {
              screen: { kind: 'details', gallery: screen.gallery, from: screen.detailsFrom ?? 'library' },
              viewer,
            }
          return { screen: { kind: 'library' }, viewer: null }
        case 'settings':
          return { screen: { kind: 'library' }, viewer: null }
        case 'visionary':
          return { screen: screen.from === 'settings' ? { kind: 'settings' } : { kind: 'library' }, viewer: null }
        case 'privacy':
          if (screen.from === 'settings') return { screen: { kind: 'settings' }, viewer: null }
          if (screen.from === 'visionary') return { screen: { kind: 'visionary', from: 'library' }, viewer: null }
          if (screen.from === 'library') return { screen: { kind: 'library' }, viewer: null }
          return { screen: { kind: 'welcome' }, viewer: null }
        case 'library':
        case 'welcome':
          return state
      }
    }
  }
}
