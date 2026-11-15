import MarkdownIt from 'markdown-it'
import aboutMd from '../../README.md?raw'
import techSpecsMd from '../../TECH-SPEC.md?raw'
import termsMd from '../../docs/terms-of-service.md?raw'

/**
 * The public document pages — /about, /techspecs and /terms — render the
 * repository's own markdown verbatim, so the pages can never drift from
 * the docs they publish: an edit to the file is live the next time the
 * Worker is built. `?raw` inlines the text at build time; there is no
 * filesystem on the Worker to read at request time.
 *
 * `html: false` escapes any raw HTML in the source rather than passing it
 * through, and markdown-it's link validator refuses unsafe URL schemes —
 * the rendered string is safe for dangerouslySetInnerHTML.
 */
const md = new MarkdownIt({ html: false, linkify: true })

export const ABOUT_DOC_HTML = md.render(aboutMd)
export const TECH_SPECS_DOC_HTML = md.render(techSpecsMd)
export const TERMS_DOC_HTML = md.render(termsMd)
