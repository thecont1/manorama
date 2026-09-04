import type {} from 'hono'

type Head = {
  title?: string
}

declare module 'hono' {
  interface ContextRenderer {
    (content: string | Promise<string>, head?: Head): Response | Promise<Response>
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    manoramaSession: import('./lib/session').ManoramaSession
  }
}

declare module '*?url' {
  const src: string
  export default src
}

declare module '@contentauth/c2pa-web/resources/c2pa.wasm?url' {
  const src: string
  export default src
}

declare namespace JSX {
  interface IntrinsicElements {
    'cai-manifest-summary': Record<string, unknown>
  }
}
