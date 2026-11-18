// Converts the four Library captures — dark, quiet and dark, quiet and
// light, light — into the formats the homepage serves: AVIF, WebP and a
// JPEG fallback, at the capture's own size and at half size for standard
// screens.
//
// The captures are 3456×2168, which is a 1728×1084 window at 2×. The
// viewer's canvas is that window's logical size, so the large variant is
// served at the capture's own 3456 and the half-size variant at 1728: a
// retina screen lands the capture's pixels one for one on the device's,
// and a standard screen lands the half-size file's one for one.
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
    { suffix: '', width: 3456 },
    { suffix: '-sm', width: 1728 },
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
