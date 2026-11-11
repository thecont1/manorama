import { describe, expect, test } from 'bun:test'
import {
  hashPassword,
  newPasswordSalt,
  parseLibraryPrefs,
  serializeLibraryPrefs,
  verifyPassword,
} from './library-prefs'

describe('library-prefs', () => {
  test('round-trips hidden keys and the password gate', async () => {
    const salt = newPasswordSalt()
    const prefs = {
      version: 1,
      hidden: ['account:wedding', 'local:abc-123', 'device:dev-1'],
      hiddenPassword: { salt, hash: await hashPassword('opal', salt) },
    }
    const parsed = parseLibraryPrefs(serializeLibraryPrefs(prefs))
    expect(parsed.hidden).toEqual(prefs.hidden)
    expect(await verifyPassword('opal', parsed.hiddenPassword!)).toBe(true)
    expect(await verifyPassword('wrong', parsed.hiddenPassword!)).toBe(false)
  })

  test('missing or malformed input falls back to an empty prefs', () => {
    expect(parseLibraryPrefs(null).hidden).toEqual([])
    expect(parseLibraryPrefs('').hidden).toEqual([])
    expect(parseLibraryPrefs('not json').hidden).toEqual([])
    expect(parseLibraryPrefs('{"hiddenPassword":true}').hiddenPassword).toBeNull()
  })

  test('drops hidden entries that are not namespaced keys', () => {
    const parsed = parseLibraryPrefs(JSON.stringify({ hidden: ['account:ok', 'no colon', 42, 'local:x'] }))
    expect(parsed.hidden).toEqual(['account:ok', 'local:x'])
  })
})
