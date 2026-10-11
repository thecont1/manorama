"""Give the editor cell its stable photograph id, and let the capture fixture
record the editor's write instead of reaching the owner's real galleries."""
from pathlib import Path
import sys

# 1 — the stable per-image id the comments seam will need, and this run asserts.
p = Path('native/islands/GalleryEditor.tsx')
s = p.read_text()
old = """                  class={`native-global-cell${held === photo.id ? ' is-active' : ''}`}
                  role="listitem"
                  key={photo.id}"""
new = """                  class={`native-global-cell${held === photo.id ? ' is-active' : ''}`}
                  role="listitem"
                  key={photo.id}
                  data-photo={photo.id}"""
if old not in s:
    sys.exit('editor cell anchor missing')
p.write_text(s.replace(old, new, 1))
print('ok: editor cell id')

# 2 — the fixture answers and records the editor's write.
p = Path('.work/capture-server.ts')
s = p.read_text()
old = """    if (url.indexOf('/api/galleries') !== -1) {
      if (init && init.method === 'POST') {
        window.__captureImport = JSON.parse(init.body)
        return Promise.resolve(json({ galleryUrl: '/thecontrarian/italy' }))
      }
      return Promise.resolve(json(seeded.galleries))
    }"""
new = """    if (url.indexOf('/api/galleries') !== -1) {
      if (init && init.method === 'POST') {
        window.__captureImport = JSON.parse(init.body)
        return Promise.resolve(json({ galleryUrl: '/thecontrarian/italy' }))
      }
      // The editor's writes are recorded and answered here. A fixture must
      // never reach the owner's real galleries.
      if (init && init.method === 'PATCH') {
        window.__capturePatch = window.__capturePatch || []
        window.__capturePatch.push({ url: url, body: JSON.parse(init.body) })
        return Promise.resolve(json({ gallery: seeded.galleries.galleries[0] }))
      }
      return Promise.resolve(json(seeded.galleries))
    }"""
if old not in s:
    sys.exit('capture fetch anchor missing')
s = s.replace(old, new, 1)

old = """      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      errors: window.__captureErrors || [] })"""
new = """      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      patches: window.__capturePatch || [],
      errors: window.__captureErrors || [] })"""
if old not in s:
    sys.exit('report anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
print('ok: fixture records writes')