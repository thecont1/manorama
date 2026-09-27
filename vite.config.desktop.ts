import { defineConfig } from 'vite'

/** Static client-only build for the Tauri shell, mirroring
 *  vite.config.native.ts — the worker's HonoX/Vite chain cannot emit a
 *  standalone SPA, so each shell gets its own config. */
export default defineConfig({
  root: 'desktop',
  publicDir: '../public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
