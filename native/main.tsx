import { render } from 'hono/jsx/dom'
import GalleryList from './islands/GalleryList'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Native app root is missing')

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'
render(<GalleryList apiBase={apiBase} />, root)
