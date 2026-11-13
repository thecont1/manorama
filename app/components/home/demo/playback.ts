export type PlaybackSettings = {
  curtainHoldMs: number
  curtainWordsMs: number
  curtainVeilMs: number
  chromeVisibleMs: number
  strokeMs: number
  restMs: number
  holdEndMs: number
  rewindMs: number
  holdStartMs: number
}

export const DEFAULT_SETTINGS: PlaybackSettings = {
  curtainHoldMs: 1200,
  curtainWordsMs: 350,
  curtainVeilMs: 1100,
  chromeVisibleMs: 3000,
  strokeMs: 1600,
  restMs: 700,
  holdEndMs: 2400,
  rewindMs: 750,
  holdStartMs: 1000,
}