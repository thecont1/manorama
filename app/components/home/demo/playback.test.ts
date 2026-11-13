import { describe, expect, test } from 'bun:test'
import {
  advancePlayback,
  chromeIsVisible,
  curtainDuration,
  curtainPresentation,
  DEFAULT_SETTINGS,
  initialPlayback,
  MAX_STEP_MS,
  rebasePlayback,
  type PlaybackState,
} from './playback'

const S = DEFAULT_SETTINGS
const BOUNDS = 1200
const STOPS = [0, 400, 900, BOUNDS]

const run = (state: PlaybackState, durationMs: number) => {
  let remaining = durationMs
  let current = state
  while (remaining > 0) {
    const step = Math.min(25, remaining)
    current = advancePlayback(current, step, STOPS, BOUNDS)
    remaining -= step
  }
  return current
}

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)

const travelling = (): PlaybackState => ({
  ...initialPlayback(),
  phase: 'travel',
})

describe('the opening curtain', () => {
  test('holds before travelling and keeps its duration independent of the strip', () => {
    let state = run(initialPlayback(), curtainDuration() - 25)
    expect(state.phase).toBe('curtain')
    expect(state.offset).toBe(0)
    state = run(state, 25)
    expect(state.phase).toBe('travel')
    expect(state.phaseElapsedMs).toBe(0)
    expect(state.offset).toBe(0)
  })

  test('fades the words before thinning the frost', () => {
    expect(curtainPresentation(initialPlayback())).toEqual({ wordsOpacity: 1, veilOpacity: 1 })
    const wordsFading = { ...initialPlayback(), phaseElapsedMs: S.curtainHoldMs + S.curtainWordsMs / 2 }
    near(curtainPresentation(wordsFading).wordsOpacity, 0.5)
    expect(curtainPresentation(wordsFading).veilOpacity).toBe(1)
    const veilFading = {
      ...initialPlayback(),
      phaseElapsedMs: S.curtainHoldMs + S.curtainWordsMs + S.curtainVeilMs / 2,
    }
    expect(curtainPresentation(veilFading).wordsOpacity).toBe(0)
    near(curtainPresentation(veilFading).veilOpacity, 0.5)
    expect(curtainPresentation(travelling())).toEqual({ wordsOpacity: 0, veilOpacity: 0 })
  })
})

describe('stroke-and-rest playback', () => {
  test('holds at the opening photograph before the first stroke', () => {
    let state = run(travelling(), S.holdStartMs - 25)
    expect(state.mode).toBe('rest')
    expect(state.offset).toBe(0)
    state = run(state, 25)
    expect(state.mode).toBe('stroke')
    expect(state.target).toBe(400)
    expect(state.direction).toBe(1)
  })

  test('eases into the next rest point and stays there', () => {
    let state = run(travelling(), S.holdStartMs)
    state = run(state, S.strokeMs / 2)
    near(state.offset, 375)
    expect(state.mode).toBe('stroke')
    state = run(state, S.strokeMs / 2)
    expect(state.mode).toBe('rest')
    expect(state.offset).toBe(400)
    state = run(state, S.restMs / 2)
    expect(state.offset).toBe(400)
    expect(state.mode).toBe('rest')
  })

  test('travels out, holds on the end card, rewinds directly, and starts over', () => {
    let state = run(travelling(), S.holdStartMs)
    for (const target of [400, 900, BOUNDS]) {
      expect(state.target).toBe(target)
      expect(state.direction).toBe(1)
      state = run(state, S.strokeMs)
      expect(state.offset).toBe(target)
      if (target !== BOUNDS) {
        expect(state.phase).toBe('travel')
        expect(state.mode).toBe('rest')
        state = run(state, S.restMs)
      }
    }

    expect(state.phase).toBe('end')
    expect(state.mode).toBe('rest')
    state = run(state, S.holdEndMs)
    expect(state.phase).toBe('rewind')
    expect(state.direction).toBe(-1)
    expect(state.mode).toBe('stroke')
    expect(state.from).toBe(BOUNDS)
    expect(state.target).toBe(0)
    state = run(state, S.rewindMs / 2)
    expect(state.phase).toBe('rewind')
    expect(state.offset).toBeGreaterThan(0)
    expect(state.offset).toBeLessThan(BOUNDS)
    state = run(state, S.rewindMs / 2)
    expect(state.phase).toBe('curtain')
    expect(state.direction).toBe(1)
    expect(state.offset).toBe(0)
    state = run(state, curtainDuration() + S.holdStartMs)
    expect(state.phase).toBe('travel')
    expect(state.mode).toBe('stroke')
    expect(state.target).toBe(400)
  })

  test('zero travel and a zero-duration frame leave the opening state unchanged', () => {
    const initial = initialPlayback()
    expect(advancePlayback(initial, 0, STOPS, BOUNDS)).toEqual(initial)
    expect(advancePlayback(initial, S.holdStartMs, [0], 0)).toEqual(initial)
  })

  test('a hidden-tab gap advances by at most one clamped step', () => {
    const resting = advancePlayback(travelling(), 5000, STOPS, BOUNDS)
    expect(resting.elapsedMs).toBe(MAX_STEP_MS)
    expect(resting.offset).toBe(0)

    const moving: PlaybackState = {
      ...travelling(),
      mode: 'stroke',
      offset: 0,
      from: 0,
      target: 400,
      direction: 1,
      elapsedMs: 0,
    }
    const advanced = advancePlayback(moving, 5000, STOPS, BOUNDS)
    expect(advanced.elapsedMs).toBe(MAX_STEP_MS)
    expect(advanced.offset).toBeGreaterThan(0)
    expect(advanced.offset).toBeLessThan(400)
  })
})

describe('temporary chrome', () => {
  test('appears for the opening travel, recedes, and returns on the end card', () => {
    expect(chromeIsVisible(initialPlayback(), false)).toBe(false)
    expect(chromeIsVisible(travelling(), false)).toBe(true)
    expect(chromeIsVisible({ ...travelling(), phaseElapsedMs: S.chromeVisibleMs }, false)).toBe(false)
    expect(chromeIsVisible({ ...travelling(), phase: 'end' }, false)).toBe(true)
    expect(chromeIsVisible({ ...travelling(), phase: 'rewind' }, false)).toBe(true)
  })

  test('stays visible throughout reduced motion', () => {
    expect(chromeIsVisible(initialPlayback(), true)).toBe(true)
    expect(chromeIsVisible({ ...travelling(), phaseElapsedMs: 10000 }, true)).toBe(true)
  })
})

describe('playback rebasing', () => {
  test('a backward stroke targets the preceding new stop without a position jump', () => {
    const state: PlaybackState = {
      ...travelling(),
      mode: 'stroke',
      offset: 850,
      from: 900,
      target: 400,
      direction: -1,
      elapsedMs: 500,
    }
    const rebased = rebasePlayback(state, 650, [0, 300, 600, 1000])
    expect(rebased).toEqual({
      ...state,
      offset: 650,
      from: 650,
      target: 600,
      elapsedMs: 0,
    })
  })

  test('a backward stroke rebased before the first stop becomes a rest', () => {
    const state: PlaybackState = {
      ...travelling(),
      mode: 'stroke',
      offset: 100,
      from: 400,
      target: 0,
      direction: -1,
      elapsedMs: 500,
    }
    const rebased = rebasePlayback(state, 0, STOPS)
    expect(rebased.mode).toBe('rest')
    expect(rebased.offset).toBe(0)
    expect(rebased.target).toBe(0)
    expect(rebased.elapsedMs).toBe(0)
  })

  test('a rewind keeps its destination across a relayout', () => {
    const state: PlaybackState = {
      ...travelling(),
      phase: 'rewind',
      mode: 'stroke',
      offset: 900,
      from: BOUNDS,
      target: 0,
      direction: -1,
      elapsedMs: 300,
    }
    const rebased = rebasePlayback(state, 650, STOPS)
    expect(rebased).toEqual({ ...state, offset: 650, from: 650, elapsedMs: 0 })
    expect(run(rebased, S.rewindMs).phase).toBe('curtain')
  })

  test('a rest preserves its direction and elapsed hold across a relayout', () => {
    const state: PlaybackState = {
      ...travelling(),
      mode: 'rest',
      offset: 900,
      from: 900,
      target: 900,
      direction: -1,
      elapsedMs: 300,
    }
    const rebased = rebasePlayback(state, 650, [0, 300, 600, 1000])
    expect(rebased).toEqual({
      ...state,
      offset: 650,
      from: 650,
      target: 650,
    })
  })
})
