/**
 * Generates public/og-logo-pill.png — the Manorama wordmark on a
 * translucent dark pill, composited over the first photo by the OG card
 * route.
 *
 * Why pre-bake: a runtime scrim would need a second transform pass on
 * every card. One flattened PNG reads on any photograph — bright sky or
 * black shadow — and costs nothing at request time.
 *
 * Run: bun scripts/make-og-pill.ts
 */
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const WIDTH = 360
const HEIGHT = 96
const RADIUS = HEIGHT / 2

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const outputPath = `${repoRoot}public/og-logo-pill.png`
const logoPath = `${repoRoot}public/manorama-merged-logo.png`

const pill = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
     <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="${RADIUS}" ry="${RADIUS}"
           fill="rgba(10,10,10,0.62)" />
   </svg>`,
)

const run = async () => {
  // The wordmark sits inside the pill with even optical padding.
  const logo = await sharp(logoPath)
    .resize({ width: WIDTH - 88, height: HEIGHT - 40, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  const logoMeta = await sharp(logo).metadata()

  await sharp(pill)
    .composite([{
      input: logo,
      left: Math.round((WIDTH - (logoMeta.width ?? 0)) / 2),
      top: Math.round((HEIGHT - (logoMeta.height ?? 0)) / 2),
    }])
    .png()
    .toFile(outputPath)

  console.log(`wrote ${outputPath} (${WIDTH}x${HEIGHT})`)
}

await run()
