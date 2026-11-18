// Converts the selected product captures into the formats the homepage
// serves: AVIF, WebP and a JPEG fallback, at the capture's own size.
//
// Run it from the repository root with node — sharp's native binding hangs
// under bun in this checkout:
//
//   node scripts/home-images.mjs
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}public/home`
mkdirSync(out, { recursive: true })

const jobs = [
  { id: 'h1-viewer', src: 'demo-captures/macos/03-first-image-hover.png', width: 1440 },
]

for (const job of jobs) {
  const input = `${root}${job.src}`
  const variants = [
    { suffix: '', width: job.width },
    ...(job.half ? [{ suffix: '-sm', width: job.half }] : []),
  ]
  for (const variant of variants) {
    const pipeline = sharp(input).resize({ width: variant.width, withoutEnlargement: true })
    await pipeline.clone().avif({ quality: 58, effort: 4 }).toFile(`${out}/${job.id}${variant.suffix}.avif`)
    await pipeline.clone().webp({ quality: 74 }).toFile(`${out}/${job.id}${variant.suffix}.webp`)
    await pipeline.clone().jpeg({ quality: 78, mozjpeg: true }).toFile(`${out}/${job.id}${variant.suffix}.jpg`)
  }
  console.log(`${job.id} ← ${job.src}`)
}
console.log('done')
