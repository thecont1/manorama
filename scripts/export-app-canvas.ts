import { writeFile } from 'node:fs/promises'
import { APP_CANVAS_INKS, appCanvasSvg, type AppCanvasPalette } from '../app/lib/app-canvas'

/* Run with bun scripts/export-app-canvas.ts. Output is committed vector
   artwork, not photographs or generated device thumbnails. */
for (const palette of Object.keys(APP_CANVAS_INKS) as AppCanvasPalette[]) {
  await writeFile(new URL(`../public/app-canvas-${palette}.svg`, import.meta.url), appCanvasSvg(palette))
}
