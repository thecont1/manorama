// The quick-add sign-in page renders its provider links inert until
// quickadd.ts wires each one to `?next=` — if that module fails to load,
// the page would sit dead with no explanation. Watch for the module's
// error event and say so in the status line. Capture phase: resource
// errors do not bubble.
window.addEventListener('error', (event) => {
  const node = event.target
  if (!(node instanceof HTMLScriptElement) || !node.hasAttribute('data-quickadd-module')) return
  const status = document.querySelector('[data-quickadd-status]')
  if (status) status.textContent = 'Sign-in could not load — reload this page to try again.'
}, true)
