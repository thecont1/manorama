// Builds the homepage photo-demo renditions from the owner's originals.
//
// The source folder is passed at run time and is never written into the
// repository (the owner's local path must not ship):
//
//   node scripts/home-demo-images.mjs /path/to/originals/ITALY
//
// node only: sharp's native binding hangs under bun in this checkout.
//
// Two renditions per photograph, sized from the demo's own geometry rather
// than guessed: the strip stages every frame at MAX_STRIP_CSS_HEIGHT, so the
// long edge a frame can honestly occupy is that height times the device
// pixel ratio times max(aspect, 1). `lg` covers dpr 2, `sm` covers dpr 1.
// withoutEnlargement keeps a pixel-short source at its own size.
//
// Metadata: GPS and device/personal fields are removed; orientation and the
// source ICC profile are kept; a credit/copyright line is added. Renditions
// carry no Content Credentials (C2PA) — expected for downscaled homepage
// files.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}public/home-demo`
mkdirSync(out, { recursive: true })

const srcDir = process.argv[2]
if (!srcDir) {
  console.error('usage: node scripts/home-demo-images.mjs <originals-dir>')
  process.exit(1)
}

// The demo's tallest staged frame, in CSS pixels (see demo/presets.ts).
const MAX_STRIP_CSS_HEIGHT = 450
const DPR_CAP = 2

// The chosen sequence, in travel order. Opener: the red vintage car.
const SEQUENCE = [
  '0005', '0100', '0060', '0141', '0142', '0145', '0227',
  '0302', '0299', '0285', '0232', '0503', '0470', '0351', '0544',
]

const round10 = (n) => Math.ceil(n / 10) * 10
const report = []

for (const num of SEQUENCE) {
  const file = readdirSync(srcDir).find((f) => f.includes(`Italy${num}.`))
  if (!file) throw new Error(`missing original for ${num}`)
  const input = `${srcDir}/${file}`
  const meta = await sharp(input).metadata()
  const aspect = meta.width / meta.height
  const portrait = aspect < 1
  const longEdge = (dpr) => round10(MAX_STRIP_CSS_HEIGHT * dpr * Math.max(aspect, 1))
  const id = `italy-${num}`

  for (const [suffix, dpr] of [['lg', DPR_CAP], ['sm', 1]]) {
    const edge = longEdge(dpr)
    const resize = portrait ? { height: edge } : { width: edge }
    const pipeline = sharp(input).resize({ ...resize, withoutEnlargement: true }).withMetadata()
    const base = `${out}/${id}-${suffix}`
    await pipeline.clone().avif({ quality: 50, effort: 4 }).toFile(`${base}.avif`)
    await pipeline.clone().webp({ quality: 74 }).toFile(`${base}.webp`)
    await pipeline.clone().jpeg({ quality: 78, mozjpeg: true }).toFile(`${base}.jpg`)
    // Strip location/device/personal fields, keep orientation + ICC, add credit.
    execFileSync('exiftool', [
      '-overwrite_original', '-quiet',
      '-gps:all=', '-exif:SerialNumber=', '-exif:Software=', '-exif:OwnerName=',
      '-xmp:all=',
      '-IFD0:Artist=Mahesh Shantaram',
      '-IFD0:Copyright=Copyright 2026 Mahesh Shantaram. All rights reserved.',
      '-XMP-dc:Creator=Mahesh Shantaram',
      '-XMP-dc:Rights=Copyright 2026 Mahesh Shantaram. All rights reserved.',
      `${base}.avif`, `${base}.webp`, `${base}.jpg`,
    ])
  }

  const lg = await sharp(`${out}/${id}-lg.jpg`).metadata()
  const sm = await sharp(`${out}/${id}-sm.jpg`).metadata()
  report.push({
    id,
    source: file,
    orientation: portrait ? 'portrait' : 'landscape',
    original: { width: meta.width, height: meta.height },
    lg: { width: lg.width, height: lg.height },
    sm: { width: sm.width, height: sm.height },
  })
  console.log(`${id} ${portrait ? 'portrait' : 'landscape'} lg=${lg.width}x${lg.height} sm=${sm.width}x${sm.height}`)
}

console.log(JSON.stringify(report, null, 2))