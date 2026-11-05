import { describe, expect, test } from 'bun:test'
import { validateEncryptedManifest } from './encrypted-manifest'
import { MAX_GALLERY_ITEMS } from './imagesource'

const sourceUrl = 'https://mega.nz/folder/AbCdEf12'
const image = () => ({
  id: 'mega-node1', ref: 'node1', filename: 'one.jpg', src: '',
  media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'node1' },
  contentVersion: 'a'.repeat(64), width: 4000, height: 3000,
  alt: 'One', c2pa: true, placeholder: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
})
const manifest = () => ({ provider: 'mega', sourceUrl, title: 'Test', images: [image()] })

describe('encrypted manifest trust boundary', () => {
  test('accepts a keyless MEGA manifest', () => {
    const result = validateEncryptedManifest(manifest())
    expect(result.provider).toBe('mega')
    expect(result.images).toHaveLength(1)
  })

  test('rejects secrets in source, item URLs, ids, and refs', () => {
    for (const mutate of [
      (value: any) => { value.sourceUrl += '#secret' },
      (value: any) => { value.images[0].src = '/api/mega/file?node=1&k=secret' },
      (value: any) => { value.images[0].id = 'secret-key' },
      (value: any) => { value.images[0].ref = 'node1#secret' },
      (value: any) => { value.images[0].media.sourceId = 'AbCdEf12#secret' },
    ]) {
      const value = manifest()
      mutate(value)
      expect(() => validateEncryptedManifest(value)).toThrow()
    }
  })

  test('rejects bad dimensions, versions, references, and unknown fields', () => {
    for (const mutate of [
      (value: any) => { value.images[0].width = 0 },
      (value: any) => { value.images[0].height = 10000; value.images[0].width = 1 },
      (value: any) => { value.images[0].contentVersion = 'size=123' },
      (value: any) => { value.images[0].media = { kind: 'http', url: 'https://evil.example/a.jpg' } },
      (value: any) => { value.images[0].unexpected = true },
    ]) {
      const value = manifest()
      mutate(value)
      expect(() => validateEncryptedManifest(value)).toThrow()
    }
  })

  test('rejects duplicate ids/refs and over-cap manifests', () => {
    const duplicate = manifest()
    duplicate.images.push(image())
    expect(() => validateEncryptedManifest(duplicate)).toThrow('unique')
    const large = { ...manifest(), images: Array.from({ length: MAX_GALLERY_ITEMS + 1 }, (_, index) => ({ ...image(), id: `i${index}`, ref: `n${index}`, media: { ...image().media, nodeId: `n${index}` } })) }
    expect(() => validateEncryptedManifest(large)).toThrow('1000')
  })

  test('requires the reference identity to match the published source', () => {
    const value = manifest()
    value.images[0].media.sourceId = 'OtherHandle'
    expect(() => validateEncryptedManifest(value)).toThrow('identity')
  })
})

describe('proton manifests', () => {
  const protonSource = 'https://drive.proton.me/urls/AbCdEf12_Gh'
  const protonImage = () => ({
    id: 'proton-NodeId01', ref: 'vol-ume_01~NodeId01', filename: 'two.jpg', src: '',
    media: { kind: 'encrypted', provider: 'proton', sourceKind: 'urls', sourceId: 'AbCdEf12_Gh', nodeId: 'vol-ume_01~NodeId01', previewId: 'vol-ume_01~NodeId01' },
    contentVersion: 'b'.repeat(64), width: 3000, height: 2000,
    alt: 'Two', c2pa: true, placeholder: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    variants: [{ width: 800, src: '', format: 'jpeg', media: { kind: 'encrypted', provider: 'proton', sourceKind: 'urls', sourceId: 'AbCdEf12_Gh', nodeId: 'vol-ume_01~NodeId01', previewId: 'vol-ume_01~NodeId01' } }],
  })
  const protonManifest = () => ({ provider: 'proton', sourceUrl: protonSource, title: 'Drive', images: [protonImage()] })

  test('accepts a keyless proton manifest', () => {
    const result = validateEncryptedManifest(protonManifest())
    expect(result.provider).toBe('proton')
    expect(result.images).toHaveLength(1)
  })

  test('rejects a keyed source URL, a wrong provider, and bad node ids', () => {
    for (const mutate of [
      (value: any) => { value.sourceUrl += '#secretpassword' },
      (value: any) => { value.provider = 'mega' },
      (value: any) => { value.images[0].media.sourceKind = 'folder' },
      (value: any) => { value.images[0].media.nodeId = 'vol~node#pw' },
      (value: any) => { value.images[0].ref = 'vol~node#pw' },
      (value: any) => { value.images[0].media.sourceId = 'OtherToken' },
      (value: any) => { value.images[0].id = 'mega-NodeId01' },
    ]) {
      const value = protonManifest()
      mutate(value)
      expect(() => validateEncryptedManifest(value)).toThrow()
    }
  })
})
