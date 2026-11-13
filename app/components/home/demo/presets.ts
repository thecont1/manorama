/**
 * The demo's screen shapes, as data.
 *
 * Each preset is a logical viewport plus a restrained frame style. The frame
 * suggests a shape without faking a device: no logos, notches, status bars or
 * glow. A Duo preset can be added here later without touching the renderer;
 * it would need a hinge axis, two segment rectangles and a rule for which
 * photograph spans the fold (see the report).
 */

export type DemoPresetId = 'desktop' | 'phone' | 'tablet'

export type DemoPreset = {
  id: DemoPresetId
  label: string
  /** The simulated screen's logical pixel size. */
  logical: { width: number; height: number }
  /** Frame bezel thickness in CSS px, drawn inside the logical box. */
  bezel: number
  /** Frame corner radius in CSS px. Photographs keep square corners. */
  radius: number
}

export const DEMO_PRESETS: DemoPreset[] = [
  { id: 'desktop', label: 'Desktop', logical: { width: 1440, height: 900 }, bezel: 10, radius: 6 },
  { id: 'phone', label: 'Phone', logical: { width: 390, height: 844 }, bezel: 10, radius: 22 },
  // Portrait: a tablet held for reading is the middle composition between the
  // wide desktop strip and the narrow phone strip.
  { id: 'tablet', label: 'Tablet', logical: { width: 820, height: 1180 }, bezel: 12, radius: 14 },
]

export const demoPresetById = (id: DemoPresetId) =>
  DEMO_PRESETS.find((p) => p.id === id) ?? DEMO_PRESETS[0]!

/**
 * The reserved outer stage. Its aspect and max width are constant across
 * presets and across enhancement, so the surrounding page never shifts when
 * the demo loads or the shape changes; only the frame inside changes shape.
 * 16:10 matches the desktop preset, so the wide frame fills the stage while
 * the height stays at 450px — the ceiling the renditions were sized against.
 */
export const DEMO_STAGE = { aspect: 16 / 10, maxWidth: 720 }

/** The tallest staged frame the renditions were sized against (CSS px). */
export const MAX_STRIP_CSS_HEIGHT = 450