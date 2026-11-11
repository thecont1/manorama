/**
 * The native shell's Tauri shim.
 *
 * The desktop bundle is the app — the Library, the gallery grid, the vault
 * meter, the local catalogue. It is written against Tauri's runtime API,
 * and Tauri's JavaScript surface is deliberately thin: everything the app
 * asks of the machine goes through `window.__TAURI_INTERNALS__` (`invoke`,
 * `convertFileSrc`, `transformCallback`, `unregisterCallback`) and
 * `window.__TAURI_EVENT_PLUGIN_INTERNALS__`.
 *
 * That thinness is the whole reason this file exists. Implementing those
 * primitives over the native shell's own channel lets the *same*
 * bundle run inside the SwiftUI shell, with no fork of the app's code and
 * no second implementation of the Library.
 *
 * The shell is not a browser: it has no window chrome, no file dialogs and
 * no plugin runtime. So each command is answered by the shell, and a
 * command the shell has not implemented fails loudly rather than silently
 * pretending to have worked.
 */

export type InvokeReply = {
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

type ShellMessage =
  | { type: 'invoke'; id: number; cmd: string; args: unknown; headers?: Record<string, string> }
  | { type: 'position'; index: number; total: number }
  | { type: 'gallery'; open: boolean; title?: string }
  | { type: 'escape' }

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>
      convertFileSrc: (filePath: string, protocol?: string) => string
      transformCallback?: (callback?: (payload: unknown) => void, once?: boolean) => number
      unregisterCallback?: (id: number) => void
      metadata?: {
        currentWindow: { label: string }
        currentWebview: { windowLabel: string; label: string }
      }
    }
    /** The shell's own inbound channel: the native side calls these. */
    __manoramaShell?: {
      invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>
      goTo: (index: number) => void
    }
    /** Settles an in-flight `invoke` promise from the native side. */
    __manoramaShellSettle?: (reply: InvokeReply) => void
    /** Delivers a backend event (`manorama://deep-link`, `deep-link://new-url`) to registered Tauri listeners. */
    __manoramaShellEmit?: (event: string, payload: unknown) => void
    /** The shell's outbound channel. Absent under Tauri, so every call is a
     *  no-op there and the Tauri build is unchanged by this file. */
    __MANORAMA_SHELL__?: {
      post: (message: ShellMessage) => void
    }
  }
}

const post = (message: ShellMessage, win: Window = window) => {
  const handler = (win as unknown as {
    webkit?: { messageHandlers?: { manorama?: { postMessage(payload: unknown): void } } }
  }).webkit?.messageHandlers?.manorama
  handler?.postMessage(message)
}

/** Pending invokes, by id. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextId = 0

/** Registered JS callbacks (created by `transformCallback` for events/channels). */
const callbacks = new Map<number, { fn: (payload: unknown) => void; once: boolean }>()
/** Active event listeners by event name -> set of callback ids. */
const eventListeners = new Map<string, Set<number>>()
let nextCallbackId = 1

const transformCallback = (callback?: (payload: unknown) => void, once = false): number => {
  const id = nextCallbackId++
  if (callback) {
    callbacks.set(id, { fn: callback, once })
  }
  return id
}

const unregisterCallback = (id: number): void => {
  callbacks.delete(id)
  for (const ids of eventListeners.values()) {
    ids.delete(id)
  }
}

const unregisterListener = (event: string, eventId: number): void => {
  eventListeners.get(event)?.delete(eventId)
  callbacks.delete(eventId)
}

/** Deliver an event from the native shell (or `emit`) to all registered listeners. */
const emitEvent = (event: string, payload: unknown): void => {
  const ids = eventListeners.get(event)
  if (!ids) return
  for (const id of [...ids]) {
    const entry = callbacks.get(id)
    if (!entry) {
      ids.delete(id)
      continue
    }
    if (entry.once) {
      ids.delete(id)
      callbacks.delete(id)
    }
    entry.fn({ event, id, payload })
  }
}

/** The shell answers an invoke by calling this. */
const settle = (reply: InvokeReply) => {
  const waiter = pending.get(reply.id)
  if (!waiter) return
  pending.delete(reply.id)
  if (reply.ok) waiter.resolve(reply.value)
  else waiter.reject(new Error(reply.error ?? 'the native shell refused the command'))
}

/**
 * Ask the shell to run one command.
 *
 * The reply comes back as JSON, so a value that is not JSON-safe — a
 * byte array, for one — is carried as base64 and revived here. The vault
 * reads and `plugin:http` streaming body chunks use this path.
 */
const invoke = async (
  cmd: string,
  args?: unknown,
  options?: { headers?: Record<string, string> },
): Promise<unknown> => {
  if (cmd === 'plugin:event|listen' && args && typeof args === 'object') {
    const record = args as { event?: unknown; handler?: unknown }
    if (typeof record.event === 'string' && typeof record.handler === 'number') {
      let set = eventListeners.get(record.event)
      if (!set) {
        set = new Set()
        eventListeners.set(record.event, set)
      }
      set.add(record.handler)
    }
  } else if (cmd === 'plugin:event|unlisten' && args && typeof args === 'object') {
    const record = args as { event?: unknown; eventId?: unknown }
    if (typeof record.event === 'string' && typeof record.eventId === 'number') {
      unregisterListener(record.event, record.eventId)
    }
  } else if (cmd === 'plugin:event|emit' && args && typeof args === 'object') {
    const record = args as { event?: unknown; payload?: unknown }
    if (typeof record.event === 'string') {
      emitEvent(record.event, record.payload)
    }
  }

  const id = nextId++
  const promise = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
  post({
    type: 'invoke',
    id,
    cmd,
    args: encodeArgs(args),
    headers: options?.headers,
  })
  const value = await promise
  return decodeValue(value)
}

/**
 * A command's arguments, prepared for the channel.
 *
 * The vault's write command carries its bytes as the request body and the
 * file's path in a header. Those bytes are a typed array, which the
 * channel cannot carry directly, so they travel as base64 and are revived
 * on the other side.
 */
const encodeArgs = (args: unknown): unknown => {
  if (args instanceof Uint8Array) return { __bytes: toBase64(args) }
  if (args instanceof ArrayBuffer) return { __bytes: toBase64(new Uint8Array(args)) }
  if (Array.isArray(args)) return args.map(encodeArgs)
  if (args && typeof args === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) out[key] = encodeArgs(value)
    return out
  }
  return args
}

/** The same, in reverse: a base64 payload becomes bytes again. */
const decodeValue = (value: unknown): unknown => {
  // The array check comes first on purpose: an array is an object too, and
  // treating it as a record would turn the vault's file list into an
  // object with numeric keys — which the vault then cannot iterate.
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.__bytes === 'string') return fromBase64(record.__bytes)
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(record)) out[key] = decodeValue(inner)
    return out
  }
  return value
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * A URL the webview can load for a file on disk.
 *
 * Tauri's version points at the asset protocol; here it points at the
 * shell's own media scheme. The path travels inside the URL and the shell
 * resolves it against the roots the user actually granted — so a URL that
 * names a file outside every grant answers 403, exactly as the media
 * handler already does for the viewer.
 */
const convertFileSrc = (filePath: string): string =>
  `manorama://media/local/${encodeURIComponent(filePath)}`

/**
 * The API host the shell proxies.
 *
 * The page's origin is the shell's own scheme, so a direct call to the
 * site would be a cross-origin request the API's CORS allowlist has no
 * reason to know about. Routing it through the shell keeps the call
 * same-origin, which needs no deployment and grants nothing extra.
 */
const API_HOSTS = ['manorama.xyz', 'www.manorama.xyz']

/** Put an API call back on the page's own origin. */
const throughTheShell = (input: RequestInfo | URL, _init?: RequestInit): RequestInfo | URL => {
  let url: URL
  try {
    url = input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return input
  }
  if (url.protocol !== 'https:' || !API_HOSTS.includes(url.hostname)) return input
  const proxied = new URL(`${window.location.origin}${url.pathname}${url.search}`)
  // Rebuild on every method, not just writes — a GET Request's headers,
  // signal and credentials vanish when the proxy answers with a bare URL.
  if (input instanceof Request) {
    return new Request(proxied, input)
  }
  return proxied
}

const NON_DRAGGABLE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]'

/** Install the Tauri runtime shim on a target Window. */
export const installShellBridge = (win: Window = window): void => {
  pending.clear()
  callbacks.clear()
  eventListeners.clear()

  win.__TAURI_INTERNALS__ = {
    invoke,
    convertFileSrc,
    transformCallback,
    unregisterCallback,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
  }
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener,
  }

  // The shell is the network boundary: the page's API calls go through it
  // rather than straight out to the site.
  const outerFetch = win.fetch.bind(win)
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = throughTheShell(input, init)
    if (target === input) return outerFetch(input, init)
    if (init) return outerFetch(target, init)
    if (input instanceof Request) return outerFetch(target)
    return outerFetch(target)
  }) as typeof win.fetch

  win.__manoramaShell = {
    invoke,
    goTo: (index: number) => {
      const handle = (win as unknown as {
        __manoramaGoTo?: (index: number) => void
      }).__manoramaGoTo
      handle?.(index)
    },
  }
  win.__manoramaShellSettle = settle
  win.__manoramaShellEmit = emitEvent
  // The app's own outbound channel. It is the same transport the runtime
  // calls use, wrapped so the app never names the webkit handler.
  win.__MANORAMA_SHELL__ = { post: (msg) => post(msg, win) }

  // Marks the SwiftUI shell for CSS: its window puts the traffic lights
  // in a real toolbar above the webview, so the Tauri-era insets that
  // clear an overlay titlebar do not apply here.
  win.document.documentElement.classList.add('macos-shell')

  // Emulate Tauri's `data-tauri-drag-region` attribute so dragging `.desktop-titlebar`
  // or `TopBar` moves the window when the user exits fullscreen into windowed mode.
  win.addEventListener('mousedown', (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (!target || typeof target.closest !== 'function') return
    if (target.closest(NON_DRAGGABLE_SELECTOR)) return
    const region = target.closest('[data-tauri-drag-region]')
    if (!region) return
    if (region !== target && region.getAttribute('data-tauri-drag-region') !== 'deep' && !region.classList.contains('desktop-titlebar')) {
      return
    }
    void invoke('plugin:window|start_dragging').catch(() => {})
  })
}

// Install only when the Tauri runtime is absent: under Tauri the real
// implementation is already there and must win.
if (typeof window !== 'undefined' && !window.__TAURI_INTERNALS__) {
  installShellBridge(window)
}

/**
 * The page's side of the shell channel.
 *
 * Every call is a no-op when no shell is present, so the same bundle can
 * run under Tauri, in a browser for a test, or in the native shell.
 */
export const shellPost = (message: ShellMessage) => {
  window.__MANORAMA_SHELL__?.post(message)
}

export default { invoke, convertFileSrc }
