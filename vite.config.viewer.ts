import { defineConfig } from 'vite'

/**
 * The viewer-only bundle for the native macOS shell.
 *
 * Separate from `vite.config.desktop.ts` on purpose: the native shell does
 * not want the Tauri catalogue, the drawer, the sign-in pane or the
 * provider adapters. It wants the shared Viewer and nothing else. A
 * separate root also keeps the shell's load light — the Viewer is the
 * whole surface.
 */
export default defineConfig({
  root: 'desktop-viewer',
  cacheDir: '../.work/vite-viewer-cache',
  // GalleryShell loads /curtain-boot.js and /manorama-merged-logo.png — both
  // live in the repo's shared public dir, so the shell bundle serves them.
  publicDir: '../public',
  envDir: '..',
  envPrefix: ['VITE_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
