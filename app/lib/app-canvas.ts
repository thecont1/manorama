import ground from '../assets/gallery-ground'

/* Stronger inks distinguish the photographic texture without changing the
   approved geometry. These are decorative backgrounds, never provider media. */
export const APP_CANVAS_INKS = { dark: '#484848', light: '#aaa59b' } as const
export type AppCanvasPalette = keyof typeof APP_CANVAS_INKS

export function appCanvasSvg(palette: AppCanvasPalette): string {
  const size = 256
  const scale = size / ground.width
  const groups = ground.groups.map(group =>
    `<g data-gallery-ground-motif="${group.motifId}" data-gallery-ground-placement="${group.placementId}">${group.paths.map(d => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${ground.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</g>`,
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" shape-rendering="geometricPrecision" color="${APP_CANVAS_INKS[palette]}" data-doodle-artwork="${ground.artworkId}" data-doodle-count="${ground.placementCount}"><defs><pattern id="app-canvas" width="${size}" height="${ground.height * scale}" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" overflow="hidden"><g data-gallery-ground-scale="${scale}" transform="scale(${scale})">${groups}</g></pattern></defs><rect width="100%" height="100%" fill="url(#app-canvas)"/></svg>\n`
}
