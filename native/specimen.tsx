/** Dev/test-only specimen for the P1 redesign primitives, served by the
 *  native fixture server at /specimen.html. Not part of the app bundle
 *  (vite.config.native.ts only builds index.html). Renders inside .m-owner
 *  in both owner themes; ?theme=light presets the theme. */
import { render, useState } from 'hono/jsx/dom'
import '../app/styles.css'
import { TopBar } from '../app/components/ui/TopBar'
import { Button } from '../app/components/ui/Button'
import { ActionGroup, ActionRow } from '../app/components/ui/ActionRow'
import { Switch } from '../app/components/ui/Switch'
import { Segmented } from '../app/components/ui/Segmented'
import { Meter } from '../app/components/ui/Meter'
import { Sheet } from '../app/components/ui/Sheet'
import { applyTheme, oppositeTheme, readStoredTheme, storeTheme, themeControlLabel, type Theme } from '../app/lib/owner-theme'

const root = document.getElementById('app')
if (!root) throw new Error('specimen root missing')

const preset = new URLSearchParams(location.search).get('theme')
if (preset === 'light' || preset === 'dark') {
  try { localStorage.setItem('manorama:theme', preset) } catch { /* storage may be off */ }
}
// theme-init.js runs at parse time — before a ?theme= preset can land — so the
// specimen applies the stored choice itself for the same result.
applyTheme(readStoredTheme(localStorage), document.documentElement)

const Specimen = () => {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(localStorage))
  const [toggle, setToggle] = useState(true)
  const [seg, setSeg] = useState<'strip' | 'scroll' | 'single'>('strip')
  const [sheet, setSheet] = useState<'half' | 'auto' | 'confirm' | null>(null)
  const [link, setLink] = useState('')

  const flip = () => {
    const next = oppositeTheme(theme)
    setTheme(next)
    applyTheme(next, document.documentElement)
    storeTheme(localStorage, next)
  }

  return (
    <div class="m-owner" style="min-height:100dvh;display:flex;flex-direction:column;gap:16px;padding-bottom:40px">
      <TopBar
        start={<Button variant="quiet" aria-label="Back to the library">Library</Button>}
        end={<Button variant="quiet" aria-label="Settings">⚙</Button>}
      />
      <main style="display:grid;gap:20px;padding:0 var(--m-pad)">
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="destructive">Remove gallery</Button>
        </div>
        <div>
          <Button variant="secondary" onClick={flip}>{themeControlLabel(theme)}</Button>
        </div>

        <ActionGroup label="Gallery details">
          <ActionRow label="Name" value="quiet light" chevron onClick={() => setSheet('auto')} />
          <ActionRow label="Address" value="manorama.xyz/owner/quiet-light" href="#address" />
          <ActionRow label="Keep a copy" control={<Switch checked={toggle} onChange={setToggle} label="Keep a copy" />} />
          <ActionRow label="Remove gallery" tone="destructive" chevron onClick={() => setSheet('confirm')} />
        </ActionGroup>

        <Segmented
          label="Layout"
          options={[
            { value: 'strip', label: 'Strip' },
            { value: 'scroll', label: 'Scroll' },
            { value: 'single', label: 'One by one' },
          ]}
          value={seg}
          onChange={setSeg}
        />

        <Meter label="Saving" value={9} max={13} valueText="9 of 13" />
        <Meter label="Plan" value={2} max={3} valueText="2 of 3 free galleries" />

        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <Button variant="primary" onClick={() => setSheet('half')}>Open half sheet</Button>
          <Button variant="secondary" onClick={() => setSheet('auto')}>Open scrolling sheet</Button>
        </div>
      </main>

      <Sheet
        open={sheet === 'half'}
        onClose={() => setSheet(null)}
        title="Add a gallery"
        size="half"
        footer={<Button variant="primary" block onClick={() => setSheet('confirm')}>Add gallery</Button>}
      >
        <label style="display:grid;gap:6px">
          <span>Shared folder or album link</span>
          <input type="url" placeholder="https://" value={link} onInput={(e) => setLink((e.target as HTMLInputElement).value)} style="min-height:44px;padding:8px 12px;font:inherit" />
        </label>
      </Sheet>

      <Sheet open={sheet === 'auto'} onClose={() => setSheet(null)} title="About this gallery">
        {Array.from({ length: 24 }, (_, i) => (
          <p key={i}>A row of specimen copy — the body scrolls while the sheet pins its header and any footer.</p>
        ))}
      </Sheet>

      <Sheet
        open={sheet === 'confirm'}
        onClose={() => setSheet('half')}
        title="Remove this gallery?"
        footer={<Button variant="destructive" block onClick={() => setSheet(null)}>Remove gallery</Button>}
      >
        <p>Removing it leaves every photograph at its source.</p>
      </Sheet>
    </div>
  )
}

render(<Specimen />, root)
