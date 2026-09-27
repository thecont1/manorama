import { defineConfig } from 'vite'

/** Static client-only build for the Tauri shell, mirroring
 *  vite.config.native.ts — the worker's HonoX/Vite chain cannot emit a
 *  standalone SPA, so each shell gets its own config. */
export default defineConfig({
  root: 'desktop',
  publicDir: '../public',
  // Provider OAuth client ids are public app identifiers injected at build
  // time; envDir reaches the repo root so .env.local works for desktop dev
  // the same way it does for the web app.
  envDir: '..',
  envPrefix: ['VITE_', 'MANORAMA_DESKTOP_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
