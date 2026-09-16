/**
 * Minimal AES-128 (encrypt + decrypt) plus the MEGA key/CTR helpers.
 *
 * Pure JS rather than WebCrypto for two MEGA-specific reasons:
 *  - Node keys are AES-ECB encrypted, which WebCrypto does not expose.
 *  - Attribute blobs are zero-padded, not PKCS7, so WebCrypto's
 *    AES-CBC decrypt rejects them.
 *
 * S-boxes are generated at module load instead of embedding 512 table
 * constants — keeps the source small and self-auditing.
 */

// --- AES tables (generated) -------------------------------------------------

const mul2 = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff
const mulGf = (a: number, b: number) => {
  let r = 0
  for (; b; b >>= 1) {
    if (b & 1) r ^= a
    a = mul2(a)
  }
  return r
}

const buildTables = () => {
  const sbox = new Uint8Array(256)
  const invSbox = new Uint8Array(256)
  // Multiplicative inverse in GF(2^8), then the affine transform.
  const inv = new Uint8Array(256)
  inv[1] = 1
  for (let i = 2; i < 256; i++) {
    for (let j = 2; j < 256; j++) {
      if (mulGf(i, j) === 1) { inv[i] = j; break }
    }
  }
  for (let i = 0; i < 256; i++) {
    const x = inv[i]
    sbox[i] = x ^ ((x << 1) | (x >> 7)) ^ ((x << 2) | (x >> 6)) ^ ((x << 3) | (x >> 5)) ^ ((x << 4) | (x >> 4)) ^ 0x63
    invSbox[sbox[i]] = i
  }
  return { sbox, invSbox }
}
const { sbox, invSbox } = buildTables()

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

const expandKey = (key: Uint8Array) => {
  // 11 round keys of 16 bytes each.
  const w = new Uint8Array(176)
  w.set(key.slice(0, 16))
  for (let i = 16; i < 176; i += 4) {
    let t = [w[i - 4]!, w[i - 3]!, w[i - 2]!, w[i - 1]!]
    if (i % 16 === 0) {
      t = [sbox[t[1]!]!, sbox[t[2]!]!, sbox[t[3]!]!, sbox[t[0]!]!]
      t[0]! ^= RCON[i / 16 - 1]!
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j]! ^ t[j]!
  }
  return w
}

const addRoundKey = (s: Uint8Array, w: Uint8Array, round: number) => {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]!
}

const subBytes = (s: Uint8Array, box: Uint8Array) => {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]!]!
}

// State is column-major: byte i sits at row i%4, column floor(i/4).
const shiftRows = (s: Uint8Array) => {
  const t = s.slice()
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r]!
  }
}
const invShiftRows = (s: Uint8Array) => {
  const t = s.slice()
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[c * 4 + r] = t[((c - r + 4) % 4) * 4 + r]!
  }
}

const mixColumns = (s: Uint8Array) => {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const [a0, a1, a2, a3] = [s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!]
    s[i] = mul2(a0) ^ (mul2(a1) ^ a1) ^ a2 ^ a3
    s[i + 1] = a0 ^ mul2(a1) ^ (mul2(a2) ^ a2) ^ a3
    s[i + 2] = a0 ^ a1 ^ mul2(a2) ^ (mul2(a3) ^ a3)
    s[i + 3] = (mul2(a0) ^ a0) ^ a1 ^ a2 ^ mul2(a3)
  }
}
const invMixColumns = (s: Uint8Array) => {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const [a0, a1, a2, a3] = [s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!]
    s[i] = mulGf(a0, 14) ^ mulGf(a1, 11) ^ mulGf(a2, 13) ^ mulGf(a3, 9)
    s[i + 1] = mulGf(a0, 9) ^ mulGf(a1, 14) ^ mulGf(a2, 11) ^ mulGf(a3, 13)
    s[i + 2] = mulGf(a0, 13) ^ mulGf(a1, 9) ^ mulGf(a2, 14) ^ mulGf(a3, 11)
    s[i + 3] = mulGf(a0, 11) ^ mulGf(a1, 13) ^ mulGf(a2, 9) ^ mulGf(a3, 14)
  }
}

export const aesEncryptBlock = (key: Uint8Array, block: Uint8Array) => {
  const w = expandKey(key)
  const s = block.slice(0, 16)
  addRoundKey(s, w, 0)
  for (let round = 1; round < 10; round++) {
    subBytes(s, sbox)
    shiftRows(s)
    mixColumns(s)
    addRoundKey(s, w, round)
  }
  subBytes(s, sbox)
  shiftRows(s)
  addRoundKey(s, w, 10)
  return s
}

export const aesDecryptBlock = (key: Uint8Array, block: Uint8Array) => {
  const w = expandKey(key)
  const s = block.slice(0, 16)
  addRoundKey(s, w, 10)
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s)
    subBytes(s, invSbox)
    addRoundKey(s, w, round)
    invMixColumns(s)
  }
  invShiftRows(s)
  subBytes(s, invSbox)
  addRoundKey(s, w, 0)
  return s
}

// --- MEGA helpers -----------------------------------------------------------

export const b64uDecode = (input: string) => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export const b64uEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** ECB decrypt: each 16-byte block independently (node keys). */
export const ecbDecrypt = (key: Uint8Array, data: Uint8Array) => {
  const out = new Uint8Array(data.length)
  for (let i = 0; i + 16 <= data.length; i += 16) {
    out.set(aesDecryptBlock(key, data.subarray(i, i + 16)), i)
  }
  return out
}

/** CBC decrypt with a zero IV and zero (not PKCS7) padding (attributes). */
export const cbcDecryptZeroIv = (key: Uint8Array, data: Uint8Array) => {
  const out = new Uint8Array(data.length)
  let prev: Uint8Array = new Uint8Array(16)
  for (let i = 0; i + 16 <= data.length; i += 16) {
    const block = data.subarray(i, i + 16)
    const dec = aesDecryptBlock(key, block)
    for (let j = 0; j < 16; j++) out[i + j] = dec[j]! ^ prev[j]!
    prev = block
  }
  return out
}

/** MEGA key folding: a 32-byte file key is key[0:16] XOR key[16:32] for
 *  AES, with nonce at key[16:24] and a meta-MAC at key[24:32] (ignored —
 *  we proxy, we don't attest). 16-byte keys fold to themselves. */
export const foldKey = (key: Uint8Array) => {
  const folded = key.slice(0, 16)
  for (let i = 0; i < 16 && i + 16 < key.length; i++) folded[i] = key[i]! ^ key[i + 16]!
  return folded
}

export const b64Encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** AES-CCM payload decrypt (tag verification skipped — we proxy, we
 *  don't attest). Counter blocks: [L-1][nonce][BE counter], L = 15 -
 *  ivlen, data starts at counter 1. */
const ccmPayloadDecrypt = (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => {
  const l = 15 - iv.length
  const block = new Uint8Array(16)
  block[0] = l - 1
  block.set(iv, 1)
  const out = new Uint8Array(data.length)
  let counter = 1
  let position = 0
  while (position < data.length) {
    for (let i = 0; i < l; i++) block[15 - i] = (counter >> (8 * i)) & 0xff
    const keystream = aesEncryptBlock(key, block)
    const n = Math.min(16, data.length - position)
    for (let j = 0; j < n; j++) out[position + j] = data[position + j]! ^ keystream[j]!
    position += n
    counter++
  }
  return out
}

/** Parses the MEGA TLV record container: repeated {type C-string,
 *  u16be length, value} entries. */
const tlvParse = (data: Uint8Array) => {
  const records = new Map<string, Uint8Array>()
  let offset = 0
  while (offset < data.length) {
    let end = offset
    while (end < data.length && data[end] !== 0) end++
    if (end >= data.length || end + 3 > data.length) return null
    const type = new TextDecoder().decode(data.subarray(offset, end))
    const length = (data[end + 1]! << 8) | data[end + 2]!
    const value = data.subarray(end + 3, end + 3 + length)
    if (value.length !== length) return null
    records.set(type, value)
    offset = end + 3 + length
  }
  return records
}

/** Decrypts a MEGA encrypted-TLV attribute container (Sets and Set
 *  Elements use these instead of "MEGA{...}" JSON): layout is
 *  {encSetting byte}{iv}{ciphertext+tag}. New data uses AES-GCM;
 *  legacy encSettings are AES-CCM. */
export const decryptTlvRecords = async (key16: Uint8Array, blob: Uint8Array) => {
  if (blob.length < 1) return null
  const setting = blob[0]!
  // encSetting -> [mode, ivlen, taglen]
  const table: Record<number, ['ccm' | 'gcm', number, number] | undefined> = {
    0x00: ['ccm', 12, 16], 0x01: ['ccm', 10, 16], 0x02: ['ccm', 10, 8],
    0x03: ['ccm', 12, 16], 0x04: ['ccm', 10, 8], // legacy mislabeled GCM
    0x10: ['gcm', 12, 16], 0x11: ['gcm', 10, 8],
  }
  const spec = table[setting]
  if (!spec || blob.length < 1 + spec[1] + spec[2]) return null
  const [mode, ivlen, taglen] = spec
  const iv = blob.subarray(1, 1 + ivlen)
  const payload = blob.subarray(1 + ivlen)
  let plain: Uint8Array
  if (mode === 'gcm') {
    try {
      const cryptoKey = await crypto.subtle.importKey('raw', key16.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt'])
      const result = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer, tagLength: taglen * 8 },
        cryptoKey,
        payload.slice().buffer as ArrayBuffer,
      )
      plain = new Uint8Array(result)
    } catch {
      return null
    }
  } else {
    plain = ccmPayloadDecrypt(key16, iv, payload.subarray(0, payload.length - taglen))
  }
  return tlvParse(plain)
}

/** AES-128-CTR over data starting at a 16-byte-aligned offset. Counter
 *  block = 8-byte nonce || 8-byte big-endian block counter. */
export const ctrCrypt = (key: Uint8Array, nonce: Uint8Array, data: Uint8Array, startOffset = 0) => {
  const out = new Uint8Array(data.length)
  const counterBlock = new Uint8Array(16)
  counterBlock.set(nonce.slice(0, 8))
  let counter = Math.floor(startOffset / 16)
  let position = 0
  while (position < data.length) {
    const view = new DataView(counterBlock.buffer)
    view.setUint32(8, Math.floor(counter / 0x100000000))
    view.setUint32(12, counter >>> 0)
    const keystream = aesEncryptBlock(key, counterBlock)
    const n = Math.min(16, data.length - position)
    for (let j = 0; j < n; j++) out[position + j] = data[position + j]! ^ keystream[j]!
    position += n
    counter++
  }
  return out
}
