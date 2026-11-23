import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

/**
 * `readFileRange` is the bounded probe the embedded-metadata reader runs on:
 * a shell with `read_file_range` answers a `__bytes` window and every other
 * failure is real (scope, IO, decode) and must propagate. Only a shell that
 * lacks the command entirely may fall back to a whole-file read — otherwise
 * a real failure would silently turn the byte bound into a full transfer.
 */

const wholeFile = new Uint8Array(4096).map((_, i) => i % 251)
let bridge: (command: string, args?: Record<string, unknown>) => unknown
let calls: string[]

const installTauri = () => {
  const win = new Window() as unknown as Record<string, unknown>
  const globals = globalThis as Record<string, unknown>
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement']) {
    if (win[key] !== undefined) globals[key] = win[key]
  }
  win.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push(command)
      return bridge(command, args)
    },
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
  globals.window = win
}

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

describe('readFileRange', () => {
  beforeAll(installTauri)
  beforeEach(() => {
    calls = []
    bridge = () => null
  })

  test('a __bytes reply decodes to the window', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') return { __bytes: b64(wholeFile.subarray(100, 164)) }
      return null
    }
    const { readFileRange } = await import('./tauri')
    const out = await readFileRange('/photos/a.jpg', 100, 64)
    expect(out.length).toBe(64)
    expect(out[0]).toBe(100 % 251)
    expect(calls).toEqual(['read_file_range'])
  })

  test('an ArrayBuffer reply decodes the same', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') return wholeFile.slice(10, 42).buffer
      return null
    }
    const { readFileRange } = await import('./tauri')
    const out = await readFileRange('/photos/a.jpg', 10, 32)
    expect(out.length).toBe(32)
    expect(out[0]).toBe(10 % 251)
  })

  test('a shell without the command falls back to a sliced whole-file read', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') throw new Error('the native shell does not implement read_file_range')
      if (command === 'plugin:fs|read_file') return wholeFile.buffer.slice(0)
      return null
    }
    const { readFileRange } = await import('./tauri')
    const out = await readFileRange('/photos/a.jpg', 200, 50)
    expect(out.length).toBe(50)
    expect(out[0]).toBe(200 % 251)
    expect(out[49]).toBe(249 % 251)
    expect(calls).toEqual(['read_file_range', 'plugin:fs|read_file'])
  })

  test('a Tauri unknown-command error falls back the same way', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') throw new Error('Command read_file_range not found')
      if (command === 'plugin:fs|read_file') return wholeFile.buffer.slice(0)
      return null
    }
    const { readFileRange } = await import('./tauri')
    const out = await readFileRange('/photos/a.jpg', 0, 16)
    expect(out.length).toBe(16)
    expect(calls).toEqual(['read_file_range', 'plugin:fs|read_file'])
  })

  test('a real command failure propagates — no whole-file fallback', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') throw new Error('read_file_range path is outside the granted roots')
      if (command === 'plugin:fs|read_file') return wholeFile.buffer.slice(0)
      return null
    }
    const { readFileRange } = await import('./tauri')
    await expect(readFileRange('/secrets/a.jpg', 0, 64)).rejects.toThrow('outside the granted roots')
    expect(calls).toEqual(['read_file_range'])
  })

  test('a decode failure propagates the same way', async () => {
    bridge = (command) => {
      if (command === 'read_file_range') return { note: 'no bytes here' }
      return null
    }
    const { readFileRange } = await import('./tauri')
    await expect(readFileRange('/photos/a.jpg', 0, 64)).rejects.toThrow('no bytes')
    expect(calls).toEqual(['read_file_range'])
  })
})
