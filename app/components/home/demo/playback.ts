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

export const MAX_STEP_MS = 100
export const curtainDuration = (settings: PlaybackSettings = DEFAULT_SETTINGS) =>
  settings.curtainHoldMs + settings.curtainWordsMs + settings.curtainVeilMs

export type PlaybackState = {
  phase: 'curtain' | 'travel' | 'end' | 'rewind'
  phaseElapsedMs: number
  mode: 'stroke' | 'rest'
  offset: number
  from: number
  target: number
  direction: 1 | -1
  elapsedMs: number
}

export const initialPlayback = (): PlaybackState => ({
  phase: 'curtain',
  phaseElapsedMs: 0,
  mode: 'rest',
  offset: 0,
  from: 0,
  target: 0,
  direction: 1,
  elapsedMs: 0,
})

const nextTarget = (offset: number, direction: 1 | -1, stops: number[]) => {
  const epsilon = 0.5
  return direction === 1
    ? stops.find((stop) => stop > offset + epsilon) ?? null
    : [...stops].reverse().find((stop) => stop < offset - epsilon) ?? null
}

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
const progress = (elapsed: number, duration: number) =>
  duration <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / duration))

export const curtainPresentation = (
  state: PlaybackState,
  settings: PlaybackSettings = DEFAULT_SETTINGS,
) => {
  if (state.phase !== 'curtain') return { wordsOpacity: 0, veilOpacity: 0 }
  const wordsElapsed = state.phaseElapsedMs - settings.curtainHoldMs
  const veilElapsed = wordsElapsed - settings.curtainWordsMs
  return {
    wordsOpacity: 1 - progress(wordsElapsed, settings.curtainWordsMs),
    veilOpacity: 1 - progress(veilElapsed, settings.curtainVeilMs),
  }
}

export const chromeIsVisible = (
  state: PlaybackState,
  reducedMotion: boolean,
  settings: PlaybackSettings = DEFAULT_SETTINGS,
) => reducedMotion || state.phase === 'end' || state.phase === 'rewind' ||
  (state.phase === 'travel' && state.phaseElapsedMs < settings.chromeVisibleMs)

export const rebasePlayback = (
  state: PlaybackState,
  offset: number,
  stops: number[],
): PlaybackState => {
  if (state.phase === 'rewind') {
    return { ...state, offset, from: offset, target: 0, elapsedMs: 0 }
  }
  if (state.phase !== 'travel' || state.mode === 'rest') {
    return { ...state, offset, from: offset, target: offset }
  }
  const target = nextTarget(offset, state.direction, stops)
  return target === null
    ? { ...state, mode: 'rest', offset, from: offset, target: offset, elapsedMs: 0 }
    : { ...state, offset, from: offset, target, elapsedMs: 0 }
}

export const advancePlayback = (
  state: PlaybackState,
  dtMs: number,
  stops: number[],
  bounds: number,
  settings: PlaybackSettings = DEFAULT_SETTINGS,
): PlaybackState => {
  const dt = Math.min(Math.max(0, dtMs), MAX_STEP_MS)
  if (bounds <= 0 || stops.length < 2) return { ...state, offset: 0, from: 0, target: 0 }

  if (state.phase === 'curtain') {
    const phaseElapsedMs = state.phaseElapsedMs + dt
    if (phaseElapsedMs < curtainDuration(settings)) return { ...state, phaseElapsedMs }
    return { ...state, phase: 'travel', phaseElapsedMs: 0, elapsedMs: 0 }
  }

  if (state.phase === 'end') {
    const phaseElapsedMs = state.phaseElapsedMs + dt
    if (phaseElapsedMs < settings.holdEndMs) return { ...state, phaseElapsedMs }
    return {
      ...state,
      phase: 'rewind',
      phaseElapsedMs: 0,
      mode: 'stroke',
      offset: bounds,
      from: bounds,
      target: 0,
      direction: -1,
      elapsedMs: 0,
    }
  }

  if (state.phase === 'rewind') {
    const phaseElapsedMs = state.phaseElapsedMs + dt
    const elapsedMs = state.elapsedMs + dt
    const t = progress(elapsedMs, settings.rewindMs)
    const offset = state.from * (1 - easeInOutCubic(t))
    if (t < 1) return { ...state, phaseElapsedMs, elapsedMs, offset }
    return {
      ...state,
      phase: 'curtain',
      phaseElapsedMs: 0,
      mode: 'rest',
      offset: 0,
      from: 0,
      target: 0,
      direction: 1,
      elapsedMs: 0,
    }
  }

  const phaseElapsedMs = state.phaseElapsedMs + dt
  const travelling = { ...state, phaseElapsedMs }

  if (state.mode === 'stroke') {
    const elapsedMs = state.elapsedMs + dt
    const t = Math.min(1, elapsedMs / settings.strokeMs)
    const offset = state.from + (state.target - state.from) * easeOutQuart(t)
    if (t < 1) return { ...travelling, elapsedMs, offset }
    if (state.direction === 1 && state.target >= bounds) {
      return {
        ...travelling,
        phase: 'end',
        phaseElapsedMs: 0,
        mode: 'rest',
        offset: bounds,
        from: bounds,
        target: bounds,
        elapsedMs: 0,
      }
    }
    if (state.direction === -1 && state.target <= 0) {
      return {
        ...travelling,
        phase: 'curtain',
        phaseElapsedMs: 0,
        mode: 'rest',
        offset: 0,
        from: 0,
        target: 0,
        direction: 1,
        elapsedMs: 0,
      }
    }
    return {
      ...travelling,
      mode: 'rest',
      offset: state.target,
      from: state.target,
      elapsedMs: 0,
    }
  }

  const atStart = state.offset <= 0
  const holdMs = atStart && state.direction === 1 ? settings.holdStartMs : settings.restMs
  const elapsedMs = state.elapsedMs + dt
  if (elapsedMs < holdMs) return { ...travelling, elapsedMs }

  const target = nextTarget(state.offset, state.direction, stops)
  if (target === null) {
    if (state.direction === 1) {
      return { ...travelling, phase: 'end', phaseElapsedMs: 0, elapsedMs: 0 }
    }
    return {
      ...travelling,
      phase: 'curtain',
      phaseElapsedMs: 0,
      direction: 1,
      elapsedMs: 0,
    }
  }
  return {
    ...travelling,
    mode: 'stroke',
    offset: state.offset,
    from: state.offset,
    target,
    elapsedMs: 0,
  }
}
