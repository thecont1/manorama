import { describe, expect, test } from 'bun:test'
import { fitSize, runImageProgram, type ImageProgramRuntime } from './image-program'

/**
 * The program's contract is a decision, not a picture: it fits inside a
 * long-edge bound, it never enlarges, and it leaves a photograph that already
 * fits exactly as it found it.
 */

const bytes = (length: number): Uint8Array => new Uint8Array(length).fill(7)

/** A runtime that reports a fixed size and records what it was asked to encode. */
const runtime = (width: number, height: number, calls: number[] = []) => ({
  decode: async () => ({
    width,
    height,
    encode: async (target: { width: number; height: number }) => {
      calls.push(target.width, target.height)
      return bytes(target.width * target.height)
    },
  }),
}) satisfies ImageProgramRuntime

describe('fitSize', () => {
  test('leaves a photograph inside the bound alone', () => {
    expect(fitSize(1600, 1200, 2048)).toEqual({ width: 1600, height: 1200 })
    expect(fitSize(2048, 1365, 2048)).toEqual({ width: 2048, height: 1365 })
  })

  test('never enlarges a photograph that is already small', () => {
    expect(fitSize(640, 480, 2048)).toEqual({ width: 640, height: 480 })
  })

  test('bounds the long edge, not a box', () => {
    // A 2:3 portrait at X's 2048 ceiling: 1365 wide, 2048 tall.
    expect(fitSize(3000, 4500, 2048)).toEqual({ width: 1365, height: 2048 })
    // A 16:9 frame: 2048 across, 1152 down.
    expect(fitSize(4000, 2250, 2048)).toEqual({ width: 2048, height: 1152 })
  })

  test('refuses a photograph with no dimensions', () => {
    expect(() => fitSize(0, 100, 2048)).toThrow(/positive width and height/)
    expect(() => fitSize(Number.NaN, 100, 2048)).toThrow(/positive width and height/)
  })
})

describe('runImageProgram', () => {
  const payload = { kind: 'fit', maxEdge: 2048, format: 'jpeg', quality: 0.9 } as const

  test('passes a photograph that already fits through untouched', async () => {
    const source = { bytes: bytes(10), mimeType: 'image/jpeg', width: 1600, height: 1200 }
    const result = await runImageProgram(payload, source, runtime(9999, 9999))
    expect(result.transformed).toBe(false)
    expect(result.bytes).toBe(source.bytes)
    expect(result.width).toBe(1600)
    expect(result.height).toBe(1200)
  })

  test('resizes a photograph past the bound', async () => {
    const source = { bytes: bytes(10), mimeType: 'image/jpeg', width: 3000, height: 4500 }
    const result = await runImageProgram(payload, source, runtime(3000, 4500))
    expect(result.transformed).toBe(true)
    expect(result.width).toBe(1365)
    expect(result.height).toBe(2048)
    expect(result.mimeType).toBe('image/jpeg')
  })

  test('re-encodes a photograph that is already inside the bound but not a JPEG', async () => {
    const source = { bytes: bytes(10), mimeType: 'image/png', width: 800, height: 600 }
    const calls: number[] = []
    const result = await runImageProgram(payload, source, runtime(800, 600, calls))
    expect(result.transformed).toBe(true)
    expect(result.mimeType).toBe('image/jpeg')
    // The size is unchanged: the format changed, not the geometry.
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(calls).toEqual([800, 600])
  })

  test('measures the photograph when the caller does not know its size', async () => {
    const source = { bytes: bytes(10), mimeType: 'image/jpeg' }
    const result = await runImageProgram(payload, source, runtime(2400, 1800))
    expect(result.transformed).toBe(true)
    expect(result.width).toBe(2048)
    expect(result.height).toBe(1536)
  })

  test('refuses a photograph the device cannot read', async () => {
    const failing: ImageProgramRuntime = {
      decode: async () => { throw new Error('This device could not read that photograph') },
    }
    await expect(runImageProgram(payload, { bytes: bytes(4), mimeType: 'image/jpeg' }, failing))
      .rejects.toThrow(/could not read that photograph/)
  })
})
