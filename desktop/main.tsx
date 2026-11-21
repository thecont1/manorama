import { render } from 'hono/jsx/dom'
import Catalogue from './islands/Catalogue'
import './styles.css'
import '../app/styles/canvas.css'

const root = document.getElementById('app')
if (!root) throw new Error('Desktop app root is missing')
// body.manorama-desktop is a static class in index.html — the marker must be
// present before first paint, not after module evaluation.

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'

render(<Catalogue apiBase={apiBase} />, root)
