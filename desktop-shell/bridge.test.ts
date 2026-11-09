import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window as HappyWindow } from 'happy-dom'
import { installShellBridge } from './bridge'

describe('desktop-shell bridge Tauri runtime emulation', () => {
  const globals = globalThis as unknown as Record<string, unknown>
  let previousWindow: unknown
  let previousDocument: unknown
  let posted: Array<Record<string, unknown>> = []

  beforeEach(() => {
    posted = []
    previousWindow = globals.window
    previousDocument = globals.document
    const dom = new HappyWindow({ url: 'manorama://localhost/index.html' })
    ;(dom as unknown as Record<string, unknown>).webkit = {
      messageHandlers: {
        manorama: {
          postMessage: (msg: Record<string, unknown>) => {
            posted.push(msg)
          },
        },
      },
    }
    globals.window = dom
    globals.document = dom.document
    installShellBridge(dom as unknown as Window)
  })

  afterEach(() => {
    globals.window = previousWindow
    globals.document = previousDocument
  })

  test('provides transformCallback, event listen/unlisten, and delivers backend events', async () => {
    const internals = window.__TAURI_INTERNALS__!
    expect(typeof internals.transformCallback).toBe('function')
    expect(typeof internals.unregisterCallback).toBe('function')

    const { listen } = await import('@tauri-apps/api/event')
    const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')

    const coldStartUrls: string[] = []
    const liveUrls: string[][] = []

    const listenColdPromise = listen<string>('manorama://deep-link', (event) => {
      coldStartUrls.push(event.payload)
    })
    // Settle the plugin:event|listen invoke
    const coldPost = posted.at(-1)!
    expect(coldPost.cmd).toBe('plugin:event|listen')
    window.__manoramaShellSettle!({
      id: coldPost.id as number,
      ok: true,
      value: (coldPost.args as { handler: number }).handler,
    })
    const unlistenCold = await listenColdPromise

    const listenLivePromise = onOpenUrl((urls) => {
      liveUrls.push(urls)
    })
    const livePost = posted.at(-1)!
    expect(livePost.cmd).toBe('plugin:event|listen')
    window.__manoramaShellSettle!({
      id: livePost.id as number,
      ok: true,
      value: (livePost.args as { handler: number }).handler,
    })
    const unlistenLive = await listenLivePromise

    window.__manoramaShellEmit!('manorama://deep-link', 'in.thecontrarian.manorama.desktop://auth/callback?handoff=cold1')
    window.__manoramaShellEmit!('deep-link://new-url', ['in.thecontrarian.manorama.desktop://auth/callback?handoff=live1'])

    expect(coldStartUrls).toEqual(['in.thecontrarian.manorama.desktop://auth/callback?handoff=cold1'])
    expect(liveUrls).toEqual([['in.thecontrarian.manorama.desktop://auth/callback?handoff=live1']])

    // Unlistening stops delivery
    const unlistenColdPromise = unlistenCold()
    const unlistenPost = posted.at(-1)!
    expect(unlistenPost.cmd).toBe('plugin:event|unlisten')
    window.__manoramaShellSettle!({ id: unlistenPost.id as number, ok: true, value: null })
    await unlistenColdPromise

    window.__manoramaShellEmit!('manorama://deep-link', 'in.thecontrarian.manorama.desktop://auth/callback?handoff=cold2')
    expect(coldStartUrls).toHaveLength(1)

    const unlistenLivePromise = unlistenLive()
    const unlistenLivePost = posted.at(-1)!
    window.__manoramaShellSettle!({ id: unlistenLivePost.id as number, ok: true, value: null })
    await unlistenLivePromise
  })

  test('mousedown on a data-tauri-drag-region element invokes plugin:window|start_dragging', () => {
    document.body.innerHTML = `
      <div class="desktop-titlebar" data-tauri-drag-region>
        <button id="inside-btn">Action</button>
      </div>
    `
    const bar = document.querySelector('.desktop-titlebar')!
    const btn = document.getElementById('inside-btn')!

    // Clicking a button inside a drag region must NOT start dragging
    btn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(posted.some((m) => m.cmd === 'plugin:window|start_dragging')).toBe(false)

    // Left-clicking the drag region itself starts window dragging
    bar.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(posted.some((m) => m.cmd === 'plugin:window|start_dragging')).toBe(true)
  })

  test('streams @tauri-apps/plugin-http responses via __bytes chunks', async () => {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')

    const responsePromise = tauriFetch('https://drive-api.proton.me/drive/urls/tok', {
      method: 'POST',
      headers: { 'x-pm-appversion': 'external-drive-manorama@1.0.0-stable' },
      body: JSON.stringify({ hello: 'world' }),
    })

    // Wait for plugin:http|fetch invoke
    await new Promise((r) => setTimeout(r, 10))
    const fetchMsg = posted.find((m) => m.cmd === 'plugin:http|fetch')!
    expect(fetchMsg).toBeDefined()
    window.__manoramaShellSettle!({ id: fetchMsg.id as number, ok: true, value: 101 })

    // Wait for plugin:http|fetch_send invoke
    await new Promise((r) => setTimeout(r, 10))
    const sendMsg = posted.find((m) => m.cmd === 'plugin:http|fetch_send')!
    expect(sendMsg).toBeDefined()
    window.__manoramaShellSettle!({
      id: sendMsg.id as number,
      ok: true,
      value: {
        status: 200,
        statusText: 'OK',
        url: 'https://drive-api.proton.me/drive/urls/tok',
        headers: [['content-type', 'application/json']],
        rid: 202,
      },
    })

    const res = await responsePromise
    expect(res.status).toBe(200)

    const textPromise = res.text()
    await new Promise((r) => setTimeout(r, 10))
    const read1 = posted.filter((m) => m.cmd === 'plugin:http|fetch_read_body')[0]!
    const payloadBytes = new TextEncoder().encode('{"ok":true}')
    const chunk1 = new Uint8Array(payloadBytes.length + 1)
    chunk1.set(payloadBytes, 0)
    chunk1[payloadBytes.length] = 0 // 0 = more chunks follow
    window.__manoramaShellSettle!({
      id: read1.id as number,
      ok: true,
      value: { __bytes: btoa(String.fromCharCode(...chunk1)) },
    })

    await new Promise((r) => setTimeout(r, 10))
    const read2 = posted.filter((m) => m.cmd === 'plugin:http|fetch_read_body')[1]!
    // [1] = EOF signal for @tauri-apps/plugin-http
    window.__manoramaShellSettle!({
      id: read2.id as number,
      ok: true,
      value: { __bytes: btoa(String.fromCharCode(1)) },
    })

    expect(await textPromise).toBe('{"ok":true}')
  })
})
