import { defineConfig } from '@playwright/test'

/**
 * A run config for this checkout only: the repository's own config ignores
 * `**​/.worktrees/**`, and this checkout lives inside `.worktrees/`. From a
 * checkout that is not a worktree, the repository config picks both specs up
 * normally.
 *
 * Captures are 1× — one png pixel per CSS pixel at the window's own size, the
 * same convention the web admin evidence uses. Layout is measured in CSS pixels
 * either way.
 *
 * `theme-persistence.playwright.ts` drives the web dashboard as well as the
 * desktop shell, so it additionally needs `GALLERY_URL` (the dev server with
 * its seed) alongside `DESKTOP_URL`.
 */
export default defineConfig({
  testDir: '..',
  testMatch: ['desktop-catalogue.playwright.ts', 'desktop-admin.playwright.ts', 'theme-persistence.playwright.ts'],
  timeout: 180_000,
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 840 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
