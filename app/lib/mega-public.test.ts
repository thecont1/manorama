import { describe, expect, test } from 'bun:test'
import { aesDecryptBlock, aesEncryptBlock, b64uDecode, b64uEncode, cbcDecryptZeroIv, ctrCrypt, decryptTlvRecords, ecbDecrypt, expandKey, foldKey } from './mega-crypto'
import { extractMegaFolder, extractMegaLink, fetchMegaPreview, scanMegaCollection, scanMegaFolder } from './mega-public'

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
      if (url.startsWith('https://cdntest/')) {
        const enc = ctrCrypt(foldKey(NODE_KEY), NODE_KEY.subarray(16, 24), jpegHead())
        return new Response(enc, { status: 200 })
      }
      return jsonResponse({ g: 'https://cdntest/file', s: DIMS_HEAD_LEN })
    }
    // Route a=g calls (cs with n= query and 'g' command) vs folder fetch.
    const routed = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (String(input).includes('cs?') && body[0]?.a === 'g') return jsonResponse({ g: 'https://cdntest/file', s: DIMS_HEAD_LEN })
      return fetchImpl(input)
    }
    const scan = await scanMegaFolder(link, routed as typeof fetch)
    expect(scan.sourceUrl).toBe(`https://mega.nz/folder/${FOLDER_HANDLE}#${SHARE_KEY_B64}`)
    expect(scan.title).toBe('Monsoon')
    expect(scan.images).toHaveLength(1)
    const image = scan.images[0]!
    expect(image.ref).toBe(FILE_HANDLE)
    expect(image.filename).toBe('IMG_0001.jpg')
    expect(image.src).toContain(`/api/mega/file?folder=${FOLDER_HANDLE}&node=${FILE_HANDLE}&k=`)
    expect(image.c2pa).toBe(true)
    expect(image.width).toBe(6000)
    expect(image.height).toBe(4000)
  })

  test('fails friendly when the folder is not found', async () => {
    const fetchImpl = async () => jsonResponse([-9])
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('not found')
  })

  test('fails friendly when no decryptable images exist', async () => {
    const fetchImpl = async () => jsonResponse([{ f: [folderNode, fileNode('notes.txt')] }])
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('No image files')
  })

  test('rejects links without a key', async () => {
    await expect(scanMegaFolder(`https://mega.nz/folder/${FOLDER_HANDLE}`)).rejects.toThrow('folder link')
  })

  test('routes non-renderable originals through the JPEG preview proxy', async () => {
    const heicNode = fileNode('IMG_9.heic', { fa: `1*${FA_HANDLE}` })
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (String(input).includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, heicNode] }])
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    expect(scan.images[0]!.src).toContain(`/api/mega/preview?folder=${FOLDER_HANDLE}&h=${FA_HANDLE}&k=`)
  })

  test('drops non-renderable originals with no preview available', async () => {
    const fetchImpl = async () => jsonResponse([{ f: [folderNode, fileNode('IMG_9.heic')] }])
    await expect(scanMegaFolder(link, fetchImpl as typeof fetch)).rejects.toThrow('No image files')
  })

  test('emits the decrypted preview as the rail variant so admin never loads originals', async () => {
    const node = fileNode('IMG_0002.jpg', { fa: `1*${FA_HANDLE}` })
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown>[] : []
      if (String(input).includes('cs?')) {
        if (body[0]?.a === 'f') return jsonResponse([{ f: [folderNode, node] }])
        if (body[0]?.a === 'g') return jsonResponse({ g: 'https://cdntest/file', s: DIMS_HEAD_LEN })
        if (body[0]?.a === 'ufa') return jsonResponse({ p: 'https://cdntest/attr' })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaFolder(link, fetchImpl as typeof fetch)
    const image = scan.images[0]!
    expect(image.src).toContain('/api/mega/file?')
    expect(image.variants?.[0]?.src).toContain(`/api/mega/preview?folder=${FOLDER_HANDLE}&h=${FA_HANDLE}&k=`)
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
    expect(scan.images[0]!.src).toContain('/api/mega/file?')
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
      if (url.includes('cs?') && body[0]?.a === 'g') return jsonResponse({ g: 'https://cdntest/file', s: DIMS_HEAD_LEN })
      if (url.startsWith('https://cdntest/')) {
        return new Response(ctrCrypt(foldKey(ELEMENT_KEY), ELEMENT_KEY.subarray(16, 24), jpegHead()), { status: 200 })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanMegaCollection(link, fetchImpl as typeof fetch)
    expect(scan.title).toBe('Bangkok Plates')
    expect(scan.sourceUrl).toBe(link)
    expect(scan.images.map((image) => image.filename)).toEqual(['a.jpg', 'b.jpg'])
    expect(scan.images[0]!.src).toContain(`/api/mega/file?set=${COLLECTION_HANDLE}&node=nodeA&k=`)
  })

  test('fails friendly when the collection is not found', async () => {
    const fetchImpl = async () => jsonResponse([-9])
    await expect(scanMegaCollection(link, fetchImpl as typeof fetch)).rejects.toThrow('not found')
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
        return jsonResponse([{ p: 'https://fa.test/post' }])
      }
      if (url === 'https://fa.test/post') {
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
