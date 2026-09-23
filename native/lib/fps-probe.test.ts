import { describe, expect, test } from 'bun:test'
import { measureFrameRate } from './fps-probe'

describe('measureFrameRate', () => {
  test('reports the delivered cadence from injected animation timestamps', async () => {
    let timestamp = 0
    const sample = await measureFrameRate({
      frames: 61,
      requestFrame: (callback) => {
        timestamp += 1000 / 120
        callback(timestamp)
        return timestamp
      },
    })

    expect(sample.frames).toBe(61)
    expect(Math.abs(sample.durationMs - 500)).toBeLessThan(0.01)
    expect(Math.abs(sample.framesPerSecond - 120)).toBeLessThan(0.01)
  })

  test('uses a minimum two-frame sample for invalid frame counts', async () => {
    let calls = 0
    const sample = await measureFrameRate({
      frames: 0,
      requestFrame: (callback) => {
        calls += 1
        callback(calls * 16)
        return calls
      },
    })

    expect(sample.frames).toBe(2)
    expect(Math.abs(sample.framesPerSecond - 62.5)).toBeLessThan(0.01)
  })
})
