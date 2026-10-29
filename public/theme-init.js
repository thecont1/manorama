/* Applies the stored owner theme before first paint. Same-origin because
 * production CSP is script-src 'self' — no inline script is allowed on web. */
try {
  if (localStorage.getItem('manorama:theme') === 'light') document.documentElement.classList.add('light')
} catch {}
