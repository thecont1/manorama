import { beforeEach, describe, expect, test } from 'bun:test'
import {
  AUTH_FLOW_TTL_SECONDS,
  consumeAuthFlow,
  createAuthFlow,
  pkceChallenge,
  resetAuthFlowStore,
} from './auth-flows'

const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

beforeEach(() => {
  resetAuthFlowStore()
})

describe('pkceChallenge', () => {
  test('matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE)
  })
})

describe('createAuthFlow validation', () => {
  test('rejects unknown providers and intents', async () => {
    await expect(createAuthFlow({ provider: 'vimeo' as never, intent: 'signin' })).rejects.toThrow()
    await expect(createAuthFlow({ provider: 'google', intent: 'peek' as never })).rejects.toThrow()
  })

  test('a link intent requires a nonblank account and rejects handoffs', async () => {
    await expect(createAuthFlow({ provider: 'google', intent: 'link' })).rejects.toThrow()
    await expect(createAuthFlow({ provider: 'google', intent: 'link', accountId: '  ' })).rejects.toThrow()
    await expect(createAuthFlow({ provider: 'google', intent: 'link', accountId: 'acct_1', native: '1' })).rejects.toThrow()
    await expect(createAuthFlow({ provider: 'google', intent: 'link', accountId: 'acct_1', native: 'desktop' })).rejects.toThrow()
    const ok = await createAuthFlow({ provider: 'google', intent: 'link', accountId: 'acct_1' })
    expect(ok.state).toMatch(/^[0-9a-f]{64}$/)
  })

  test('native accepts only the empty, iOS and desktop flavours', async () => {
    for (const native of ['2', 'ios', 'DESKTOP', ' desktop'] as const) {
      await expect(createAuthFlow({ provider: 'dropbox', intent: 'signin', native })).rejects.toThrow()
    }
    await expect(createAuthFlow({ provider: 'dropbox', intent: 'signin', native: '1' })).resolves.toBeTruthy()
    await expect(
      createAuthFlow({ provider: 'dropbox', intent: 'signin', native: 'desktop', appChallenge: 'c'.repeat(43) }),
    ).resolves.toBeTruthy()
  })

  test('app_challenge only pairs with the desktop handoff and must be 43 unreserved chars', async () => {
    await expect(createAuthFlow({ provider: 'dropbox', intent: 'signin', appChallenge: 'c'.repeat(43) })).rejects.toThrow()
    await expect(createAuthFlow({ provider: 'dropbox', intent: 'signin', native: '1', appChallenge: 'c'.repeat(43) })).rejects.toThrow()
    for (const challenge of ['short', `${'c'.repeat(42)}+`, 'c'.repeat(44), 'c'.repeat(42) + '=']) {
      await expect(
        createAuthFlow({ provider: 'dropbox', intent: 'signin', native: 'desktop', appChallenge: challenge }),
      ).rejects.toThrow()
    }
    const ok = await createAuthFlow({
      provider: 'dropbox',
      intent: 'signin',
      native: 'desktop',
      appChallenge: RFC7636_CHALLENGE,
    })
    expect((await consumeAuthFlow(ok.state))?.appChallenge).toBe(RFC7636_CHALLENGE)
  })

  test('an oversized next destination is rejected', async () => {
    await expect(
      createAuthFlow({ provider: 'dropbox', intent: 'signin', next: `https://manorama.xyz/${'x'.repeat(2100)}` }),
    ).rejects.toThrow()
  })
})

describe('createAuthFlow / consumeAuthFlow on the memory fallback', () => {
  test('mints a 64-hex state and nonce; only Google gets a PKCE verifier', async () => {
    const google = await createAuthFlow({ provider: 'google', intent: 'signin' })
    expect(google.state).toMatch(/^[0-9a-f]{64}$/)
    expect(google.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(google.codeVerifier).toMatch(VERIFIER_PATTERN)
    const dropbox = await createAuthFlow({ provider: 'dropbox', intent: 'signin' })
    const apple = await createAuthFlow({ provider: 'apple', intent: 'signin' })
    expect(dropbox.codeVerifier).toBeUndefined()
    expect(apple.codeVerifier).toBeUndefined()
    expect(new Set([google.state, dropbox.state, apple.state]).size).toBe(3)
    expect(new Set([google.nonce, dropbox.nonce, apple.nonce]).size).toBe(3)
  })

  test('consume returns the stored flow exactly once', async () => {
    const { state, nonce, codeVerifier } = await createAuthFlow({
      provider: 'google',
      intent: 'signin',
      native: '1',
      next: 'https://manorama.xyz/return',
    })
    const flow = await consumeAuthFlow(state)
    expect(flow).toEqual({
      state,
      provider: 'google',
      intent: 'signin',
      nonce,
      codeVerifier,
      native: '1',
      nextUrl: 'https://manorama.xyz/return',
    })
    expect(await consumeAuthFlow(state)).toBeNull()
    expect(await consumeAuthFlow(state)).toBeNull()
  })

  test('unknown, blank and cross-shaped states come back null', async () => {
    expect(await consumeAuthFlow('nope')).toBeNull()
    expect(await consumeAuthFlow('')).toBeNull()
    expect(await consumeAuthFlow('  ')).toBeNull()
    expect(await consumeAuthFlow('x'.repeat(4096))).toBeNull()
  })

  test('an expired flow cannot be consumed', async () => {
    const { state } = await createAuthFlow({ provider: 'dropbox', intent: 'signin' }, undefined, -1)
    expect(await consumeAuthFlow(state)).toBeNull()
  })

  test('link flows round-trip the bound account id', async () => {
    const { state } = await createAuthFlow({ provider: 'apple', intent: 'link', accountId: 'acct_link-me' })
    const flow = await consumeAuthFlow(state)
    expect(flow?.intent).toBe('link')
    expect(flow?.accountId).toBe('acct_link-me')
    expect(flow?.native).toBe('')
  })

  test('AUTH_FLOW_TTL_SECONDS is ten minutes', () => {
    expect(AUTH_FLOW_TTL_SECONDS).toBe(600)
  })
})
