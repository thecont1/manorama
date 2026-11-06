import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/** Same build tag the web Library renders under its mark — the desktop rail
 *  carries it too. */
const buildCommit = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

/** Static client-only build for the Tauri shell, mirroring
 *  vite.config.native.ts — the worker's HonoX/Vite chain cannot emit a
 *  standalone SPA, so each shell gets its own config. */
export default defineConfig({
  root: 'desktop',
  cacheDir: '../.work/vite-desktop-cache',
  publicDir: '../public',
  // Provider OAuth client ids are public app identifiers injected at build
  // time; envDir reaches the repo root so .env.local works for desktop dev
  // the same way it does for the web app.
  envDir: '..',
  envPrefix: ['VITE_', 'MANORAMA_DESKTOP_'],
  define: { __MANORAMA_COMMIT__: JSON.stringify(buildCommit) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
