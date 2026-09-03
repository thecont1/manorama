import { defineConfig } from '@playwright/test'

// The browser suite lives in *.playwright.ts so bun's unit-test discovery
// (*.test.ts / *.spec.ts) never loads Playwright specs — `bun test` stays
// green and `bun run test` runs this suite.
export default defineConfig({
  testMatch: '**/*.playwright.ts',
})
