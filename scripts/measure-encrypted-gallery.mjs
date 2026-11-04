// Measures keyed-open latency for the seeded MEGA gallery (dev-mega) against a
// running dev server. Produces median/p95 for time-to-first-blob at the three
// matrix viewports, plus warm (stored-key) opens and resolver blob counts.
//
// This is a LIVE-NETWORK measurement: there is no deterministic local encrypted
// fixture, so run-to-run variance includes MEGA API/CDN time. Results belong in
// the live-network section of docs/encrypted-sources-validation.md.
//
// Usage:
//   bun run dev            # in another shell
//   bun scripts/measure-encrypted-gallery.mjs [--runs 5] [--warm-runs 3]
//
// Requires MANORAMA_DEV_SOURCE_MEGA (env or .env.local) — the same real share
// the encrypted-gallery spec uses.

import { chromium } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const base = process.env.GALLERY_URL ?? 'http://localhost:5173'
const owner = 'thecontrarian'
const slug = 'dev-mega'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(args[i + 1])
}
const RUNS = arg('runs', 5)
const WARM_RUNS = arg('warm-runs', 3)
const BLOB_TIMEOUT = 90_000

const keyed = process.env.MANORAMA_DEV_SOURCE_MEGA ?? (() => {
  try {
    const line = readFileSync('.env.local', 'utf8').split('\n').find((r) => r.startsWith('MANORAMA_DEV_SOURCE_MEGA='))
    return line?.slice('MANORAMA_DEV_SOURCE_MEGA='.length).trim().replace(/^["']|["']$/g, '')
  } catch { return undefined }
})()
if (!keyed) {
  console.error('MANORAMA_DEV_SOURCE_MEGA not configured — no live share to measure')
  process.exit(1)
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

const measure = async (page) => {
  const t0 = Date.now()
  await page.goto(`${base}/${owner}/${slug}#source=${encodeURIComponent(keyed)}`, { waitUntil: 'domcontentloaded' })
  await page.locator('img[src^="blob:"]').first().waitFor({ state: 'visible', timeout: BLOB_TIMEOUT })
  const firstBlob = Date.now() - t0
  const stats = await page.evaluate(() => ({
    blobImages: document.querySelectorAll('img[src^="blob:"]').length,
    workers: window.__workerCount ?? 0,
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  }))
  return { firstBlob, ...stats }
}

const run = async () => {
  const browser = await chromium.launch()
  const results = {}
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 },
  ]) {
    const cold = []
    const warm = []
    let lastStats = null
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.__workerCount = 0
        const W = window.Worker
        window.Worker = class extends W {
          constructor(...a) { window.__workerCount += 1; super(...a) }
        }
      })
      await page.request.post(`${base}/.dev-seed/reset`)
      const m = await measure(page)
      cold.push(m.firstBlob)
      lastStats = m
      for (let w = 0; w < WARM_RUNS; w++) {
        // Stored session key survives the reload — this is the cached-key open.
        const t0 = Date.now()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.locator('img[src^="blob:"]').first().waitFor({ state: 'visible', timeout: BLOB_TIMEOUT })
        warm.push(Date.now() - t0)
      }
      await context.close()
    }
    results[`${viewport.width}x${viewport.height}`] = {
      cold: { runs: cold, median: Math.round(median(cold)), p95: Math.round(p95(cold)) },
      warm: { runs: warm, median: Math.round(median(warm)), p95: Math.round(p95(warm)) },
      final: lastStats,
    }
  }
  await browser.close()
  const commit = execSync('git rev-parse --short HEAD').toString().trim()
  return {
    date: new Date().toISOString().slice(0, 10),
    commit, base, fixture: 'MANORAMA_DEV_SOURCE_MEGA live share (69 items at run time)',
    runsPerViewport: RUNS, warmRunsPerContext: WARM_RUNS,
    browser: 'chromium (playwright)', results,
  }
}

const report = await run()
console.log(JSON.stringify(report, null, 2))
