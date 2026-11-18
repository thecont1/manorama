// Converts the four Library captures — dark, quiet and dark, quiet and
// light, light — into the formats the homepage serves: AVIF, WebP and a
// JPEG fallback, at a generous size and at half size for narrow screens.
//
// The captures are 3456×2168. The frame that holds them is at most 1344
// CSS pixels wide, so the large variant is served at 2688: exactly twice
// that, which keeps every word in the dashboard crisp on a retina screen
// without carrying the full-resolution file to the browser.
//
// Run it from the repository root with node — sharp's native binding hangs
// under bun in this checkout:
//
//   node scripts/home-library-images.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}public/home`
mkdirSync(out, { recursive: true })

const jobs = [
  { id: 'lib-dark', src: 'demo-captures/library/01-dark-mode.png' },
  { id: 'lib-quiet-dark', src: 'demo-captures/library/02-quiet-dark-mode.png' },
  { id: 'lib-quiet-light', src: 'demo-captures/library/03-quiet-light-mode.png' },
  { id: 'lib-light', src: 'demo-captures/library/04-light-mode.png' },
]

for (const job of jobs) {
  const input = `${root}${job.src}`
  const variants = [
    { suffix: '', width: 2688 },
    { suffix: '-sm', width: 1344 },
  ]
  for (const variant of variants) {
    const pipeline = sharp(input).resize({ width: variant.width, withoutEnlargement: true })
    await pipeline.clone().avif({ quality: 56, effort: 5 }).toFile(`${out}/${job.id}${variant.suffix}.avif`)
    await pipeline.clone().webp({ quality: 72 }).toFile(`${out}/${job.id}${variant.suffix}.webp`)
    await pipeline.clone().jpeg({ quality: 80, mozjpeg: true }).toFile(`${out}/${job.id}${variant.suffix}.jpg`)
  }
  console.log(`${job.id} ← ${job.src}`)
}
console.log('done')
