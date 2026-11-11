// Converts the selected product captures into the formats the homepage
// serves: AVIF, WebP and a JPEG fallback, at the capture's own size and
// (for the phone and tablet pictures) at half size for narrow screens.
//
// Run it from the repository root with node — sharp's native binding hangs
// under bun in this checkout:
//
//   node scripts/home-images.mjs
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const root = new URL('..', import.meta.url).pathname
const out = `${root}public/home`
mkdirSync(out, { recursive: true })

const jobs = [
  { id: 'h1-viewer', src: 'demo-captures/macos/03-first-image-hover.png', width: 1440 },
  { id: 'h2-matrix', src: 'demo-captures/ios/06-global-view.png', width: 1284, half: 642 },
  { id: 'h3-iphone', src: 'demo-captures/ios/03-first-image-hover.png', width: 1284, half: 642 },
  { id: 'h4-macos-curtain', src: 'demo-captures/macos/02-gallery-curtain.png', width: 1440 },
  { id: 'h5-ipad', src: 'demo-captures/ipad/03-first-image-hover.png', width: 2752, half: 1376 },
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
