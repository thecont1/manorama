import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window as HappyWindow } from 'happy-dom'
import { hasIosGlass, installIosShellBridge, iosPost, publishIosChrome } from './ios-shell'
import type { ViewerChromeControl } from '../../app/islands/Viewer'

type ShellWindow = Window & {
  __manoramaShell?: {
    activateControl: (control: ViewerChromeControl) => void
    setChromeActive: (active: boolean) => void
    focusStage: () => void
  }
  __manoramaChrome?: unknown
  __manoramaChromeGen?: string
  webkit?: { messageHandlers?: { manorama?: { postMessage(payload: unknown): void } } }
}

const globals = globalThis as unknown as Record<string, unknown>

describe('iOS shell chrome contract', () => {
  let previousWindow: unknown
  let previousDocument: unknown
  let posted: unknown[] = []

  beforeEach(() => {
    posted = []
    previousWindow = globals.window
    previousDocument = globals.document
    const dom = new HappyWindow({ url: 'manorama://localhost/index.html' })
    ;(dom as unknown as Record<string, unknown>).webkit = {
      messageHandlers: {
        manorama: { postMessage: (msg: unknown) => { posted.push(msg) } },
      },
    }
    globals.window = dom
    globals.document = dom.document
  })

  afterEach(() => {
    globals.window = previousWindow
    globals.document = previousDocument
  })

  const w = () => window as ShellWindow

  test('install is a no-op without the glass stamp', () => {
    installIosShellBridge()
    expect(hasIosGlass()).toBe(false)
    expect(w().__manoramaShell).toBeUndefined()
  })

  test('the stamped shell gets the bounded inbound surface', () => {
    document.documentElement.dataset.iosGlass = '1'
    installIosShellBridge()
    expect(typeof w().__manoramaShell?.activateControl).toBe('function')
    expect(typeof w().__manoramaShell?.setChromeActive).toBe('function')
    expect(typeof w().__manoramaShell?.focusStage).toBe('function')
  })

  test('calls resolve the published chrome handle', () => {
    document.documentElement.dataset.iosGlass = '1'
    const calls: string[] = []
    publishIosChrome({
      current: {
        activate: (control) => calls.push(`activate:${control}`),
        setActive: (active) => calls.push(`active:${active}`),
        focusStage: () => calls.push('stage'),
      },
    })
    installIosShellBridge()
    w().__manoramaShell?.activateControl('settings')
    w().__manoramaShell?.setChromeActive(true)
    w().__manoramaShell?.focusStage()
    expect(calls).toEqual(['activate:settings', 'active:true', 'stage'])
  })

  test('a call before the Viewer mounts is a harmless no-op', () => {
    document.documentElement.dataset.iosGlass = '1'
    installIosShellBridge()
    expect(() => {
      w().__manoramaShell?.activateControl('info')
      w().__manoramaShell?.setChromeActive(false)
      w().__manoramaShell?.focusStage()
    }).not.toThrow()
  })

  test('focus posts travel through the manorama message handler', () => {
    document.documentElement.dataset.iosGlass = '1'
    iosPost({ type: 'focus', control: 'position' })
    expect(posted).toEqual([{ type: 'focus', control: 'position' }])
  })

  test('posts carry the document generation the observer minted', () => {
    document.documentElement.dataset.iosGlass = '1'
    w().__manoramaChromeGen = 'dtest123'
    iosPost({ type: 'focus', control: 'position' })
    expect(posted).toEqual([{ type: 'focus', control: 'position', gen: 'dtest123' }])
    delete w().__manoramaChromeGen
    iosPost({ type: 'focus', control: 'settings' })
    expect(posted).toEqual([
      { type: 'focus', control: 'position', gen: 'dtest123' },
      { type: 'focus', control: 'settings' },
    ])
  })

  test('hasIosGlass reads the document-start stamp', () => {
    expect(hasIosGlass()).toBe(false)
    document.documentElement.dataset.iosGlass = '1'
    expect(hasIosGlass()).toBe(true)
  })
})
