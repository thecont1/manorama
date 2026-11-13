/**
 * Demo playback: a small state machine driven by elapsed time, not frames.
 *
 * One out-and-back cycle is: forward leg, hold at end, backward leg, hold at
 * start. Each leg eases into its endpoints (a trapezoid velocity profile) so
 * there is no jump at the turnaround. The DOM order never reverses; only the
 * direction of travel does.
 *
 * `advanceElapsed` accumulates time only while running and clamps each step,
 * so a hidden tab or a long gap resumes where it was without catching up.
 * The visitor's pause is kept outside this module (eligibility), so scrolling
 * away and back never undoes a deliberate pause.
 */

export type PlaybackSettings = {
  /** Cruise speed in CSS px per second. */
  speed: number
  /** Ease-in / ease-out window at each leg endpoint, in ms. */
  easeMs: number
  holdEndMs: number
  holdStartMs: number
}

export const DEFAULT_SETTINGS: PlaybackSettings = {
  speed: 64,
  easeMs: 900,
  holdEndMs: 1200,
  holdStartMs: 900,
}

/** A hidden tab or a stalled frame must not fast-forward the strip. */
export const MAX_STEP_MS = 100

export type TravelPhase = 'forward' | 'holdEnd' | 'backward' | 'holdStart'

export type CycleState = {
  phase: TravelPhase
  offset: number
  direction: 1 | -1
}

export const legDuration = (bounds: number, s: PlaybackSettings) =>
  bounds / s.speed + s.easeMs / 1000

/** Position along a leg at elapsed `t` (seconds), 0 -> bounds, eased at both
 *  ends. Short strips that cannot reach cruise speed use a smooth cosine
 *  ease over the same duration instead of a negative cruise window. */
export const legOffset = (t: number, bounds: number, s: PlaybackSettings) => {
  if (bounds <= 0) return 0
  const T = legDuration(bounds, s)
  const v = s.speed
  const e = s.easeMs / 1000
  if (t <= 0) return 0
  if (t >= T) return bounds
  if (bounds < v * e) return bounds * (1 - Math.cos(Math.PI * (t / T))) / 2
  const half = (v * e) / 2
  if (t < e) return (v * t * t) / (2 * e)
  if (t < T - e) return half + v * (t - e)
  const u = T - t
  return bounds - (v * u * u) / (2 * e)
}

export const cyclePeriod = (bounds: number, s: PlaybackSettings) =>
  2 * legDuration(bounds, s) + (s.holdEndMs + s.holdStartMs) / 1000

/** Where the strip is at `elapsed` seconds of *active* time. */
export const cycleState = (elapsed: number, bounds: number, s: PlaybackSettings): CycleState => {
  if (bounds <= 0) return { phase: 'holdStart', offset: 0, direction: 1 }
  const T = legDuration(bounds, s)
  const holdEnd = s.holdEndMs / 1000
  const period = cyclePeriod(bounds, s)
  const t = ((elapsed % period) + period) % period
  if (t < T) return { phase: 'forward', offset: legOffset(t, bounds, s), direction: 1 }
  if (t < T + holdEnd) return { phase: 'holdEnd', offset: bounds, direction: 1 }
  if (t < 2 * T + holdEnd)
    return { phase: 'backward', offset: bounds - legOffset(t - T - holdEnd, bounds, s), direction: -1 }
  return { phase: 'holdStart', offset: 0, direction: -1 }
}

/** Accumulate active time. Clamped so gaps never cause a catch-up jump. */
export const advanceElapsed = (
  prev: number,
  dtMs: number,
  running: boolean,
  maxStepMs: number = MAX_STEP_MS,
) => (running ? prev + Math.min(Math.max(0, dtMs), maxStepMs) : prev)