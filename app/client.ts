import { createClient } from 'honox/client'

// Vendo overlay — lazy import so it only loads when the page is interactive
import('./vendo-client').catch(() => {})
