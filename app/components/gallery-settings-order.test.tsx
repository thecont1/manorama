import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import type { Child } from 'hono/jsx'
import OwnerGalleryPanel, { type OwnerGalleryPanelProps } from './viewer/OwnerGalleryPanel'
import GalleryDetailsView from './GalleryDetailsView'
import LocalGalleryDetails from '../../desktop/islands/LocalGalleryDetails'
import { ActionGroup, ActionRow } from './ui/ActionRow'
import type { LocalGalleryRecord } from '../../desktop/lib/catalogue'

/**
 * The gallery-settings contract, asserted on every surface at once: the
 * same rows in the same order, with the same labels, whether the host is
 * the web owner panel, the desktop local panel, or the native full-screen
 * details. A label that drifts on one surface fails here, not in a
 * screenshot review.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document, fetch: globals.fetch,
  }
  dom = new Window({ url: 'http://localhost/thecontrarian/mixed' })
  globals.window = dom
  globals.document = dom.document
  // SVGElement, the rAF pair, HTMLElement and MutationObserver stay
  // installed after this file — hono keeps its namespace context once an
  // <svg> has rendered, and a later file that never sets them would crash
  // on `instanceof SVGElement` against an undefined global.
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
})

/** Mounts a node into a detached container for assertions. */
const mount = (node: Child) => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    render(node as never, container as unknown as HTMLElement)
  })
  return container as unknown as HTMLElement
}

/** Row labels in render order — the contract under test. */
const rowLabels = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.m-actionrow-label')].map((el) => el.textContent)

const BANNED = ['Remove gallery', 'Stream only', 'Manage gallery', 'Source available']

/** Asserts the exact row order and that retired labels stay absent. */
const expectCanonical = (root: HTMLElement, expected: string[]) => {
  expect(rowLabels(root)).toEqual(expected)
  const text = root.textContent ?? ''
  for (const banned of BANNED) expect(text).not.toContain(banned)
}

/** A callback the panel requires but the order test never fires. */
const noop = () => {}

const ownerProps: OwnerGalleryPanelProps = {
  owner: 'thecontrarian',
  slug: 'mixed',
  title: 'Mixed album',
  caption: 'A quiet set',
  sourceLabel: 'Dropbox',
  temporary: false,
  expiresAt: null,
  mediaCount: { stills: 24, videos: 1, hidden: 0 },
  libraryHref: '/thecontrarian',
  onReorder: noop,
  currentPhotoId: () => 'photo-3',
  onTitleSaved: noop,
}

const localRecord: LocalGalleryRecord = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: 'italy, amore mio',
  rootPath: '/Users/home/Pictures/italy, amore mio',
  sourceKind: 'folder',
  itemCount: 2,
  items: [],
  addedAt: '2026-10-11T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
}

const detailsProps = {
  title: 'Mixed album',
  caption: 'A quiet set',
  address: 'thecontrarian/mixed',
  imageCount: 25,
  mediaCount: { stills: 24, videos: 1, hidden: 0 },
  sourceLabel: 'Dropbox',
  editable: true,
  streamOnly: false,
  onBack: noop,
  onOpen: noop,
  onShare: noop,
  onEditName: noop,
  onEditCaption: noop,
  onEditAddress: noop,
  onReorder: noop,
  onRefresh: noop,
  onOpenSource: noop,
  onStreamOnlyChange: noop,
  onPurge: noop,
  onRemove: noop,
}

describe('the gallery-settings row contract', () => {
  test('the web owner panel orders groups 1–5 and hosts the device group', () => {
    const deviceGroup = (
      <ActionGroup label="On this Mac">
        <ActionRow label="Keep a copy" control={<span>On this Mac</span>} />
        <ActionRow label="Remove saved copy" />
      </ActionGroup>
    )
    const root = mount(
      <OwnerGalleryPanel
        {...ownerProps}
        onOpen={noop}
        onOpenSource={noop}
        deviceGroup={deviceGroup}
      />,
    )
    expectCanonical(root, [
      'Open gallery', 'Share link',
      'Name', 'Caption', 'Address', 'Reorder photographs',
      'Refresh gallery contents', 'Open source',
      'Keep a copy', 'Remove saved copy',
      'Remove from Library',
    ])
    // The device group keeps its own label — the only labelled group.
    expect(root.querySelector('.m-actiongroup-label')?.textContent).toBe('On this Mac')
  })

  test('the desktop local panel omits the rows a local gallery cannot perform', () => {
    const root = mount(
      <LocalGalleryDetails
        record={localRecord}
        availability="available"
        onOpen={noop}
        publishedUrl={null}
        onShare={noop}
        onReorder={noop}
        onRescan={noop}
        onRename={async () => {}}
        onRemove={noop}
        onRevealFolder={noop}
      />,
    )
    // Publish stands in for Share link until a public slug exists; there is
    // no Caption, Address, source link, or device group — the originals are
    // already on this Mac.
    expectCanonical(root, [
      'Open gallery', 'Publish',
      'Name', 'Reorder photographs',
      'Refresh gallery contents', 'Open folder',
      'Remove from Library',
    ])
  })

  test('the native details view keeps the device group between refresh and remove', () => {
    const root = mount(
      <GalleryDetailsView
        {...detailsProps}
        platform="native"
        deviceLabel="this iPhone"
        hasSavedCopy
      />,
    )
    expectCanonical(root, [
      'Open gallery', 'Share link',
      'Name', 'Caption', 'Address', 'Reorder photographs',
      'Refresh gallery contents', 'Open source',
      'Keep a copy', 'Remove saved copy',
      'Remove from Library',
    ])
    expect(root.querySelector('.m-actiongroup-label')?.textContent).toBe('On this iPhone')
    // The availability warning is the only place "available" may appear —
    // and only when the source is actually gone.
    expect(root.textContent).not.toContain('Source available')
  })

  test('the web details view drops the device group entirely', () => {
    const root = mount(<GalleryDetailsView {...detailsProps} platform="web" />)
    expectCanonical(root, [
      'Open gallery', 'Share link',
      'Name', 'Caption', 'Address', 'Reorder photographs',
      'Refresh gallery contents', 'Open source',
      'Remove from Library',
    ])
    expect(root.querySelector('.m-actiongroup-label')).toBeNull()
    expect(root.querySelector('[role="switch"]')).toBeNull()
  })
})
