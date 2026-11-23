/**
 * Embedded metadata reader — EXIF (TIFF), IPTC-IIM and XMP packets inside
 * JPEG, PNG, WebP and HEIC/HEIF/AVIF containers. Platform-free by contract
 * (invariant 8): callers supply bytes or a ranged reader, nothing here
 * touches Node, the DOM or Worker bindings.
 *
 * Read-only by contract (invariant 2): this parses bytes, it never
 * rewrites them. GPS is never read — the GPS IFD pointer is not followed
 * and no GPS tag is decoded, so location comes only from IPTC/XMP fields
 * the photographer chose to publish.
 */

import type { ExifData } from './imagesource'

/** Reads `length` bytes starting at `start`; may return fewer near EOF
 *  and an empty array past it. */
export type RangeReader = (start: number, length: number) => Promise<Uint8Array>

/** How much of a file the ranged reader pulls up front — metadata lives
 *  in the head of every container we support. */
export const EMBEDDED_HEAD_BYTES = 512 * 1024

/** JPEG segment walks and HEIC item extents may continue past the head
 *  window, but never past this total — a pathological file must not turn
 *  an Info-sheet open into an unbounded download. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024
/** A WebP tail read fetches this many bytes of chunk headers at a time —
 *  enough to cover several small metadata chunks at once, cheap enough
 *  that skipping bitstream payloads never drains the scan budget. */
const WEBP_TAIL_BYTES = 8 * 1024

// ---------------------------------------------------------------------------
// byte helpers

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const utf8 = new TextDecoder('utf-8')
const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const latin1 = new TextDecoder('iso-8859-1')

/** UTF-8 when it validates, Latin-1 otherwise — the same fallback IPTC
 *  and legacy EXIF writers assume. */
const decodeText = (bytes: Uint8Array): string => {
  try {
    return utf8Fatal.decode(bytes)
  } catch {
    return latin1.decode(bytes)
  }
}

/** Control characters and NULs never belong in a caption row. */
const clean = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim()
  if (!stripped) return undefined
  const capped = stripped.length > max ? stripped.slice(0, max).trimEnd() : stripped
  return capped || undefined
}

const cleanKeywords = (values: readonly (string | undefined)[]): string[] | undefined => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = clean(value, 60)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= 20) break
  }
  return out.length ? out : undefined
}

/** Make+Model folded into one camera name: when the model already opens
 *  with the make's first word ("Canon EOS R5" under Make "Canon") the
 *  model stands alone; otherwise they join ("Apple" + "iPhone 15 Pro"). */
const foldCamera = (make: string | undefined, model: string | undefined): string | undefined => {
  const maker = clean(make, 100)
  const body = clean(model, 100)
  if (!maker) return body
  if (!body) return maker
  const first = maker.split(/\s+/)[0]!.toLowerCase()
  const folded = body.toLowerCase().startsWith(first) ? body : `${maker} ${body}`
  return clean(folded, 100)
}

const trimNumber = (value: number): string => {
  if (!Number.isFinite(value)) return ''
  const fixed = value.toFixed(4).replace(/\.?0+$/, '')
  return fixed === '-0' ? '0' : fixed
}

/** One decimal, trailing ".0" dropped — the printed convention lenses and
 *  apertures actually use (FNumber 1.78 -> f/1.8, FocalLength 6.95 -> 7 mm). */
const trimNumber1 = (value: number): string => {
  if (!Number.isFinite(value)) return ''
  const fixed = value.toFixed(1).replace(/\.0$/, '')
  return fixed === '-0' ? '0' : fixed
}

/** "f/2.8", "f/2" — trailing .0 dropped. */
const formatAperture = (rational: { num: number; den: number } | undefined): string | undefined => {
  if (!rational || rational.den === 0) return undefined
  const value = rational.num / rational.den
  if (!Number.isFinite(value) || value <= 0) return undefined
  const text = trimNumber1(value)
  return text ? `f/${text}` : undefined
}

/** "1/250 s" for clean fractions, "2 s" / "0.5 s" otherwise. */
const formatShutter = (rational: { num: number; den: number } | undefined): string | undefined => {
  if (!rational || rational.den === 0) return undefined
  const t = rational.num / rational.den
  if (!Number.isFinite(t) || t <= 0) return undefined
  if (t >= 1) {
    const text = trimNumber(t)
    return text ? `${text} s` : undefined
  }
  const reciprocal = 1 / t
  const nearest = Math.round(reciprocal)
  if (nearest >= 2 && Math.abs(reciprocal - nearest) <= reciprocal * 0.01) return `1/${nearest} s`
  const text = trimNumber(t)
  return text ? `${text} s` : undefined
}

const formatFocal = (rational: { num: number; den: number } | undefined): string | undefined => {
  if (!rational || rational.den === 0) return undefined
  const value = rational.num / rational.den
  if (!Number.isFinite(value) || value <= 0) return undefined
  const text = trimNumber1(value)
  return text ? `${text} mm` : undefined
}

/** "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS", with the
 *  OffsetTimeOriginal zone appended only when it is well-formed.
 *  0000:00:00 placeholders and unparseable strings yield nothing. */
const formatDateOriginal = (raw: string | undefined, offset: string | undefined): string | undefined => {
  if (!raw) return undefined
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  const year = Number(y), month = Number(mo), day = Number(d)
  const hour = Number(h), minute = Number(mi), second = Number(s)
  if (year === 0 && month === 0 && day === 0) return undefined
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  if (day > daysInMonth) return undefined
  let out = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  const zone = /^([+-])(\d{2}):(\d{2})$/.exec((offset ?? '').trim())
  if (zone && Number(zone[2]) <= 14 && Number(zone[3]) <= 59) out += `${zone[1]}${zone[2]}:${zone[3]}`
  return out
}

// ---------------------------------------------------------------------------
// TIFF / EXIF

const IFD_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

type Tiff = { b: Uint8Array; le: boolean }
type IfdEntry = { tag: number; type: number; count: number; dataAt: number }

const tiffU16 = (t: Tiff, o: number) => {
  const v = t.le ? t.b[o]! | (t.b[o + 1]! << 8) : (t.b[o]! << 8) | t.b[o + 1]!
  return v
}
const tiffU32 = (t: Tiff, o: number) => {
  if (t.le) return (t.b[o]! | (t.b[o + 1]! << 8) | (t.b[o + 2]! << 16) | (t.b[o + 3]! << 24)) >>> 0
  return ((t.b[o]! << 24) >>> 0) + (t.b[o + 1]! << 16) + (t.b[o + 2]! << 8) + t.b[o + 3]!
}

/** Reads one IFD into `out` (first tag wins). `visited` guards against
 *  IFD loops — a corrupt offset pointing back at an ancestor stops the
 *  walk instead of spinning. */
const readIfd = (t: Tiff, offset: number, visited: Set<number>, out: Map<number, IfdEntry>) => {
  if (offset < 8 || offset + 2 > t.b.length || visited.has(offset)) return
  visited.add(offset)
  const count = tiffU16(t, offset)
  if (count > 4096) return
  let pos = offset + 2
  for (let i = 0; i < count && pos + 12 <= t.b.length; i++, pos += 12) {
    const tag = tiffU16(t, pos)
    const type = tiffU16(t, pos + 2)
    const entryCount = tiffU32(t, pos + 4)
    const size = IFD_TYPE_SIZE[type] ?? 0
    if (!size || entryCount > 0x100000 || out.has(tag)) continue
    const total = entryCount * size
    // Values of <= 4 bytes live inside the entry itself; larger ones are
    // an offset from the TIFF header start. Bounds are checked when the
    // value is actually read — a bogus offset simply yields nothing.
    const dataAt = total <= 4 ? pos + 8 : tiffU32(t, pos + 8)
    out.set(tag, { tag, type, count: entryCount, dataAt })
  }
}

const entryBytes = (t: Tiff, e: IfdEntry): Uint8Array | undefined => {
  const size = IFD_TYPE_SIZE[e.type] ?? 0
  if (!size) return undefined
  const total = e.count * size
  if (e.dataAt < 0 || e.dataAt + total > t.b.length) return undefined
  return t.b.subarray(e.dataAt, e.dataAt + total)
}

const tagText = (t: Tiff, ifd: Map<number, IfdEntry>, tag: number): string | undefined => {
  const e = ifd.get(tag)
  if (!e) return undefined
  const bytes = entryBytes(t, e)
  if (!bytes?.length) return undefined
  const text = decodeText(bytes).replace(/\0+$/, '')
  return text || undefined
}

const tagNumber = (t: Tiff, ifd: Map<number, IfdEntry>, tag: number): number | undefined => {
  const e = ifd.get(tag)
  if (!e) return undefined
  const bytes = entryBytes(t, e)
  if (!bytes?.length) return undefined
  switch (e.type) {
    case 1: case 7: return bytes[0] || undefined
    case 3: return bytes.length >= 2 ? tiffU16From(bytes, 0, t.le) || undefined : undefined
    case 4: return bytes.length >= 4 ? tiffU32From(bytes, 0, t.le) || undefined : undefined
    case 8: return bytes.length >= 2 ? tiffI16From(bytes, 0, t.le) || undefined : undefined
    case 9: return bytes.length >= 4 ? tiffI32From(bytes, 0, t.le) || undefined : undefined
    default: return undefined
  }
}

const tiffU16From = (b: Uint8Array, o: number, le: boolean) => le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!
const tiffU32From = (b: Uint8Array, o: number, le: boolean) => le
  ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
  : ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
const tiffI16From = (b: Uint8Array, o: number, le: boolean) => { const v = tiffU16From(b, o, le); return v >= 0x8000 ? v - 0x10000 : v }
const tiffI32From = (b: Uint8Array, o: number, le: boolean) => le
  ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) << 0 >> 0
  : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) << 0 >> 0

const tagRational = (t: Tiff, ifd: Map<number, IfdEntry>, tag: number): { num: number; den: number } | undefined => {
  const e = ifd.get(tag)
  if (!e || (e.type !== 5 && e.type !== 10) || e.count < 1) return undefined
  const bytes = entryBytes(t, e)
  if (!bytes || bytes.length < 8) return undefined
  const signed = e.type === 10
  const num = signed ? tiffI32From(bytes, 0, t.le) : tiffU32From(bytes, 0, t.le)
  const den = signed ? tiffI32From(bytes, 4, t.le) : tiffU32From(bytes, 4, t.le)
  if (den === 0) return undefined
  return { num, den }
}

const parseTiff = (bytes: Uint8Array): { t: Tiff; ifd0: Map<number, IfdEntry>; exifIfd: Map<number, IfdEntry> } | undefined => {
  if (bytes.length < 8) return undefined
  const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a
  if (!le && !be) return undefined
  const t: Tiff = { b: bytes, le }
  const ifd0Offset = tiffU32(t, 4)
  const visited = new Set<number>()
  const ifd0 = new Map<number, IfdEntry>()
  readIfd(t, ifd0Offset, visited, ifd0)
  const exifIfd = new Map<number, IfdEntry>()
  // ExifIFD pointer 0x8769 — the ONLY sub-IFD we follow. The GPS IFD
  // pointer 0x8825 is deliberately never dereferenced.
  const ptr = ifd0.get(0x8769)
  if (ptr && ptr.type === 4 && ptr.count >= 1) {
    const pbytes = entryBytes(t, ptr)
    if (pbytes && pbytes.length >= 4) {
      const sub = tiffU32From(pbytes, 0, t.le)
      if (sub !== ifd0Offset) readIfd(t, sub, visited, exifIfd)
    }
  }
  return { t, ifd0, exifIfd }
}

const exifFromTiff = (bytes: Uint8Array): ExifData | undefined => {
  const parsed = parseTiff(bytes)
  if (!parsed) return undefined
  const { t, ifd0, exifIfd } = parsed
  // ExifIFD tags fall back to IFD0 — ISOSpeedRatings legitimately lives
  // in either place depending on the writer.
  const pick = <T>(read: (m: Map<number, IfdEntry>) => T | undefined): T | undefined =>
    read(exifIfd) ?? read(ifd0)
  const out: ExifData = {}
  const camera = foldCamera(tagText(t, ifd0, 0x010f), tagText(t, ifd0, 0x0110))
  if (camera) out.camera = camera
  const lens = clean(pick((m) => tagText(t, m, 0xa434)), 100)
  if (lens) out.lens = lens
  const aperture = formatAperture(pick((m) => tagRational(t, m, 0x829d)))
  if (aperture) out.aperture = aperture
  const shutter = formatShutter(pick((m) => tagRational(t, m, 0x829a)))
  if (shutter) out.shutter = shutter
  const iso = pick((m) => tagNumber(t, m, 0x8827))
  if (typeof iso === 'number' && iso > 0) out.iso = iso
  const focal = formatFocal(pick((m) => tagRational(t, m, 0x920a)))
  if (focal) out.focalLength = focal
  const captured = formatDateOriginal(
    pick((m) => tagText(t, m, 0x9003)),
    pick((m) => tagText(t, m, 0x9011)),
  )
  if (captured) out.dateOriginal = captured
  // Shared fields at the lowest merge priority — IPTC and XMP override.
  const description = clean(tagText(t, ifd0, 0x010e), 500)
  if (description) out.description = description
  const creator = clean(tagText(t, ifd0, 0x013b), 100)
  if (creator) out.creator = creator
  const copyright = clean(tagText(t, ifd0, 0x8298), 150)
  if (copyright) out.copyright = copyright
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// IPTC-IIM (record 2), as carried in JPEG APP13 8BIM resource 0x0404

const IPTC_FIELDS: Record<number, 'title' | 'keywords' | 'city' | 'sublocation' | 'state' | 'country' | 'creator' | 'copyright' | 'description'> = {
  0x05: 'title',
  0x19: 'keywords',
  0x5a: 'city',
  0x5c: 'sublocation',
  0x5f: 'state',
  0x65: 'country',
  0x50: 'creator',
  0x74: 'copyright',
  0x78: 'description',
}

const isUtf8Charset = (payload: Uint8Array) => {
  // ESC % G (and the UTF-8 level-1 variant ESC % @) designate UTF-8.
  for (let i = 0; i + 2 < payload.length; i++) {
    if (payload[i] === 0x1b && payload[i + 1] === 0x25 && (payload[i + 2] === 0x47 || payload[i + 2] === 0x40)) return true
  }
  return false
}

const decodeIptc = (payload: Uint8Array, utf8Declared: boolean) => {
  if (utf8Declared) return utf8.decode(payload)
  try {
    return utf8Fatal.decode(payload)
  } catch {
    return latin1.decode(payload)
  }
}

const iptcFromData = (data: Uint8Array): ExifData | undefined => {
  // Datasets are a sequential run of 0x1C markers; tolerate a little
  // leading padding by scanning for the first marker.
  let pos = -1
  for (let i = 0; i < Math.min(data.length, 64); i++) {
    if (data[i] === 0x1c) { pos = i; break }
  }
  if (pos < 0) return undefined
  // Two passes: CodedCharacterSet (1:90) may trail the record-2 strings
  // it governs, so payloads are collected raw and decoded at the end.
  const raw = new Map<number, Uint8Array[]>()
  let charsetPayload: Uint8Array | undefined
  let saw = false
  while (pos + 5 <= data.length) {
    if (data[pos] !== 0x1c) break
    const record = data[pos + 1]!
    const tag = data[pos + 2]!
    let length = u16be(data, pos + 3)
    pos += 5
    if (length & 0x8000) {
      const n = length & 0x7fff
      if (n > 8 || pos + n > data.length) break
      length = 0
      for (let i = 0; i < n; i++) length = length * 256 + data[pos + i]!
      pos += n
    }
    if (pos + length > data.length) break
    const payload = data.subarray(pos, pos + length)
    pos += length
    saw = true
    if (record === 1 && tag === 90) { charsetPayload = payload; continue }
    if (record !== 2) continue
    const list = raw.get(tag) ?? []
    list.push(payload)
    raw.set(tag, list)
  }
  if (!saw) return undefined
  const utf8Declared = charsetPayload ? isUtf8Charset(charsetPayload) : false
  const values = new Map<string, string[]>()
  const push = (field: string, payload: Uint8Array) => {
    const list = values.get(field) ?? []
    list.push(decodeIptc(payload, utf8Declared))
    values.set(field, list)
  }
  for (const [tag, payloads] of raw) {
    const field = IPTC_FIELDS[tag]
    if (!field) continue
    for (const payload of payloads) push(field, payload)
  }
  const first = (field: string) => values.get(field)?.[0]
  const keywords = cleanKeywords(values.get('keywords') ?? [])
  // "Sublocation, City, State, Country" — present parts only, de-duped.
  const locationParts = [first('sublocation'), first('city'), first('state'), first('country')]
    .map((v) => clean(v, 60))
    .filter((v): v is string => Boolean(v))
    .filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
  const location = locationParts.length ? locationParts.join(', ') : undefined
  const out: ExifData = {}
  const title = clean(first('title'), 120)
  if (title) out.title = title
  const description = clean(first('description'), 500)
  if (description) out.description = description
  const creator = clean(first('creator'), 100)
  if (creator) out.creator = creator
  const copyright = clean(first('copyright'), 150)
  if (copyright) out.copyright = copyright
  if (keywords) out.keywords = keywords
  const loc = clean(location, 150)
  if (loc) out.location = loc
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// XMP — tolerant string extraction, no DOM

/** Entities decode only outside CDATA — inside it the text is literal. */
const decodeEntities = (text: string): string => {
  const parts = text.split(/<!\[CDATA\[([\s\S]*?)\]\]>/g)
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  const decode = (segment: string) =>
    segment.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
      const namedChar = named[entity]
      if (namedChar !== undefined) return namedChar
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    })
  // split() with a capture group interleaves: even indexes are plain
  // text, odd indexes are CDATA payloads kept verbatim.
  return parts.map((segment, i) => (i % 2 === 1 ? segment : decode(segment))).join('')
}

const stripTags = (xml: string) => xml.replace(/<[^>]*>/g, '')

/** Inner texts of every rdf:li (any prefix) inside an Alt/Seq/Bag
 *  fragment — the close tag must carry the same prefix. */
const rdfLiTexts = (inner: string): string[] => {
  const out: string[] = []
  const re = /<((?:[A-Za-z_][\w.-]*:)?li)\b[^>]*>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) out.push(decodeEntities(stripTags(m[2]!)).trim())
  return out.filter(Boolean)
}

/** Inner XML of every element whose local name matches — any namespace
 *  prefix tolerated, since prefixes are document-local. */
const xmpElements = (xml: string, local: string): string[] => {
  const out: string[] = []
  const open = new RegExp(`<([A-Za-z_][\\w.-]*:)?${local}(?=[\\s>/])([^>]*)>`, 'g')
  let m: RegExpExecArray | null
  while ((m = open.exec(xml))) {
    const prefix = m[1] ?? ''
    const attrs = m[2] ?? ''
    const selfClosing = /\/\s*$/.test(attrs)
    if (selfClosing) { out.push(''); continue }
    const closeTag = `</${prefix}${local}>`
    const closeAt = xml.indexOf(closeTag, open.lastIndex)
    if (closeAt < 0) continue
    out.push(xml.slice(open.lastIndex, closeAt))
    open.lastIndex = closeAt + closeTag.length
  }
  return out
}

/** Cheap attribute form: `dc:title="..."` on an rdf:Description. */
const xmpAttributes = (xml: string, local: string): string[] => {
  const out: string[] = []
  const re = new RegExp(`(?:^|[\\s<])(?:[A-Za-z_][\\w.-]*:)?${local}\\s*=\\s*"([^"]*)"`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1]!)
  return out
}

/** Alt/Seq/Bag-aware leaf text: Alt contributes its first li, Seq joins
 *  with ", ", Bag yields every li. Plain character content passes through. */
const xmpLeafTexts = (inner: string): { first: string[]; all: string[] } => {
  const lis = rdfLiTexts(inner)
  if (lis.length) return { first: [lis[0]!], all: lis }
  const text = decodeEntities(stripTags(inner)).trim()
  return text ? { first: [text], all: [text] } : { first: [], all: [] }
}

const xmpFromPacket = (packet: string): ExifData | undefined => {
  const out: ExifData = {}
  const leaf = (local: string) => {
    const parts: string[] = []
    for (const inner of xmpElements(packet, local)) parts.push(...xmpLeafTexts(inner).first)
    for (const attr of xmpAttributes(packet, local)) parts.push(decodeEntities(attr).trim())
    return parts.filter(Boolean)
  }
  const leafAll = (local: string) => {
    const parts: string[] = []
    for (const inner of xmpElements(packet, local)) parts.push(...xmpLeafTexts(inner).all)
    return parts.filter(Boolean)
  }
  const bag = (local: string) => leafAll(local)

  const title = clean(leaf('title')[0], 120)
  if (title) out.title = title
  const description = clean(leaf('description')[0], 500)
  if (description) out.description = description
  // dc:creator is an rdf:Seq — every li joins with ", ".
  const creator = clean(leafAll('creator').join(', '), 100)
  if (creator) out.creator = creator
  const rights = clean(leaf('rights')[0], 150)
  if (rights) out.copyright = rights
  const keywords = cleanKeywords(leafAll('subject'))
  if (keywords) out.keywords = keywords

  // Location: structured photoshop fields win; Iptc4xmpCore:Location is
  // the fallback for writers that only emit the composite string.
  const locationParts = [
    clean(leaf('City')[0], 60),
    clean(leaf('State')[0], 60),
    clean(leaf('Country')[0], 60),
  ].filter((v): v is string => Boolean(v))
  const deduped = locationParts.filter((v, i) => locationParts.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
  let location = deduped.length ? deduped.join(', ') : undefined
  if (!location) {
    const composite = clean(leaf('Location')[0], 150)
    if (composite) location = composite
  }
  const loc = clean(location, 150)
  if (loc) out.location = loc
  return Object.keys(out).length ? out : undefined
}

// ---------------------------------------------------------------------------
// containers

type Parts = { tiff?: Uint8Array; iptc?: Uint8Array; xmp?: string }
/** A ranged read readEmbeddedMetadata owes the analysis: `exif`/`xmp`
 *  fetch one metadata payload, `webtail` fetches a window of RIFF chunks
 *  to keep walking (`end` carries the declared RIFF end so the walk knows
 *  when the container is done). */
type PendingItem = { offset: number; length: number; kind: 'exif' | 'xmp' | 'webtail'; end?: number }
type Analysis = { parts: Parts; incomplete: boolean; pending: PendingItem[]; iptcZtxt?: Uint8Array[] }

const APP1_XMP = 'http://ns.adobe.com/xap/1.0/'
const PHOTOSHOP_8BIM = 'Photoshop 3.0'

const jpegAnalysis = (b: Uint8Array): Analysis => {
  const parts: Parts = {}
  let pos = 2 // past FFD8
  let truncated = false
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) { pos += 1; continue }
    let marker = b[pos + 1]!
    // Fill bytes and standalone markers carry no length.
    while (marker === 0xff && pos + 2 < b.length) { pos += 1; marker = b[pos + 1]! }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xda || marker === 0xd9) break // SOS / EOI
      pos += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break
    const segLen = u16be(b, pos + 2)
    if (segLen < 2) break
    const segStart = pos + 4
    const segEnd = pos + 2 + segLen
    if (segEnd > b.length) { truncated = true; break }
    if (marker === 0xe1) {
      const head = b.subarray(segStart, Math.min(segEnd, segStart + 64))
      const ascii = (s: string) => {
        for (let i = 0; i < s.length; i++) if (head[i] !== s.charCodeAt(i)) return false
        return true
      }
      if (ascii('Exif\0\0')) {
        parts.tiff ??= b.slice(segStart + 6, segEnd)
      } else if (ascii(APP1_XMP) && head[APP1_XMP.length] === 0) {
        parts.xmp ??= utf8.decode(b.subarray(segStart + APP1_XMP.length + 1, segEnd))
      }
    } else if (marker === 0xed) {
      const headLen = PHOTOSHOP_8BIM.length + 1
      const head = b.subarray(segStart, Math.min(segEnd, segStart + headLen))
      let ok = head.length >= headLen
      for (let i = 0; ok && i < PHOTOSHOP_8BIM.length; i++) ok = head[i] === PHOTOSHOP_8BIM.charCodeAt(i)
      ok = ok && head[PHOTOSHOP_8BIM.length] === 0
      if (ok) {
        const iptc = findIptcResource(b, segStart + headLen, segEnd)
        if (iptc) parts.iptc ??= iptc
      }
    }
    pos = segEnd
  }
  return { parts, incomplete: truncated, pending: [] }
}

/** Walks 8BIM resources inside a Photoshop APP13 segment for resource
 *  0x0404 (IPTC-NAA). */
const findIptcResource = (b: Uint8Array, start: number, end: number): Uint8Array | undefined => {
  let pos = start
  while (pos + 12 <= end) {
    if (b[pos] !== 0x38 || b[pos + 1] !== 0x42 || b[pos + 2] !== 0x49 || b[pos + 3] !== 0x4d) break // "8BIM"
    const resource = u16be(b, pos + 4)
    // Pascal name: 1 length byte + chars, padded to an even boundary.
    const nameLen = b[pos + 6]!
    let dataAt = pos + 7 + nameLen
    if (dataAt % 2 === 1) dataAt += 1 // pad to even relative to segment? 8BIM pads name to make data offset even
    // The pad rule counts from the resource start: name field is padded
    // so that (7 + nameLen + pad) is even — equivalently dataAt-pos even.
    if ((dataAt - pos) % 2 === 1) dataAt += 1
    if (dataAt + 4 > end) break
    const size = u32be(b, dataAt)
    const dataStart = dataAt + 4
    const dataEnd = dataStart + size
    if (dataEnd > end) break
    if (resource === 0x0404) return b.slice(dataStart, dataEnd)
    pos = dataEnd + (size % 2) // resources pad to even
  }
  return undefined
}

/** PNG has no IPTC chunk — writers carry it as a "Raw profile type iptc"
 *  tEXt/zTXt whose text is a description line, a length line, then the
 *  payload hex-encoded (wrappers included). Returns the decoded bytes. */
const decodePngRawProfile = (text: string): Uint8Array | undefined => {
  let hex = ''
  let started = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!started) {
      // The first long all-hex line opens the payload; description and
      // length lines above it can never qualify (too short or non-hex).
      if (t.length >= 16 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t)) {
        started = true
        hex = t
      }
      continue
    }
    if (!/^[0-9a-fA-F]*$/.test(t)) break
    hex += t
  }
  if (!started || hex.length % 2 !== 0) return undefined
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A raw-profile payload is either a bare IPTC-IIM dataset or an 8BIM
 *  resource block (resource 0x0404) — the two shapes JPEG APP13 carries. */
const iptcProfilePayload = (payload: Uint8Array): Uint8Array | undefined => {
  if (payload.length >= 4 && payload[0] === 0x38 && payload[1] === 0x42 && payload[2] === 0x49 && payload[3] === 0x4d) {
    return findIptcResource(payload, 0, payload.length)
  }
  return payload.length ? payload : undefined
}

/** Inflate with a hard ceiling on DECOMPRESSED bytes — the chunk only
 *  bounds the compressed payload, and a small zTXt can hide a much larger
 *  stream. Overflow throws; the caller keeps whatever else it parsed. */
const inflateZlib = async (data: Uint8Array, limit: number): Promise<Uint8Array> => {
  // The copy pins the payload to a plain ArrayBuffer for BlobPart.
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      total += chunk.length
      if (total > limit) throw new Error('decompressed profile exceeds the metadata byte budget')
      chunks.push(chunk)
    }
  } finally {
    // Overflow and truncation both land here — the stream must not keep
    // pumping a payload nobody will read.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const pngAnalysis = (b: Uint8Array): Analysis => {
  const parts: Parts = {}
  const iptcZtxt: Uint8Array[] = []
  let pos = 8 // past the 8-byte signature
  while (pos + 12 <= b.length) {
    const length = u32be(b, pos)
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > b.length) break
    if (type === 'IEND') break
    if (type === 'eXIf') {
      parts.tiff ??= b.slice(dataStart, dataEnd)
    } else if (type === 'iTXt') {
      // Work inside the chunk's own bounds — a NUL hunt must never leak
      // into the next chunk's bytes.
      const d = b.subarray(dataStart, dataEnd)
      const keywordEnd = d.indexOf(0)
      if (keywordEnd > 0 && keywordEnd < d.length) {
        const keyword = latin1.decode(d.subarray(0, keywordEnd))
        // iTXt: keyword NUL compressionFlag compressionMethod lang NUL
        // translatedKeyword NUL text — XMP requires the uncompressed form.
        if (keyword === 'XML:com.adobe.xmp' && d[keywordEnd + 1] === 0) {
          const langEnd = d.indexOf(0, keywordEnd + 3)
          if (langEnd >= 0 && langEnd < d.length) {
            const transEnd = d.indexOf(0, langEnd + 1)
            if (transEnd >= 0 && transEnd <= d.length) {
              parts.xmp ??= utf8.decode(d.subarray(transEnd + 1))
            }
          }
        }
      }
    } else if (type === 'tEXt' || type === 'zTXt') {
      const d = b.subarray(dataStart, dataEnd)
      const keywordEnd = d.indexOf(0)
      if (keywordEnd > 0 && keywordEnd < d.length) {
        const keyword = latin1.decode(d.subarray(0, keywordEnd))
        // Raw profile type iptc is the only PNG carrier for IPTC-IIM.
        // tEXt decodes inline; zTXt inflate is async, so its bytes ride
        // along for readEmbeddedMetadata to decompress.
        if (keyword === 'Raw profile type iptc') {
          if (type === 'tEXt') {
            const profile = decodePngRawProfile(latin1.decode(d.subarray(keywordEnd + 1)))
            const iptc = profile && iptcProfilePayload(profile)
            if (iptc) parts.iptc ??= iptc
          } else if (d[keywordEnd + 1] === 0) {
            iptcZtxt.push(d.slice(keywordEnd + 2))
          }
        }
      }
    }
    pos = dataEnd + 4 // + CRC
  }
  return { parts, incomplete: false, pending: [], ...(iptcZtxt.length ? { iptcZtxt } : {}) }
}

/** EXIF and XMP chunks decode the same whether they sit in the head
 *  window or in a fetched tail window. */
const webpTakeChunk = (parts: Parts, fourcc: string, data: Uint8Array) => {
  if (fourcc === 'EXIF') {
    parts.tiff ??= data.length >= 6 && data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69 && data[3] === 0x66 && data[4] === 0 && data[5] === 0
      ? data.slice(6)
      : data.slice()
  } else if (fourcc === 'XMP ') {
    parts.xmp ??= utf8.decode(data)
  }
}

const webpAnalysis = (b: Uint8Array): Analysis => {
  const parts: Parts = {}
  const pending: PendingItem[] = []
  if (b.length < 20 || u32be(b, 0) !== 0x52494646 || u32be(b, 8) !== 0x57454250) return { parts, incomplete: false, pending } // RIFF....WEBP
  const riffEnd = 8 + u32le(b, 4)
  let pos = 12
  while (pos + 8 <= b.length && pos + 8 <= riffEnd) {
    const fourcc = String.fromCharCode(b[pos]!, b[pos + 1]!, b[pos + 2]!, b[pos + 3]!)
    const size = u32le(b, pos + 4)
    const dataStart = pos + 8
    const dataEnd = dataStart + size
    if (dataEnd > b.length) {
      // The image bitstream usually outgrows the head window, and EXIF /
      // XMP chunks sit AFTER it — RIFF sizes let the walk skip past it
      // without transferring a byte of it. A straddling metadata chunk's
      // payload gets a ranged read of its own; whatever follows resumes
      // as a tail window.
      if ((fourcc === 'EXIF' || fourcc === 'XMP ') && size > 0 && size <= MAX_SCAN_BYTES) {
        pending.push({ offset: dataStart, length: size, kind: fourcc === 'EXIF' ? 'exif' : 'xmp' })
      }
      pos = dataEnd + (size % 2) // chunks pad to even
      break
    }
    webpTakeChunk(parts, fourcc, b.subarray(dataStart, dataEnd))
    pos = dataEnd + (size % 2)
  }
  // The RIFF declares more chunks than the window fetched — the walk
  // resumes with small header-window reads at `pos`, skipping bitstream
  // payloads outright instead of downloading them.
  if (pos + 8 <= riffEnd) pending.push({ offset: pos, length: WEBP_TAIL_BYTES, kind: 'webtail', end: riffEnd })
  return { parts, incomplete: false, pending }
}

/** The webpAnalysis walk continued over a window fetched at absolute
 *  offset `base`: chunks inside it parse directly, a straddling metadata
 *  payload becomes its own ranged read, and the boundary past the next
 *  chunk becomes the following tail window. */
const webpTailAnalysis = (b: Uint8Array, base: number, riffEnd: number): Analysis => {
  const parts: Parts = {}
  const pending: PendingItem[] = []
  let pos = 0
  while (pos + 8 <= b.length) {
    const fourcc = String.fromCharCode(b[pos]!, b[pos + 1]!, b[pos + 2]!, b[pos + 3]!)
    const size = u32le(b, pos + 4)
    const dataStart = pos + 8
    const dataEnd = dataStart + size
    if (dataEnd > b.length) {
      if ((fourcc === 'EXIF' || fourcc === 'XMP ') && size > 0 && size <= MAX_SCAN_BYTES) {
        pending.push({ offset: base + dataStart, length: size, kind: fourcc === 'EXIF' ? 'exif' : 'xmp' })
      }
      pos = dataEnd + (size % 2)
      break
    }
    webpTakeChunk(parts, fourcc, b.subarray(dataStart, dataEnd))
    pos = dataEnd + (size % 2)
  }
  // Continue past what this window saw — a straddling bitstream was
  // skipped for free, and dense small chunks parsed inline. Requeueing
  // without progress would just re-read the same short window.
  if (pos > 0 && base + pos + 8 <= riffEnd) {
    pending.push({ offset: base + pos, length: WEBP_TAIL_BYTES, kind: 'webtail', end: riffEnd })
  }
  return { parts, incomplete: false, pending }
}

// --- ISOBMFF (HEIC/HEIF/AVIF) ---

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1', 'avif', 'avis', 'avio', 'heif',
])

type IsoBox = { type: string; start: number; end: number }

const isoBoxes = (b: Uint8Array, start: number, end: number): IsoBox[] => {
  const out: IsoBox[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = u32be(b, pos)
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!)
    let header = 8
    if (size === 1) {
      if (pos + 16 > end) break
      size = u32be(b, pos + 8) * 0x100000000 + u32be(b, pos + 12)
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) break
    out.push({ type, start: pos + header, end: pos + size })
    pos += size
  }
  return out
}

const fourccAt = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

const isHeif = (b: Uint8Array): boolean => {
  if (b.length < 16) return false
  const boxes = isoBoxes(b, 0, b.length)
  const ftyp = boxes.find((box) => box.type === 'ftyp')
  if (!ftyp) return false
  const major = fourccAt(b, ftyp.start)
  if (HEIF_BRANDS.has(major)) return true
  // Compatible brands follow major(4) + minor(4).
  for (let p = ftyp.start + 8; p + 4 <= ftyp.end; p += 4) {
    if (HEIF_BRANDS.has(fourccAt(b, p))) return true
  }
  return false
}

const readBE = (b: Uint8Array, pos: number, size: number): number => {
  let v = 0
  for (let i = 0; i < size && pos + i < b.length; i++) v = v * 256 + b[pos + i]!
  return v
}

const cstring = (b: Uint8Array, pos: number, end: number): { text: string; next: number } => {
  let p = pos
  while (p < end && b[p] !== 0) p++
  return { text: latin1.decode(b.subarray(pos, p)), next: p < end ? p + 1 : p }
}

type HeifItem = { id: number; kind: 'exif' | 'xmp' }
type HeifExtent = { offset: number; length: number }

const heifItems = (b: Uint8Array): {
  items: HeifItem[]
  extents: Map<number, HeifExtent[]>
  primaryId: number | undefined
  describes: Map<number, number[]>
} => {
  const items = new Map<number, 'exif' | 'xmp'>()
  const extents = new Map<number, HeifExtent[]>()
  const empty = { items: [], extents, primaryId: undefined, describes: new Map<number, number[]>() }
  const top = isoBoxes(b, 0, b.length)
  const meta = top.find((box) => box.type === 'meta')
  if (!meta || meta.end - meta.start < 4) return empty
  const children = isoBoxes(b, meta.start + 4, meta.end) // FullBox header
  const iinf = children.find((box) => box.type === 'iinf')
  const iloc = children.find((box) => box.type === 'iloc')

  // pitm names the primary item — the photograph the file IS. A FullBox:
  // item_ID is u16 (version 0) or u32 (version 1).
  let primaryId: number | undefined
  const pitm = children.find((box) => box.type === 'pitm')
  if (pitm && pitm.end - pitm.start >= 6) {
    primaryId = b[pitm.start] === 0 ? u16be(b, pitm.start + 4) : u32be(b, pitm.start + 4)
  }

  // iref carries typed references; 'cdsc' (content describes) links a
  // metadata item to the image item it describes — without it a
  // secondary image's EXIF would be attributed to the primary.
  const describes = new Map<number, number[]>()
  const iref = children.find((box) => box.type === 'iref')
  if (iref && iref.end - iref.start >= 4) {
    const idSize = b[iref.start] === 0 ? 2 : 4
    for (const ref of isoBoxes(b, iref.start + 4, iref.end)) {
      if (ref.type !== 'cdsc') continue
      let p = ref.start
      if (p + idSize + 2 > ref.end) continue
      const from = readBE(b, p, idSize)
      p += idSize
      const count = u16be(b, p)
      p += 2
      const tos: number[] = []
      for (let i = 0; i < count && p + idSize <= ref.end; i++, p += idSize) {
        tos.push(readBE(b, p, idSize))
      }
      if (tos.length) describes.set(from, [...(describes.get(from) ?? []), ...tos])
    }
  }

  if (iinf && iinf.end - iinf.start >= 6) {
    const version = b[iinf.start]!
    const countSize = version === 0 ? 2 : 4
    let p = iinf.start + 4
    if (p + countSize > iinf.end) return { items: [], extents, primaryId, describes }
    const entryCount = countSize === 2 ? u16be(b, p) : u32be(b, p)
    p += countSize
    for (const child of isoBoxes(b, p, iinf.end)) {
      if (child.type !== 'infe') continue
      const d = child.start
      if (d + 8 > child.end) continue
      const v = b[d]! // FullBox version; flags occupy d+1..d+3
      try {
        if (v === 2 || v === 3) {
          let q = d + 4
          const idSize = v === 2 ? 2 : 4
          if (q + idSize + 2 + 4 > child.end) continue
          const id = readBE(b, q, idSize); q += idSize
          q += 2 // protection index
          const itemType = fourccAt(b, q); q += 4
          const name = cstring(b, q, child.end); q = name.next
          if (itemType === 'Exif') items.set(id, 'exif')
          else if (itemType === 'mime') {
            // infe mime layout: item_name, content_type, content_encoding.
            const contentType = cstring(b, q, child.end)
            if (contentType.text.trim() === 'application/rdf+xml') items.set(id, 'xmp')
          }
        }
      } catch { /* malformed item — skip */ }
    }
  }

  if (iloc && iloc.end - iloc.start >= 6) {
    const version = b[iloc.start]!
    const sizes = b[iloc.start + 4]!
    const offsetSize = sizes >> 4
    const lengthSize = sizes & 0xf
    const baseSizes = b[iloc.start + 5]!
    const baseOffsetSize = baseSizes >> 4
    const indexSize = version >= 1 ? baseSizes & 0xf : 0
    let p = iloc.start + 6
    const idSize = version === 2 ? 4 : 2
    const countSize = version === 2 ? 4 : 2
    if (p + countSize > iloc.end) return { items: [], extents, primaryId, describes }
    const itemCount = countSize === 2 ? u16be(b, p) : u32be(b, p)
    p += countSize
    for (let i = 0; i < itemCount && p < iloc.end; i++) {
      if (p + idSize + 2 + baseOffsetSize > iloc.end) break
      const id = readBE(b, p, idSize); p += idSize
      let method = 0
      if (version >= 1) { method = u16be(b, p) & 0x0fff; p += 2 }
      p += 2 // data_reference_index
      const base = readBE(b, p, baseOffsetSize); p += baseOffsetSize
      if (p + 2 > iloc.end) break
      const extentCount = u16be(b, p); p += 2
      const list: HeifExtent[] = []
      for (let e = 0; e < extentCount && p < iloc.end; e++) {
        if (version >= 1 && indexSize > 0) p += indexSize
        if (p + offsetSize + lengthSize > iloc.end) break
        const offset = readBE(b, p, offsetSize); p += offsetSize
        const length = readBE(b, p, lengthSize); p += lengthSize
        if (method === 0 && length > 0) list.push({ offset: base + offset, length })
      }
      if (list.length) extents.set(id, list)
    }
  }
  return { items: [...items.entries()].map(([id, kind]) => ({ id, kind })), extents, primaryId, describes }
}

const tiffMagicAt = (b: Uint8Array, o: number): boolean =>
  o >= 0 && o + 4 <= b.length &&
  ((b[o] === 0x49 && b[o + 1] === 0x49 && b[o + 2] === 0x2a && b[o + 3] === 0) ||
   (b[o] === 0x4d && b[o + 1] === 0x4d && b[o + 2] === 0 && b[o + 3] === 0x2a))

/** Exif item payloads lead with a 4-byte big-endian offset to the TIFF
 *  header measured from just past that field (exiftool: `$start = 4 + $n`).
 *  Payloads may also start with TIFF magic directly or with an `Exif\0\0`
 *  signature; writers disagree, so every plausible offset is tried and a
 *  bounded magic scan covers the rest. */
const tiffFromExifPayload = (payload: Uint8Array): Uint8Array | undefined => {
  if (payload.length < 8) return undefined
  const declared = u32be(payload, 0)
  const candidates = [declared + 4, declared, 4, 0]
  for (const at of candidates) {
    if (tiffMagicAt(payload, at)) return payload.slice(at)
  }
  const scanEnd = Math.min(payload.length - 4, 32)
  for (let at = 0; at <= scanEnd; at++) {
    if (tiffMagicAt(payload, at)) return payload.slice(at)
  }
  return undefined
}

const heifAnalysis = (b: Uint8Array): Analysis => {
  const parts: Parts = {}
  const pending: PendingItem[] = []
  if (!isHeif(b)) return { parts, incomplete: false, pending }
  const { items, extents, primaryId, describes } = heifItems(b)
  let candidates = items
  if (primaryId !== undefined) {
    // A cdsc reference says which image each metadata item describes —
    // only the primary image's own items may speak for the file. When no
    // item claims the primary, unattributed items fall back to the old
    // first-recognized order; items claiming another image are excluded.
    const primary = items.filter((item) => describes.get(item.id)?.includes(primaryId))
    candidates = primary.length ? primary : items.filter((item) => !describes.has(item.id))
  }
  for (const item of candidates) {
    const list = extents.get(item.id)
    if (!list?.length) continue
    // Metadata items are single contiguous extents in every real file;
    // an item only qualifies for a ranged read when it is exactly one.
    if (list.length !== 1) {
      const inside = list.every((e) => e.offset >= 0 && e.offset + e.length <= b.length)
      if (!inside) continue
      // Assemble once — per-extent concat is quadratic, and the joined
      // payload answers to the same ceiling every other item does.
      const total = list.reduce((n, e) => n + e.length, 0)
      if (total <= 0 || total > MAX_SCAN_BYTES) continue
      const payload = new Uint8Array(total)
      let at = 0
      for (const e of list) {
        payload.set(b.subarray(e.offset, e.offset + e.length), at)
        at += e.length
      }
      if (item.kind === 'exif') {
        const tiff = tiffFromExifPayload(payload)
        if (tiff && !parts.tiff) parts.tiff = tiff
      } else if (parts.xmp === undefined) {
        parts.xmp = utf8.decode(payload)
      }
      continue
    }
    const extent = list[0]!
    const end = extent.offset + extent.length
    if (extent.offset >= 0 && end <= b.length) {
      if (item.kind === 'exif') {
        const tiff = tiffFromExifPayload(b.slice(extent.offset, end))
        if (tiff && !parts.tiff) parts.tiff = tiff
      } else if (parts.xmp === undefined) {
        parts.xmp = utf8.decode(b.subarray(extent.offset, end))
      }
    } else if (extent.length > 0 && extent.length <= MAX_SCAN_BYTES && extent.offset >= 0) {
      pending.push({ offset: extent.offset, length: extent.length, kind: item.kind })
    }
  }
  return { parts, incomplete: false, pending }
}

const analyze = (b: Uint8Array): Analysis => {
  try {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return jpegAnalysis(b)
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return pngAnalysis(b)
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return webpAnalysis(b)
    return heifAnalysis(b)
  } catch {
    return { parts: {}, incomplete: false, pending: [] }
  }
}

// ---------------------------------------------------------------------------
// merge + caps

const mergeParts = (parts: (Parts | undefined)[]): ExifData | undefined => {
  const exifParts: ExifData[] = []
  const iptcParts: ExifData[] = []
  const xmpParts: ExifData[] = []
  for (const part of parts) {
    if (!part) continue
    if (part.tiff) {
      try { const v = exifFromTiff(part.tiff); if (v) exifParts.push(v) } catch { /* skip */ }
    }
    if (part.iptc) {
      try { const v = iptcFromData(part.iptc); if (v) iptcParts.push(v) } catch { /* skip */ }
    }
    if (part.xmp) {
      try { const v = xmpFromPacket(part.xmp); if (v) xmpParts.push(v) } catch { /* skip */ }
    }
  }
  const last = <T>(list: T[]): T | undefined => list[list.length - 1]
  const exif = last(exifParts)
  const iptc = last(iptcParts)
  const xmp = last(xmpParts)
  const out: ExifData = {}
  // Shared descriptive fields: XMP > IPTC > EXIF.
  const pick = <K extends 'title' | 'description' | 'creator' | 'copyright' | 'keywords' | 'location'>(key: K): ExifData[K] | undefined =>
    (xmp?.[key] ?? iptc?.[key] ?? exif?.[key]) as ExifData[K] | undefined
  const title = clean(pick('title'), 120)
  if (title) out.title = title
  const description = clean(pick('description'), 500)
  if (description) out.description = description
  const creator = clean(pick('creator'), 100)
  if (creator) out.creator = creator
  const copyright = clean(pick('copyright'), 150)
  if (copyright) out.copyright = copyright
  const keywords = cleanKeywords(pick('keywords') ?? [])
  if (keywords) out.keywords = keywords
  const location = clean(pick('location'), 150)
  if (location) out.location = location
  // Capture fields are EXIF-only by contract.
  if (exif?.camera) out.camera = exif.camera
  if (exif?.lens) out.lens = exif.lens
  if (exif?.aperture) out.aperture = exif.aperture
  if (exif?.shutter) out.shutter = exif.shutter
  if (exif?.iso) out.iso = exif.iso
  if (exif?.focalLength) out.focalLength = exif.focalLength
  if (exif?.dateOriginal) out.dateOriginal = exif.dateOriginal
  return Object.keys(out).length ? out : undefined
}

/** Everything reachable inside `bytes` — synchronous, total. PNG zTXt
 *  raw profiles need async inflate and are only read by
 *  readEmbeddedMetadata. */
export const parseEmbeddedMetadata = (bytes: Uint8Array): ExifData | undefined => {
  try {
    const analysis = analyze(bytes)
    return mergeParts([analysis.parts])
  } catch {
    return undefined
  }
}

/** Reads the head window, follows JPEG segment walks and HEIC item
 *  extents further when needed, and never throws — any failure degrades
 *  to whatever parsed, or undefined. */
export const readEmbeddedMetadata = async (read: RangeReader): Promise<ExifData | undefined> => {
  try {
    // Every range read — the head, each JPEG continuation window, every
    // queued extent — spends from one budget, so a pathological file
    // cannot multiply a small probe into a large transfer.
    let budget = MAX_SCAN_BYTES
    const head = await read(0, EMBEDDED_HEAD_BYTES)
    if (!head?.length) return undefined
    budget -= head.length
    let buffer = head
    let analysis = analyze(buffer)
    // JPEG metadata can sit behind a long strip of segments; keep pulling
    // chunks (bounded) until the walk reaches SOS/EOI or the buffer ends.
    let guard = 0
    while (analysis.incomplete && buffer.length < MAX_SCAN_BYTES && budget > 0 && guard++ < 8) {
      const want = Math.min(EMBEDDED_HEAD_BYTES, MAX_SCAN_BYTES - buffer.length, budget)
      const chunk = await read(buffer.length, want)
      if (!chunk?.length) break
      budget -= chunk.length
      buffer = concat(buffer, chunk)
      analysis = analyze(buffer)
    }
    const parts: (Parts | undefined)[] = [analysis.parts]
    // HEIC items whose extents lie past the head get one ranged read each;
    // WebP chunk walks resume as tail windows. A queued read that would
    // overrun the budget reads what is left, and none start once it is gone.
    const queue = analysis.pending.slice()
    for (let i = 0; i < queue.length && budget > 0; i++) {
      const pending = queue[i]!
      try {
        const want = Math.min(pending.length, (pending.end ?? Number.MAX_SAFE_INTEGER) - pending.offset, budget)
        if (want <= 0) break
        const payload = await read(pending.offset, want)
        budget -= payload?.length ?? 0
        if (!payload?.length) continue
        if (pending.kind === 'webtail') {
          const tail = webpTailAnalysis(payload, pending.offset, pending.end ?? 0)
          parts.push(tail.parts)
          queue.push(...tail.pending)
        } else if (pending.kind === 'exif') {
          const tiff = tiffFromExifPayload(payload)
          if (tiff) parts.push({ tiff })
        } else {
          parts.push({ xmp: utf8.decode(payload) })
        }
      } catch { /* one bad item must not sink the rest */ }
    }
    // PNG zTXt raw profiles decompress here — inflate is async, so the
    // sync parser never sees them (documented on parseEmbeddedMetadata).
    for (const compressed of analysis.iptcZtxt ?? []) {
      try {
        const profile = decodePngRawProfile(latin1.decode(await inflateZlib(compressed, MAX_SCAN_BYTES)))
        const iptc = profile && iptcProfilePayload(profile)
        if (iptc) parts.push({ iptc })
      } catch { /* skip */ }
    }
    return mergeParts(parts)
  } catch {
    return undefined
  }
}
