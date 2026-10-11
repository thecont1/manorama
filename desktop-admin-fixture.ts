/**
 * The fixture the desktop acceptance specs share.
 *
 * The desktop bundle is a client-only SPA: outside the Tauri webview its IPC
 * bridge is absent, so the shell would stop at the welcome screen. These specs
 * install the bridge before any page script runs and answer the handful of
 * commands the catalogue actually calls. Everything asserted on top of it is
 * then the real bundle's own behaviour, not a fixture's.
 *
 * Deliberately not named `*.playwright.ts` — Playwright's testMatch would try
 * to collect it as a spec.
 */

/** A 1x1 transparent GIF — the asset protocol's stand-in, so a thumbnail
 *  paints without reaching for a file the browser cannot read. */
export const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

export const GALLERY_ID = '11111111-2222-4333-8444-555555555555'
export const GALLERY_ID_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa'

export const catalogue = {
  version: 1,
  deviceId: 'f8e9e5ce-b31a-41a1-b4cd-5261fb3d48f2',
  deviceLabel: 'This Mac',
  galleries: [
    {
      id: GALLERY_ID,
      title: 'Bangkok Rain',
      rootPath: '/Users/photographer/Pictures/Bangkok Rain',
      sourceKind: 'folder',
      itemCount: 25,
      items: [
        { id: `${GALLERY_ID}-1`, name: 'IMG_0001.jpg', path: '/Users/photographer/Pictures/Bangkok Rain/IMG_0001.jpg', width: 4000, height: 2667 },
        { id: `${GALLERY_ID}-2`, name: 'IMG_0002.jpg', path: '/Users/photographer/Pictures/Bangkok Rain/IMG_0002.jpg', width: 2667, height: 4000 },
      ],
      addedAt: '2026-10-11T05:00:00.000Z',
      lastSeenAt: '2026-10-11T05:00:00.000Z',
    },
    {
      id: GALLERY_ID_TWO,
      title: 'Monsoon Card',
      rootPath: '/Volumes/NO NAME/DCIM',
      sourceKind: 'card',
      mountPoint: '/Volumes/NO NAME',
      itemCount: 1,
      items: [
        { id: `${GALLERY_ID_TWO}-1`, name: 'DSC_0001.jpg', path: '/Volumes/NO NAME/DCIM/DSC_0001.jpg', width: 6000, height: 4000 },
      ],
      addedAt: '2026-10-10T05:00:00.000Z',
      lastSeenAt: '2026-10-10T05:00:00.000Z',
    },
  ],
}

/** A signed-in session, plan included — the shape the exchange writes. */
export const session = { token: 'test-session-token', ownerSlug: 'thecontrarian', tier: 'pro' }

/** Injected into the page before any script runs. Its payload arrives as an
 *  argument because an init script is serialized, not called: anything it
 *  closes over would be missing in the browser. */
export const installBridge = (payload: { catalogue: string; session: string; pixel: string }) => {
  const internals = {
    transformCallback: (callback: unknown) => {
      const id = 1
      ;(window as unknown as Record<string, unknown>)[`_${id}`] = callback
      return id
    },
    convertFileSrc: () => payload.pixel,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'read_private_file') {
        const name = String(args?.name ?? '')
        if (name === 'catalogue.json') return payload.catalogue
        if (name === 'session.json') return payload.session
        return null
      }
      if (cmd === 'write_private_file' || cmd === 'delete_private_file') return null
      if (cmd === 'register_saved_gallery_roots') return null
      if (cmd === 'pick_gallery_root') return null
      if (cmd === 'plugin:fs|exists') return true
      if (cmd === 'plugin:fs|read_dir') return []
      return null
    },
  }
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals
}

export const bridgePayload = {
  catalogue: JSON.stringify(catalogue),
  session: JSON.stringify(session),
  pixel: PIXEL,
}

/** The bundle's default API base is production; no spec may reach it. The
 *  catalogue's sync seam is answered locally instead. */
export const blockProductionApi = async (page: { route: (url: string, handler: (route: { fulfill: (r: unknown) => unknown }) => unknown) => Promise<unknown> }): Promise<{ calls: () => number }> => {
  let calls = 0
  await page.route('https://manorama.xyz/**', (route) => {
    calls += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  return { calls: () => calls }
}