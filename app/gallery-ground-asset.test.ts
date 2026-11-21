import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ground from './assets/gallery-ground'
import source from '../assets/gallery-ground/approved.project.json'

/* The app ships geometry, not a generator. These checks bind the compact
   render asset to the exact project the owner selected for all galleries. */
describe('approved photographic gallery ground', () => {
  test('retains the owner-approved source byte checksum and engine provenance', () => {
    const bytes = readFileSync(new URL('../assets/gallery-ground/approved.project.json', import.meta.url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ground.sourceSha256)
    expect(ground.sourceSha256).toBe('16c19ef3be3c830d7ef5a8f8d0fb27c670c1995a765d96667e4cbec9f072565d')
    expect(source.engineVersion).toBe('0.1.0')
    expect(source.library.source).toBe('hand-authored')
    expect(source.modelRecords).toHaveLength(0)
  })

  test('uses the exact selected 1024px, dense, 3px, 20px-gap recipe', () => {
    expect(ground.artworkId).toBe('optical-marginalia-v1')
    expect(ground.seed).toBe(source.config.seed)
    expect(ground.seed).toBe(1843)
    expect(ground.width).toBe(1024)
    expect(ground.height).toBe(1024)
    expect(ground.strokeWidth).toBe(source.config.style.strokeWidth)
    expect(ground.strokeWidth).toBe(3)
    expect(source.config.layout.density).toBe('dense')
    expect(source.config.layout.minimumGap).toBe(20)
    expect(source.config.layout.periodic).toBe(true)
    expect(source.quality.valid).toBe(true)
    expect(source.quality.collisionPairs).toHaveLength(0)
  })

  test('ships every approved placement and all 24 motifs, including wrapped copies', () => {
    const placements = new Set(ground.groups.map(group => group.placementId))
    expect(ground.placementCount).toBe(80)
    expect(ground.placementCount).toBe(source.layout.placements.length)
    expect([...placements].sort()).toEqual(source.layout.placements.map(placement => placement.id).sort())
    expect(ground.motifCount).toBe(24)
    expect(new Set(ground.groups.map(group => group.motifId)).size).toBe(24)
    expect(ground.groups.length).toBeGreaterThan(ground.placementCount)
    const identities = new Map(source.layout.placements.map(placement => [placement.id, placement.motifId]))
    for (const group of ground.groups) expect(group.motifId).toBe(identities.get(group.placementId))
  })

  test('contains only finite baked monoline commands, never active markup or media URLs', () => {
    for (const group of ground.groups) for (const path of group.paths) {
      expect(path).toMatch(/^M[MLQCZ0-9eE+\-.\s]+$/)
      expect(path).not.toMatch(/NaN|Infinity|script|https?:|data:/)
      for (const number of path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []) expect(Number.isFinite(Number(number))).toBe(true)
    }
  })
})
