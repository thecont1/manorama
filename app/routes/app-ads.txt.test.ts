import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { APP_ADS_TXT, GET } from './app-ads.txt'

const app = new Hono()
app.get('/app-ads.txt', GET[0] as never)

describe('app-ads.txt', () => {
  test('serves the owner publisher line as cacheable plain text', async () => {
    const response = await app.request('/app-ads.txt')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400')
    expect(await response.text()).toBe(APP_ADS_TXT)
  })
})
