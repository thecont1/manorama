/// <reference types="vite/client" />

import type {} from 'hono'

type Head = {
  title?: string
  description?: string
  ogImage?: string
  /** Owner surfaces opt into the pre-paint theme bootstrap (theme-init.js).
   *  Public gallery pages must not: html.light would flip the viewer's
   *  doodle-ink, and viewer appearance follows the Canvas choice instead. */
  ownerTheme?: boolean
  /** The homepage is the one page the world may find: it drops the noindex
   *  meta and the noindex header, and takes the canonical `/` URL. Every
   *  other route leaves both in place. */
  indexable?: boolean
  /** Loads the marketing stylesheet alongside the app stylesheet. */
  home?: boolean
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

declare global {
  /** Injected by vite.config's `define` — the build commit shown under the
   *  Library mark. Undefined outside bundled code (unit tests, scripts). */
  const __MANORAMA_COMMIT__: string | undefined
}
