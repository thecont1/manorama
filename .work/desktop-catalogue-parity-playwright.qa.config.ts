import { defineConfig } from '@playwright/test'

/**
 * Same reason as playwright.desktop.config.ts: this checkout lives inside
 * `.worktrees/`, which the repository config's testIgnore excludes, so the
 * live-provider viewer suite cannot run from here under the repo config.
 *
 * Needs the dev server with its seed: GALLERY_URL=http://127.0.0.1:5199
 */
export default defineConfig({
  testDir: '..',
  testMatch: ['qa.playwright.ts'],
  timeout: 180_000,
  reporter: [['list']],
})
