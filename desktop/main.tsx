import { render } from 'hono/jsx/dom'
import Catalogue from './islands/Catalogue'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Desktop app root is missing')

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'

render(<Catalogue apiBase={apiBase} />, root)
