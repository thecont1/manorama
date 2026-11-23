import { describe, expect, test } from 'bun:test'
import { parseEmbeddedMetadata, readEmbeddedMetadata, type RangeReader } from './embedded-metadata'

// ---------------------------------------------------------------------------
// byte builders — no fixtures on disk

const te = new TextEncoder()

const u16 = (v: number, le: boolean) => {
  const b = new Uint8Array(2)
  if (le) { b[0] = v & 0xff; b[1] = (v >> 8) & 0xff } else { b[0] = (v >> 8) & 0xff; b[1] = v & 0xff }
  return b
}
const u32 = (v: number, le: boolean) => {
  const b = new Uint8Array(4)
  if (le) { b[0] = v & 0xff; b[1] = (v >> 8) & 0xff; b[2] = (v >> 16) & 0xff; b[3] = (v >> 24) & 0xff }
  else { b[0] = (v >> 24) & 0xff; b[1] = (v >> 16) & 0xff; b[2] = (v >> 8) & 0xff; b[3] = v & 0xff }
  return b
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// TIFF tag spec: type 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 7 UNDEFINED.
// Payloads are pre-encoded in the file's byte order by tiffTags(le).
type TiffTag = { tag: number; type: number; count: number; data: Uint8Array }

const tiffTags = (le: boolean) => ({
  ascii: (tag: number, text: string): TiffTag => ({ tag, type: 2, count: text.length + 1, data: concat(te.encode(text), new Uint8Array(1)) }),
  short: (tag: number, ...values: number[]): TiffTag => ({ tag, type: 3, count: values.length, data: concat(...values.map((v) => u16(v, le))) }),
  long: (tag: number, ...values: number[]): TiffTag => ({ tag, type: 4, count: values.length, data: concat(...values.map((v) => u32(v, le))) }),
  rational: (tag: number, ...pairs: [number, number][]): TiffTag => ({ tag, type: 5, count: pairs.length, data: concat(...pairs.map(([n, d]) => concat(u32(n, le), u32(d, le)))) }),
  undef: (tag: number, bytes: Uint8Array): TiffTag => ({ tag, type: 7, count: bytes.length, data: bytes }),
})

/** Lays out one IFD: values of <= 4 bytes sit inline in the entry, larger
 *  ones become offsets into the trailing data area. */
const layoutIfd = (tags: TiffTag[], dataStart: number, le: boolean) => {
  const rows: { tag: number; type: number; count: number; value: Uint8Array }[] = []
  const dataParts: Uint8Array[] = []
  let cursor = dataStart
  for (const tag of tags) {
    if (tag.data.length <= 4) {
      const inline = new Uint8Array(4)
      inline.set(tag.data)
      rows.push({ tag: tag.tag, type: tag.type, count: tag.count, value: inline })
    } else {
      rows.push({ tag: tag.tag, type: tag.type, count: tag.count, value: u32(cursor, le) })
      dataParts.push(tag.data)
      cursor += tag.data.length
    }
  }
  return { rows, dataParts, end: cursor }
}

const writeIfd = (out: Uint8Array, at: number, rows: { tag: number; type: number; count: number; value: Uint8Array }[], le: boolean) => {
  out.set(u16(rows.length, le), at)
  let p = at + 2
  for (const row of rows) {
    out.set(u16(row.tag, le), p)
    out.set(u16(row.type, le), p + 2)
    out.set(u32(row.count, le), p + 4)
    out.set(row.value, p + 8)
    p += 12
  }
  out.set(u32(0, le), p) // next IFD = 0
}

/** Minimal TIFF: header + IFD0 (+ optional ExifIFD reached via 0x8769). */
const tiff = (le: boolean, ifd0: TiffTag[], exifIfd: TiffTag[] = []): Uint8Array => {
  const hasExif = exifIfd.length > 0
  const n0 = ifd0.length + (hasExif ? 1 : 0)
  const ifd0Size = 2 + n0 * 12 + 4
  const data0Start = 8 + ifd0Size
  const lay0 = layoutIfd(ifd0, data0Start, le)
  const ifd1Start = lay0.end
  const ifd1Size = hasExif ? 2 + exifIfd.length * 12 + 4 : 0
  const data1Start = ifd1Start + ifd1Size
  const lay1 = hasExif ? layoutIfd(exifIfd, data1Start, le) : null
  const size = lay1 ? lay1.end : lay0.end
  const out = new Uint8Array(size)
  out.set(le ? new Uint8Array([0x49, 0x49]) : new Uint8Array([0x4d, 0x4d]), 0)
  out.set(u16(42, le), 2)
  out.set(u32(8, le), 4)
  const rows0 = [...lay0.rows]
  if (hasExif) rows0.push({ tag: 0x8769, type: 4, count: 1, value: u32(ifd1Start, le) })
  writeIfd(out, 8, rows0, le)
  let p = data0Start
  for (const part of lay0.dataParts) { out.set(part, p); p += part.length }
  if (lay1) {
    writeIfd(out, ifd1Start, lay1.rows, le)
    p = data1Start
    for (const part of lay1.dataParts) { out.set(part, p); p += part.length }
  }
  return out
}

// JPEG container
const jpeg = (...segments: { marker: number; data: Uint8Array }[]): Uint8Array => {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
  for (const seg of segments) {
    parts.push(new Uint8Array([0xff, seg.marker]), u16(seg.data.length + 2, false), seg.data)
  }
  parts.push(new Uint8Array([0xff, 0xd9]))
  return concat(...parts)
}
const app1Exif = (tiffBytes: Uint8Array) => ({ marker: 0xe1, data: concat(te.encode('Exif\0\0'), tiffBytes) })
const app1Xmp = (packet: string) => ({ marker: 0xe1, data: concat(te.encode('http://ns.adobe.com/xap/1.0/\0'), te.encode(packet)) })

const iptcDataset = (record: number, tag: number, payload: Uint8Array): Uint8Array =>
  concat(new Uint8Array([0x1c, record, tag]), u16(payload.length, false), payload)

const bimIptcResource = (iptc: Uint8Array): Uint8Array =>
  // 8BIM: '8BIM' + id(2) + empty Pascal name(1) + pad(1) + size(4) + data (+pad)
  concat(
    te.encode('8BIM'),
    u16(0x0404, false),
    new Uint8Array([0x00, 0x00]),
    u32(iptc.length, false),
    iptc,
    iptc.length % 2 ? new Uint8Array(1) : new Uint8Array(0),
  )

const photoshopIptc = (iptc: Uint8Array): { marker: number; data: Uint8Array } => ({
  marker: 0xed,
  data: concat(te.encode('Photoshop 3.0\0'), bimIptcResource(iptc)),
})

// PNG
const pngChunk = (type: string, data: Uint8Array): Uint8Array =>
  concat(u32(data.length, false), te.encode(type), data, new Uint8Array(4))
const png = (...chunks: Uint8Array[]): Uint8Array =>
  concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks, pngChunk('IEND', new Uint8Array(0)))

const hexEncode = (bytes: Uint8Array): string => {
  let s = ''
  for (const byte of bytes) s += byte.toString(16).padStart(2, '0')
  return s
}

// "Raw profile type iptc" text: description, length, then hex payload.
const pngRawProfileText = (payload: Uint8Array): string =>
  `\nIPTC profile\n${String(payload.length).padStart(8)}\n${hexEncode(payload)}`
const pngText = (keyword: string, text: string): Uint8Array =>
  pngChunk('tEXt', concat(te.encode(keyword), new Uint8Array([0]), te.encode(text)))
const pngZtxt = async (keyword: string, data: Uint8Array, method = 0): Promise<Uint8Array> => {
  const compressed = method === 0
    ? new Uint8Array(await new Response(
        new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer())
    : data
  return pngChunk('zTXt', concat(te.encode(keyword), new Uint8Array([0, method]), compressed))
}

// WebP
const webpChunk = (fourcc: string, data: Uint8Array): Uint8Array =>
  concat(te.encode(fourcc), u32(data.length, true), data, data.length % 2 ? new Uint8Array(1) : new Uint8Array(0))
const webp = (...chunks: Uint8Array[]): Uint8Array => {
  const body = concat(te.encode('WEBP'), ...chunks)
  return concat(te.encode('RIFF'), u32(body.length, true), body)
}

// HEIC/ISOBMFF
const isoBox = (type: string, content: Uint8Array): Uint8Array =>
  concat(u32(8 + content.length, false), te.encode(type), content)
const fullBox = (version: number, content: Uint8Array): Uint8Array =>
  concat(new Uint8Array([version, 0, 0, 0]), content)

const heifFileItems = (entries: { type: 'Exif' | 'mime'; payload: Uint8Array; offset: number; contentType?: string }[]) => {
  const calls: { offset: number; length: number }[] = []
  const infes = entries.map((entry, i) => {
    const id = i + 1
    const itemBody = entry.type === 'mime'
      ? concat(
          u16(id, false), u16(0, false), te.encode('mime'), new Uint8Array([0]),
          te.encode(entry.contentType ?? 'application/rdf+xml'), new Uint8Array([0]),
          new Uint8Array([0]),
        )
      : concat(u16(id, false), u16(0, false), te.encode('Exif'), new Uint8Array([0]))
    return isoBox('infe', fullBox(2, itemBody))
  })
  const iinf = isoBox('iinf', fullBox(0, concat(u16(entries.length, false), ...infes)))
  // iloc v0: offset_size=4, length_size=4, base_offset_size=0
  const ilocEntries = entries.flatMap((entry, i) => [
    u16(i + 1, false), // item_ID
    u16(0, false), // data_reference_index
    u16(1, false), // extent_count
    u32(entry.offset, false),
    u32(entry.payload.length, false),
  ])
  const iloc = isoBox('iloc', fullBox(0, concat(
    new Uint8Array([0x44, 0x00]),
    u16(entries.length, false),
    ...ilocEntries,
  )))
  const meta = isoBox('meta', fullBox(0, concat(iinf, iloc)))
  const ftyp = isoBox('ftyp', concat(te.encode('heic'), u32(0, false), te.encode('heic')))
  const head = concat(ftyp, meta)
  const end = Math.max(...entries.map((e) => e.offset + e.payload.length), head.length)
  const bytes = new Uint8Array(end)
  bytes.set(head, 0)
  for (const entry of entries) bytes.set(entry.payload, entry.offset)
  const read: RangeReader = async (start, length) => {
    calls.push({ offset: start, length })
    return bytes.slice(start, Math.min(start + length, bytes.length))
  }
  return { bytes, calls, read }
}

const heifFile = (exifPayload: Uint8Array, payloadOffset: number) =>
  heifFileItems([{ type: 'Exif', payload: exifPayload, offset: payloadOffset }])

// Canonical little-endian EXIF content shared across tests.
const T = tiffTags(true)
const exifTags = () => ({
  ifd0: [
    T.ascii(0x010f, 'Canon'),
    T.ascii(0x0110, 'EOS R5'),
    T.ascii(0x010e, 'A description'),
    T.ascii(0x013b, 'Jane Doe'),
    T.ascii(0x8298, 'Copyright 2026'),
  ],
  exif: [
    T.rational(0x829a, [1, 250]),
    T.rational(0x829d, [28, 10]),
    T.short(0x8827, 400),
    T.ascii(0x9003, '2026:11:22 14:05:09'),
    T.ascii(0x9011, '+05:30'),
    T.rational(0x920a, [35, 1]),
    T.undef(0xa434, te.encode('RF 24-70mm F2.8L')),
  ],
})

// ---------------------------------------------------------------------------

describe('embedded metadata — JPEG EXIF', () => {
  test('little-endian TIFF parses camera, exposure, date', () => {
    const tags = exifTags()
    const exif = parseEmbeddedMetadata(jpeg(app1Exif(tiff(true, tags.ifd0, tags.exif))))
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.aperture).toBe('f/2.8')
    expect(exif?.shutter).toBe('1/250 s')
    expect(exif?.iso).toBe(400)
    expect(exif?.focalLength).toBe('35 mm')
    expect(exif?.lens).toBe('RF 24-70mm F2.8L')
    expect(exif?.dateOriginal).toBe('2026-11-22T14:05:09+05:30')
    expect(exif?.description).toBe('A description')
    expect(exif?.creator).toBe('Jane Doe')
    expect(exif?.copyright).toBe('Copyright 2026')
  })

  test('big-endian TIFF parses the same fields', () => {
    const TB = tiffTags(false)
    const file = jpeg(app1Exif(tiff(false, [
      TB.ascii(0x010f, 'NIKON'), TB.ascii(0x0110, 'D850'),
    ], [
      TB.rational(0x829d, [56, 10]), TB.short(0x8827, 64), TB.ascii(0x9003, '2020:01:02 03:04:05'),
    ])))
    const exif = parseEmbeddedMetadata(file)
    expect(exif?.camera).toBe('NIKON D850')
    expect(exif?.aperture).toBe('f/5.6')
    expect(exif?.iso).toBe(64)
    expect(exif?.dateOriginal).toBe('2020-01-02T03:04:05')
  })

  test('camera folding cases', () => {
    const prefixed = jpeg(app1Exif(tiff(true, [T.ascii(0x010f, 'Canon'), T.ascii(0x0110, 'Canon EOS R5')])))
    expect(parseEmbeddedMetadata(prefixed)?.camera).toBe('Canon EOS R5')
    const apple = jpeg(app1Exif(tiff(true, [T.ascii(0x010f, 'Apple'), T.ascii(0x0110, 'iPhone 15 Pro')])))
    expect(parseEmbeddedMetadata(apple)?.camera).toBe('Apple iPhone 15 Pro')
    const modelOnly = jpeg(app1Exif(tiff(true, [T.ascii(0x0110, 'X100V')])))
    expect(parseEmbeddedMetadata(modelOnly)?.camera).toBe('X100V')
    const makeOnly = jpeg(app1Exif(tiff(true, [T.ascii(0x010f, 'Hasselblad')])))
    expect(parseEmbeddedMetadata(makeOnly)?.camera).toBe('Hasselblad')
  })

  test('shutter and aperture edge formats', () => {
    const two = jpeg(app1Exif(tiff(true, [], [T.rational(0x829a, [2, 1]), T.rational(0x829d, [2, 1])])))
    const exif = parseEmbeddedMetadata(two)
    expect(exif?.shutter).toBe('2 s')
    expect(exif?.aperture).toBe('f/2')
    const half = jpeg(app1Exif(tiff(true, [], [T.rational(0x829a, [1, 2])])))
    expect(parseEmbeddedMetadata(half)?.shutter).toBe('1/2 s')
    const third = jpeg(app1Exif(tiff(true, [], [T.rational(0x829a, [3, 10])])))
    expect(parseEmbeddedMetadata(third)?.shutter).toBe('0.3 s')
  })

  test('aperture and focal length round to one decimal, ".0" dropped', () => {
    const mk = (fnumber: [number, number], focal: [number, number]) =>
      parseEmbeddedMetadata(jpeg(app1Exif(tiff(true, [], [
        T.rational(0x829d, fnumber), T.rational(0x920a, focal),
      ]))))
    expect(mk([244, 100], [695, 100])?.aperture).toBe('f/2.4')
    expect(mk([244, 100], [695, 100])?.focalLength).toBe('7 mm')
    expect(mk([178, 100], [694, 100])?.aperture).toBe('f/1.8')
    expect(mk([178, 100], [694, 100])?.focalLength).toBe('6.9 mm')
    expect(mk([20, 10], [235, 10])?.aperture).toBe('f/2')
    expect(mk([20, 10], [235, 10])?.focalLength).toBe('23.5 mm')
    expect(mk([28, 10], [350, 10])?.aperture).toBe('f/2.8')
    expect(mk([28, 10], [350, 10])?.focalLength).toBe('35 mm')
  })

  test('GPS IFD is never followed or surfaced', () => {
    const T2 = tiffTags(true)
    // Hand-built three-IFD TIFF: IFD0 -> ExifIFD (0x8769) and GPS IFD (0x8825).
    const ifd0Tags = [T2.ascii(0x010f, 'GPS')]
    const gpsIfd: TiffTag[] = [T2.ascii(0x0002, 'N'), T2.rational(0x0004, [37, 1])]
    const n0 = ifd0Tags.length + 2
    const ifd0Size = 2 + n0 * 12 + 4
    const data0Start = 8 + ifd0Size
    const lay0 = layoutIfd(ifd0Tags, data0Start, true)
    const ifd1Start = lay0.end
    const ifd1Size = 2 + 1 * 12 + 4
    const data1Start = ifd1Start + ifd1Size
    const lay1 = layoutIfd([T2.short(0x8827, 100)], data1Start, true)
    const ifd2Start = lay1.end
    const ifd2Size = 2 + gpsIfd.length * 12 + 4
    const data2Start = ifd2Start + ifd2Size
    const lay2 = layoutIfd(gpsIfd, data2Start, true)
    const out = new Uint8Array(lay2.end)
    out.set(new Uint8Array([0x49, 0x49]), 0)
    out.set(u16(42, true), 2)
    out.set(u32(8, true), 4)
    writeIfd(out, 8, [
      ...lay0.rows,
      { tag: 0x8769, type: 4, count: 1, value: u32(ifd1Start, true) },
      { tag: 0x8825, type: 4, count: 1, value: u32(ifd2Start, true) },
    ], true)
    let p = data0Start
    for (const part of lay0.dataParts) { out.set(part, p); p += part.length }
    writeIfd(out, ifd1Start, lay1.rows, true)
    p = data1Start
    for (const part of lay1.dataParts) { out.set(part, p); p += part.length }
    writeIfd(out, ifd2Start, lay2.rows, true)
    p = data2Start
    for (const part of lay2.dataParts) { out.set(part, p); p += part.length }
    const exif = parseEmbeddedMetadata(jpeg(app1Exif(out)))
    expect(exif?.iso).toBe(100)
    expect(exif?.location).toBeUndefined()
    expect(JSON.stringify(exif)).not.toContain('37')
  })

  test('0000:00:00 and unparseable dates yield no dateOriginal', () => {
    const zero = jpeg(app1Exif(tiff(true, [], [T.ascii(0x9003, '0000:00:00 00:00:00')])))
    expect(parseEmbeddedMetadata(zero)?.dateOriginal).toBeUndefined()
    const bad = jpeg(app1Exif(tiff(true, [], [T.ascii(0x9003, 'not a date')])))
    expect(parseEmbeddedMetadata(bad)?.dateOriginal).toBeUndefined()
    const feb30 = jpeg(app1Exif(tiff(true, [], [T.ascii(0x9003, '2026:02:30 10:00:00')])))
    expect(parseEmbeddedMetadata(feb30)?.dateOriginal).toBeUndefined()
    const noZone = jpeg(app1Exif(tiff(true, [], [T.ascii(0x9003, '2026:09:23 08:00:00')])))
    expect(parseEmbeddedMetadata(noZone)?.dateOriginal).toBe('2026-09-23T08:00:00')
  })
})

describe('embedded metadata — IPTC', () => {
  test('record 2 strings decode as UTF-8 when 1:90 declares it', () => {
    const charset = iptcDataset(1, 90, new Uint8Array([0x1b, 0x25, 0x47]))
    const iptc = concat(
      charset,
      iptcDataset(2, 5, te.encode('München Dawn')),
      iptcDataset(2, 90, te.encode('München')),
      iptcDataset(2, 101, te.encode('Deutschland')),
      iptcDataset(2, 92, te.encode('Schwabing')),
      iptcDataset(2, 95, te.encode('Bavaria')),
      iptcDataset(2, 25, te.encode('night')),
      iptcDataset(2, 25, te.encode('street')),
      iptcDataset(2, 80, te.encode('José Ángel')),
      iptcDataset(2, 116, te.encode('© 2026 Studio')),
      iptcDataset(2, 120, te.encode('A quiet street.')),
    )
    const exif = parseEmbeddedMetadata(jpeg(photoshopIptc(iptc)))
    expect(exif?.title).toBe('München Dawn')
    expect(exif?.creator).toBe('José Ángel')
    expect(exif?.copyright).toBe('© 2026 Studio')
    expect(exif?.description).toBe('A quiet street.')
    expect(exif?.keywords).toEqual(['night', 'street'])
    expect(exif?.location).toBe('Schwabing, München, Bavaria, Deutschland')
  })

  test('Latin-1 fallback when bytes are not valid UTF-8', () => {
    const creator = iptcDataset(2, 80, new Uint8Array([0x4a, 0x6f, 0x73, 0xe9])) // "José" Latin-1
    expect(parseEmbeddedMetadata(jpeg(photoshopIptc(creator)))?.creator).toBe('José')
  })

  test('UTF-8 validates without a declared charset', () => {
    expect(parseEmbeddedMetadata(jpeg(photoshopIptc(iptcDataset(2, 80, te.encode('Zoë')))))?.creator).toBe('Zoë')
  })
})

describe('embedded metadata — XMP', () => {
  const packet = `<?xpacket begin=""?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Harbour &amp; Light &#8212; &#x2019;tide&#8217;</rdf:li><rdf:li xml:lang="fr">Port</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li>A foggy morning &lt;here&gt;</rdf:li></rdf:Alt></dc:description>
   <dc:creator><rdf:Seq><rdf:li>Ada Lovelace</rdf:li><rdf:li>Grace Hopper</rdf:li></rdf:Seq></dc:creator>
   <dc:rights><rdf:Alt><rdf:li>All rights reserved</rdf:li></rdf:Alt></dc:rights>
   <dc:subject><rdf:Bag><rdf:li>sea</rdf:li><rdf:li>fog</rdf:li><rdf:li>sea</rdf:li></rdf:Bag></dc:subject>
   <photoshop:City>Lisbon</photoshop:City>
   <photoshop:State>Lisboa</photoshop:State>
   <photoshop:Country>Portugal</photoshop:Country>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`

  test('Alt/Seq/Bag extraction with entities', () => {
    const exif = parseEmbeddedMetadata(jpeg(app1Xmp(packet)))
    expect(exif?.title).toBe('Harbour & Light — ’tide’')
    expect(exif?.description).toBe('A foggy morning <here>')
    expect(exif?.creator).toBe('Ada Lovelace, Grace Hopper')
    expect(exif?.copyright).toBe('All rights reserved')
    expect(exif?.keywords).toEqual(['sea', 'fog'])
    expect(exif?.location).toBe('Lisbon, Lisboa, Portugal')
  })

  test('Iptc4xmpCore:Location is the fallback when structured fields are absent', () => {
    const p = `<x:xmpmeta><rdf:RDF><rdf:Description xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"><Iptc4xmpCore:Location>Porto, Norte</Iptc4xmpCore:Location></rdf:Description></rdf:RDF></x:xmpmeta>`
    expect(parseEmbeddedMetadata(jpeg(app1Xmp(p)))?.location).toBe('Porto, Norte')
  })
})

describe('embedded metadata — merge priority', () => {
  test('XMP beats IPTC beats EXIF for shared fields; EXIF keeps capture fields', () => {
    const tags = exifTags()
    const iptc = concat(
      iptcDataset(2, 5, te.encode('IPTC Title')),
      iptcDataset(2, 120, te.encode('IPTC caption')),
      iptcDataset(2, 80, te.encode('IPTC Author')),
    )
    const xmp = `<?xpacket?><x:xmpmeta><rdf:RDF><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li>XMP Title</rdf:li></rdf:Alt></dc:title><dc:description><rdf:Alt><rdf:li>XMP desc</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`
    const exif = parseEmbeddedMetadata(jpeg(
      app1Exif(tiff(true, tags.ifd0, tags.exif)),
      photoshopIptc(iptc),
      app1Xmp(xmp),
    ))
    expect(exif?.title).toBe('XMP Title')
    expect(exif?.description).toBe('XMP desc')
    expect(exif?.creator).toBe('IPTC Author') // XMP has none → IPTC over EXIF Artist
    expect(exif?.copyright).toBe('Copyright 2026') // only EXIF has it
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.shutter).toBe('1/250 s')
  })
})

describe('embedded metadata — PNG and WebP', () => {
  test('PNG eXIf chunk parses', () => {
    const tags = exifTags()
    const file = png(pngChunk('IHDR', new Uint8Array(13)), pngChunk('eXIf', tiff(true, tags.ifd0, tags.exif)))
    const exif = parseEmbeddedMetadata(file)
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.iso).toBe(400)
  })

  test('PNG iTXt XMP packet parses', () => {
    const xmpText = `<x:xmpmeta><rdf:RDF><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li>PNG Title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`
    // iTXt: keyword NUL flag(0) method(0) lang NUL translated NUL text —
    // five NUL bytes total between the keyword and the packet.
    const itxt = concat(te.encode('XML:com.adobe.xmp'), new Uint8Array(5), te.encode(xmpText))
    expect(parseEmbeddedMetadata(png(pngChunk('IHDR', new Uint8Array(13)), pngChunk('iTXt', itxt)))?.title).toBe('PNG Title')
  })

  test('PNG tEXt raw-profile IPTC parses (8BIM-wrapped payload)', () => {
    const iptc = concat(
      iptcDataset(2, 0x05, te.encode('Raw Profile Title')),
      iptcDataset(2, 0x5a, te.encode('Panjim')),
      iptcDataset(2, 0x65, te.encode('India')),
    )
    const file = png(
      pngChunk('IHDR', new Uint8Array(13)),
      pngText('Raw profile type iptc', pngRawProfileText(bimIptcResource(iptc))),
    )
    const exif = parseEmbeddedMetadata(file)
    expect(exif?.title).toBe('Raw Profile Title')
    expect(exif?.location).toBe('Panjim, India')
  })

  test('PNG raw profile with a bare IPTC dataset parses', () => {
    const iptc = iptcDataset(2, 0x50, te.encode('Bare Creator'))
    const file = png(
      pngChunk('IHDR', new Uint8Array(13)),
      pngText('Raw profile type iptc', pngRawProfileText(iptc)),
    )
    expect(parseEmbeddedMetadata(file)?.creator).toBe('Bare Creator')
  })

  test('PNG zTXt raw-profile IPTC parses through the ranged reader', async () => {
    const iptc = iptcDataset(2, 0x74, te.encode('Raw Profile Copyright'))
    const file = png(
      pngChunk('IHDR', new Uint8Array(13)),
      await pngZtxt('Raw profile type iptc', te.encode(pngRawProfileText(bimIptcResource(iptc)))),
    )
    // Inflate is async — the sync parser cannot see compressed profiles.
    expect(parseEmbeddedMetadata(file)?.copyright).toBeUndefined()
    const read: RangeReader = async (start, length) => file.slice(start, Math.min(start + length, file.length))
    expect((await readEmbeddedMetadata(read))?.copyright).toBe('Raw Profile Copyright')
  })

  test('PNG raw profiles for other types and non-deflate zTXt are ignored', async () => {
    const iptc = iptcDataset(2, 0x05, te.encode('Nope'))
    const file = png(
      pngChunk('IHDR', new Uint8Array(13)),
      pngText('Raw profile type exif', pngRawProfileText(bimIptcResource(iptc))),
      await pngZtxt('Raw profile type iptc', te.encode('not-deflate'), 1),
    )
    const read: RangeReader = async (start, length) => file.slice(start, Math.min(start + length, file.length))
    expect(await readEmbeddedMetadata(read)).toBeUndefined()
  })

  test('WebP EXIF chunk parses (with Exif prefix)', () => {
    const tags = exifTags()
    const file = webp(webpChunk('EXIF', concat(te.encode('Exif\0\0'), tiff(true, tags.ifd0, tags.exif))))
    expect(parseEmbeddedMetadata(file)?.camera).toBe('Canon EOS R5')
  })
})

describe('embedded metadata — HEIC', () => {
  test('in-window Exif item parses', () => {
    const tags = exifTags()
    const payload = concat(u32(4, false), tiff(true, tags.ifd0, tags.exif))
    const { bytes } = heifFile(payload, 200)
    expect(parseEmbeddedMetadata(bytes)?.camera).toBe('Canon EOS R5')
  })

  test('Exif payload with offset field and Exif signature (real HEIC layout)', () => {
    const tags = exifTags()
    // Offset 6 -> TIFF starts 4 + 6 bytes in, right after "Exif\0\0".
    const payload = concat(u32(6, false), te.encode('Exif\0\0'), tiff(true, tags.ifd0, tags.exif))
    const { bytes } = heifFile(payload, 200)
    const exif = parseEmbeddedMetadata(bytes)
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.iso).toBe(400)
  })

  test('mime item with rdf+xml content type supplies XMP', () => {
    const tags = exifTags()
    const exifPayload = concat(u32(4, false), tiff(true, tags.ifd0, tags.exif))
    const xmpPayload = te.encode('<?xpacket?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">HEIC Title</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>')
    const { bytes } = heifFileItems([
      { type: 'Exif', payload: exifPayload, offset: 200 },
      { type: 'mime', payload: xmpPayload, offset: 900 },
    ])
    const exif = parseEmbeddedMetadata(bytes)
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.title).toBe('HEIC Title')
    expect(exif?.creator).toBe('Ada, Grace')
  })

  test('mime item with a non-XMP content type is ignored', () => {
    const xmpPayload = te.encode('<not>xmp</not>')
    const { bytes } = heifFileItems([
      { type: 'mime', payload: xmpPayload, offset: 200, contentType: 'text/plain' },
    ])
    expect(parseEmbeddedMetadata(bytes)).toBeUndefined()
  })

  test('extent beyond the head window triggers one ranged read', async () => {
    const tags = exifTags()
    const payload = concat(u32(4, false), tiff(true, tags.ifd0, tags.exif))
    const offset = 600 * 1024 // beyond the 512 KiB head
    const { bytes, read, calls } = heifFile(payload, offset)
    // Sync parse over just the head window sees the item but cannot reach
    // the payload — the same view readEmbeddedMetadata starts from.
    expect(parseEmbeddedMetadata(bytes.subarray(0, 512 * 1024))?.camera).toBeUndefined()
    const exif = await readEmbeddedMetadata(read)
    expect(exif?.camera).toBe('Canon EOS R5')
    expect(exif?.iso).toBe(400)
    const itemRead = calls.find((c) => c.offset === offset)
    expect(itemRead?.length).toBe(payload.length)
  })
})

describe('embedded metadata — robustness and caps', () => {
  test('garbage, truncation and IFD loops never throw', async () => {
    expect(parseEmbeddedMetadata(new Uint8Array(0))).toBeUndefined()
    expect(parseEmbeddedMetadata(te.encode('not an image at all'))).toBeUndefined()
    expect(parseEmbeddedMetadata(new Uint8Array([0xff, 0xd8]))).toBeUndefined()
    const tags = exifTags()
    const truncated = jpeg(app1Exif(tiff(true, tags.ifd0, tags.exif))).subarray(0, 30)
    expect(() => parseEmbeddedMetadata(truncated)).not.toThrow()
    // IFD whose next-IFD pointer loops back to itself.
    const loop = new Uint8Array(64)
    loop.set(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), 0)
    loop.set(u32(8, true), 4)
    loop.set(u16(1, true), 8)
    loop.set(u16(0x010f, true), 10)
    loop.set(u16(2, true), 12)
    loop.set(u32(4, true), 14)
    loop.set(u32(8, true), 18) // value = next-IFD? entry value field at 18..21
    loop.set(te.encode('Ab'), 26)
    // The entry's value/offset field is bytes 18-21; the next-IFD pointer
    // sits after the single entry at offset 8+2+12=22.
    loop.set(u32(8, true), 22) // next IFD = 8 → loop
    expect(() => parseEmbeddedMetadata(jpeg(app1Exif(loop)))).not.toThrow()
    await expect(readEmbeddedMetadata(async () => { throw new Error('io') })).resolves.toBeUndefined()
  })

  test('field caps apply', () => {
    const tags = exifTags()
    const iptc = concat(
      iptcDataset(2, 5, te.encode('T'.repeat(500))),
      iptcDataset(2, 25, te.encode('k'.repeat(100))),
    )
    const exif = parseEmbeddedMetadata(jpeg(photoshopIptc(iptc), app1Exif(tiff(true, tags.ifd0, tags.exif))))
    expect(exif?.title?.length).toBe(120)
    expect(exif?.keywords?.[0]?.length).toBe(60)
  })

  test('keywords dedupe case-insensitively', () => {
    const iptc = concat(...Array.from({ length: 25 }, (_, i) => iptcDataset(2, 25, te.encode(`Key${i % 3}`))))
    expect(parseEmbeddedMetadata(jpeg(photoshopIptc(iptc)))?.keywords).toEqual(['Key0', 'Key1', 'Key2'])
  })

  test('empty strings become absent fields', () => {
    const tags = exifTags()
    const file = jpeg(app1Exif(tiff(true, [T.ascii(0x010f, ''), T.ascii(0x0110, '   ')], tags.exif)))
    const exif = parseEmbeddedMetadata(file)
    expect(exif?.camera).toBeUndefined()
    expect(exif?.iso).toBe(400)
  })
})
