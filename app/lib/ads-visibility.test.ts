import { beforeEach, describe, expect, test } from 'bun:test'
import {
  adSuppressionFor,
  clearAdSuppression,
  listAdSuppressions,
  resetAdSuppressionStore,
  setAdSuppression,
  WEB_HOUSE_AD_FRAME,
  webAdFrameFor,
  webAdFrameForRequest,
} from './ads-visibility'
import { resetUserStore, setUserTier, upsertUser } from './user-repository'
import type { D1Database } from '@cloudflare/workers-types'
import { sessionCookieFor, TEST_SESSION_SECRET } from './test-fixtures'
import type { AdFrame } from './adframe'

// No DB binding -> the repository's in-memory store, the same path the dev
// server takes.
beforeEach(() => resetAdSuppressionStore())

describe('ad suppression store', () => {
  test('a day suppression hides plates for that UTC day only', async () => {
    await setAdSuppression('day', '2026-10-01')
    expect(await adSuppressionFor('2026-10-01', 'US')).toBe('day')
    expect(await adSuppressionFor('2026-10-02', 'US')).toBeNull()
  })

  test('a region suppression hides plates for that region only', async () => {
    await setAdSuppression('region', 'IN')
    expect(await adSuppressionFor('2026-10-01', 'IN')).toBe('region')
    expect(await adSuppressionFor('2026-10-01', 'DE')).toBeNull()
    // An undetermined region never matches.
    expect(await adSuppressionFor('2026-10-01', '')).toBeNull()
  })

  test('suppression is idempotent and clearable', async () => {
    await setAdSuppression('region', 'IN')
    await setAdSuppression('region', 'IN')
    expect((await listAdSuppressions()).filter((row) => row.kind === 'region' && row.value === 'IN')).toHaveLength(1)
    await clearAdSuppression('region', 'IN')
    expect(await adSuppressionFor('2026-10-01', 'IN')).toBeNull()
    expect(await listAdSuppressions()).toHaveLength(0)
  })

  test('the list round-trips kind, value and ordering', async () => {
    await setAdSuppression('region', 'US')
    await setAdSuppression('day', '2026-10-01')
    const rows = await listAdSuppressions()
    expect(rows.map((row) => `${row.kind}:${row.value}`)).toEqual(['day:2026-10-01', 'region:US'])
    expect(rows[0].createdAt).toBeTruthy()
  })
})

describe('web ad frame policy', () => {
  const networkFrame: AdFrame = {
    id: 'supplied-static-frame',
    advertiser: 'Static Network',
    badge: 'Ad',
    provider: 'web-network',
  }

  test('anonymous and free viewers receive a supplied network frame', () => {
    expect(webAdFrameFor('anonymous', networkFrame)).toBe(networkFrame)
    expect(webAdFrameFor('free', networkFrame)).toBe(networkFrame)
  })

  test('pro always receives the house frame, even when a network frame is supplied', () => {
    expect(webAdFrameFor('pro', networkFrame)).toBe(WEB_HOUSE_AD_FRAME)
  })

  test('without a network frame, anonymous and free fall back to the house frame', () => {
    expect(webAdFrameFor('anonymous')).toBe(WEB_HOUSE_AD_FRAME)
    expect(webAdFrameFor('free', null)).toBe(WEB_HOUSE_AD_FRAME)
    expect(webAdFrameFor('pro')).toBe(WEB_HOUSE_AD_FRAME)
  })

  test('suppression hides the plate for every tier', () => {
    expect(webAdFrameFor('anonymous', networkFrame, false)).toBeNull()
    expect(webAdFrameFor('free', networkFrame, false)).toBeNull()
    expect(webAdFrameFor('pro', undefined, false)).toBeNull()
  })
})

describe('web ad frame request policy', () => {
  const freeViewer = 'dbid:AAATESTviewerF2'
  const proViewer = 'dbid:AAATESTviewerP2'
  const sessionEnv = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
  const suppliedFrame: AdFrame = {
    id: 'supplied-static-frame',
    advertiser: 'Static Network',
    badge: 'Ad',
    provider: 'web-network',
  }
  const pageRequest = (cookie?: string) =>
    new Request('https://manorama.xyz/gallery', cookie ? { headers: { Cookie: cookie } } : {})

  beforeEach(async () => {
    resetUserStore()
    await upsertUser({ accountId: freeViewer, displayName: 'Free Viewer' })
    await upsertUser({ accountId: proViewer, displayName: 'Pro Viewer' })
    await setUserTier(proViewer, 'pro')
  })

  test('anonymous and signed-in free receive a supplied frame while pro keeps house', async () => {
    expect(await webAdFrameForRequest(pageRequest(), sessionEnv, suppliedFrame)).toBe(suppliedFrame)
    expect(await webAdFrameForRequest(pageRequest(await sessionCookieFor(freeViewer)), sessionEnv, suppliedFrame)).toBe(suppliedFrame)
    expect(await webAdFrameForRequest(pageRequest(await sessionCookieFor(proViewer)), sessionEnv, suppliedFrame)).toBe(WEB_HOUSE_AD_FRAME)
  })

  test('a session-store failure degrades to anonymous instead of failing the render', async () => {
    const brokenDbEnv = {
      HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
      DB: { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database,
    }
    const cookie = await sessionCookieFor(freeViewer)
    expect(await webAdFrameForRequest(pageRequest(cookie), brokenDbEnv, suppliedFrame)).toBe(suppliedFrame)
  })

  test('a day suppression hides the plate for every viewer', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await setAdSuppression('day', day)
    try {
      expect(await webAdFrameForRequest(pageRequest(), sessionEnv, suppliedFrame)).toBeNull()
      expect(await webAdFrameForRequest(pageRequest(await sessionCookieFor(freeViewer)), sessionEnv, suppliedFrame)).toBeNull()
      expect(await webAdFrameForRequest(pageRequest(await sessionCookieFor(proViewer)), sessionEnv, suppliedFrame)).toBeNull()
    } finally {
      await clearAdSuppression('day', day)
    }
  })

  test('a region suppression reads the viewer country for every viewer', async () => {
    const requestFrom = (cookie?: string) => {
      const request = pageRequest(cookie)
      Object.defineProperty(request, 'cf', { value: { country: 'in' } })
      return request
    }
    await setAdSuppression('region', 'IN')
    try {
      expect(await webAdFrameForRequest(requestFrom(), sessionEnv, suppliedFrame)).toBeNull()
      expect(await webAdFrameForRequest(requestFrom(await sessionCookieFor(freeViewer)), sessionEnv, suppliedFrame)).toBeNull()
      expect(await webAdFrameForRequest(requestFrom(await sessionCookieFor(proViewer)), sessionEnv, suppliedFrame)).toBeNull()
    } finally {
      await clearAdSuppression('region', 'IN')
    }
  })
})
