/**
 * @manorama/core — the platform-free heart of manorama.
 *
 * Every module here must run unchanged in three hosts: the Cloudflare Worker
 * (SSR + API), the web viewer bundle, and the native Capacitor/Tauri shells.
 * That means no Worker bindings, no `window`, no Node built-ins, no Capacitor
 * imports — pure TypeScript only. Anything that needs a platform belongs in
 * `app/lib` (Worker) or `native/lib` (device).
 *
 * `app/lib/*.ts` keeps thin re-export shims for each module moved here, so
 * existing Worker and test imports are unaffected.
 */
export * from './imagesource'
export * from './image-dims'
export * from './image-staging'
export * from './gallery-settings'
