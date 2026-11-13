import { describe, expect, test } from 'bun:test'
import {
  advanceElapsed,
  cyclePeriod,
  cycleState,
  DEFAULT_SETTINGS,
  legDuration,
  legOffset,
  MAX_STEP_MS,
} from './playback'

const S = DEFAULT_SETTINGS
const BOUNDS = 1200
const T = legDuration(BOUNDS, S)
const HOLD_END = S.holdEndMs / 1000
const HOLD_START = S.holdStartMs / 1000

const near = (actual: number, expected: number, tol = 1e-6) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol)

describe('legOffset easing', () => {
  test('starts at zero and ends at the bounds', () => {
    expect(legOffset(0, BOUNDS, S)).toBe(0)
    expect(legOffset(T, BOUNDS, S)).toBe(BOUNDS)
  })

  test('eases into the endpoints: slower at the ends than in the middle', () => {
    const dt = 0.05
    const startSpeed = (legOffset(dt, BOUNDS, S) - legOffset(0, BOUNDS, S)) / dt
    const midSpeed = (legOffset(T / 2 + dt, BOUNDS, S) - legOffset(T / 2, BOUNDS, S)) / dt
    const endSpeed = (legOffset(T, BOUNDS, S) - legOffset(T - dt, BOUNDS, S)) / dt
    expect(startSpeed).toBeLessThan(midSpeed)
    expect(endSpeed).toBeLessThan(midSpeed)
    near(midSpeed, S.speed, 0.5)
  })

  test('is monotonic and continuous across the leg', () => {
    let prev = -1
    for (let t = 0; t <= T; t += T / 200) {
      const offset = legOffset(t, BOUNDS, S)
      expect(offset).toBeGreaterThanOrEqual(prev)
      expect(offset).toBeLessThanOrEqual(BOUNDS)
      prev = offset
    }
  })

  test('a short strip that cannot reach cruise still eases smoothly', () => {
    const small = 10 // < speed * easeSec
    const tSmall = legDuration(small, S)
    expect(legOffset(0, small, S)).toBe(0)
    expect(legOffset(tSmall, small, S)).toBe(small)
    near(legOffset(tSmall / 2, small, S), small / 2, 1e-5)
  })

  test('zero bounds never animates empty space', () => {
    expect(legOffset(1, 0, S)).toBe(0)
    expect(cycleState(5, 0, S)).toEqual({ phase: 'holdStart', offset: 0, direction: 1 })
  })
})

describe('the out-and-back cycle', () => {
  test('phases run forward, hold at end, backward, hold at start', () => {
    expect(cycleState(0, BOUNDS, S).phase).toBe('forward')
    expect(cycleState(T / 2, BOUNDS, S).phase).toBe('forward')
    expect(cycleState(T + HOLD_END / 2, BOUNDS, S).phase).toBe('holdEnd')
    expect(cycleState(T + HOLD_END + T / 2, BOUNDS, S).phase).toBe('backward')
    expect(cycleState(2 * T + HOLD_END + HOLD_START / 2, BOUNDS, S).phase).toBe('holdStart')
  })

  test('holds keep the offset pinned at the ends', () => {
    expect(cycleState(T + 0.01, BOUNDS, S).offset).toBe(BOUNDS)
    expect(cycleState(T + HOLD_END - 0.01, BOUNDS, S).offset).toBe(BOUNDS)
    expect(cycleState(2 * T + HOLD_END + 0.01, BOUNDS, S).offset).toBe(0)
    expect(cycleState(cyclePeriod(BOUNDS, S) - 0.01, BOUNDS, S).offset).toBe(0)
  })

  test('forward travels out, backward travels home, direction flips', () => {
    const a = cycleState(T * 0.25, BOUNDS, S)
    const b = cycleState(T * 0.75, BOUNDS, S)
    expect(b.offset).toBeGreaterThan(a.offset)
    expect(a.direction).toBe(1)
    const c = cycleState(T + HOLD_END + T * 0.25, BOUNDS, S)
    const d = cycleState(T + HOLD_END + T * 0.75, BOUNDS, S)
    expect(d.offset).toBeLessThan(c.offset)
    expect(c.direction).toBe(-1)
  })

  test('two full cycles return to the start with no drift', () => {
    const period = cyclePeriod(BOUNDS, S)
    for (const cycle of [1, 2]) {
      const at = cycle * period
      near(cycleState(at, BOUNDS, S).offset, 0, 1e-6)
      expect(cycleState(at, BOUNDS, S).phase).toBe('forward')
    }
  })

  test('the turnaround is clean: offset is continuous at the hold boundaries', () => {
    const eps = 1e-6
    near(cycleState(T - eps, BOUNDS, S).offset, BOUNDS, 1e-3)
    near(cycleState(T + HOLD_END + eps, BOUNDS, S).offset, BOUNDS, 1e-3)
    near(cycleState(2 * T + HOLD_END - eps, BOUNDS, S).offset, 0, 1e-3)
  })
})

describe('the elapsed-time clock', () => {
  test('does not advance while not running (pause / hidden / off screen)', () => {
    expect(advanceElapsed(500, 16, false)).toBe(500)
  })

  test('clamps a long gap so a hidden tab never catches up', () => {
    expect(advanceElapsed(500, 5000, true)).toBe(500 + MAX_STEP_MS)
    expect(advanceElapsed(500, 16, true)).toBe(516)
  })

  test('pause survives a hide/show round trip without a time jump', () => {
    let elapsed = 1000
    const offsetBefore = cycleState(elapsed / 1000, BOUNDS, S).offset
    // visitor pauses
    elapsed = advanceElapsed(elapsed, 16, false)
    // tab hides for a long time
    elapsed = advanceElapsed(elapsed, 60_000, false)
    // tab shows, still paused
    elapsed = advanceElapsed(elapsed, 16, false)
    expect(cycleState(elapsed / 1000, BOUNDS, S).offset).toBe(offsetBefore)
    // visitor resumes: continues from where it was, no catch-up
    elapsed = advanceElapsed(elapsed, 16, true)
    const after = cycleState(elapsed / 1000, BOUNDS, S).offset
    expect(Math.abs(after - offsetBefore)).toBeLessThan(S.speed * (MAX_STEP_MS / 1000) + 1)
  })

  test('consecutive frames never jump more than one clamped step of travel', () => {
    let elapsed = 0
    let prev = cycleState(0, BOUNDS, S).offset
    const maxStep = S.speed * (MAX_STEP_MS / 1000) + 1
    for (let i = 0; i < 4000; i++) {
      elapsed = advanceElapsed(elapsed, 16, true)
      const offset = cycleState(elapsed / 1000, BOUNDS, S).offset
      // At the cycle wrap the offset resets home by design (a hold, not a jump
      // mid-travel); elsewhere consecutive frames stay within one step.
      const phase = cycleState(elapsed / 1000, BOUNDS, S).phase
      if (phase !== 'holdStart') expect(Math.abs(offset - prev)).toBeLessThanOrEqual(maxStep)
      prev = offset
    }
  })
})