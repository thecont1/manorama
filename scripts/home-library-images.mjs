// Converts the four Library captures — dark, quiet and dark, quiet and
// light, light — into the formats the homepage serves: AVIF, WebP and a
// JPEG fallback, at a generous size and at half size for narrow screens.
//
// The captures are 3456×2168. The frame that holds them is at most 1312
// CSS pixels wide and its 2-pixel rules take four of them, so the
// viewable area is 1308. The large variant is therefore served at 2616 —
// exactly twice that — which lands the capture's own pixels one for one on
// a retina screen's device pixels, and the half-size variant lands the
// same way on a standard screen.
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
    { suffix: '', width: 2616 },
    { suffix: '-sm', width: 1308 },
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
