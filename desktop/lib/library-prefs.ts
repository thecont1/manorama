/**
 * Library display preferences — `library-prefs.json` in the private store
 * (the same 0600 allowlisted file family as catalogue.json). It carries
 * two things, both device-local display choices that never sync:
 *
 * - `hidden`: namespaced gallery keys ("account:{slug}", "device:{id}",
 *   "local:{id}") concealed from the Library's pinned/compact sections and
 *   gathered in the collapsed "Hidden galleries" section at the bottom.
 *   Declutter and screen-privacy, not deletion — nothing is removed.
 * - `hiddenPassword`: an optional salted SHA-256 gate on opening that
 *   section. A display lock only — it is not vault crypto and makes no
 *   confidentiality claim beyond a casual-glance barrier. Off by default.
 */

export const LIBRARY_PREFS_FILE = 'library-prefs.json'
const LIBRARY_PREFS_VERSION = 1

export type HiddenPassword = { salt: string; hash: string }

export type LibraryPrefs = {
  version: number
  hidden?: string[]
  hiddenPassword?: HiddenPassword | null
}

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length > 0

export const parseLibraryPrefs = (text: string | null | undefined): LibraryPrefs => {
  const fallback: LibraryPrefs = { version: LIBRARY_PREFS_VERSION, hidden: [] }
  if (!text) return fallback
  try {
    const raw = JSON.parse(text) as Partial<LibraryPrefs>
    const hidden = Array.isArray(raw.hidden)
      ? raw.hidden.filter((key): key is string => typeof key === 'string' && /^[a-z]+:[^\s]+$/.test(key))
      : []
    const password = raw.hiddenPassword
    return {
      version: LIBRARY_PREFS_VERSION,
      hidden,
      hiddenPassword:
        password && isHex(password.salt) && isHex(password.hash)
          ? { salt: password.salt, hash: password.hash }
          : null,
    }
  } catch {
    return fallback
  }
}

export const serializeLibraryPrefs = (prefs: LibraryPrefs): string =>
  JSON.stringify(
    {
      version: LIBRARY_PREFS_VERSION,
      hidden: [...(prefs.hidden ?? [])],
      ...(prefs.hiddenPassword ? { hiddenPassword: prefs.hiddenPassword } : {}),
    },
    null,
    2,
  )

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export const hashPassword = async (password: string, saltHex: string): Promise<string> => {
  const data = new TextEncoder().encode(`${saltHex}:${password}`)
  return toHex(await crypto.subtle.digest('SHA-256', data))
}

export const newPasswordSalt = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)

export const verifyPassword = async (password: string, stored: HiddenPassword): Promise<boolean> =>
  (await hashPassword(password, stored.salt)) === stored.hash
