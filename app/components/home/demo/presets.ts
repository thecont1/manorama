export type DemoPresetId = 'desktop' | 'phone' | 'tablet' | 'duo'

export const IPAD_ORIENTATION = 'portrait' as const

// A drawing constant for the simulated book pose, not a report of UIKit's
// reserved region: that region is zero while the physical device is flat.
export const DUO_HINGE_WIDTH = 40
const DUO_BODY_RATIO = 164.6 / 117.8
const DUO_BEZEL = (951 * 0.04) / (1 - 0.08)
const DUO_BODY_WIDTH = 951 + DUO_BEZEL * 2
const DUO_BEZEL_Y = (DUO_BODY_WIDTH / DUO_BODY_RATIO - 669) / 2

export type DemoPreset = {
  id: DemoPresetId
  label: string
  model: string
  screen: { width: number; height: number }
  bezel: number
  bezelY?: number
  rim: number
  bodyRadius: number
  screenRadius: number
  chromeTop: number
  viewerInset: { top: number; right: number; bottom: number; left: number }
  orientation?: typeof IPAD_ORIENTATION
  notch?: { width: number; height: number }
  island?: { width: number; height: number; top: number }
  baseHeight: number
  baseOverhang: number
}

export const DEMO_PRESETS: DemoPreset[] = [
  {
    id: 'desktop',
    label: 'Desktop',
    model: 'MacBook Pro 14-inch',
    screen: { width: 1512, height: 982 },
    bezel: 26,
    rim: 5,
    bodyRadius: 24,
    screenRadius: 12,
    chromeTop: 8,
    viewerInset: { top: 36, right: 0, bottom: 0, left: 0 },
    notch: { width: 180, height: 36 },
    baseHeight: 30,
    baseOverhang: 0,
  },
  {
    id: 'phone',
    label: 'Mobile',
    model: 'iPhone 17 Pro',
    screen: { width: 402, height: 874 },
    bezel: 16.064,
    rim: 4,
    bodyRadius: 65.119,
    screenRadius: 49.056,
    chromeTop: 60,
    viewerInset: { top: 0, right: 0, bottom: 0, left: 0 },
    island: { width: 121.555, height: 35.598, top: 10.853 },
    baseHeight: 0,
    baseOverhang: 0,
  },
  {
    id: 'tablet',
    label: 'Tablet',
    model: 'iPad Pro 11-inch (M5)',
    screen: { width: 834, height: 1210 },
    bezel: 44,
    rim: 7.38,
    bodyRadius: 65,
    screenRadius: 23,
    chromeTop: 16,
    viewerInset: { top: 0, right: 0, bottom: 0, left: 0 },
    orientation: IPAD_ORIENTATION,
    baseHeight: 0,
    baseOverhang: 0,
  },
  {
    id: 'duo',
    label: 'Foldable',
    model: 'iPhone Duo',
    screen: { width: 951, height: 669 },
    bezel: DUO_BEZEL,
    bezelY: DUO_BEZEL_Y,
    rim: 5,
    bodyRadius: 76,
    screenRadius: 60,
    chromeTop: 24,
    viewerInset: { top: 0, right: 0, bottom: 0, left: 0 },
    baseHeight: 0,
    baseOverhang: 0,
  },
]

export const demoPresetById = (id: DemoPresetId) =>
  DEMO_PRESETS.find((p) => p.id === id) ?? DEMO_PRESETS[0]!

export const deviceViewerSize = (preset: DemoPreset) => ({
  width: preset.screen.width - preset.viewerInset.left - preset.viewerInset.right,
  height: preset.screen.height - preset.viewerInset.top - preset.viewerInset.bottom,
})

export const deviceFrameSize = (preset: DemoPreset) => ({
  width: preset.screen.width + preset.bezel * 2 + preset.baseOverhang * 2,
  height: preset.screen.height + (preset.bezelY ?? preset.bezel) * 2 + preset.baseHeight,
})

export const fitDeviceFrame = (
  preset: DemoPreset,
  available: { width: number; height: number },
  maxScale = 1,
) => {
  const frame = deviceFrameSize(preset)
  const scale = Math.max(0, Math.min(
    maxScale,
    available.width > 0 ? available.width / frame.width : 0,
    available.height > 0 ? available.height / frame.height : 0,
  ))
  return { scale, width: frame.width * scale, height: frame.height * scale }
}
