import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const base64url = (value: string) => Buffer.from(value).toString('base64url')

const sessionToken = (subject: string, secret: string) => {
  const encodedHeader = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const encodedPayload = base64url(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + 60 }))
  const unsigned = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

describe('Vendo review fixes', () => {
  test('environment template names the model key consumed by the Vendo handlers', () => {
    const template = readFileSync(`${repoRoot}/.env.example`, 'utf8')
    expect(template).toContain('# VENDO_API_KEY=')
    expect(template).not.toContain('# ANTHROPIC_API_KEY=')
  })

  test('renderer loads the Vendo client only after its mount root is emitted', () => {
    const renderer = readFileSync(`${repoRoot}/app/routes/_renderer.tsx`, 'utf8')
    expect(renderer.indexOf('<div id="vendo-root" />')).toBeGreaterThan(-1)
    expect(renderer.indexOf('<Script src="/app/vendo-client.tsx"')).toBeGreaterThan(
      renderer.indexOf('<div id="vendo-root" />'),
    )
  })

  test('both Vendo handlers reject anonymous requests and derive the user subject from a verified session', async () => {
    const secret = 'test-session-secret-that-is-long-enough'
    const subject = 'user_42'
    const request = new Request('https://manorama.example/api/vendo/threads', {
      headers: { authorization: `Bearer ${sessionToken(subject, secret)}` },
    })
    const anonymousRequest = new Request('https://manorama.example/api/vendo/threads')

    const tsModule = await import('./server')
    const cjsModule = require('./handler.cjs') as {
      createVendoAuth: (env: { HOST_API_JWT_SECRET?: string }) => {
        principal: (request: Request) => Promise<{ kind: 'user'; subject: string } | null>
      }
    }

    for (const createAuth of [tsModule.createVendoAuth, cjsModule.createVendoAuth]) {
      const auth = createAuth({ HOST_API_JWT_SECRET: secret })
      expect(await auth.principal(anonymousRequest)).toBeNull()
      expect(await auth.principal(request)).toMatchObject({ kind: 'user', subject })
      expect(
        await auth.principal(new Request(request, { headers: { authorization: 'Bearer invalid' } })),
      ).toBeNull()
    }
  })
})
