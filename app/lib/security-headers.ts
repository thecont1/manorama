/**
 * Page-level security headers, applied once in the renderer so every HTML
 * route carries the same policy. The CSP is assembled directive-per-line
 * so each allowance reads next to its reason.
 */

export const pageSecurityHeaders = (opts: { dev: boolean }): Record<string, string> => {
  const directives = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' for the C2PA reader's wasm; 'unsafe-inline' only in
    // dev, where the Vite client injects inline scripts.
    `script-src 'self' 'wasm-unsafe-eval'${opts.dev ? ` 'unsafe-inline'` : ''}`,
    // @contentauth/c2pa-web and heic2any spawn Workers; heic2any's is built
    // from a blob: URL.
    "worker-src 'self' blob:",
    // style={} attributes plus the Google Fonts @import in app/styles.css.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    // Dev adds ws:/wss: for Vite HMR.
    `connect-src 'self'${opts.dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]
  return {
    'Content-Security-Policy': directives.join('; '),
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  }
}

/** Proxied provider bytes: <img> loads ignore CSP, but a direct navigation
 *  to a proxy URL gets an opaque, scriptless origin. */
export const PROXY_RESPONSE_CSP = "default-src 'none'; sandbox"
