import { afterAll, describe, expect, mock, test } from 'bun:test'
import { MAX_GALLERY_ITEMS } from './imagesource'
import { aesDecryptBlock, aesEncryptBlock, b64uDecode, b64uEncode, cbcDecryptZeroIv, ctrCrypt, decryptTlvRecords, ecbDecrypt, expandKey, foldKey, metaMac, verifyMegaMac } from './mega-crypto'
import { extractMegaFolder, extractMegaLink, fetchMegaFile, fetchMegaPreview, megaTransport, openMegaSession, scanMegaCollection, scanMegaFolder } from './mega-client'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))

describe('mega-crypto', () => {
  // FIPS-197 Appendix B known-answer: AES-128 encrypt of the canonical
  // plaintext under the canonical key.
  const FIPS_KEY = hex('000102030405060708090a0b0c0d0e0f')
  const FIPS_PLAIN = hex('00112233445566778899aabbccddeeff')
  const FIPS_CIPHER = hex('69c4e0d86a7b0430d8cdb78070b4c55a')

  test('AES-128 encrypt/decrypt match the FIPS-197 vector', () => {
    expect(aesEncryptBlock(expandKey(FIPS_KEY), FIPS_PLAIN)).toEqual(FIPS_CIPHER)
    expect(aesDecryptBlock(expandKey(FIPS_KEY), FIPS_CIPHER)).toEqual(FIPS_PLAIN)
  })

  test('ECB decrypt decrypts blocks independently', () => {
    const two = new Uint8Array(32)
    two.set(FIPS_CIPHER, 0)
    two.set(aesEncryptBlock(expandKey(FIPS_KEY), hex('ffeeddccbbaa99887766554433221100')), 16)
    const out = ecbDecrypt(FIPS_KEY, two)
    expect(out.subarray(0, 16)).toEqual(FIPS_PLAIN)
    expect(out.subarray(16)).toEqual(hex('ffeeddccbbaa99887766554433221100'))
  })

  test('CBC zero-IV decrypt round-trips a manual CBC encryption', () => {
    // Manually CBC-encrypt two blocks: C1 = E(P1), C2 = E(P2 ^ C1).
    const p1 = new TextEncoder().encode('MEGA{"n":"IMG_00') // 16 bytes — MEGA attr framing
    const p2 = new Uint8Array(16)
    p2.set(new TextEncoder().encode('1.jpg"}')) // zero-padded tail
    const c1 = aesEncryptBlock(expandKey(FIPS_KEY), p1)
    const c2 = aesEncryptBlock(expandKey(FIPS_KEY), p2.map((b, i) => b ^ c1[i]!))
    const cipher = new Uint8Array(32)
    cipher.set(c1, 0)
    cipher.set(c2, 16)
    const plain = cbcDecryptZeroIv(FIPS_KEY, cipher)
    expect(plain.subarray(0, 16)).toEqual(p1)
    expect(plain.subarray(16)).toEqual(p2)
  })

  test('CTR crypt is an involution with the 8-byte nonce', () => {
    const key = foldKey(hex('000102030405060708090a0b0c0d0e0f1011121314151617'))
    const nonce = hex('1011121314151617')
    const data = new Uint8Array(100).map((_, i) => i)
    const enc = ctrCrypt(key, nonce, data)
    expect(enc).not.toEqual(data)
    expect(ctrCrypt(key, nonce, enc)).toEqual(data)
  })

  test('foldKey XORs the two halves of a 32-byte file key', () => {
    const key = hex('000102030405060708090a0b0c0d0e0ffff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')
    expect(foldKey(key)).toEqual(hex('fff1f3f1f7f1f3f1fff1f3f1f7f1f3f1'))
  })

  test('b64u round-trips', () => {
    const bytes = hex('0123456789abcdef')
    expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes)
  })

  // meta-MAC known-answer vectors: the 200KB input crosses the first
  // 128KB chunk boundary, exercising the chained outer MAC. Values are
  // pinned — verified against a literal port of the reference client's
  // MAC loop across progressive and 1MB-tail chunk boundaries.
  const MAC_KEY = hex('0f1e2d3c4b5a69788796a5b4c3d2e1f0')
  const MAC_NONCE = hex('aabbccddeeff0011')

  test('metaMac matches the pinned vectors for single and multi-chunk inputs', () => {
    const small = new Uint8Array(100).map((_, i) => (i * 13 + 7) & 0xff)
    const big = new Uint8Array(200000).map((_, i) => (i * 17 + 3) & 0xff)
    expect([...metaMac(MAC_KEY, MAC_NONCE, small)].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe('68772ac9eee32891')
    expect([...metaMac(MAC_KEY, MAC_NONCE, big)].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe('6a6250e0f5c5365b')
  })

  // Boundary vectors pinned the same way: an empty file still MACs one
  // zero-length chunk; a ≤16-byte file MACs its own zero-padded bytes
  // (a ≤16-byte chunk inside a larger file MACs an empty block instead —
  // the reference's loop index overshoots); 17 bytes is the first
  // two-block shape; 393217 crosses into progressive chunk 4; 5,000,000
  // exhausts the progressive schedule and ends inside the 1MB tail.
  test('metaMac matches the pinned boundary vectors', () => {
    const file = (n: number) => new Uint8Array(n).map((_, i) => (i * 31 + 17) & 0xff)
    const mac = (n: number) => [...metaMac(MAC_KEY, MAC_NONCE, file(n))].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(mac(0)).toBe('02c9e9f5ade6a5f5')
    expect(mac(10)).toBe('cd6038c659f1591e')
    expect(mac(16)).toBe('8717d40fa41c2189')
    expect(mac(17)).toBe('4afe649b2de8ea7e')
    expect(mac(393217)).toBe('e16314227417d03a')
    expect(mac(5000000)).toBe('fa90c17cf132621a')
  })

  test('verifyMegaMac accepts the matching key tail and rejects a wrong one', () => {
    const plain = new Uint8Array(5000).map((_, i) => (i * 29 + 11) & 0xff)
    const goodKey = fileKeyFor(metaMac(MAC_KEY, MAC_NONCE, plain))
    expect(verifyMegaMac(plain, goodKey)).toBe(true)
    const badKey = goodKey.slice()
    badKey[24]! ^= 0xff
    expect(verifyMegaMac(plain, badKey)).toBe(false)
    expect(verifyMegaMac(plain.subarray(0, 4999), goodKey)).toBe(false)
  })
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

// Fixture built with the module's own crypto: a folder share key, one
// file whose node key is share-ECB-encrypted and whose attributes are
// node-CBC-encrypted — the same shapes the real API returns.
const SHARE_KEY = hex('00112233445566778899aabbccddeeff')
const SHARE_KEY_B64 = b64uEncode(SHARE_KEY)
const NODE_KEY = hex('0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccddeeff00112233445566778899')

const ecbEncrypt = (key: Uint8Array, data: Uint8Array) => {
  const out = new Uint8Array(data.length)
  for (let i = 0; i + 16 <= data.length; i += 16) out.set(aesEncryptBlock(expandKey(key), data.subarray(i, i + 16)), i)
  return out
}

const encryptAttributes = (key: Uint8Array, attrs: object) => {
  const text = `MEGA${JSON.stringify(attrs)}`
  const bytes = new TextEncoder().encode(text)
  const padded = new Uint8Array(Math.ceil(bytes.length / 16) * 16)
  padded.set(bytes)
  const aesKey = foldKey(key)
  const out = new Uint8Array(padded.length)
  let prev = new Uint8Array(16)
  for (let i = 0; i < padded.length; i += 16) {
    const block = padded.subarray(i, i + 16).map((b, j) => b ^ prev[j]!)
    const enc = aesEncryptBlock(expandKey(aesKey), block)
    out.set(enc, i)
    prev = enc
  }
  return b64uEncode(out)
}

const cbcEncryptZeroIv = (key: Uint8Array, data: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(data.length / 16) * 16)
  padded.set(data)
  const out = new Uint8Array(padded.length)
  let prev = new Uint8Array(16)
  for (let i = 0; i < padded.length; i += 16) {
    const block = padded.subarray(i, i + 16).map((b, j) => b ^ prev[j]!)
    const enc = aesEncryptBlock(expandKey(key), block)
    out.set(enc, i)
    prev = enc
  }
  return out
}

/** Builds an encrypted TLV container (AES_GCM_12_16) holding the given
 *  records — the format MEGA Sets use for `at`. */
const encryptTlv = async (key: Uint8Array, records: Record<string, string>) => {
  const parts: number[] = []
  for (const [type, value] of Object.entries(records)) {
    const valueBytes = new TextEncoder().encode(value)
    for (const c of type) parts.push(c.charCodeAt(0))
    parts.push(0, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes)
  }
  const iv = hex('aabbccddeeff00112233aabb')
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, new Uint8Array(parts)))
  const blob = new Uint8Array(1 + iv.length + cipher.length)
  blob[0] = 0x10
  blob.set(iv, 1)
  blob.set(cipher, 1 + iv.length)
  return b64uEncode(blob)
}

const FOLDER_HANDLE = 'AbCdEf12'
const FILE_HANDLE = 'FiLeHaNd'
const fileNode = (name: string, overrides: Record<string, unknown> = {}) => ({
  h: FILE_HANDLE,
  p: FOLDER_HANDLE,
  t: 0,
  a: encryptAttributes(NODE_KEY, { n: name }),
  k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, NODE_KEY))}`,
  s: 1000,
  ...overrides,
})
const folderNode = { h: FOLDER_HANDLE, p: '', t: 1, a: encryptAttributes(SHARE_KEY, { n: 'Monsoon' }), k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, SHARE_KEY))}` }

describe('extractMegaFolder', () => {
  test('parses modern and legacy folder links', () => {
    expect(extractMegaFolder(`https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`)?.folder).toBe(FOLDER_HANDLE)
    expect(extractMegaFolder(`https://mega.co.nz/#F!${FOLDER_HANDLE}!${SHARE_KEY_B64}`)?.key).toBe(SHARE_KEY_B64)
    expect(extractMegaFolder(`https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}/file/xyz`)?.folder).toBe(FOLDER_HANDLE)
  })

  test('rejects non-MEGA and keyless links', () => {
    expect(extractMegaFolder('https://mega.nz/file/abc#def')).toBeNull()
    expect(extractMegaFolder(`https://mega.nz/folder/${FOLDER_HANDLE}`)).toBeNull()
    expect(extractMegaFolder('https://dropbox.com/sh/abc')).toBeNull()
  })
})

describe('scanMegaFolder', () => {
  const link = `https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`

  test('decrypts node keys and attributes, mapping image files to gallery images', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('cs?')) {
        return jsonResponse([{ f: [
          folderNode,
          fileNode('IMG_0001.jpg'),
          fileNode('notes.txt', { h: 'TxT1' }),
          { h: 'Sub1', p: FOLDER_HANDLE, t: 1, a: encryptAttributes(SHARE_KEY, { n: 'sub' }), k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, NODE_KEY))}` },
        ] }])
      }
      if (url.includes('g.mega')) return jsonResponse({}, 404)
      // a=g download-info + ranged head fetch for the JPEG dims probe
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        const enc = ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), jpegHead())
        return new Response(enc, { status: 200 })
      }
      return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
    }
    // Route a=g calls (cs with n= query and 'g' command) vs folder fetch.
    const routed = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (String(input).includes('cs?') && body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      return fetchImpl(input)
    }
    const scan = await scanMegaFolder(link, routed as typeof fetch)
    expect(scan.sourceUrl).toBe(`https://mega.nz/folder/${FOLDER_HANDLE}`)
    expect(scan.title).toBe('Monsoon')
    expect(scan.images).toHaveLength(1)
    const image = scan.images[0]!
    expect(image.ref).toBe(FILE_HANDLE)
    expect(image.filename).toBe('IMG_0001.jpg')
    expect(image.src).toBe('')
    expect(image.media).toEqual({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: FOLDER_HANDLE, nodeId: FILE_HANDLE, previewId: undefined })
    expect(image.contentVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(image.c2pa).toBe(true)
    expect(image.width).toBe(6000)
    expect(image.height).toBe(4000)
  })

  test('fails friendly when the folder is not found', async () => {
    const fetchImpl = async () => jsonResponse([-9])
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('not found')
  })

  test('refuses a folder over the item limit before spending a single probe', async () => {
    const files = Array.from({ length: MAX_GALLERY_ITEMS + 1 }, (_, i) => fileNode(`IMG_${i}.jpg`, { h: `H${i}` }))
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return jsonResponse([{ f: [folderNode, ...files] }])
    }
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('limited to 1,000 items')
    expect(calls).toBe(1)
  })

  test('does not refuse a folder at the item limit', async () => {
    // A full 1000-item probe pass is inherently slow; the boundary pin is
    // that the count check does not fire at MAX — so the scan must die by
    // the session closing mid-probe, never by the item-limit message.
    const files = Array.from({ length: MAX_GALLERY_ITEMS }, (_, i) => fileNode(`IMG_${i}.jpg`, { h: `H${i}` }))
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?') && body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, ...files] }])
      return jsonResponse({}, 500)
    }
    const session = await openMegaSession(link, fetchImpl as typeof fetch)
    session.dispose()
    await expect(session.scan).rejects.toThrow('session is closed')
  })

  test('fails friendly when no decryptable images exist', async () => {
    const fetchImpl = async () => jsonResponse([{ f: [folderNode, fileNode('notes.txt')] }])
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('No image files')
  })

  test('rejects links without a key', async () => {
    await expect(scanMegaFolder(`https://mega.nz/folder/${FOLDER_HANDLE}`)).rejects.toThrow('folder link')
  })

  test('serves HEIC originals through the file proxy; the preview stays the rail variant', async () => {
    const heicNode = fileNode('IMG_9.heic', { fa: `1*${FA_HANDLE}` })
    const jpeg = jpegHead()
    const record = new Uint8Array(12 + Math.ceil(jpeg.length / 16) * 16)
    record.set(b64uDecode(FA_HANDLE), 0)
    new DataView(record.buffer).setUint32(8, record.length - 12, true)
    record.set(cbcEncryptZeroIv(foldKey(NODE_KEY), jpeg), 12)
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      // The ufa POST body is the raw 8-byte attribute handle, not JSON.
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, heicNode] }])
        if (body[0]?.a === 'ufa') return jsonResponse([{ p: 'https://gfs262n002.userstorage.mega.co.nz/post' }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      }
      if (url === 'https://gfs262n002.userstorage.mega.co.nz/post') return new Response(record, { status: 200 })
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        return new Response(ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), heicHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    const image = scan.images[0]!
    expect(image.src).toBe('')
    expect(image.media).toEqual({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: FOLDER_HANDLE, nodeId: FILE_HANDLE, previewId: undefined })
    expect(image.contentVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(image.variants?.[0]?.src).toBe('')
    expect(image.variants?.[0]?.media).toMatchObject({ kind: 'encrypted', provider: 'mega', previewId: FA_HANDLE })
    // Declared dims are the original's ispe box, not the rendition's.
    expect(image.width).toBe(12110)
    expect(image.height).toBe(3772)
  })

  test('keeps a HEIC with no MEGA preview — the original decodes client-side', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, fileNode('IMG_9.heic')] }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      }
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        return new Response(ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), heicHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    const image = scan.images[0]!
    expect(image.src).toBe('')
    expect(image.media).toEqual({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: FOLDER_HANDLE, nodeId: FILE_HANDLE, previewId: undefined })
    expect(image.contentVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(image.variants).toBeUndefined()
    expect(image.width).toBe(12110)
    expect(image.height).toBe(3772)
  })

  test('tries every k alternative — the first is not always the valid key', async () => {
    const wrongKey = hex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    const node = {
      ...fileNode('multi.jpg'),
      k: `otherScope:${b64uEncode(ecbEncrypt(SHARE_KEY, wrongKey))}/${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, NODE_KEY))}`,
    }
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, node] }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      }
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        return new Response(ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), jpegHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images.map((image) => image.filename)).toEqual(['multi.jpg'])
    // The valid key remains client-side in the session; the published ref
    // carries only a keyless handle and an opaque change detector.
    expect(scan.images[0]!.contentVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(scan.images[0]!.src).not.toContain(b64uEncode(NODE_KEY).slice(0, 16))
  })

  test('finds images nested inside a subfolder of the share', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [
          { h: 'Sub1', p: 'ParentHandle', t: 1, a: encryptAttributes(SHARE_KEY, { n: 'nested' }), k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, SHARE_KEY))}` },
          fileNode('deep.jpg', { p: 'Sub1' }),
        ] }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      }
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        return new Response(ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), jpegHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images.map((image) => image.filename)).toEqual(['deep.jpg'])
  })

  test('emits the decrypted preview as the rail variant so admin never loads originals', async () => {
    const node = fileNode('IMG_0002.jpg', { fa: `1*${FA_HANDLE}` })
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (String(input).includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, node] }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
        if (body[0]?.a === 'ufa') return jsonResponse({ p: 'https://gfs262n001.userstorage.mega.co.nz/attr' })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    const image = scan.images[0]!
    expect(image.src).toBe('')
    expect(image.variants?.[0]?.src).toBe('')
    expect(image.variants?.[0]?.media).toMatchObject({ kind: 'encrypted', provider: 'mega', previewId: FA_HANDLE })
  })

  test('accepts AVIF and consciously ignores PNG, GIF, and TIFF', async () => {
    const fetchImpl = async () => jsonResponse([{ f: [
      folderNode,
      fileNode('a.avif', { h: 'AvIf' }),
      fileNode('b.png', { h: 'Png1' }),
      fileNode('c.gif', { h: 'Gif1' }),
      fileNode('d.tiff', { h: 'Tiff' }),
      fileNode('e.mp4', { h: 'Vid1' }),
    ] }])
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images.map((image) => image.filename)).toEqual(['a.avif'])
    expect(scan.images[0]!.src).toBe('')
  })
})

const SET_HANDLE = 'SeThAnDlE1'
const COLLECTION_HANDLE = 'MzBkCAJQ'
const ELEMENT_KEY = NODE_KEY // element keys are the node file keys
const FA_HANDLE = b64uEncode(hex('0102030405060708'))

const setElement = (node: string, order: number) => ({
  id: `el${node}`,
  s: SET_HANDLE,
  h: node,
  k: b64uEncode(cbcEncryptZeroIv(SHARE_KEY, ELEMENT_KEY)),
  o: order,
})

describe('extractMegaLink collections', () => {
  test('parses /collection/ links and legacy #C! fragments', () => {
    const link = extractMegaLink(`https://mega.nz/collection/${COLLECTION_HANDLE}#${SHARE_KEY_B64}`)
    expect(link).toEqual({ kind: 'collection', id: COLLECTION_HANDLE, key: SHARE_KEY_B64 })
    expect(extractMegaLink(`https://mega.nz/#C!${COLLECTION_HANDLE}!${SHARE_KEY_B64}`)?.kind).toBe('collection')
    expect(extractMegaLink(`https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`)?.kind).toBe('folder')
  })
})

describe('decryptTlvRecords', () => {
  test('decrypts a GCM TLV container into records', async () => {
    const blob = b64uDecode(await encryptTlv(SHARE_KEY, { n: 'My Set' }))
    const records = await decryptTlvRecords(SHARE_KEY, blob)
    expect(new TextDecoder().decode(records?.get('n'))).toBe('My Set')
  })
})

describe('scanMegaCollection', () => {
  const link = `https://mega.nz/collection/${COLLECTION_HANDLE}#${SHARE_KEY_B64}`

  test('decrypts element keys and node metadata, honoring element order', async () => {
    const setAttrs = await encryptTlv(SHARE_KEY, { n: 'Bangkok Plates' })
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes(`cs?`) && body[0]?.a === 'aft') {
        expect(url).toContain(`&s=${COLLECTION_HANDLE}`)
        expect(body[0]?.v).toBe(2)
        return jsonResponse([{
          s: [{ id: SET_HANDLE, at: setAttrs }],
          e: [setElement('nodeB', 2), setElement('nodeA', 1)],
          n: [
            { h: 'nodeA', s: 10, at: encryptAttributes(ELEMENT_KEY, { n: 'a.jpg' }) },
            { h: 'nodeB', s: 10, at: encryptAttributes(ELEMENT_KEY, { n: 'b.jpg' }) },
          ],
        }])
      }
      if (url.includes('cs?') && body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: DIMS_HEAD_LEN })
      if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
        return new Response(ctrCrypt(foldKey(ELEMENT_KEY), ELEMENT_KEY.subarray(16, 24), jpegHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaCollection(link, fetchImpl as typeof fetch)
    expect(scan.title).toBe('Bangkok Plates')
    expect(scan.sourceUrl).toBe(`https://mega.nz/collection/${COLLECTION_HANDLE}`)
    expect(scan.images.map((image) => image.filename)).toEqual(['a.jpg', 'b.jpg'])
    expect(scan.images[0]!.media).toMatchObject({ kind: 'encrypted', provider: 'mega', sourceKind: 'collection', sourceId: COLLECTION_HANDLE, nodeId: 'nodeA' })
  })

  test('fails friendly when the collection is not found', async () => {
    const fetchImpl = async () => jsonResponse([-9])
    await expect(scanMegaCollection(link, fetchImpl as typeof fetch)).rejects.toThrow('not found')
  })

  test('refuses a collection over the item limit before spending a single probe', async () => {
    const setAttrs = await encryptTlv(SHARE_KEY, { n: 'Too many' })
    const elements = Array.from({ length: MAX_GALLERY_ITEMS + 1 }, (_, i) => setElement(`node${i}`, i))
    const meta = elements.map((element) => ({ h: element.h, s: 10, at: encryptAttributes(ELEMENT_KEY, { n: `${element.h}.jpg` }) }))
    let calls = 0
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls += 1
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      expect(body[0]?.a).toBe('aft')
      return jsonResponse([{ s: [{ id: SET_HANDLE, at: setAttrs }], e: elements, n: meta }])
    }
    await expect(scanMegaCollection(link, fetchImpl as typeof fetch)).rejects.toThrow('limited to 1,000 items')
    expect(calls).toBe(1)
  })

  test('rejects a folder link', async () => {
    await expect(scanMegaCollection(`https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`)).rejects.toThrow('collection link')
  })
})

describe('fetchMegaPreview', () => {
  test('posts the attribute handle and returns the decrypted JPEG', async () => {
    const jpeg = jpegHead()
    const record = new Uint8Array(12 + Math.ceil(jpeg.length / 16) * 16)
    record.set(b64uDecode(FA_HANDLE), 0)
    new DataView(record.buffer).setUint32(8, record.length - 12, true)
    record.set(cbcEncryptZeroIv(foldKey(ELEMENT_KEY), jpeg), 12)
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body
      if (url.includes('cs?') && typeof body === 'string' && JSON.parse(body)[0]?.a === 'ufa') {
        const arg = JSON.parse(body)[0]
        expect(b64uDecode(String(arg.fah)).length).toBe(8)
        return jsonResponse([{ p: 'https://gfs262n002.userstorage.mega.co.nz/post' }])
      }
      if (url === 'https://gfs262n002.userstorage.mega.co.nz/post') {
        expect(init?.method).toBe('POST')
        expect(new Uint8Array(body as ArrayBuffer)).toEqual(b64uDecode(FA_HANDLE))
        return new Response(record, { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const response = await fetchMegaPreview(FOLDER_HANDLE, undefined, FA_HANDLE, b64uEncode(ELEMENT_KEY), fetchImpl as typeof fetch)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer()).subarray(0, 10)).toEqual(jpeg.subarray(0, 10))
  })
})

// Minimal valid ISO-BMFF head: 'ftypheic' then an ispe box declaring
// 12110x3772 — the panorama dims the live HEICs carry.
const heicHead = () => {
  const bytes = new Uint8Array(DIMS_HEAD_LEN)
  bytes.set([0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], 4) // 'ftypheic'
  bytes.set([0x69, 0x73, 0x70, 0x65], 64) // 'ispe' at offset 64
  new DataView(bytes.buffer).setUint32(72, 12110)
  new DataView(bytes.buffer).setUint32(76, 3772)
  return bytes
}

// Minimal valid JPEG header with a SOF0 frame declaring 6000x4000.
const DIMS_HEAD_LEN = 4096
const jpegHead = () => {
  const bytes = new Uint8Array(DIMS_HEAD_LEN)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xc0
  bytes[4] = 0x00
  bytes[5] = 0x11
  bytes[7] = 0x0f // height 4000 = 0x0fa0
  bytes[8] = 0xa0
  bytes[9] = 0x17 // width 6000 = 0x1770
  bytes[10] = 0x70
  return bytes
}

// A 32-byte file key is obfuscatedKey(16) ∥ nonce(8) ∥ metaMac(8), where
// obfuscatedKey = fileKey ⊕ (nonce ∥ metaMac). Building it this way keeps
// foldKey and the nonce stable while the expected MAC varies.
const MAC_FILE_KEY = hex('0f1e2d3c4b5a69788796a5b4c3d2e1f0')
const MAC_FILE_NONCE = hex('aabbccddeeff0011')
const fileKeyFor = (meta: Uint8Array) => {
  const tail = new Uint8Array(16)
  tail.set(MAC_FILE_NONCE, 0)
  tail.set(meta, 8)
  const key = new Uint8Array(32)
  key.set(MAC_FILE_KEY.map((b, i) => b ^ tail[i]!), 0)
  key.set(tail, 16)
  return key
}

describe('fetchMegaFile', () => {
  const PLAIN = new Uint8Array(300000).map((_, i) => (i * 41 + 19) & 0xff)
  const CIPHER = ctrCrypt(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN)

  const fetchImpl = (size = PLAIN.length, bytes = CIPHER) => async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    if (url.includes('cs?')) return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: size })
    if (url.startsWith('https://gfs262n001.userstorage.mega.co.nz/')) {
      const [, start, end] = url.match(/\/(\d+)-(\d+)$/) ?? []
      return new Response(bytes.subarray(Number(start), Number(end) + 1).slice(), { status: 200 })
    }
    return jsonResponse({}, 404)
  }

  test('serves decrypted bytes when the meta-MAC matches', async () => {
    const key = fileKeyFor(metaMac(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN))
    const response = await fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64uEncode(key), fetchImpl() as typeof fetch)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PLAIN)
  })

  test('rejects a full-file fetch when the meta-MAC mismatches', async () => {
    const key = fileKeyFor(new Uint8Array(8))
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64uEncode(key), fetchImpl() as typeof fetch)).rejects.toThrow('integrity check')
  })

  test('rejects corrupted ciphertext even though it decrypts cleanly', async () => {
    const tampered = CIPHER.slice()
    tampered[150000]! ^= 0xff
    const key = fileKeyFor(metaMac(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN))
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64uEncode(key), fetchImpl(PLAIN.length, tampered) as typeof fetch)).rejects.toThrow('integrity check')
  })

  test('serves ranged reads unverified — the MAC cannot cover a window', async () => {
    const key = fileKeyFor(new Uint8Array(8)) // wrong MAC, accepted for ranges
    const response = await fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64uEncode(key), fetchImpl() as typeof fetch, 'bytes=17-40')
    expect(response.status).toBe(206)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PLAIN.subarray(17, 41))
    expect(response.headers.get('Content-Range')).toBe(`bytes 17-40/${PLAIN.length}`)
  })
})

describe('openMegaSession', () => {
  const link = `https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`

  test('materializes off the listing while the probe pass is still running', async () => {
    // One ciphertext serves both the materialize path and the head probe:
    // foldKey(fileKey) is the shared CTR key, so the head's JPEG SOF dims
    // parse for the probe while the whole file verifies its meta-MAC.
    const PLAIN = jpegHead()
    const CIPHER = ctrCrypt(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN)
    const fileKey = fileKeyFor(metaMac(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN))
    const file = fileNode('IMG_0001.jpg', {
      a: encryptAttributes(fileKey, { n: 'IMG_0001.jpg' }),
      k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, fileKey))}`,
      fa: `1*${b64uEncode(new Uint8Array(8).fill(9))}`,
      s: PLAIN.length,
    })
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
    const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'ufa') { await probeGate; return jsonResponse({}) }
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: PLAIN.length })
        return jsonResponse([{ f: [folderNode, file] }])
      }
      const [, start, end] = url.match(/\/(\d+)-(\d+)$/) ?? []
      return new Response(CIPHER.subarray(Number(start), Number(end) + 1).slice(), { status: 200 })
    }
    const session = await openMegaSession(link, impl as typeof fetch)
    let scanSettled = false
    const scanPromise = session.scan.then((scan) => { scanSettled = true; return scan })
    const materialized = await session.materialize(FILE_HANDLE)
    // The probe is still gated — materialize worked off the listed keys alone.
    expect(scanSettled).toBe(false)
    expect(materialized.mimeType).toBe('image/jpeg')
    expect(materialized.bytes).toEqual(PLAIN)
    releaseProbe()
    const scan = await scanPromise
    expect(scan.images).toHaveLength(1)
    expect(scan.images[0]!.width).toBe(6000)
    session.dispose()
    await expect(session.materialize(FILE_HANDLE)).rejects.toThrow('closed')
  })

  test('materializes a known item while the share listing is still in flight', async () => {
    const PLAIN = jpegHead()
    const CIPHER = ctrCrypt(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN)
    const fileKey = fileKeyFor(metaMac(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN))
    const file = fileNode('IMG_0001.jpg', {
      a: encryptAttributes(fileKey, { n: 'IMG_0001.jpg' }),
      k: `${FOLDER_HANDLE}:${b64uEncode(ecbEncrypt(SHARE_KEY, fileKey))}`,
      s: PLAIN.length,
    })
    let releaseListing!: () => void
    const listingGate = new Promise<void>((resolve) => { releaseListing = resolve })
    const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') { await listingGate; return jsonResponse([{ f: [folderNode, file] }]) }
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://gfs262n001.userstorage.mega.co.nz/file', s: PLAIN.length })
        return jsonResponse({})
      }
      const [, start, end] = url.match(/\/(\d+)-(\d+)$/) ?? []
      return new Response(CIPHER.subarray(Number(start), Number(end) + 1).slice(), { status: 200 })
    }
    const session = await openMegaSession(link, impl as typeof fetch)
    let settled = false
    const materialized = session.materialize(FILE_HANDLE).then((result) => { settled = true; return result })
    await Promise.resolve()
    // The listing fetch is still gated — materialize is parked on the key.
    expect(settled).toBe(false)
    releaseListing()
    expect((await materialized).bytes).toEqual(PLAIN)
    session.dispose()
  })

  test('a materialize for an absent node rejects when the listing settles', async () => {
    let releaseListing!: () => void
    const listingGate = new Promise<void>((resolve) => { releaseListing = resolve })
    const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') { await listingGate; return jsonResponse([{ f: [folderNode, fileNode('IMG_0001.jpg')] }]) }
        return jsonResponse({})
      }
      return jsonResponse({}, 404)
    }
    const session = await openMegaSession(link, impl as typeof fetch)
    let rejected = false
    const absent = session.materialize('NoSuchHdl').then(
      () => { throw new Error('resolved unexpectedly') },
      (error: unknown) => { rejected = true; throw error },
    )
    await Promise.resolve()
    expect(rejected).toBe(false) // parked, not refused — the listing has not landed
    releaseListing()
    await expect(absent).rejects.toThrow('not present')
    session.dispose()
  })

  test('dispose rejects a materialize parked on the listing', async () => {
    let releaseListing!: () => void
    const listingGate = new Promise<void>((resolve) => { releaseListing = resolve })
    const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (url.includes('cs?')) {
        if (body[0]?.a === 'f') { await listingGate; return jsonResponse([{ f: [folderNode, fileNode('IMG_0001.jpg')] }]) }
        return jsonResponse({})
      }
      return jsonResponse({}, 404)
    }
    const session = await openMegaSession(link, impl as typeof fetch)
    const parked = session.materialize(FILE_HANDLE)
    await Promise.resolve()
    session.dispose()
    await expect(parked).rejects.toThrow('closed')
    releaseListing()
    await expect(session.scan).rejects.toThrow('closed')
  })
})

describe('CDN host allowlist', () => {
  const PLAIN = new Uint8Array(1024).map((_, i) => (i * 7 + 3) & 0xff)
  const CIPHER = ctrCrypt(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN)
  const key = fileKeyFor(metaMac(MAC_FILE_KEY, MAC_FILE_NONCE, PLAIN))
  const b64Key = b64uEncode(key)

  // cdn calls are counted separately from the API call so a refused host
  // is provably never fetched.
  const fetchImpl = (g: string, cdnCalls: string[], cdn?: (url: string) => Response) => async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('cs?')) return jsonResponse({ g, s: PLAIN.length })
    cdnCalls.push(url)
    return cdn?.(url) ?? jsonResponse({}, 404)
  }
  const cdnBytes = (url: string) => {
    const [, start, end] = url.match(/\/(\d+)-(\d+)$/) ?? []
    return new Response(CIPHER.subarray(Number(start), Number(end) + 1).slice(), { status: 200 })
  }

  test('refuses a download URL on a non-allowlisted host before fetching it', async () => {
    const cdnCalls: string[] = []
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64Key,
      fetchImpl('https://evil.example/file', cdnCalls, cdnBytes) as typeof fetch)).rejects.toThrow('allowed download host')
    expect(cdnCalls).toHaveLength(0)
  })

  test('refuses a download URL that is not https', async () => {
    const cdnCalls: string[] = []
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64Key,
      fetchImpl('http://gfs1.userstorage.mega.co.nz/file', cdnCalls, cdnBytes) as typeof fetch)).rejects.toThrow('allowed download host')
    expect(cdnCalls).toHaveLength(0)
  })

  test('refuses a redirect to a non-allowlisted host', async () => {
    const cdnCalls: string[] = []
    const hop = (url: string) => url.includes('userstorage')
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/stolen' } })
      : cdnBytes(url)
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64Key,
      fetchImpl('https://gfs262n001.userstorage.mega.co.nz/file', cdnCalls, hop) as typeof fetch)).rejects.toThrow('redirected off its host')
  })

  test('refuses a redirect with no readable target — the browser opaqueredirect case', async () => {
    const cdnCalls: string[] = []
    const hop = () => new Response(null, { status: 302 })
    await expect(fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64Key,
      fetchImpl('https://gfs262n001.userstorage.mega.co.nz/file', cdnCalls, hop) as typeof fetch)).rejects.toThrow('redirected off its host')
  })

  test('follows a redirect that stays inside the allowlist', async () => {
    const cdnCalls: string[] = []
    // A real CDN host-move keeps the request path — the signed suffix is
    // part of the URL MEGA issued.
    const hop = (url: string) => url.startsWith('https://gfs262n001')
      ? new Response(null, { status: 302, headers: { location: url.replace('gfs262n001', 'gfs999n042') } })
      : cdnBytes(url)
    const response = await fetchMegaFile(FOLDER_HANDLE, undefined, FILE_HANDLE, b64Key,
      fetchImpl('https://gfs262n001.userstorage.mega.co.nz/file', cdnCalls, hop) as typeof fetch)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PLAIN)
    expect(cdnCalls).toHaveLength(2)
    expect(cdnCalls[1]).toContain('gfs999n042')
  })

  test('fetchMegaPreview refuses a non-allowlisted attribute host', async () => {
    const cdnCalls: string[] = []
    const impl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('cs?')) return jsonResponse({ p: 'https://evil.example/post' })
      cdnCalls.push(url)
      return jsonResponse({}, 404)
    }
    const fah = b64uEncode(new Uint8Array(8).fill(7))
    await expect(fetchMegaPreview(FOLDER_HANDLE, undefined, fah, b64Key, impl as typeof fetch)).rejects.toThrow('allowed download host')
    expect(cdnCalls).toHaveLength(0)
  })
})

describe('megaTransport', () => {
  // This file runs without the DOM preload — `window` is undefined, so the
  // shell branch is reached by defining the global the checks read.
  const glob = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }

  afterAll(() => {
    delete glob.window
    // mock.module is process-global — restore the real plugin binding so a
    // sibling file never sees this stub.
    mock.restore()
  })

  test('rides the native http plugin under a shell and translates manual redirects', async () => {
    const inits: Array<Record<string, unknown>> = []
    mock.module('@tauri-apps/plugin-http', () => ({
      fetch: async (_input: unknown, init?: Record<string, unknown>) => {
        inits.push(init ?? {})
        return new Response('ok')
      },
    }))
    glob.window = { __TAURI_INTERNALS__: {} }
    try {
      const transport = await megaTransport()
      await transport('https://gfs262n001.userstorage.mega.co.nz/dl/x', { redirect: 'manual' })
      await transport('https://g.api.mega.co.nz/cs')
      expect(inits[0].maxRedirections).toBe(0)
      expect(inits[1].maxRedirections).toBeUndefined()
    } finally {
      delete glob.window
    }
  })

  test('keeps plain fetch outside a shell', async () => {
    delete glob.window
    const transport = await megaTransport()
    expect(transport).toBe(fetch)
  })
})
