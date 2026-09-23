import {
  getUserByDropboxId,
  setUserTier,
  type BillingEventOrder,
  type UserRepositoryEnv,
} from './user-repository'

export const REVENUECAT_PRO_ENTITLEMENT = 'will_pay'
export const REVENUECAT_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export type RevenueCatWebhookEnv = UserRepositoryEnv & {
  REVENUECAT_WEBHOOK_AUTH?: string
  REVENUECAT_WEBHOOK_SIGNING_SECRET?: string
}

type RevenueCatEvent = {
  id?: string
  type?: string
  app_user_id?: string
  original_app_user_id?: string
  aliases?: string[]
  transferred_from?: unknown[]
  transferred_to?: unknown[]
  entitlement_ids?: string[] | null
  event_timestamp_ms?: number
  expiration_at_ms?: number | null
}

type RevenueCatWebhookPayload = {
  api_version?: string
  event?: RevenueCatEvent
}

const constantTimeEqual = (expected: string, actual: string) => {
  if (expected.length !== actual.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  }
  return difference === 0
}

export const verifyRevenueCatAuthorization = (request: Request, expected: string) => {
  const actual = request.headers.get('Authorization')?.trim()
  return Boolean(actual && expected.trim() && constantTimeEqual(expected.trim(), actual))
}

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const verifyRevenueCatSignature = async (
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => {
  if (!header || !secret.trim()) return false
  const parts = new Map<string, string>()
  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator > 0) parts.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  const timestamp = Number(parts.get('t'))
  const signature = parts.get('v1')
  if (!Number.isSafeInteger(timestamp) || !signature) return false
  if (Math.abs(nowSeconds - timestamp) > REVENUECAT_SIGNATURE_TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`))
  return constantTimeEqual(bytesToHex(new Uint8Array(digest)), signature)
}

const eventUserIds = (event: RevenueCatEvent) => [
  event.app_user_id,
  event.original_app_user_id,
  ...(event.aliases ?? []),
].filter((id): id is string => typeof id === 'string' && id.trim().length > 0)

const dbAccountIds = (ids: unknown[]) => Array.from(new Set(
  ids.filter((id): id is string => typeof id === 'string' && id.startsWith('dbid:')),
))

const eventAccountIds = (event: RevenueCatEvent) => event.type === 'TRANSFER'
  ? {
      from: dbAccountIds(event.transferred_from ?? []),
      to: dbAccountIds(event.transferred_to ?? []),
    }
  : { from: [], to: dbAccountIds(eventUserIds(event)) }

const isProEvent = (event: RevenueCatEvent) =>
  event.entitlement_ids?.includes(REVENUECAT_PRO_ENTITLEMENT) === true

const establishesProState = (event: RevenueCatEvent) =>
  Array.isArray(event.entitlement_ids)
  && event.entitlement_ids.includes(REVENUECAT_PRO_ENTITLEMENT)

const isActiveEvent = (event: RevenueCatEvent) => {
  if (['EXPIRATION', 'REFUND'].includes(event.type ?? '')) return false
  if (event.expiration_at_ms == null) return true
  return event.expiration_at_ms > Date.now()
}

/**
 * Verifies and applies one RevenueCat event. The caller owns the HTTP response;
 * this function returns a small result so the route can acknowledge duplicates
 * and unknown accounts without exposing account details.
 */
export const processRevenueCatWebhook = async (
  request: Request,
  env: RevenueCatWebhookEnv,
  nowSeconds = Math.floor(Date.now() / 1000),
) => {
  const rawBody = await request.text()
  const authorization = env.REVENUECAT_WEBHOOK_AUTH?.trim()
  const signingSecret = env.REVENUECAT_WEBHOOK_SIGNING_SECRET?.trim()
  if (!authorization || !verifyRevenueCatAuthorization(request, authorization)) {
    return { status: 401 as const, code: 'UNAUTHORIZED' as const }
  }
  if (signingSecret && !(await verifyRevenueCatSignature(rawBody, request.headers.get('X-RevenueCat-Webhook-Signature'), signingSecret, nowSeconds))) {
    return { status: 401 as const, code: 'INVALID_SIGNATURE' as const }
  }

  let payload: RevenueCatWebhookPayload
  try {
    payload = JSON.parse(rawBody) as RevenueCatWebhookPayload
  } catch {
    return { status: 400 as const, code: 'INVALID_JSON' as const }
  }
  const event = payload.event
  if (!event || typeof event.id !== 'string' || !event.type) return { status: 400 as const, code: 'INVALID_EVENT' as const }
  const accounts = eventAccountIds(event)
  const accountIds = Array.from(new Set([...accounts.from, ...accounts.to]))
  if (!accountIds.length) return { status: 200 as const, code: 'IGNORED_IDENTITY' as const, eventId: event.id }
  if (!establishesProState(event)) {
    return { status: 200 as const, code: 'IGNORED_ENTITLEMENT' as const, eventId: event.id }
  }
  const order: BillingEventOrder | undefined = Number.isSafeInteger(event.event_timestamp_ms)
    ? { timestampMs: event.event_timestamp_ms!, eventId: event.id }
    : undefined
  let knownAccount = false
  let applied = 0
  for (const accountId of accountIds) {
    const user = await getUserByDropboxId(accountId, env)
    if (!user) continue
    knownAccount = true
    const tier = accounts.from.includes(accountId) && event.type === 'TRANSFER'
      ? 'free'
      : isProEvent(event) && isActiveEvent(event) ? 'pro' : 'free'
    if (await setUserTier(accountId, tier, env, undefined, order)) applied += 1
  }
  if (!knownAccount) return { status: 200 as const, code: 'IGNORED_UNKNOWN_ACCOUNT' as const, eventId: event.id }
  if (!applied) return { status: 200 as const, code: 'IGNORED_STALE' as const, eventId: event.id }
  const tier = isProEvent(event) && isActiveEvent(event) ? 'pro' : 'free'
  return { status: 200 as const, code: 'APPLIED' as const, eventId: event.id, tier }
}
