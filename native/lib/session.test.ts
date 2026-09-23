import { describe, expect, test } from 'bun:test'
import { NATIVE_CALLBACK_URL, __private__ } from './session'

describe('native OAuth callback', () => {
  test('uses the manorama custom scheme and auth host', () => {
    const url = new URL(`${NATIVE_CALLBACK_URL}?handoff=abc`)
    expect(url.protocol).toBe('in.thecontrarian.manorama:')
    expect(url.hostname).toBe('auth')
    expect(url.searchParams.get('handoff')).toBe('abc')
  })

  test('ignores unrelated deep links before making a request', async () => {
    const fetcher = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch
    try {
      expect(await __private__.exchangeHandoff('https://manorama.xyz/', 'https://manorama.xyz')).toBe(false)
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = fetcher
    }
  })
})
