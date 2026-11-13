export type DemoPresetId = 'desktop' | 'phone' | 'tablet'

export type DemoPreset = {
  id: DemoPresetId
  label: string
  model: string
  screen: { width: number; height: number }
  bezel: number
  bodyRadius: number
  screenRadius: number
  viewerInset: { top: number; right: number; bottom: number; left: number }
  notch?: { width: number; height: number }
  island?: { width: number; height: number }
  homeIndicator?: { width: number; height: number; bottom: number }
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
    bodyRadius: 24,
    screenRadius: 12,
    viewerInset: { top: 36, right: 0, bottom: 0, left: 0 },
    notch: { width: 180, height: 36 },
    baseHeight: 30,
    baseOverhang: 0,
  },
  {
    id: 'phone',
    label: 'Phone',
    model: 'iPhone 17 Pro',
    screen: { width: 874, height: 402 },
    bezel: 15,
    bodyRadius: 70,
    screenRadius: 54,
    viewerInset: { top: 0, right: 0, bottom: 20, left: 48 },
    island: { width: 30, height: 126 },
    homeIndicator: { width: 136, height: 5, bottom: 7 },
    baseHeight: 0,
    baseOverhang: 0,
  },
  {
    id: 'tablet',
    label: 'Tablet',
    model: 'iPad Pro 11-inch (M5)',
    screen: { width: 834, height: 1210 },
    bezel: 44,
    bodyRadius: 48,
    screenRadius: 30,
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
  height: preset.screen.height + preset.bezel * 2 + preset.baseHeight,
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
