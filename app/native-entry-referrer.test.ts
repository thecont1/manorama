import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// The native shells serve their entry document from a local origin, so the
// Worker's Referrer-Policy header never reaches them — without the meta,
// cross-origin media requests (signed googlevideo URLs) carry a Referer
// and 403, the same failure the web header fixed.
describe('shell entry documents', () => {
  for (const entry of ['native/index.html', 'desktop/index.html']) {
    test(`${entry} carries the web referrer policy`, () => {
      const html = readFileSync(join(repoRoot, entry), 'utf8')
      expect(html).toContain('<meta name="referrer" content="same-origin"')
    })
  }

  test('the web page policy is unchanged', () => {
    const headers = readFileSync(join(repoRoot, 'app', 'lib', 'security-headers.ts'), 'utf8')
    expect(headers).toContain("'Referrer-Policy': 'same-origin'")
  })
})
