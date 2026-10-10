import { defineConfig } from '@playwright/test'

// The browser suite lives in *.playwright.ts so bun's unit-test discovery
// (*.test.ts / *.spec.ts) never loads Playwright specs — `bun test` stays
// green and `bun run test` runs this suite.
export default defineConfig({
  testMatch: '**/*.playwright.ts',
  // Every linked checkout has its own runner; collecting it here loads a
  // second @playwright/test and aborts before the requested suite can start.
  testIgnore: ['**/.worktrees/**', '**/node_modules/**'],
})
