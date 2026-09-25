import { defineConfig } from 'vite'
import nativeConfig from './vite.config.native'

/** Fixture server for #23's browser ad-safety suite. The app build uses
 *  appType 'spa', whose history fallback rewrites every GET — including the
 *  module request for /ads-fixture.tsx — back to index.html. 'mpa' keeps the
 *  dev server serving real files so the fixture entry resolves, while the
 *  real app stays reachable at / for the through-GalleryList coverage. */
export default defineConfig({
  ...nativeConfig,
  appType: 'mpa',
})
