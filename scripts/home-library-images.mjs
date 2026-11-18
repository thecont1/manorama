// Publishes the four Library captures — dark, quiet and dark, quiet and
// light, light — to the homepage.
//
// The captures are 3456×2168, which is a 1728×1084 window at 2×, and the
// band's canvas is drawn at that logical size. So the file that goes out
// has to be 3456 wide: at 2× the canvas asks the device for 3456 pixels
// and the file is the one that answers, with nothing resampled in
// between. This script never resizes — that is checked, not assumed.
//
// The format is WebP, lossless. The captures carry an sRGB profile and a
// cICP chunk that declares BT.2020 primaries at the same time, and a
// *lossless* re-encode of them as PNG is not lossless in practice:
// measured, 88% of the pixels moved, by as much as 163 levels. WebP's
// lossless path does not have that problem — the pixels come out
// identical, and the file is about half the capture's weight.
//
// The profile, the EXIF and the XMP ride along inside the file; only the
// bytes of the picture are re-encoded, and losslessly.
//
// Run it from the repository root:
//
//   node scripts/home-library-images.mjs
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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

const WIDTH = 3456
const HEIGHT = 2168

for (const job of jobs) {
  const input = `${root}${job.src}`

  // No resize anywhere: the picture is written at the capture's own size.
  const buffer = await sharp(input)
    .webp({ lossless: true, effort: 6 })
    .withMetadata()
    .toBuffer()

  const written = await sharp(buffer).metadata()
  if (written.width !== WIDTH || written.height !== HEIGHT) {
    throw new Error(
      `${job.id}: wrote ${written.width}×${written.height}, expected ${WIDTH}×${HEIGHT} — the capture must not be resized`,
    )
  }

  // The bytes go down verbatim. Writing them back through sharp would
  // decode and re-encode the file — and a lossless WebP re-encoded by
  // sharp's defaults comes out lossy and a fifth of the size, which is
  // exactly the thing this file exists to prevent.
  await writeFile(`${out}/${job.id}.webp`, buffer)

  console.log(
    `${job.id}.webp ← ${job.src}  ${written.width}×${written.height}  ${(buffer.length / 1048576).toFixed(2)} MB` +
      `  icc ${written.icc ? written.icc.length : 0}  exif ${written.exif ? written.exif.length : 0}  xmp ${written.xmp ? written.xmp.length : 0}`,
  )
}

console.log('done')
