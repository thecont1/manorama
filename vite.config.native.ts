import { defineConfig } from 'vite'

/** Static client-only build for Capacitor. The worker’s HonoX/Vite chain stays
 * untouched because it cannot emit a standalone SPA. */
export default defineConfig({
  root: 'native',
  // `root` moves .env resolution into native/, but the shared env files —
  // VITE_REVENUECAT_API_KEY included — live at the repo root.
  envDir: '..',
  publicDir: '../public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
