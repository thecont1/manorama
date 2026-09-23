export type FrameScheduler = (callback: (timestamp: number) => void) => number

export type FrameRateSample = {
  frames: number
  durationMs: number
  framesPerSecond: number
}

export type FrameRateProbeOptions = {
  frames?: number
  requestFrame: FrameScheduler
}

/**
 * Measures delivered animation callbacks without assuming a particular display rate.
 * The native shell supplies requestAnimationFrame; tests can inject a deterministic clock.
 */
export const measureFrameRate = ({
  frames = 60,
  requestFrame,
}: FrameRateProbeOptions): Promise<FrameRateSample> => {
  const targetFrames = Math.max(2, Math.floor(frames))

  return new Promise((resolve) => {
    let count = 0
    let firstTimestamp = 0
    let lastTimestamp = 0

    const sample = (timestamp: number) => {
      if (count === 0) firstTimestamp = timestamp
      lastTimestamp = timestamp
      count += 1

      if (count >= targetFrames) {
        const durationMs = Math.max(0, lastTimestamp - firstTimestamp)
        const framesPerSecond = durationMs > 0
          ? ((count - 1) * 1000) / durationMs
          : 0
        resolve({ frames: count, durationMs, framesPerSecond })
        return
      }

      requestFrame(sample)
    }

    requestFrame(sample)
  })
}
