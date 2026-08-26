import type { GalleryImage, GalleryManifest } from './imagesource'

export type ViewerMode = 'strip' | 'vertical' | 'single'

export type GallerySettings = {
  title: string
  caption: string
  date: string
  curtainKicker: string
  curtainPrompt: string
  defaultMode: ViewerMode
  defaultShowCaptions: boolean
  defaultShowArrows: boolean
  imageCaptions: Record<string, string>
  imageAlts: Record<string, string>
}

export const settingsStorageKey = (slug: string) => `manorama:gallery-settings:${slug}`

export const defaultGallerySettings = (manifest: GalleryManifest): GallerySettings => ({
  title: manifest.title,
  caption: manifest.caption,
  date: manifest.date,
  curtainKicker: 'A single album',
  curtainPrompt: 'Tap, click, or press Enter to enter',
  defaultMode: 'strip',
  defaultShowCaptions: false,
  defaultShowArrows: false,
  imageCaptions: Object.fromEntries(manifest.images.map((image) => [image.id, image.caption ?? ''])),
  imageAlts: Object.fromEntries(manifest.images.map((image) => [image.id, image.alt])),
})

const text = (value: unknown, fallback: string) => typeof value === 'string' ? value.slice(0, 5000) : fallback
const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback
const mode = (value: unknown, fallback: ViewerMode): ViewerMode => value === 'vertical' || value === 'single' || value === 'strip' ? value : fallback
const record = (value: unknown, fallback: Record<string, string>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, text(entry, fallback[key] ?? '')]))
}

const normalizeWithDefaults = (value: unknown, defaults: GallerySettings): GallerySettings => {
  const candidate = value && typeof value === 'object' ? value as Partial<GallerySettings> : {}
  return {
    title: text(candidate.title, defaults.title),
    caption: text(candidate.caption, defaults.caption),
    date: text(candidate.date, defaults.date),
    curtainKicker: text(candidate.curtainKicker, defaults.curtainKicker),
    curtainPrompt: text(candidate.curtainPrompt, defaults.curtainPrompt),
    defaultMode: mode(candidate.defaultMode, defaults.defaultMode),
    defaultShowCaptions: bool(candidate.defaultShowCaptions, defaults.defaultShowCaptions),
    defaultShowArrows: bool(candidate.defaultShowArrows, defaults.defaultShowArrows),
    imageCaptions: record(candidate.imageCaptions, defaults.imageCaptions),
    imageAlts: record(candidate.imageAlts, defaults.imageAlts),
  }
}

export const normalizeGallerySettings = (value: unknown, manifest: GalleryManifest): GallerySettings => normalizeWithDefaults(value, defaultGallerySettings(manifest))

export const loadGallerySettings = (slug: string, manifest: GalleryManifest): GallerySettings => {
  if (typeof window === 'undefined') return defaultGallerySettings(manifest)
  try {
    const stored = window.localStorage.getItem(settingsStorageKey(slug))
    return stored ? normalizeGallerySettings(JSON.parse(stored), manifest) : defaultGallerySettings(manifest)
  } catch {
    return defaultGallerySettings(manifest)
  }
}

export const loadStoredGallerySettings = (slug: string, fallback: GallerySettings): GallerySettings => {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(settingsStorageKey(slug))
    return stored ? normalizeWithDefaults(JSON.parse(stored), fallback) : fallback
  } catch {
    return fallback
  }
}

export const saveGallerySettings = (slug: string, settings: GallerySettings) => {
  window.localStorage.setItem(settingsStorageKey(slug), JSON.stringify(settings))
}

export const clearGallerySettings = (slug: string) => {
  window.localStorage.removeItem(settingsStorageKey(slug))
}

export const imageWithSettings = (image: GalleryImage, settings: GallerySettings): GalleryImage => ({
  ...image,
  alt: settings.imageAlts[image.id] || image.alt,
  caption: settings.imageCaptions[image.id] || undefined,
})
