/**
 * Dropbox OAuth2 (authorization code) for Manorama sign-in. The same
 * DROPBOX_APP_KEY / DROPBOX_APP_SECRET pair that powers the gallery
 * folder scanner authorizes the user sign-in flow; the only extra setup
 * is registering this app's callback URL in the Dropbox app console.
 *
 * There is deliberately no sign-up flow on our side: Dropbox creates
 * accounts, we only accept signed-in Dropbox users.
 *
 * Transaction state (CSRF state, post-login destination, handoff flavour)
 * lives in the `auth_flows` table via app/lib/auth-flows.ts — not in
 * cookies — so the same machinery serves every provider.
 */

export type DropboxOauthEnv = {
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
}

export type DropboxAccount = {
  dropboxAccountId: string
  displayName: string
  email?: string
}

const oauthConfigured = (env: DropboxOauthEnv) =>
  Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET)

export const dropboxAuthorizeUrl = (redirectUri: string, state: string, env: DropboxOauthEnv) => {
  if (!oauthConfigured(env)) throw new Error('Dropbox app credentials are not configured')
  const url = new URL('https://www.dropbox.com/oauth2/authorize')
  url.searchParams.set('client_id', env.DROPBOX_APP_KEY!)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  return url.toString()
}

/** Exchanges the authorization code for the user's Dropbox account
 * (short-lived access token + account details). We keep no Dropbox
 * tokens — identity only. Both Dropbox requests share a bounded timeout
 * so a hung connection cannot stall sign-in indefinitely. */
const DROPBOX_REQUEST_TIMEOUT_MS = 10_000

const withTimeout = () => AbortSignal.timeout(DROPBOX_REQUEST_TIMEOUT_MS)

export const fetchDropboxAccount = async (
  code: string,
  redirectUri: string,
  env: DropboxOauthEnv,
  fetcher: typeof fetch = fetch,
): Promise<DropboxAccount> => {
  if (!oauthConfigured(env)) throw new Error('Dropbox app credentials are not configured')
  const tokenResponse = await fetcher('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: env.DROPBOX_APP_KEY!,
      client_secret: env.DROPBOX_APP_SECRET!,
      redirect_uri: redirectUri,
    }),
    signal: withTimeout(),
  })
  if (!tokenResponse.ok) throw new Error('Dropbox sign-in could not be completed')
  const token = await tokenResponse.json() as { access_token?: string }
  if (!token.access_token) throw new Error('Dropbox sign-in could not be completed')

  const accountResponse = await fetcher('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: withTimeout(),
  })
  if (!accountResponse.ok) throw new Error('Dropbox sign-in could not be completed')
  const account = await accountResponse.json() as {
    account_id?: string
    email?: string
    email_verified?: boolean
    name?: { display_name?: string }
  }
  if (!account.account_id) throw new Error('Dropbox sign-in could not be completed')
  const profile: DropboxAccount = {
    dropboxAccountId: account.account_id,
    displayName: account.name?.display_name?.trim() || 'Photographer',
  }
  if (account.email_verified && account.email) profile.email = account.email
  return profile
}
