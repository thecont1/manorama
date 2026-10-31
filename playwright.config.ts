import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const configDir = fileURLToPath(new URL('.', import.meta.url))
const anchorRe = (dir: string) =>
  new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.worktrees/`)

// The browser suite lives in *.playwright.ts so bun's unit-test discovery
// (*.test.ts / *.spec.ts) never loads Playwright specs — `bun test` stays
// green and `bun run test` runs this suite.
export default defineConfig({
  testMatch: '**/*.playwright.ts',
  // The seeded galleries are live provider originals proxied at full size,
  // so image-dependent assertions legitimately take longer than the 5s
  // default; navigations settle on domcontentloaded, never on load.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Every linked checkout has its own runner; collecting it here loads a
  // second @playwright/test and aborts before the requested suite can start.
  // The evidence specs regenerate committed PNGs under demo-captures/ and
  // outputs/ as a side effect of passing, so the default run ignores them.
  // Playwright's testIgnore also filters explicit file arguments, so they
  // run on demand behind PW_EVIDENCE: PW_EVIDENCE=1 bunx playwright test
  // <spec>.playwright.ts
  // The .worktrees ignore must anchor at this config's directory: spec paths
  // are matched as absolute paths, so a bare '**/.worktrees/**' also swallows
  // every spec when the suite runs inside a linked checkout — a silent
  // zero-test "green". Anchored, it ignores only nested linked checkouts.
  testIgnore: [
    anchorRe(configDir),
    '**/node_modules/**',
    ...(process.env.PW_EVIDENCE
      ? []
      : [
          '**/capture-harness.playwright.ts',
          '**/admin-appearance.playwright.ts',
          '**/desktop-admin.playwright.ts',
          '**/desktop-catalogue.playwright.ts',
          '**/native-vault-controls.playwright.ts',
        ]),
  ],
})
