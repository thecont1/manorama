// manorama gallery asset pipeline.
// Usage: bun run gallery
// Originals remain immutable; credentialed bytes are copied verbatim.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import exifr from 'exifr'

const ORIGINALS = process.argv[2] ?? './images'
const OUT = process.argv[3] ?? './public/images'
const SLUG = process.argv[4] ?? 'italy-2018'
const WIDTHS = [1200, 2000, 3200]
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const TITLE = 'Italy, seen slowly'
const CAPTION = 'A quiet sequence of streets, stone, and weather along an Italian journey.'
const DATE = 'October 2018'

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const placeholder = (w, h) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E`
const hasC2PA = (buf) => buf.includes(Buffer.from('c2pa', 'ascii'))
const clean = (value) => (value == null ? undefined : String(value))
const formatDate = (value) => {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
const extForFormat = (format, originalExt) => {
  if (format === 'webp') return '.webp'
  if (format === 'png') return '.png'
  if (format === 'jpeg') return '.jpg'
  return originalExt === '.jpeg' ? '.jpg' : originalExt
}
const labelFor = (file) => {
  const frame = file.match(/Italy(\d{4})/i)?.[1] ?? ''
  return `Photograph from Italy, 2018${frame ? ` — frame ${frame}` : ''}`
}

const files = (await readdir(ORIGINALS))
  .filter((file) => EXT.has(path.extname(file).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

const outDir = path.join(OUT, SLUG)
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const images = []
const report = []

for (const [index, file] of files.entries()) {
  const originalExt = path.extname(file).toLowerCase()
  const srcPath = path.join(ORIGINALS, file)
  const buf = await readFile(srcPath)
  const frame = file.match(/Italy(\d{4})/i)?.[1] ?? String(index + 1).padStart(4, '0')
  const id = `italy-2018-${frame}`
  const parsed = await exifr.parse(buf, {
    pick: ['DateTimeOriginal', 'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'ImageDescription'],
  }).catch(() => null)
  const metadata = await sharp(buf, { failOn: 'none' }).rotate().metadata()
  const width = metadata.width ?? 1
  const height = metadata.height ?? 1
  const format = metadata.format ?? (originalExt === '.webp' ? 'webp' : 'jpeg')
  const outputExt = extForFormat(format, originalExt)
  const c2pa = hasC2PA(buf)
  const exif = parsed
    ? {
        dateOriginal: formatDate(parsed.DateTimeOriginal),
        camera: [clean(parsed.Make), clean(parsed.Model)].filter(Boolean).join(' ') || undefined,
        lens: clean(parsed.LensModel),
        aperture: parsed.FNumber == null ? undefined : `f/${parsed.FNumber}`,
        shutter: clean(parsed.ExposureTime),
        iso: parsed.ISO == null ? undefined : Number(parsed.ISO),
        focalLength: parsed.FocalLength == null ? undefined : `${parsed.FocalLength} mm`,
        description: clean(parsed.ImageDescription),
      }
    : undefined
  const alt = exif?.description || labelFor(file)
  const entry = {
    id,
    filename: file,
    src: '',
    width,
    height,
    alt,
    caption: undefined,
    exif,
    c2pa,
    placeholder: placeholder(width, height),
  }

  if (c2pa) {
    const name = `${id}-${sha(buf).slice(0, 8)}${outputExt}`
    await copyFile(srcPath, path.join(outDir, name))
    entry.src = `/images/${SLUG}/${name}`
    const copied = await readFile(path.join(outDir, name))
    report.push({ id, c2pa: true, action: 'copied byte-verbatim', verified: sha(copied) === sha(buf) ? 'PASS' : 'FAIL' })
  } else {
    // Serve an immutable full original as the primary source. Derivatives retain ICC.
    const fullName = `${id}-full${outputExt}`
    await copyFile(srcPath, path.join(outDir, fullName))
    entry.src = `/images/${SLUG}/${fullName}`
    const variants = []
    const base = sharp(buf, { failOn: 'none' }).rotate().keepIccProfile()
    for (const w of WIDTHS.filter((value) => value < width)) {
      const sameName = `${id}-${w}w${outputExt}`
      const resized = base.clone().resize({ width: w })
      if (format === 'png') await resized.png({ compressionLevel: 9 }).toFile(path.join(outDir, sameName))
      else if (format === 'webp') await resized.webp({ quality: 85 }).toFile(path.join(outDir, sameName))
      else await resized.jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(outDir, sameName))
      variants.push({ width: w, src: `/images/${SLUG}/${sameName}`, format })
    }
    entry.variants = variants
    const primary = await readFile(path.join(outDir, fullName))
    const checked = await sharp(primary, { failOn: 'none' }).metadata()
    report.push({ id, c2pa: false, action: `${variants.length} ICC-preserving variants`, verified: checked.width === width && checked.height === height ? 'PASS' : 'FAIL (dimensions)' })
  }

  images.push(entry)
}

const manifest = { slug: SLUG, title: TITLE, caption: CAPTION, date: DATE, images }
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(path.join(outDir, 'integrity-report.json'), JSON.stringify({ report }, null, 2) + '\n')
await writeFile('./app/lib/gallery-manifest.ts', `export default ${JSON.stringify(manifest, null, 2)} as const\n`)
console.table(report)
const failed = report.filter((row) => String(row.verified).startsWith('FAIL'))
if (failed.length) {
  console.error(`INTEGRITY FAILURES: ${failed.map((row) => row.id).join(', ')}`)
  process.exit(1)
}
console.log(`manifest: ${path.join(outDir, 'manifest.json')} (${images.length} images)`)
