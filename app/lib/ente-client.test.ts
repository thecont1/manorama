import { describe, expect, test } from 'bun:test'
import sodium from 'libsodium-wrappers-sumo'
import { extractEnteLink, openEnteSession, EntePasswordRequired, verifyEntePassword } from './ente-client'
import { SourceFetchError } from './imagesource'
import { enteIdentityFromUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'

await sodium.ready

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
const unb64 = (input: string) => sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

const b58encode = (bytes: Uint8Array): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = ''
  for (const byte of bytes) { if (byte !== 0) break; out += '1' }
  for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]!]
  return out
}

const ALBUM_KEY = sodium.randombytes_buf(32)
const TOKEN = 'XPA3OZ38DC'
const linkPath = `https://albums.ente.io/${TOKEN}#${b58encode(ALBUM_KEY)}`
const linkLegacy = `https://albums.ente.io/?t=${TOKEN}#${b58encode(ALBUM_KEY)}`

const jpeg = (width: number, height: number) => {
  const bytes = new Uint8Array(4096)
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xc0
  bytes[4] = 0x00; bytes[5] = 0x11
  bytes[7] = (height >> 8) & 0xff; bytes[8] = height & 0xff
  bytes[9] = (width >> 8) & 0xff; bytes[10] = width & 0xff
  return bytes
}

const boxEncrypt = (data: Uint8Array, key: Uint8Array) => {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  return { encryptedData: b64(sodium.crypto_secretbox_easy(data, nonce, key)), nonce: b64(nonce) }
}

const blobEncrypt = (data: Uint8Array, key: Uint8Array) => {
  const init = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
  const pushed = sodium.crypto_secretstream_xchacha20poly1305_push(init.state, data, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL)
  return { encryptedData: b64(pushed), decryptionHeader: b64(init.header) }
}

const streamEncrypt = (data: Uint8Array, key: Uint8Array) => {
  const init = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
  return {
    ciphertext: sodium.crypto_secretstream_xchacha20poly1305_push(init.state, data, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL),
    header: init.header,
  }
}

const pubMM = (w: number, h: number, fileKey: Uint8Array) => {
  const blob = blobEncrypt(new TextEncoder().encode(JSON.stringify({ w, h })), fileKey)
  return { data: { encryptedData: blob.encryptedData, header: blob.decryptionHeader } }
}

const fixtureFile = (id: number, options: { title?: string; fileType?: number; w?: number; h?: number; bytes?: Uint8Array; deleted?: boolean; updationTime?: number } = {}) => {
  const fileKey = sodium.randombytes_buf(32)
  const metadata = blobEncrypt(new TextEncoder().encode(JSON.stringify({
    title: options.title ?? `IMG_${id}.jpg`,
    fileType: options.fileType ?? 0,
    creationTime: 1720000000000000,
    modificationTime: 1720000000000000,
  })), fileKey)
  const plain = options.bytes ?? jpeg(options.w ?? 4000, options.h ?? 3000)
  const file = streamEncrypt(plain, fileKey)
  const thumb = streamEncrypt(jpeg(300, 200), fileKey)
  const wrapped = boxEncrypt(fileKey, ALBUM_KEY)
  return {
    fileCipher: file.ciphertext,
    thumbCipher: thumb.ciphertext,
    remote: {
      id,
      encryptedKey: wrapped.encryptedData,
      keyDecryptionNonce: wrapped.nonce,
      file: { decryptionHeader: b64(file.header) },
      thumbnail: { decryptionHeader: b64(thumb.header) },
      metadata: { encryptedData: metadata.encryptedData, decryptionHeader: metadata.decryptionHeader },
      ...(options.w && options.h ? { pubMagicMetadata: pubMM(options.w, options.h, fileKey) } : {}),
      updationTime: options.updationTime ?? 1720000000000000,
      ...(options.deleted ? { isDeleted: true } : {}),
    },
    fileKey,
    plain,
  }
}

const collection = (name = 'Monsoon', publicURLs: unknown[] = [{ url: `https://albums.ente.io/${TOKEN}` }]) => {
  const nameBox = boxEncrypt(new TextEncoder().encode(name), ALBUM_KEY)
  return { collection: { encryptedName: nameBox.encryptedData, nameDecryptionNonce: nameBox.nonce, publicURLs }, referralCode: '' }
}

const fetchFor = (files: ReturnType<typeof fixtureFile>[], options: { name?: string; infoStatus?: number; diffStatus?: number; tamper?: number; deviceToken?: string } = {}) =>
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const baseHeaders: Record<string, string> = options.deviceToken ? { 'X-Link-Device-Token': options.deviceToken } : {}
    if (url.includes('/public-collection/info')) {
      if (options.infoStatus) return new Response('{}', { status: options.infoStatus })
      return new Response(JSON.stringify(collection(options.name ?? 'Monsoon')), { status: 200, headers: { 'Content-Type': 'application/json', ...baseHeaders } })
    }
    if (url.includes('/public-collection/diff')) {
      if (options.diffStatus) return new Response('{}', { status: options.diffStatus })
      return new Response(JSON.stringify({ diff: files.map((file) => file.remote), hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json', ...baseHeaders } })
    }
    const download = url.match(/public-albums\.ente\.com\/download\/\?fileID=(\d+)/)
    if (download) {
      const file = files.find((entry) => entry.remote.id === Number(download[1]))
      if (!file) return new Response('not found', { status: 404 })
      const range = new Headers(init?.headers).get('Range')
      if (range) {
        const [, start, end] = range.match(/bytes=(\d+)-(\d+)/)!.map(Number)
        return new Response(file.fileCipher.slice(start!, end! + 1) as unknown as BodyInit, { status: 206 })
      }
      const tampered = options.tamper !== undefined ? file.fileCipher.map((byte, i) => i === options.tamper ? byte ^ 0xff : byte) : file.fileCipher
      return new Response(tampered as unknown as BodyInit, { status: 200 })
    }
    const preview = url.match(/public-albums\.ente\.com\/preview\/\?fileID=(\d+)/)
    if (preview) {
      const file = files.find((entry) => entry.remote.id === Number(preview[1]))
      if (!file) return new Response('not found', { status: 404 })
      return new Response(file.thumbCipher as unknown as BodyInit, { status: 200 })
    }
    return new Response('unrouted ' + url, { status: 500 })
  }

describe('extractEnteLink', () => {
  test('accepts path-token and legacy ?t= spellings', () => {
    expect(extractEnteLink(linkPath)?.token).toBe(TOKEN)
    expect(extractEnteLink(linkLegacy)?.token).toBe(TOKEN)
    expect([...(extractEnteLink(linkPath)?.key ?? [])]).toEqual([...ALBUM_KEY])
  })

  test('accepts a hex key fragment', () => {
    const hex = [...ALBUM_KEY].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    expect([...(extractEnteLink(`https://albums.ente.io/${TOKEN}#${hex}`)?.key ?? [])]).toEqual([...ALBUM_KEY])
  })

  test('rejects other hosts and keyless links', () => {
    expect(extractEnteLink('https://example.com/' + TOKEN + '#key')).toBeNull()
    expect(extractEnteLink(`https://albums.ente.io/${TOKEN}`)).toBeNull()
    expect(extractEnteLink('not a url')).toBeNull()
  })
})

describe('ente identity and keyless canonicalization', () => {
  test('both spellings parse to the same album identity', () => {
    expect(enteIdentityFromUrl(linkPath)).toEqual({ kind: 'album', id: TOKEN })
    expect(enteIdentityFromUrl(linkLegacy)).toEqual({ kind: 'album', id: TOKEN })
    expect(enteIdentityFromUrl(`https://albums.ente.io/${TOKEN}/`)).toEqual({ kind: 'album', id: TOKEN })
  })

  test('keylessSourceUrl canonicalizes both spellings without the fragment', () => {
    expect(keylessSourceUrl(linkPath)).toBe(`https://albums.ente.io/${TOKEN}`)
    expect(keylessSourceUrl(linkLegacy)).toBe(`https://albums.ente.io/${TOKEN}`)
  })
})

describe('openEnteSession', () => {
  test('lists an album and materializes a decrypted original', async () => {
    const files = [fixtureFile(11, { title: 'IMG_0001.jpg', w: 6000, h: 4000 }), fixtureFile(12, { title: 'IMG_0002.jpg', w: 3000, h: 2000 })]
    const session = await openEnteSession(linkPath, fetchFor(files) as typeof fetch)
    expect(session.sourceUrl).toBe(`https://albums.ente.io/${TOKEN}`)
    const scan = await session.scan
    expect(scan.title).toBe('Monsoon')
    expect(scan.images).toHaveLength(2)
    const image = scan.images[0]!
    expect(image.filename).toBe('IMG_0001.jpg')
    expect(image.src).toBe('')
    expect(image.media).toEqual({ kind: 'encrypted', provider: 'ente', sourceKind: 'album', sourceId: TOKEN, nodeId: '11', previewId: '11' })
    expect(image.width).toBe(6000)
    expect(image.height).toBe(4000)
    expect(image.fidelity).toBe('original')
    expect(image.c2pa).toBe(true)
    const materialized = await session.materialize('11', false)
    expect([...materialized.bytes.subarray(0, 11)]).toEqual([...jpeg(6000, 4000).subarray(0, 11)])
    expect(materialized.mimeType).toBe('image/jpeg')
    session.dispose()
  })

  test('decrypts a preview through the same stream path', async () => {
    const files = [fixtureFile(21, { w: 5000, h: 3000 })]
    const session = await openEnteSession(linkPath, fetchFor(files) as typeof fetch)
    await session.scan
    const preview = await session.materialize('21', true)
    expect([...preview.bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xc0])
    session.dispose()
  })

  test('materialize resolves while the diff is still listing', async () => {
    const files = [fixtureFile(31, { w: 4000, h: 3000 })]
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('/public-collection/diff')) await gate
      return fetchFor(files)(input, init)
    }
    const session = await openEnteSession(linkPath, gated as typeof fetch)
    const out = session.materialize('31', false)
    release()
    const { bytes } = await out
    expect(bytes[0]).toBe(0xff)
    session.dispose()
  })

  test('skips deleted entries and non-image fileTypes', async () => {
    const files = [
      fixtureFile(41, { w: 4000, h: 3000 }),
      fixtureFile(42, { fileType: 1, w: 1920, h: 1080 }),
      fixtureFile(43, { deleted: true, w: 4000, h: 3000 }),
    ]
    const session = await openEnteSession(linkPath, fetchFor(files) as typeof fetch)
    const scan = await session.scan
    expect(scan.images).toHaveLength(1)
    expect(scan.images[0]!.ref).toBe('41')
    session.dispose()
  })

  test('fails closed on tampered ciphertext', async () => {
    const files = [fixtureFile(51, { w: 4000, h: 3000 })]
    const session = await openEnteSession(linkPath, fetchFor(files, { tamper: 50 }) as typeof fetch)
    await session.scan
    await expect(session.materialize('51', false)).rejects.toThrow('failed to decrypt')
    session.dispose()
  })

  test('a media reference absent from the album rejects after the listing settles', async () => {
    const files = [fixtureFile(61, { w: 4000, h: 3000 })]
    const session = await openEnteSession(linkPath, fetchFor(files) as typeof fetch)
    await session.scan
    await expect(session.materialize('999', false)).rejects.toThrow('not present')
    session.dispose()
  })

  test('password-protected links surface the KDF parameters and fail visibly', async () => {
    const files = [fixtureFile(71, { w: 4000, h: 3000 })]
    const protectedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).includes('/public-collection/info')) {
        return new Response(JSON.stringify(collection('Monsoon', [{
          url: `https://albums.ente.io/${TOKEN}`,
          passwordEnabled: true,
          nonce: b64(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)),
          opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
          memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        }])), { status: 200 })
      }
      return fetchFor(files)(input, init)
    }
    const session = await openEnteSession(linkPath, protectedFetch as typeof fetch)
    await expect(session.scan).rejects.toBeInstanceOf(EntePasswordRequired)
    session.dispose()
  })

  test('an expired or revoked link reports 410, not a generic failure', async () => {
    const session = await openEnteSession(linkPath, fetchFor([], { infoStatus: 410 }) as typeof fetch)
    await expect(session.scan).rejects.toThrow('expired or was revoked')
    session.dispose()
  })

  test('sends the issued device token back on subsequent requests', async () => {
    const files = [fixtureFile(81, { w: 4000, h: 3000 })]
    const seen: string[] = []
    const recording = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const token = new Headers(init?.headers).get('X-Auth-Link-Device-Token')
      if (token) seen.push(token)
      return fetchFor(files, { deviceToken: 'device-abc' })(input, init)
    }
    const session = await openEnteSession(linkPath, recording as typeof fetch)
    await session.scan
    expect(seen).toContain('device-abc')
    session.dispose()
  })

  test('dispose closes parked and future materialize calls', async () => {
    const files = [fixtureFile(91, { w: 4000, h: 3000 })]
    const session = await openEnteSession(linkPath, fetchFor(files) as typeof fetch)
    await session.scan
    session.dispose()
    await expect(session.materialize('91', false)).rejects.toThrow('closed')
  })
})

describe('verifyEntePassword', () => {
  test('posts a pwhash verifier and returns the JWT', async () => {
    let posted: { passHash?: string } = {}
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toContain('/public-collection/verify-password')
      posted = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ jwtToken: 'jwt-xyz' }), { status: 200 })
    }
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
    const jwt = await verifyEntePassword(TOKEN, 'correct horse', {
      nonce: b64(salt),
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    }, fetchImpl as typeof fetch)
    expect(jwt).toBe('jwt-xyz')
    expect(posted.passHash).toBeTruthy()
    expect(unb64(posted.passHash!)).toHaveLength(32)
  })
})
