import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  blockProductionApi,
  buildCatalogue,
  installBridge,
  photoBridgePayload,
  photosFrom,
  servePhotos,
  type FixtureDirEntry,
  type FixturePhoto,
} from './desktop-admin-fixture'

/**
 * Folder drag-and-drop add, driven through the real desktop island.
 *
 * The macOS shell's drag callbacks cannot run in a plain browser, so the spec
 * plays the shell's part exactly: `__manoramaEmitEvent` delivers the same
 * `manorama://folder-drag-*` / `manorama://folders-dropped` events the
 * webview emits, and the fixture bridge answers `plugin:fs|read_dir` per
 * dropped path plus the `commit_dropped_roots` / `discard_dropped_roots`
 * grant commands. Everything between those seams — the veil, the review
 * sheet, selection, the catalogue write — is the shipped code.
 *
 * Drop fixtures name real photographs so a row's cover paints the same
 * original the Library card will wear; nothing is copied or re-encoded —
 * `servePhotos` hands the browser the files straight off disk.
 *
 * The captures under outputs/desktop-folder-drop/ are browser evidence at
 * the app's own window sizes, in the same spirit as the parity suite — they
 * are not native screenshots.
 */

const base = process.env.DESKTOP_URL ?? 'http://localhost:5176'
const SOURCE = process.env.MANORAMA_DESKTOP_SOURCE ?? '/Users/home/Pictures'
const FIXTURE_COUNT = 12

const evidence = resolve('outputs/desktop-folder-drop')

const sizes = [
  { name: 'window-1280x840', width: 1280, height: 840 },
  { name: 'wide-1440x900', width: 1440, height: 900 },
  { name: 'minimum-760x620', width: 760, height: 620 },
]

const readPhotos = (): FixturePhoto[] => {
  try {
    return photosFrom(SOURCE, FIXTURE_COUNT)
  } catch {
    return []
  }
}

const allPhotos = readPhotos()
const built = buildCatalogue(allPhotos, SOURCE)

/** Dropped folders the shell would have scoped — parented under Pictures so
 *  the sheet's "in Pictures" hint reads naturally. The last entry is the
 *  catalogue's own root, exercising the duplicate row. `SINGLE_ROOT` is the
 *  lone-folder drop: kept out of the multi-drop so it stays a new gallery
 *  when the sheet opens. */
const DROP_ROOTS = [
  '/Users/photographer/Pictures/Chiang Mai',
  '/Users/photographer/Pictures/Island Time',
  '/Users/photographer/Pictures/Highland Roads',
] as const
const SINGLE_ROOT = '/Users/photographer/Pictures/Lonely Pine'

const toEntry = (photo: FixturePhoto): FixtureDirEntry => ({
  name: photo.name,
  isDirectory: false,
  isFile: true,
  width: photo.width,
  height: photo.height,
})

/** Spread the fixture photographs across the dropped folders — every name
 *  is a real file `servePhotos` answers. */
const dropDirs = (): Record<string, FixtureDirEntry[]> => {
  const dirs: Record<string, FixtureDirEntry[]> = {}
  if (!allPhotos.length) return dirs
  // The lone-folder drop always holds at least one photograph whatever the
  // admitted count — a tail slice of a short list can come back empty.
  dirs[SINGLE_ROOT] = [toEntry(allPhotos[allPhotos.length - 1])]
  const shared = allPhotos.slice(0, -1)
  const per = Math.max(1, Math.ceil(shared.length / DROP_ROOTS.length))
  DROP_ROOTS.forEach((root, index) => {
    const slice = shared.slice(index * per, (index + 1) * per)
    if (slice.length) dirs[root] = slice.map(toEntry)
  })
  return dirs
}

/** A real 40×30 JPEG — smaller than the sheet's 72px cover slot, so its row
 *  proves a small source floats at honest size instead of upscaling. Served
 *  by a dedicated route in `openDrop`; the bytes are a fixture, never a
 *  source photograph. */
const TINY_JPEG_B64 =
  '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'
const TINY_ENTRY: FixtureDirEntry = {
  name: 'tiny-cover.jpg',
  isDirectory: false,
  isFile: true,
  width: 40,
  height: 30,
}

const dirs = dropDirs()
// Chiang Mai leads with the tiny photograph — its cover row must float at
// honest size inside the slot rather than fill it.
dirs[DROP_ROOTS[0]] = [TINY_ENTRY, ...(dirs[DROP_ROOTS[0]] ?? [])]

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([name, body]) => {
    ;(window as unknown as {
      __manoramaEmitEvent?: (event: string, payload: unknown) => void
    }).__manoramaEmitEvent?.(name, body)
  }, [event, payload] as const)

let dropSeq = 0
const emitDrop = async (page: Page, paths: string[], files = 0) => {
  const seq = ++dropSeq
  await emit(page, 'manorama://folders-dropped', { paths, files, drop: seq })
  return seq
}

const dropCalls = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __dropCalls?: { command: string; args?: { paths?: string[]; drop?: number } }[] }).__dropCalls) ?? [])

const compactCount = (page: Page) => page.locator('.lib-compact-card').count()

/** Signed in, catalogue seeded, originals and drop scans answered locally. */
const openDrop = async (page: Page, extras?: { dirDelay?: Record<string, number> }) => {
  await servePhotos(page, allPhotos)
  // Registered after servePhotos' wildcard so it wins for this one name.
  await page.route('**/photos/tiny-cover.jpg', (route) =>
    route.fulfill({ body: Buffer.from(TINY_JPEG_B64, 'base64'), contentType: 'image/jpeg' }))
  const api = await blockProductionApi(page)
  await page.addInitScript(installBridge, photoBridgePayload(built, { dirs, dirDelay: extras?.dirDelay }))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.desktop-catalogue')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()
  // The stylesheet lands out of the module graph on dev; an unstyled page
  // measures nothing. Same gate the parity suite uses.
  await expect
    .poll(() => page.evaluate(() => {
      const bar = document.querySelector('.desktop-titlebar')
      return bar ? getComputedStyle(bar).height : 'none'
    }), { timeout: 15_000 })
    .toBe('28px')
  return api
}

const sheet = (page: Page) => page.locator('.m-sheet', { hasText: 'Add folders' })
const rows = (page: Page) => sheet(page).locator('.drop-folder-row')

for (const size of sizes) {
  test(`${size.name}: veil, single-folder add, multi-folder review with deselect`, async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    test.skip(allPhotos.length < 4, `no photographs with pixels on disk under ${SOURCE}`)
    const engine = testInfo.project.name || String(testInfo.project.use?.defaultBrowserType ?? 'browser')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: size.width, height: size.height })
    mkdirSync(evidence, { recursive: true })
    // Island Time's scan is held so the sheet can be photographed mid-scan.
    await openDrop(page, { dirDelay: { [DROP_ROOTS[1]]: 1500 } })

    // ── The hover veil names the gesture and the count ────────────────────
    await emit(page, 'manorama://folder-drag-enter', { folders: 3, files: 1 })
    const veil = page.locator('.desktop-drop-veil')
    await expect(veil).toBeVisible()
    await expect(veil).toContainText('Drop folders to add them')
    await expect(veil).toContainText('3 folders')
    await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-veil.png`), animations: 'disabled', timeout: 15_000 })
    await emit(page, 'manorama://folder-drag-leave', null)
    await expect(veil).toBeHidden()

    // ── One folder: no sheet, the addFolder pipeline answers directly ─────
    // Other surfaces can hold their own toasts (the stubbed account feed
    // answers "could not be loaded"), so the notice is found by its text.
    const singleSeq = await emitDrop(page, [SINGLE_ROOT])
    await expect(page.locator('.admin-toast', { hasText: 'Lonely Pine added.' })).toBeVisible({ timeout: 15_000 })
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.locator('.lib-compact-card', { hasText: 'Lonely Pine' })).toBeVisible()
    let calls = await dropCalls(page)
    expect(calls.filter((call) => call.command === 'commit_dropped_roots')).toHaveLength(1)
    expect(calls.find((call) => call.command === 'commit_dropped_roots')?.args?.paths).toEqual([SINGLE_ROOT])
    // The commit echoes the drop's sequence — the shell refuses a commit
    // that arrives stale.
    expect(calls.find((call) => call.command === 'commit_dropped_roots')?.args?.drop).toBe(singleSeq)
    expect(calls.filter((call) => call.command === 'discard_dropped_roots')).toHaveLength(0)
    await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-single-added.png`), animations: 'disabled', timeout: 15_000 })

    // ── Several folders: the review sheet, deselect, commit the rest ──────
    // The catalogue's own root rides along as the duplicate row.
    await emitDrop(page, [...DROP_ROOTS, SOURCE])
    await expect(sheet(page)).toBeVisible()
    await expect(rows(page)).toHaveCount(DROP_ROOTS.length + 1)
    // Mid-scan: Island Time's delayed read_dir still shows its skeleton
    // while the duplicate row — which never scans — has already resolved.
    await expect(sheet(page).locator('.drop-folder-row.is-scanning').first()).toBeVisible()
    await expect(sheet(page).locator('.drop-folder-row[data-state="duplicate"]')).toContainText('Already in your library')
    await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-sheet-scanning.png`), animations: 'disabled', timeout: 15_000 })

    // Every new row resolves; the duplicate stays information, not a choice.
    await expect(sheet(page).locator('.drop-folder-row[data-state="new"]')).toHaveCount(DROP_ROOTS.length, { timeout: 15_000 })
    const duplicateCheck = sheet(page).locator('.drop-folder-row[data-state="duplicate"] .drop-folder-check')
    await expect(duplicateCheck).toBeDisabled()
    await expect(sheet(page).locator('.drop-folders-sub')).toContainText(`${DROP_ROOTS.length} of ${DROP_ROOTS.length} selected`)
    await expect(sheet(page).locator('.drop-folders-add')).toContainText(`Add ${DROP_ROOTS.length} galleries`)

    // Deselect Island Time through its real checkbox.
    const islandRow = sheet(page).locator('.drop-folder-row', { hasText: 'Island Time' })
    await islandRow.locator('.drop-folder-check').click()
    await expect(sheet(page).locator('.drop-folders-sub')).toContainText(`${DROP_ROOTS.length - 1} of ${DROP_ROOTS.length} selected`)
    await expect(sheet(page).locator('.drop-folders-add')).toContainText(`Add ${DROP_ROOTS.length - 1} galleries`)
    await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-sheet-review.png`), animations: 'disabled', timeout: 15_000 })

    // Cover integrity on every resolved row: the thumbnail is the whole
    // photograph fitted inside its slot — never cropped, never upscaled.
    // Covers decode lazily, so wait for every img to have pixels first.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.drop-folder-cover img')].every(
          (el) => (el as HTMLImageElement).naturalWidth > 0,
        ),
      undefined,
      { timeout: 15_000 },
    )
    for (const row of await rows(page).all()) {
      const coverImg = row.locator('.drop-folder-cover img')
      if ((await coverImg.count()) === 0) continue
      const coverBox = await row.locator('.drop-folder-cover').boundingBox()
      const imgBox = await coverImg.boundingBox()
      const natural = await coverImg.evaluate((el) => {
        const image = el as HTMLImageElement
        return { width: image.naturalWidth, height: image.naturalHeight }
      })
      expect(coverBox).not.toBeNull()
      expect(imgBox).not.toBeNull()
      expect(natural.width).toBeGreaterThan(0)
      const slot = coverBox!
      const box = imgBox!
      // (a) the img box sits fully inside the cover box — no overflow.
      expect(box.x).toBeGreaterThanOrEqual(slot.x - 0.5)
      expect(box.y).toBeGreaterThanOrEqual(slot.y - 0.5)
      expect(box.x + box.width).toBeLessThanOrEqual(slot.x + slot.width + 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual(slot.y + slot.height + 0.5)
      // (b) never rendered larger than the source's own pixels.
      expect(box.width).toBeLessThanOrEqual(natural.width + 0.5)
      expect(box.height).toBeLessThanOrEqual(natural.height + 0.5)
      // (c) the rendered box keeps the natural aspect ratio.
      const renderedAspect = box.width / box.height
      const naturalAspect = natural.width / natural.height
      expect(Math.abs(renderedAspect - naturalAspect) / naturalAspect).toBeLessThan(0.01)
      // (d) the whole photo: a source larger than the slot fits to it and
      // touches the slot on at least one axis; a smaller source keeps its
      // exact pixel size, centred.
      if (natural.width > slot.width || natural.height > slot.height) {
        const touches =
          Math.abs(box.width - slot.width) < 1 || Math.abs(box.height - slot.height) < 1
        expect(touches).toBe(true)
      } else {
        expect(Math.abs(box.width - natural.width)).toBeLessThan(1)
        expect(Math.abs(box.height - natural.height)).toBeLessThan(1)
      }
    }

    await sheet(page).getByRole('button', { name: `Add ${DROP_ROOTS.length - 1} galleries` }).click()
    await expect(page.locator('.admin-toast', { hasText: `${DROP_ROOTS.length - 1} galleries added.` })).toBeVisible({ timeout: 15_000 })
    await expect(sheet(page)).toHaveCount(0)
    // Commit carried exactly the selected, still-pending paths in dropped
    // order; the deselected folder and the duplicate went back.
    calls = await dropCalls(page)
    const commits = calls.filter((call) => call.command === 'commit_dropped_roots')
    expect(commits).toHaveLength(2) // the single-folder commit plus this one
    expect(commits[1].args?.paths).toEqual([DROP_ROOTS[0], DROP_ROOTS[2]])
    expect(calls.filter((call) => call.command === 'discard_dropped_roots')).toHaveLength(1)
    // Two new compact cards beside the three the page already had —
    // Island Time was deselected, the duplicate added nothing.
    await expect(page.locator('.lib-compact-card', { hasText: 'Island Time' })).toHaveCount(0)
    await expect(page.locator('.lib-compact-card', { hasText: 'Chiang Mai' })).toBeVisible()
    await expect(page.locator('.lib-compact-card', { hasText: 'Highland Roads' })).toBeVisible()
    await expect(page.locator('.lib-compact-card', { hasText: 'Lonely Pine' })).toBeVisible()
    await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-multi-added.png`), animations: 'disabled', timeout: 15_000 })

    expect(await compactCount(page)).toBe(5)
    expect(errors).toEqual([])
  })

  test(`${size.name}: cancel releases every pending grant and adds nothing`, async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    test.skip(allPhotos.length < 4, `no photographs with pixels on disk under ${SOURCE}`)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: size.width, height: size.height })
    await openDrop(page)

    await emitDrop(page, [DROP_ROOTS[0], DROP_ROOTS[1]])
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page).locator('.drop-folder-row[data-state="new"]')).toHaveCount(2, { timeout: 15_000 })
    await sheet(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(sheet(page)).toHaveCount(0)

    const calls = await dropCalls(page)
    expect(calls.filter((call) => call.command === 'commit_dropped_roots')).toHaveLength(0)
    expect(calls.filter((call) => call.command === 'discard_dropped_roots')).toHaveLength(1)
    expect(await compactCount(page)).toBe(2)
    await expect(page.locator('.lib-compact-card', { hasText: 'Chiang Mai' })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
