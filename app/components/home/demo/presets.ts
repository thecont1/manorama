export type DemoPresetId = 'desktop' | 'phone' | 'tablet'

export type DemoPreset = {
  id: DemoPresetId
  label: string
  screen: { width: number; height: number }
  bezel: number
  radius: number
  baseHeight: number
  baseOverhang: number
}

export const DEMO_PRESETS: DemoPreset[] = [
  {
    id: 'desktop',
    label: 'Desktop',
    screen: { width: 1440, height: 900 },
    bezel: 12,
    radius: 18,
    baseHeight: 26,
    baseOverhang: 56,
  },
  {
    id: 'phone',
    label: 'Phone',
    screen: { width: 390, height: 844 },
    bezel: 10,
    radius: 48,
    baseHeight: 0,
    baseOverhang: 0,
  },
  {
    id: 'tablet',
    label: 'Tablet',
    screen: { width: 768, height: 1024 },
    bezel: 14,
    radius: 32,
    baseHeight: 0,
    baseOverhang: 0,
  },
]

export const demoPresetById = (id: DemoPresetId) =>
  DEMO_PRESETS.find((p) => p.id === id) ?? DEMO_PRESETS[0]!

export const deviceFrameSize = (preset: DemoPreset) => ({
  width: preset.screen.width + preset.bezel * 2 + preset.baseOverhang * 2,
  height: preset.screen.height + preset.bezel * 2 + preset.baseHeight,
})

export const fitDeviceFrame = (
  preset: DemoPreset,
  available: { width: number; height: number },
) => {
  const frame = deviceFrameSize(preset)
  const scale = Math.max(0, Math.min(
    1,
    available.width > 0 ? available.width / frame.width : 0,
    available.height > 0 ? available.height / frame.height : 0,
  ))
  return { scale, width: frame.width * scale, height: frame.height * scale }
}
