import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  blockProductionApi,
  bridgePayload,
  installBridge,
  serveEventLeases,
  type EventBridgeCall,
  type EventBridgeControls,
  type FixtureEvents,
} from './desktop-admin-fixture'
import {
  RAW_DUMP_NOT_CONFIGURED,
  formatDaysLabel,
  formatEventCardLabel,
  formatEventDateSpan,
  formatEventDayLabel,
  type EventCluster,
  type EventPresentationOptions,
  type RawDumpStatus,
} from '../packages/core/event-clustering'

/**
 * Slice 6's desktop Camera Roll acceptance, through the real client bundle.
 *
 * The SPA runs behind the shared synthetic Tauri bridge. Events, folder
 * declarations and image replies contain no real paths or photographs; ready
 * replies carry only opaque local leases, answered here with a generated SVG.
 * The ordinary Library/API traffic remains mocked, and every other external
 * request is aborted and recorded. No provider seed or credential is needed.
 *
 *   bun run dev:desktop
 *   bunx playwright test specs/desktop-events.playwright.ts
 */

const desktopUrl = process.env.DESKTOP_URL ?? 'http://localhost:5175'
const desktopOrigin = new URL(desktopUrl).origin
const RAW_DUMP_CHANGED = 'manorama://raw-dump-changed'
const EVENT_COMMANDS = new Set([
  'get_raw_dump_status',
  'pick_raw_dump_root',
  'clear_raw_dump_root',
  'scan_raw_dump_events',
  'get_event_asset_image',
  'reveal_event_asset',
])
const PRESENTATION = {
  locale: 'en-US',
  calendar: 'gregory',
  timeZone: 'UTC',
} satisfies EventPresentationOptions

const TRIP: EventCluster = {
  id: 'evt_11111111111111111111',
  startDate: Date.UTC(2026, 2, 12, 9),
  endDate: Date.UTC(2026, 2, 13, 18),
  isMultiDay: true,
  coverItemId: 'synthetic/2026-03-12/frame-02.jpg',
  itemIds: [
    'synthetic/2026-03-12/frame-01.jpg',
    'synthetic/2026-03-12/frame-02.jpg',
    'synthetic/2026-03-13/frame-01.jpg',
  ],
  subDays: [
    { id: '2026-03-12', date: Date.UTC(2026, 2, 12, 9), itemIds: ['synthetic/2026-03-12/frame-01.jpg', 'synthetic/2026-03-12/frame-02.jpg'] },
    { id: '2026-03-13', date: Date.UTC(2026, 2, 13, 10), itemIds: ['synthetic/2026-03-13/frame-01.jpg'] },
  ],
}
const AFTERNOON: EventCluster = {
  id: 'evt_22222222222222222222',
  startDate: Date.UTC(2026, 2, 20, 10),
  endDate: Date.UTC(2026, 2, 20, 12),
  isMultiDay: false,
  coverItemId: 'synthetic/2026-03-20/frame-01.jpg',
  itemIds: ['synthetic/2026-03-20/frame-01.jpg'],
}
const EVENTS = [TRIP, AFTERNOON]
const TRIP_SPAN = formatEventDateSpan(TRIP, PRESENTATION)
const SECOND_DAY = TRIP.subDays![1]!
const READY_TRIP_LABEL = formatEventCardLabel(TRIP, 'ready', PRESENTATION)
const READY_AFTERNOON_LABEL = formatEventCardLabel(AFTERNOON, 'ready', PRESENTATION)
const CLOUD_AFTERNOON_LABEL = formatEventCardLabel(AFTERNOON, 'cloudOnly', PRESENTATION)
const configuredStatus = (clusters: EventCluster[] = EVENTS): RawDumpStatus => ({
  configured: true,
  label: 'Synthetic Camera Roll',
  isAvailable: true,
  lastIndexedAt: Date.UTC(2026, 2, 21, 12),
  eventCount: clusters.length,
})

test.use({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1440, height: 900 } })

const watchNetwork = async (page: Page) => {
  const requests: string[] = []
  const unexpected: string[] = []
  const failures: { url: string; reason: string | null }[] = []
  const downloads: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  page.on('requestfailed', (request) => failures.push({ url: request.url(), reason: request.failure()?.errorText ?? null }))
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === desktopOrigin) return route.continue()
    if (url.origin === 'https://manorama.xyz' && url.pathname.startsWith('/api/')) return route.continue()
    if (url.origin === 'https://downloads.manorama.xyz') return route.continue()
    if (/^http:\/\/manorama-event\.localhost\/[0-9a-f]{32}$/.test(url.href)) return route.continue()
    unexpected.push(url.href)
    return route.abort('blockedbyclient')
  })
  // Keep the release pointer synthetic even if the bundle adds a cache buster.
  await page.route('https://downloads.manorama.xyz/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  return {
    requests,
    unexpected,
    failures,
    downloads,
    leases: () => requests.filter((url) => new URL(url).hostname === 'manorama-event.localhost'),
  }
}

type NetworkWatch = Awaited<ReturnType<typeof watchNetwork>>

const expectNoRealNetwork = (network: NetworkWatch) => {
  expect(network.unexpected, 'unexpected external requests').toEqual([])
  expect(network.downloads, 'implicit downloads').toEqual([])
  for (const lease of network.leases()) expect(lease).toMatch(/^http:\/\/manorama-event\.localhost\/[0-9a-f]{32}$/)
}

const openFixture = async (page: Page, events: FixtureEvents) => {
  const network = await watchNetwork(page)
  await serveEventLeases(page)
  await blockProductionApi(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(installBridge, { ...bridgePayload, events })
  await page.goto(desktopUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Camera Roll', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return { network, errors }
}

const eventCalls = (page: Page): Promise<EventBridgeCall[]> =>
  page.evaluate(() => structuredClone(
    ((window as unknown as { __eventCalls?: EventBridgeCall[] }).__eventCalls ?? []),
  ))

const eventCommands = async (page: Page) => (await eventCalls(page)).filter((call) => EVENT_COMMANDS.has(call.command))
const assetCalls = async (page: Page) => (await eventCalls(page)).filter((call) => call.command === 'get_event_asset_image')
const scanCalls = async (page: Page) => (await eventCalls(page)).filter((call) => call.command === 'scan_raw_dump_events')
const statusCalls = async (page: Page) => (await eventCalls(page)).filter((call) => call.command === 'get_raw_dump_status')
const rawDumpListenerCount = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.rawDumpListenerCount() ?? -1))
const pendingEventAssets = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.pendingEventAssetCount() ?? -1))
const pendingEventScans = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.pendingEventScanCount() ?? -1))
const releaseEventAssets = (page: Page) => page.evaluate(() => {
  ;(window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.releaseEventAssets()
})
const releaseEventScans = (page: Page) => page.evaluate(() => {
  ;(window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.releaseEventScans()
})

const commandsSince = async (page: Page, previous: EventBridgeCall[]) => {
  const current = await eventCommands(page)
  return current.slice(previous.length)
}

const expectOnlyStatusSince = async (page: Page, previous: EventBridgeCall[]) => {
  await expect.poll(async () => (await commandsSince(page, previous)).length).toBeGreaterThan(0)
  const calls = await commandsSince(page, previous)
  expect(calls.every((call) => call.command === 'get_raw_dump_status')).toBe(true)
  return calls
}

const expectLocalAssetsOnly = async (page: Page) => {
  const calls = await assetCalls(page)
  for (const call of calls) expect(call.args?.allowNetwork, JSON.stringify(call.args)).toBe(false)
  return calls
}

const expectQuietEventCommands = async (page: Page) => {
  const calls = await eventCommands(page)
  expect(calls.map((call) => call.command)).not.toContain('scan_raw_dump_events')
  expect(calls.map((call) => call.command)).not.toContain('get_event_asset_image')
  expect(calls.map((call) => call.command)).not.toContain('reveal_event_asset')
}

const emitRawDumpChanged = (page: Page) => page.evaluate((event) => {
  ;(window as unknown as { __manoramaEmitEvent?: (name: string, payload: unknown) => void })
    .__manoramaEmitEvent?.(event, null)
}, RAW_DUMP_CHANGED)

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.web-settings')).toBeVisible()
  await expect(page.locator('.web-settings').getByRole('heading', { name: 'Camera Roll', exact: true })).toBeVisible()
  await page.locator('.web-settings').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
}

const closeSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.web-settings')).toHaveCount(0)
}

const activateCameraRoll = async (page: Page) => {
  const pill = page.getByRole('button', { name: 'Camera Roll', exact: true })
  await expect(pill).toHaveAttribute('aria-pressed', 'false')
  await pill.click()
  await expect(page.locator('[data-camera-roll-mode]')).toBeVisible()
  await expect(pill).toHaveAttribute('aria-pressed', 'true')
  return pill
}

const waitForReadyCovers = async (page: Page) => {
  await expect(page.getByRole('button', { name: READY_TRIP_LABEL, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.event-card img').evaluateAll((images) =>
    images.length === 2 && images.every((image) => (image as HTMLImageElement).naturalWidth === 640))).toBe(true)
}

test('Library and Settings only probe, declare and clear; activation alone scans', async ({ page }) => {
  const { network, errors } = await openFixture(page, {
    clusters: EVENTS,
    status: { ...RAW_DUMP_NOT_CONFIGURED },
  })

  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await expect(page.locator('.gallery-list').getByText('Bangkok Rain', { exact: true }).first()).toBeVisible()
  await expect(page.locator('[data-camera-roll-mode]')).toHaveCount(0)
  await expect(page.locator('[data-event-card]')).toHaveCount(0)
  const libraryCommands = await eventCommands(page)
  expect(libraryCommands.length).toBeGreaterThan(0)
  expect(libraryCommands.every((call) => call.command === 'get_raw_dump_status')).toBe(true)
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])

  await openSettings(page)
  await expectOnlyStatusSince(page, libraryCommands)
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])

  const beforeChoose = await eventCommands(page)
  await page.getByRole('button', { name: 'Folder Choose folder', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Folder Synthetic Camera Roll', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear folder', exact: true })).toBeVisible()
  const declaration = await commandsSince(page, beforeChoose)
  expect(declaration.filter((call) => call.command === 'pick_raw_dump_root')).toHaveLength(1)
  expect(declaration.every((call) => call.command === 'pick_raw_dump_root' || call.command === 'get_raw_dump_status')).toBe(true)
  expect(declaration.at(-1)?.command).toBe('get_raw_dump_status')
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])

  const beforeClear = await eventCommands(page)
  await page.getByRole('button', { name: 'Clear folder', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Folder Choose folder', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear folder', exact: true })).toHaveCount(0)
  const clearing = await commandsSince(page, beforeClear)
  expect(clearing.filter((call) => call.command === 'clear_raw_dump_root')).toHaveLength(1)
  expect(clearing.every((call) => call.command === 'clear_raw_dump_root' || call.command === 'get_raw_dump_status')).toBe(true)
  expect(clearing.at(-1)?.command).toBe('get_raw_dump_status')
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])

  await closeSettings(page)
  const pill = await activateCameraRoll(page)
  await expect(page.getByText('No Camera Roll folder', { exact: true })).toBeVisible()
  expect(await scanCalls(page)).toHaveLength(0)
  expect(await assetCalls(page)).toHaveLength(0)
  expect(network.leases()).toEqual([])

  await page.getByRole('button', { name: 'Back to galleries', exact: true }).click()
  await expect(page.locator('[data-camera-roll-mode]')).toHaveCount(0)
  await expect(pill).toBeFocused()
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
  await expectQuietEventCommands(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('activation scans once and exposes named event cards, list items and day groups', async ({ page }, testInfo) => {
  const { network, errors } = await openFixture(page, { clusters: EVENTS, status: configuredStatus() })

  const libraryCommands = await eventCommands(page)
  expect(libraryCommands.length).toBeGreaterThan(0)
  expect(libraryCommands.every((call) => call.command === 'get_raw_dump_status')).toBe(true)
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])
  await activateCameraRoll(page)
  await waitForReadyCovers(page)

  const mode = page.locator('[data-camera-roll-mode]')
  const list = mode.locator('ul.event-grid')
  await expect(list).toHaveAttribute('role', 'list')
  await expect(list.getByRole('listitem')).toHaveCount(EVENTS.length)
  await expect(mode.getByRole('button', { name: READY_TRIP_LABEL, exact: true })).toBeVisible()
  await expect(mode.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })).toBeVisible()
  const dayGroup = mode.getByRole('group', { name: formatDaysLabel(TRIP_SPAN, PRESENTATION), exact: true })
  await expect(dayGroup).toBeVisible()
  for (const day of TRIP.subDays!) {
    await expect(dayGroup.getByRole('button', {
      name: formatEventDayLabel(day, TRIP, TRIP_SPAN, PRESENTATION),
      exact: true,
    })).toHaveAttribute('data-event-day', day.id)
  }
  await expect(mode).not.toContainText('/synthetic/')
  await expect(mode).not.toContainText('frame-01.jpg')

  const commands = (await eventCommands(page)).map((call) => call.command)
  expect(commands.filter((command) => command === 'scan_raw_dump_events')).toHaveLength(1)
  expect((await statusCalls(page)).length).toBeGreaterThanOrEqual(libraryCommands.length + 2)
  expect(commands.indexOf('scan_raw_dump_events')).toBeLessThan(commands.indexOf('get_event_asset_image'))
  const assets = await expectLocalAssetsOnly(page)
  expect(assets).toHaveLength(2)
  expect(assets.map((call) => call.args?.ids)).toEqual(expect.arrayContaining([[TRIP.coverItemId], [AFTERNOON.coverItemId]]))
  for (const asset of assets) expect(asset.args).toMatchObject({ purpose: 'thumbnail', maxPixelSize: 512 })
  expect(network.leases()).toHaveLength(2)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])

  await page.screenshot({ path: testInfo.outputPath('camera-roll-events.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Back to galleries', exact: true }).click()
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
})

test('Camera Roll is axe-clean at desktop and enlarged phone text, including Viewer and Settings', async ({ page }, testInfo) => {
  const { network, errors } = await openFixture(page, { clusters: EVENTS, status: configuredStatus() })
  await activateCameraRoll(page)
  await waitForReadyCovers(page)

  await expect(page.locator('meta[name="text-scale"]')).toHaveAttribute('content', 'scale')
  expect((await new AxeBuilder({ page }).include('[data-camera-roll-mode]').analyze()).violations).toEqual([])

  const mode = page.locator('[data-camera-roll-mode]')
  const firstDay = mode.locator('[data-event-day]').first()
  const fontSize = await firstDay.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await page.evaluate(() => document.fonts.ready)
  expect(await firstDay.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(fontSize * 2, 1)
  const width = await mode.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1)
  for (const day of await mode.locator('[data-event-day]').all()) {
    expect((await day.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  expect((await new AxeBuilder({ page }).include('[data-camera-roll-mode]').analyze()).violations).toEqual([])
  await mode.screenshot({ path: testInfo.outputPath('camera-roll-phone-large-text.png'), animations: 'disabled' })

  await mode.getByRole('button', { name: READY_TRIP_LABEL, exact: true }).click()
  const viewer = page.getByRole('dialog', { name: 'Event photographs', exact: true })
  await expect(viewer).toBeVisible()
  await expect.poll(() => viewer.locator('img[src^="http://manorama-event.localhost/"]').first()
    .evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(640)
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([])
  await viewer.screenshot({ path: testInfo.outputPath('camera-roll-phone-viewer-large-text.png'), animations: 'disabled' })
  await viewer.getByRole('button', { name: 'Back to Camera Roll', exact: true }).click()
  await expect(mode).toBeVisible()

  await openSettings(page)
  const settings = '.web-settings .camera-roll-settings'
  await expect(page.locator(settings)).toBeVisible()
  expect((await new AxeBuilder({ page }).include(settings).analyze()).violations).toEqual([])
  await page.locator(settings).screenshot({ path: testInfo.outputPath('camera-roll-phone-settings-large-text.png'), animations: 'disabled' })
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('a day opens its first member; both viewer exits restore Camera Roll and trigger focus', async ({ page }, testInfo) => {
  const { network, errors } = await openFixture(page, { clusters: EVENTS, status: configuredStatus() })
  const pill = await activateCameraRoll(page)
  await waitForReadyCovers(page)
  const scansBeforeViewer = await scanCalls(page)

  const secondDay = page.locator('[data-event-day="2026-03-13"]')
  await secondDay.click()
  const viewer = page.getByRole('dialog', { name: 'Event photographs', exact: true })
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('[data-chrome-position]'))
    .toHaveText(`${TRIP.itemIds.indexOf(SECOND_DAY.itemIds[0]) + 1} of ${TRIP.itemIds.length}`)
  await expect.poll(async () => (await assetCalls(page)).some((call) =>
    call.args?.purpose === 'viewer' && JSON.stringify(call.args?.ids) === JSON.stringify([SECOND_DAY.itemIds[0]]))).toBe(true)
  const viewerLease = viewer.locator('img[src^="http://manorama-event.localhost/"]').first()
  await expect(viewerLease).toBeVisible()
  await expect.poll(() => viewerLease.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(640)
  expect(await viewerLease.getAttribute('src')).toMatch(/^http:\/\/manorama-event\.localhost\/[0-9a-f]{32}$/)
  await page.screenshot({ path: testInfo.outputPath('camera-roll-viewer-day-two.png'), animations: 'disabled' })

  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page.locator('[data-camera-roll-mode]')).toBeVisible()
  await expect(secondDay).toBeFocused()

  const tripCard = page.getByRole('button', { name: READY_TRIP_LABEL, exact: true })
  await tripCard.click()
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('[data-chrome-position]')).toHaveText('1 of 3')
  await expect.poll(async () => (await assetCalls(page)).some((call) =>
    call.args?.purpose === 'viewer' && JSON.stringify(call.args?.ids) === JSON.stringify([TRIP.itemIds[0]]))).toBe(true)
  await viewer.getByRole('button', { name: 'Back to Camera Roll', exact: true }).click()
  await expect(viewer).toHaveCount(0)
  await expect(page.locator('[data-camera-roll-mode]')).toBeVisible()
  await expect(pill).toHaveAttribute('aria-pressed', 'true')
  await expect(tripCard).toBeFocused()
  expect(await scanCalls(page)).toEqual(scansBeforeViewer)
  await expect.poll(() => rawDumpListenerCount(page)).toBe(1)

  // The released overlay must not consume the next Escape or close the rail.
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-camera-roll-mode]')).toBeVisible()
  await expect(viewer).toHaveCount(0)
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])

  await page.getByRole('button', { name: 'Back to galleries', exact: true }).click()
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
})

test('an unconfigured source shows the declaration path without scanning or loading previews', async ({ page }) => {
  const { network, errors } = await openFixture(page, {
    clusters: EVENTS,
    status: { ...RAW_DUMP_NOT_CONFIGURED },
  })
  await activateCameraRoll(page)
  await expect(page.getByText('No Camera Roll folder', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible()
  await expectQuietEventCommands(page)
  expect(await assetCalls(page)).toHaveLength(0)
  expect(network.leases()).toEqual([])

  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await expect(page.locator('.web-settings')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Folder Choose folder', exact: true })).toBeVisible()
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('a configured but denied/unavailable source never scans and can retry honestly', async ({ page }) => {
  const unavailable: RawDumpStatus = {
    ...configuredStatus(),
    isAvailable: false,
    authorization: 'denied',
    selectedPhotoCount: 0,
    downloadCloudOnOpen: false,
    lastIndexedAt: null,
    eventCount: 0,
  }
  const { network, errors } = await openFixture(page, { clusters: EVENTS, status: unavailable })
  await activateCameraRoll(page)
  await expect(page.getByText('Camera Roll is unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  const beforeRetry = await eventCommands(page)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('Camera Roll is unavailable', { exact: true })).toBeVisible()
  await expectOnlyStatusSince(page, beforeRetry)
  await expectQuietEventCommands(page)
  expect(network.leases()).toEqual([])

  await page.evaluate((next) => {
    ;(window as unknown as { __eventControl?: EventBridgeControls }).__eventControl?.setStatus(next)
  }, configuredStatus())
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await waitForReadyCovers(page)
  expect(await scanCalls(page)).toHaveLength(1)
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('an empty source reports no events without any asset command or lease request', async ({ page }) => {
  const { network, errors } = await openFixture(page, { clusters: [], status: configuredStatus([]) })
  await activateCameraRoll(page)
  await expect(page.getByText('No events in this folder.', { exact: true })).toBeVisible()
  expect(await scanCalls(page)).toHaveLength(1)
  expect(await assetCalls(page)).toHaveLength(0)
  expect((await eventCommands(page)).map((call) => call.command)).not.toContain('reveal_event_asset')
  expect(network.leases()).toEqual([])
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('cloud-only covers and originals never download; reveal is the sole explicit source action', async ({ page }) => {
  const { network, errors } = await openFixture(page, {
    clusters: [AFTERNOON],
    status: configuredStatus([AFTERNOON]),
    assets: { [AFTERNOON.coverItemId]: { state: 'cloudOnly', width: 640, height: 480 } },
  })
  await activateCameraRoll(page)
  const cloudCard = page.getByRole('button', { name: CLOUD_AFTERNOON_LABEL, exact: true })
  await expect(cloudCard).toBeVisible()
  await expect(cloudCard).toContainText('Not downloaded')
  expect(await assetCalls(page)).toHaveLength(1)
  expect(network.leases()).toEqual([])

  await cloudCard.click()
  const viewer = page.getByRole('dialog', { name: 'Event photographs', exact: true })
  await expect(viewer).toBeVisible()
  const placeholder = viewer.locator('[data-event-placeholder]')
  await expect(placeholder).toBeVisible()
  await expect(placeholder.getByRole('status')).toHaveText('Not downloaded')
  await expect(placeholder.getByRole('button', { name: 'Reveal in folder', exact: true })).toBeVisible()
  expect(await assetCalls(page)).toHaveLength(2)
  expect(network.leases()).toEqual([])

  await placeholder.getByRole('button', { name: 'Reveal in folder', exact: true }).click()
  await expect.poll(async () => (await eventCalls(page)).filter((call) => call.command === 'reveal_event_asset'))
    .toEqual([{ command: 'reveal_event_asset', args: { id: AFTERNOON.coverItemId } }])
  expect(network.leases()).toEqual([])
  expect(await assetCalls(page)).toHaveLength(2)
  await viewer.getByRole('button', { name: 'Back to Camera Roll', exact: true }).click()
  await expect(cloudCard).toBeFocused()
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])
})

test('a source revision cancels a late viewer reply before it reaches the DOM or network', async ({ page }) => {
  const id = AFTERNOON.coverItemId
  const { network, errors } = await openFixture(page, {
    clusters: [AFTERNOON],
    status: configuredStatus([AFTERNOON]),
    assets: { [id]: { state: 'ready', width: 640, height: 480, hold: true, holdPurpose: 'viewer' } },
  })
  await activateCameraRoll(page)
  await expect(page.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })).toBeVisible()
  await expect.poll(() => pendingEventAssets(page)).toBe(0)
  await expect.poll(() => network.leases().length).toBe(1)
  const leasesBeforeViewer = network.leases().length
  const card = page.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })
  await card.click()
  const viewer = page.getByRole('dialog', { name: 'Event photographs', exact: true })
  await expect(viewer).toBeVisible()
  await expect.poll(async () => (await assetCalls(page)).some((call) => call.args?.purpose === 'viewer')).toBe(true)
  await expect.poll(() => pendingEventAssets(page)).toBe(1)

  await emitRawDumpChanged(page)
  await expect(viewer).toHaveCount(0)
  await expect(page.getByText('Folder changed since this was indexed.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Re-scan', exact: true })).toBeVisible()
  await releaseEventAssets(page)
  await expect.poll(() => pendingEventAssets(page)).toBe(0)
  expect(network.leases()).toHaveLength(leasesBeforeViewer)
  await expect.poll(() => rawDumpListenerCount(page)).toBe(1)

  await page.getByRole('button', { name: 'Re-scan', exact: true }).click()
  await expect(page.getByText('Folder changed since this was indexed.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })).toBeVisible()
  const scans = await scanCalls(page)
  expect(scans).toHaveLength(2)
  expect(scans[1]?.args).toEqual({ force: true })
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])

  await page.getByRole('button', { name: 'Back to galleries', exact: true }).click()
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-camera-roll-mode]')).toHaveCount(0)
})

test('opening Settings retires the controller; a late scan cannot mount events or previews', async ({ page }) => {
  const { network, errors } = await openFixture(page, {
    clusters: [AFTERNOON],
    status: configuredStatus([AFTERNOON]),
    scanHold: true,
  })
  await activateCameraRoll(page)
  await expect.poll(() => scanCalls(page).then((calls) => calls.length)).toBe(1)
  await expect.poll(() => pendingEventScans(page)).toBe(1)
  const beforeSettings = await eventCommands(page)

  // Desktop has no cancel-scan IPC. Opening Settings unmounts the controller,
  // advances its generation and unlistens; the native reply may finish later,
  // but it must never reach this retired controller or start a preview read.
  await openSettings(page)
  await expect(page.locator('[data-camera-roll-mode]')).toHaveCount(0)
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
  await expectOnlyStatusSince(page, beforeSettings)
  await releaseEventScans(page)
  await expect.poll(() => pendingEventScans(page)).toBe(0)
  await expect(page.locator('[data-event-card]')).toHaveCount(0)
  expect(await assetCalls(page)).toHaveLength(0)
  expect(network.leases()).toEqual([])

  await closeSettings(page)
  await expect(page.locator('[data-camera-roll-mode]')).toBeVisible()
  await expect.poll(() => pendingEventScans(page)).toBe(1)
  await releaseEventScans(page)
  await expect.poll(() => pendingEventScans(page)).toBe(0)
  await expect(page.getByRole('button', { name: READY_AFTERNOON_LABEL, exact: true })).toBeVisible()
  expect(await scanCalls(page)).toHaveLength(2)
  await expectLocalAssetsOnly(page)
  expectNoRealNetwork(network)
  expect(errors).toEqual([])

  await page.getByRole('button', { name: 'Back to galleries', exact: true }).click()
  await expect.poll(() => rawDumpListenerCount(page)).toBe(0)
})
