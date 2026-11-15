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
export const TERMS_DOC_HTML = md.render(termsMd)

/**
 * /techspecs is a reference document, not an essay — fifty-odd sections of
 * dense prose is a wall. The page splits TECH-SPEC.md at its headings and
 * renders each section as a disclosure, the same shape as the homepage
 * FAQ: headers listed one after the other, answers revealed on demand.
 * The content is still the repository file verbatim — only the framing
 * changed, so the page can never drift from the spec it publishes.
 *
 * The split is line-based and fence-aware: a heading-looking line inside
 * a ``` or ~~~ code block stays code, and every heading level becomes its
 * own item in document order.
 */
const HEADING_RE = /^ {0,3}(#{2,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

const renderTechSpecs = (src: string): string => {
  const intro: string[] = []
  const sections: { level: number; summary: string; lines: string[] }[] = []
  let current: { level: number; summary: string; lines: string[] } | null = null
  let fenceChar: string | null = null
  let fenceLen = 0

  const push = (line: string) => (current ? current.lines : intro).push(line)
  for (const line of src.split('\n')) {
    const fence = line.match(FENCE_RE)
    if (fence) {
      const marker = fence[1]
      if (fenceChar === null) {
        fenceChar = marker[0]
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = null
      }
      push(line)
      continue
    }
    const heading = fenceChar === null ? line.match(HEADING_RE) : null
    if (heading) {
      if (current) sections.push(current)
      current = { level: heading[1].length, summary: heading[2], lines: [] }
      continue
    }
    push(line)
  }
  if (current) sections.push(current)

  const items = sections.map(
    (section) =>
      `<details class="home-faq-item doc-section doc-section--h${section.level}">` +
      `<summary>${md.renderInline(section.summary)}</summary>` +
      `<div class="doc-section-body">${md.render(section.lines.join('\n'))}</div>` +
      `</details>`,
  )
  return `${md.render(intro.join('\n'))}<div class="doc-section-list">${items.join('\n')}</div>`
}

export const TECH_SPECS_DOC_HTML = renderTechSpecs(techSpecsMd)
