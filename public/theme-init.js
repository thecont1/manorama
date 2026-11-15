/* Applies the stored owner theme before first paint. Same-origin because
 * production CSP is script-src 'self' — no inline script is allowed on web.
 * The manorama-theme cookie is shared with downloads.manorama.xyz; the
 * localStorage key remains the same-origin fallback. */
try {
  var m = /(?:^|; *)manorama-theme=(light|dark)/.exec(document.cookie)
  var t = m ? m[1] : localStorage.getItem('manorama:theme')
  if (t === 'light') document.documentElement.classList.add('light')
} catch {}
