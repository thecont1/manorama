/**
 * The native shell's Tauri shim.
 *
 * The desktop bundle is the app — the Library, the gallery grid, the vault
 * meter, the local catalogue. It is written against Tauri's runtime API,
 * and Tauri's JavaScript surface is deliberately thin: everything the app
 * asks of the machine goes through `window.__TAURI_INTERNALS__.invoke` and
 * `window.__TAURI_INTERNALS__.convertFileSrc`.
 *
 * That thinness is the whole reason this file exists. Implementing those
 * two functions over the native shell's own channel lets the *same*
 * bundle run inside the SwiftUI shell, with no fork of the app's code and
 * no second implementation of the Library.
 *
 * The shell is not a browser: it has no window chrome, no file dialogs and
 * no plugin runtime. So each command is answered by the shell, and a
 * command the shell has not implemented fails loudly rather than silently
 * pretending to have worked.
 */

type InvokeReply = {
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
    }
    /** The shell's own inbound channel: the native side calls these. */
    __manoramaShell?: {
      invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>
      goTo: (index: number) => void
    }
    /** The shell's outbound channel. Absent under Tauri, so every call is a
     *  no-op there and the Tauri build is unchanged by this file. */
    __MANORAMA_SHELL__?: {
      post: (message: ShellMessage) => void
    }
  }
}

const post = (message: ShellMessage) => {
  const handler = (window as unknown as {
    webkit?: { messageHandlers?: { manorama?: { postMessage(payload: unknown): void } } }
  }).webkit?.messageHandlers?.manorama
  handler?.postMessage(message)
}

/** Pending invokes, by id. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextId = 0

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
 * reads are the only path that needs it today.
 */
const invoke = async (
  cmd: string,
  args?: unknown,
  options?: { headers?: Record<string, string> },
): Promise<unknown> => {
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
const throughTheShell = (input: RequestInfo | URL, init?: RequestInit): RequestInfo | URL => {
  let url: URL
  try {
    url = input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return input
  }
  if (url.protocol !== 'https:' || !API_HOSTS.includes(url.hostname)) return input
  const proxied = new URL(`${window.location.origin}${url.pathname}${url.search}`)
  if (input instanceof Request && input.method !== 'GET') {
    return new Request(proxied, input)
  }
  return proxied
}

// Install only when the Tauri runtime is absent: under Tauri the real
// implementation is already there and must win.
if (typeof window !== 'undefined' && !window.__TAURI_INTERNALS__) {
  window.__TAURI_INTERNALS__ = { invoke, convertFileSrc }

  // The shell is the network boundary: the page's API calls go through it
  // rather than straight out to the site.
  const outerFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = throughTheShell(input, init)
    if (target === input) return outerFetch(input, init)
    if (init) return outerFetch(target, init)
    if (input instanceof Request) return outerFetch(target)
    return outerFetch(target)
  }) as typeof window.fetch
  window.__manoramaShell = {
    invoke,
    goTo: (index: number) => {
      const handle = (window as unknown as {
        __manoramaGoTo?: (index: number) => void
      }).__manoramaGoTo
      handle?.(index)
    },
  }
  ;(window as unknown as {
    __manoramaShellSettle?: (reply: InvokeReply) => void
  }).__manoramaShellSettle = settle
  // The app's own outbound channel. It is the same transport the runtime
  // calls use, wrapped so the app never names the webkit handler.
  window.__MANORAMA_SHELL__ = { post }
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
