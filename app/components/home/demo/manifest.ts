/**
 * The homepage photo demo's sample gallery.
 *
 * Photographs by Mahesh Shantaram, from his Italy originals. The owner took
 * these photographs and gave permission to publish them on the Manorama
 * homepage on 13 November 2026 (APPROVAL below). Renditions are produced by
 * `scripts/home-demo-images.mjs`; the sizes here are the measured output of
 * that script, not guesses.
 *
 * Two renditions per photograph: `lg` covers a device pixel ratio of 2 at the
 * demo's tallest staged frame, `sm` covers dpr 1. Both preserve orientation
 * and aspect exactly and are never enlarged past their own pixels.
 */

export const APPROVAL =
  'Photograph by Mahesh Shantaram. The owner took these photographs and gave ' +
  'permission to publish them on the Manorama homepage on 13 November 2026.'

export type DemoOrientation = 'portrait' | 'landscape'

export type DemoRendition = { width: number; height: number }

export type DemoPhoto = {
  id: string
  /** Plain description of what is in the frame, written from looking at it. */
  alt: string
  orientation: DemoOrientation
  /** The original's intrinsic pixels, for the record. */
  original: DemoRendition
  lg: DemoRendition
  sm: DemoRendition
  approval: string
}

const photo = (
  id: string,
  alt: string,
  orientation: DemoOrientation,
  original: DemoRendition,
  lg: DemoRendition,
  sm: DemoRendition,
): DemoPhoto => ({ id, alt, orientation, original, lg, sm, approval: APPROVAL })

/** Travel order. Opens on the red vintage car; closes on the red train. */
export const DEMO_PHOTOS: DemoPhoto[] = [
  photo('italy-0005', 'A red vintage coupe parked on a city street beside older cars, with people standing nearby', 'landscape', { width: 2560, height: 1707 }, { width: 2560, height: 1707 }, { width: 1540, height: 1027 }),
  photo('italy-0100', 'Two women posing in front of the Leaning Tower of Pisa on a busy lawn', 'landscape', { width: 1974, height: 1580 }, { width: 1974, height: 1580 }, { width: 1280, height: 1025 }),
  photo('italy-0060', 'A calm river beside a stone embankment, with a small Gothic church and a lamp post under a pale sky', 'landscape', { width: 2560, height: 1440 }, { width: 2560, height: 1440 }, { width: 1830, height: 1029 }),
  photo('italy-0141', 'Laundry hanging on a line against a pink house built into a rock cliff above the sea', 'landscape', { width: 2560, height: 1707 }, { width: 2560, height: 1707 }, { width: 1540, height: 1027 }),
  photo('italy-0142', 'A harbour village of stacked coloured houses on rocks beside a small bay', 'landscape', { width: 2506, height: 1671 }, { width: 2506, height: 1671 }, { width: 1540, height: 1027 }),
  photo('italy-0145', 'A footpath along a green coastal cliff with the sea below and a headland ahead', 'landscape', { width: 2491, height: 1661 }, { width: 2491, height: 1661 }, { width: 1540, height: 1027 }),
  photo('italy-0227', 'A hillside village of coloured houses above the sea at sunset', 'landscape', { width: 2342, height: 1635 }, { width: 2342, height: 1635 }, { width: 1470, height: 1026 }),
  photo('italy-0302', 'The marble facade of a cathedral rising above outdoor cafe tables and a seated crowd', 'portrait', { width: 1707, height: 2560 }, { width: 1367, height: 2050 }, { width: 687, height: 1030 }),
  photo('italy-0299', 'A striped marble baptistery and bell tower against a blue sky with large white clouds', 'landscape', { width: 2405, height: 1707 }, { width: 2405, height: 1707 }, { width: 1450, height: 1029 }),
  photo('italy-0285', 'A city panorama at dusk with a river, bridges and a tall tower among rooftops', 'landscape', { width: 2502, height: 1668 }, { width: 2502, height: 1668 }, { width: 1540, height: 1027 }),
  photo('italy-0232', 'A child seated at a table with a patterned cloth in a plainly furnished room, beside a shuttered window', 'landscape', { width: 2133, height: 1707 }, { width: 2133, height: 1707 }, { width: 1280, height: 1024 }),
  photo('italy-0503', 'A tall golden lattice pavilion standing on a lawn, with a person at its base', 'portrait', { width: 1707, height: 2560 }, { width: 1367, height: 2050 }, { width: 687, height: 1030 }),
  photo('italy-0470', 'Gondolas moored at wooden posts on a wide lagoon, with an island church across the water', 'landscape', { width: 2560, height: 1707 }, { width: 2560, height: 1707 }, { width: 1540, height: 1027 }),
  photo('italy-0351', 'Lit windows of waterside buildings reflected in dark water at night', 'landscape', { width: 2240, height: 1680 }, { width: 2240, height: 1680 }, { width: 1370, height: 1028 }),
  photo('italy-0544', 'A red high-speed train at a station platform seen from under a canopy, beside a teal train', 'landscape', { width: 2276, height: 1707 }, { width: 2276, height: 1707 }, { width: 1370, height: 1028 }),
]

/** Book order: the two portraits open the show, then landscapes keep their
 *  gallery order. Every adjacent spread is same-orientation. */
export const DEMO_DUO_PHOTOS: DemoPhoto[] = [
  ...DEMO_PHOTOS.filter((photo) => photo.orientation === 'portrait'),
  ...DEMO_PHOTOS.filter((photo) => photo.orientation === 'landscape'),
]

export type DemoRenditionSize = 'lg' | 'sm'
export type DemoFormat = 'avif' | 'webp' | 'jpg'

export const demoRenditionPath = (id: string, size: DemoRenditionSize, format: DemoFormat) =>
  `/home-demo/${id}-${size}.${format}`

export const demoPhotoById = (id: string) => DEMO_PHOTOS.find((p) => p.id === id)