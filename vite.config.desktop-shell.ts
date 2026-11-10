import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite'

/** Same build tag the web Library renders under its mark — the desktop rail
 *  carries it too. */
const buildCommit = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

/**
 * The Library bundle for the native macOS shell.
 *
 * It is the SAME bundle the Tauri shell ships — `desktop/`, unchanged — with
 * one difference: the shell's Tauri shim is installed before the app's module
 * runs, so the bundle's runtime calls land on the SwiftUI shell instead of on
 * Tauri.
 *
 * The shim has to be a classic script, not a module. A module script is
 * deferred until the document is parsed, and the app's first call into the
 * runtime happens while its modules are still evaluating; a classic script
 * placed in the head runs first and wins the race every time.
 *
 * The API base is left alone. The bundle builds its OAuth authorisation URLs
 * from it, and those must point at the real site — only the API's CORS
 * allowlist has to know about the shell's origin, which is the same
 * arrangement the Tauri and Capacitor shells already have.
 */
const nativeShellShim = (): Plugin => ({
  name: 'manorama-native-shell-shim',
  async transformIndexHtml(html) {
    const source = readFileSync('desktop-shell/bridge.ts', 'utf8')
    const { code } = await transformWithEsbuild(source, 'bridge.ts', {
      loader: 'ts',
      format: 'iife',
      target: 'es2022',
    })
    return [{
      tag: 'script',
      children: code,
      injectTo: 'head-prepend',
    }]
  },
})

export default defineConfig({
  root: 'desktop',
  cacheDir: '../.work/vite-desktop-shell-cache',
  publicDir: '../public',
  // Provider OAuth client ids are public app identifiers injected at build
  // time; envDir reaches the repo root so .env.local works the same way it
  // does for the web app and the Tauri build.
  envDir: '..',
  envPrefix: ['VITE_', 'MANORAMA_DESKTOP_'],
  define: { __MANORAMA_COMMIT__: JSON.stringify(buildCommit) },
  plugins: [nativeShellShim()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
