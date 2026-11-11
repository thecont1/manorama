import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  buildProviderAuthorizeUrl,
  DRIVE_UPLOAD_SCOPE,
  exchangeCodeForTokens,
  generateState,
  generateVerifier,
  isProviderDeepLink,
  parseProviderRedirect,
  providerClientId,
  providerConfigured,
  providerRedirectUri,
  refreshAccessToken,
  tokenExchangeParams,
  tokenRefreshParams,
} from './oauth'

const AUTHORIZE_ARGS = {
  clientId: 'client-id-value',
  redirectUri: 'in.thecontrarian.manorama.desktop://oauth/dropbox',
  state: 'state-value',
  codeChallenge: 'challenge-value',
}

describe('buildProviderAuthorizeUrl', () => {
  test('dropbox: offline access, S256 PKCE, state bound, custom-scheme redirect', () => {
    const url = new URL(
      buildProviderAuthorizeUrl('dropbox', AUTHORIZE_ARGS),
    )
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id-value')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('in.thecontrarian.manorama.desktop://oauth/dropbox')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('token_access_type')).toBe('offline')
    // No scope request — Dropbox upload access comes with the app.
    expect(url.searchParams.get('scope')).toBeNull()
  })

  test('drive: drive.file scope ONLY, offline, S256 PKCE', () => {
    const url = new URL(
      buildProviderAuthorizeUrl('drive', {
        ...AUTHORIZE_ARGS,
        redirectUri: 'http://127.0.0.1:53210',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toBe(DRIVE_UPLOAD_SCOPE)
    // Exactly one scope — no openid/profile mixing, no full-drive scope.
    expect((url.searchParams.get('scope') ?? '').split(' ')).toEqual([DRIVE_UPLOAD_SCOPE])
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53210')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('redirect uris', () => {
  test('dropbox uses the registered custom scheme — its console matches URIs exactly', () => {
    // An ephemeral loopback port can never satisfy Dropbox's exact-match
    // registration, so the flow rides the scheme the deep-link handler owns.
    expect(providerRedirectUri('dropbox', 40123)).toBe('in.thecontrarian.manorama.desktop://oauth/dropbox')
  })
  test('drive keeps the ephemeral loopback — installed-app rules allow any port', () => {
    // The OS-bound listener avoids the browser→LaunchServices hop where
    // connects silently died.
    expect(providerRedirectUri('drive', 40123)).toBe('http://127.0.0.1:40123')
  })
})

describe('parseProviderRedirect', () => {
  test('parses code+state from the custom scheme per provider', () => {
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://oauth/dropbox?code=abc&state=s1')).toEqual({
      provider: 'dropbox',
      code: 'abc',
      state: 's1',
    })
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://oauth/drive?code=abc&state=s1')).toEqual({
      provider: 'drive',
      code: 'abc',
      state: 's1',
    })
  })

  test('parses a loopback URL as the provider the caller names', () => {
    expect(parseProviderRedirect('http://127.0.0.1:53210/?code=xyz&state=s9')).toEqual({
      provider: 'drive',
      code: 'xyz',
      state: 's9',
    })
    expect(parseProviderRedirect('http://localhost:53210/?code=xyz&state=s9')).toEqual({
      provider: 'drive',
      code: 'xyz',
      state: 's9',
    })
    // The loopback carries no provider marker — dropbox completions come
    // through the same host form and are tagged by the waiting pending.
    expect(parseProviderRedirect('http://127.0.0.1:53210/?code=xyz&state=s9', 'dropbox')).toEqual({
      provider: 'dropbox',
      code: 'xyz',
      state: 's9',
    })
  })

  test('surfaces provider errors and rejects foreign URLs', () => {
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://oauth/dropbox?error=access_denied')).toEqual({
      provider: 'dropbox',
      error: 'access_denied',
    })
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://oauth/dropbox?state=s1')).toEqual({
      provider: 'dropbox',
      error: 'missing_code',
    })
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://auth/callback?handoff=h')).toBeNull()
    expect(parseProviderRedirect('in.thecontrarian.manorama.desktop://oauth/evil?code=c&state=s')).toBeNull()
    expect(parseProviderRedirect('https://evil.example.com/?code=c&state=s')).toBeNull()
    expect(parseProviderRedirect('not a url')).toBeNull()
  })
})

describe('isProviderDeepLink', () => {
  test('true for oauth/* links on our scheme only', () => {
    expect(isProviderDeepLink('in.thecontrarian.manorama.desktop://oauth/dropbox?code=c&state=s')).toBe(true)
    expect(isProviderDeepLink('in.thecontrarian.manorama.desktop://auth/callback?handoff=h')).toBe(false)
    expect(isProviderDeepLink('https://manorama.xyz/oauth/dropbox')).toBe(false)
    expect(isProviderDeepLink('not a url')).toBe(false)
  })
})

describe('state and verifier generation', () => {
  test('unique, url-safe values', () => {
    expect(new Set(Array.from({ length: 10 }, generateState)).size).toBe(10)
    expect(new Set(Array.from({ length: 10 }, generateVerifier)).size).toBe(10)
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(generateVerifier()).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
  })
})

describe('token request shapes', () => {
  test('exchange body is grant+code+client+verifier+redirect, secret only when provided', () => {
    const params = tokenExchangeParams({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      clientId: 'the-client',
      redirectUri: 'http://127.0.0.1:9',
    })
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('the-code')
    expect(params.get('client_id')).toBe('the-client')
    expect(params.get('code_verifier')).toBe('the-verifier')
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:9')
    expect(params.get('client_secret')).toBeNull()
    const withSecret = tokenExchangeParams({
      code: 'c', codeVerifier: 'v', clientId: 'id', redirectUri: 'r', clientSecret: 'pub-secret',
    })
    expect(withSecret.get('client_secret')).toBe('pub-secret')
  })

  test('refresh body is grant+refresh+client', () => {
    const params = tokenRefreshParams({ refreshToken: 'rt', clientId: 'id' })
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rt')
    expect(params.get('client_id')).toBe('id')
    expect(params.get('client_secret')).toBeNull()
  })
})

describe('token exchanges', () => {
  const captureFetch = (response: Response) => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return response
    }) as typeof fetch
    return { calls, fetcher }
  }

  test('dropbox exchange posts the form to api.dropboxapi.com', async () => {
    const { calls, fetcher } = captureFetch(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
    )
    const tokens = await exchangeCodeForTokens('dropbox', {
      code: 'code', codeVerifier: 'verifier', clientId: 'id', redirectUri: 'in.thecontrarian.manorama.desktop://oauth/dropbox',
    }, fetcher)
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
    expect(calls[0]!.url).toBe('https://api.dropboxapi.com/oauth2/token')
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(calls[0]!.init?.body as string)
    expect(body.get('code_verifier')).toBe('verifier')
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  test('drive refresh posts to oauth2.googleapis.com', async () => {
    const { calls, fetcher } = captureFetch(
      new Response(JSON.stringify({ access_token: 'new-at', expires_in: 3599 }), { status: 200 }),
    )
    const tokens = await refreshAccessToken('drive', { refreshToken: 'rt', clientId: 'id' }, fetcher)
    expect(tokens.accessToken).toBe('new-at')
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
  })

  test('a failed exchange throws the generic provider error', async () => {
    const { fetcher } = captureFetch(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    await expect(
      exchangeCodeForTokens('dropbox', { code: 'c', codeVerifier: 'v', clientId: 'i', redirectUri: 'r' }, fetcher),
    ).rejects.toThrow('Dropbox authorization could not be completed.')
  })
})

describe('providerConfigured', () => {
  test('empty client id means not configured — the disabled state the sheet renders', () => {
    expect(providerConfigured('dropbox', '')).toBe(false)
    expect(providerConfigured('drive', '')).toBe(false)
    expect(providerConfigured('dropbox', 'id-value')).toBe(true)
    // The env-driven path agrees with whatever id the build carried in.
    expect(providerConfigured('dropbox')).toBe(providerClientId('dropbox').length > 0)
    expect(providerConfigured('drive')).toBe(providerClientId('drive').length > 0)
  })
})

describe('connectProvider ownership', () => {
  // mock.module is process-global — restore the real bindings so the rest
  // of the file (and the suite) keeps its own import graph.
  afterEach(() => mock.restore())

  test('a stale loopback rejection cannot fail a newer connection', async () => {
    const finishes: Array<{ resolve: (target: string) => void; reject: (error: Error) => void }> = []
    mock.module('@tauri-apps/api/core', () => ({
      invoke: (command: string) => {
        if (command === 'oauth_loopback_begin') return Promise.resolve(40123)
        if (command === 'oauth_loopback_finish') {
          return new Promise<string>((resolve, reject) => { finishes.push({ resolve, reject }) })
        }
        return Promise.resolve(undefined)
      },
    }))
    mock.module('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))
    process.env.MANORAMA_DESKTOP_GOOGLE_CLIENT_ID = 'test-client-id'
    const { connectProvider, cancelProviderConnect } = await import('./oauth')
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    const a = connectProvider('drive')
    await flush()
    expect(finishes.length).toBe(1)
    cancelProviderConnect()
    await expect(a).rejects.toThrow('cancelled')

    const b = connectProvider('drive')
    await flush()
    expect(finishes.length).toBe(2)
    let bVerdict = 'pending'
    void b.then(() => { bVerdict = 'resolved' }, () => { bVerdict = 'rejected' })
    // The cancelled flow's listener settling late must not reach the
    // pending flow that took ownership after it.
    finishes[0]!.reject(new Error('listener died'))
    await flush()
    expect(bVerdict).toBe('pending')
    // Settle the live flow so nothing leaks past the test.
    finishes[1]!.reject(new Error('done'))
    await expect(b).rejects.toThrow('done')
    await flush()
    expect(bVerdict).toBe('rejected')
  })
})
