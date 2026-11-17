/**
 * The Liquid Glass gate — runs inside `bun test` (unit mirror + CI), no DOM,
 * no dev server. Enforces the design system's invariants on the stylesheets:
 *
 *  1. Blur budgets: every blur(Npx) under a .glass-* rule resolves ≤ the
 *     per-surface ceiling in packages/core/glass-tokens.ts (var() refs resolved
 *     against :root token definitions; unresolved vars fail).
 *  2. Fallbacks: every .glass-* material selector has a reduced-transparency/
 *     contrast media rule AND an @supports not (backdrop-filter) rule.
 *  3. Gating: every .glass-* rule is scoped under a frost attribute
 *     (data-ios-shell / data-android-shell / data-macos-shell) — never bare,
 *     never under a takeover attribute.
 *  4. Frost never hides: no visibility:hidden / display:none under a frost
 *     attribute. Hide rules may key only on takeover attributes.
 *  5. No glass near images: a .glass-* selector may not contain an <img>
 *     descendant. DOM-level ancestry is covered by specs/glass-freeze.playwright.ts.
 * Named exempt dims (glassExemptDims) are skipped for budget checks — they are
 * not .glass-* surfaces and keep their owner's filters.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  frostGateAttributes,
  glassBlurMaxPx,
  glassExemptDims,
  takeoverGateAttributes,
} from '../packages/core/glass-tokens'

const repo = new URL('..', import.meta.url).pathname

const cssFiles = (): string[] => {
  const files: string[] = []
  const push = (dir: string, suffix = '.css') => {
    for (const name of readdirSync(join(repo, dir))) {
      if (name.endsWith(suffix)) files.push(join(dir, name))
    }
  }
  files.push('app/styles.css', 'app/home.css', 'native/styles.css', 'desktop/styles.css')
  push('app/styles')
  push('native/styles')
  return files
}

type CssRule = {
  selector: string
  body: string
  atRules: string[]
  file: string
}

/** Naive block parser — good enough for declarations, at-rule stacks and
 *  nested media/supports. Comments stripped; strings left intact. */
const parseCss = (css: string, file: string): CssRule[] => {
  const rules: CssRule[] = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack: string[] = []
  let i = 0
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i)
    const close = stripped.indexOf('}', i)
    if (open === -1 && close === -1) break
    if (close !== -1 && (open === -1 || close < open)) {
      stack.pop()
      i = close + 1
      continue
    }
    const head = stripped.slice(i, open).trim()
    if (head.startsWith('@')) {
      stack.push(head)
      i = open + 1
      continue
    }
    // Normal rule: capture it, then skip past its matching close so the '}'
    // is not mistaken for the end of a containing at-rule.
    let depthCursor = 1
    let j = open + 1
    while (j < stripped.length && depthCursor > 0) {
      if (stripped[j] === '{') depthCursor++
      else if (stripped[j] === '}') depthCursor--
      j++
    }
    rules.push({ selector: head, body: stripped.slice(open + 1, j - 1), atRules: [...stack], file })
    i = j
  }
  return rules
}

const allRules = cssFiles().flatMap((file) => parseCss(readFileSync(join(repo, file), 'utf8'), file))
const isGlassRule = (r: CssRule) => /\.glass-[a-z-]+/i.test(r.selector)
const hasFrostAttr = (r: CssRule) => frostGateAttributes.some((a) => r.selector.includes(`[${a}]`))
const hasTakeoverAttr = (r: CssRule) => takeoverGateAttributes.some((a) => r.selector.includes(`[${a}]`))
const isExempt = (r: CssRule) => glassExemptDims.some((d) => r.selector.includes(d))
const inReducedTransparency = (r: CssRule) =>
  r.atRules.some((a) => /prefers-reduced-transparency|prefers-contrast/.test(a))
const inNoBackdropSupports = (r: CssRule) =>
  r.atRules.some((a) => /@supports\s+not\b/.test(a) && /backdrop-filter/.test(a))

/** Splits a selector prelude into its comma-separated branches. Commas
 *  inside :is()/:not()/:where() parens and [attr="a,b"] brackets do not
 *  split — only top-level ones do. */
const selectorBranches = (selector: string): string[] => {
  const branches: string[] = []
  let depth = 0
  let attr = 0
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[') {
      attr++
    } else if (c === ']') {
      attr--
    } else if (attr === 0 && c === '(') {
      depth++
    } else if (attr === 0 && c === ')') {
      depth--
    } else if (attr === 0 && depth === 0 && c === ',') {
      branches.push(selector.slice(start, i))
      start = i + 1
    }
  }
  branches.push(selector.slice(start))
  return branches.map((b) => b.trim()).filter(Boolean)
}

// Resolve --glass-* token values (px only) from :root blocks.
const glassVars = new Map<string, number>()
for (const r of allRules) {
  if (!r.selector.includes(':root')) continue
  for (const m of r.body.matchAll(/--glass-[a-z-]+:\s*(\d+(?:\.\d+)?)px/gi)) {
    const name = /--glass-[a-z-]+/i.exec(m[0])![0]
    glassVars.set(name, Number.parseFloat(m[1]))
  }
}

const blurPx = (body: string): number[] => {
  const out: number[] = []
  for (const m of body.matchAll(/blur\(\s*([0-9.]+)px\s*\)/g)) out.push(Number.parseFloat(m[1]))
  for (const m of body.matchAll(/blur\(\s*var\((--glass-[a-z-]+)\)\s*\)/g)) {
    const v = glassVars.get(m[1])
    if (v !== undefined) out.push(v)
  }
  return out
}
const hasUnresolvedGlassVar = (body: string) =>
  /blur\(\s*var\((--glass-[a-z-]+)\)\s*\)/.test(body) &&
  [...body.matchAll(/blur\(\s*var\((--glass-[a-z-]+)\)\s*\)/g)].some((m) => !glassVars.has(m[1]))

const glassRules = allRules.filter(isGlassRule)
const glassClasses = new Set<string>()
for (const r of glassRules) {
  for (const m of r.selector.matchAll(/\.glass-[a-z-]+/gi)) glassClasses.add(m[0])
}
// Only classes that actually paint a backdrop need a Tier-0 fallback —
// flat fills and transition helpers are solid already.
const backdropClasses = new Set<string>()
for (const r of glassRules) {
  if (!/backdrop-filter\s*:/.test(r.body) || inReducedTransparency(r) || inNoBackdropSupports(r)) continue
  for (const m of r.selector.matchAll(/\.glass-[a-z-]+/gi)) backdropClasses.add(m[0])
}

describe('glass gate — blur budgets', () => {
  test('every .glass-* blur resolves at or under the larger ceiling', () => {
    const violations = glassRules
      .filter((r) => !isExempt(r) && !inReducedTransparency(r) && !inNoBackdropSupports(r))
      .flatMap((r) =>
        blurPx(r.body)
          .filter((px) => px > glassBlurMaxPx.larger)
          .map((px) => `${r.file} ${r.selector} blur(${px}px) > ${glassBlurMaxPx.larger}`),
      )
    expect(violations).toEqual([])
  })

  test('no blur(var(--glass-*)) reference is unresolved', () => {
    const bad = glassRules.filter((r) => hasUnresolvedGlassVar(r.body)).map((r) => `${r.file} ${r.selector}`)
    expect(bad).toEqual([])
  })
})

describe('glass gate — fallbacks', () => {
  test('every backdrop-filter .glass-* class has a reduced-transparency/contrast override', () => {
    const covered = new Set(
      glassRules.filter(inReducedTransparency).flatMap((r) => [...r.selector.matchAll(/\.glass-[a-z-]+/gi)].map((m) => m[0])),
    )
    const missing = [...backdropClasses].filter((c) => !covered.has(c))
    expect(missing).toEqual([])
  })

  test('every backdrop-filter .glass-* class has an @supports no-backdrop-filter fallback', () => {
    const covered = new Set(
      glassRules.filter(inNoBackdropSupports).flatMap((r) => [...r.selector.matchAll(/\.glass-[a-z-]+/gi)].map((m) => m[0])),
    )
    const missing = [...backdropClasses].filter((c) => !covered.has(c))
    expect(missing).toEqual([])
  })
})

describe('glass gate — gating', () => {
  test('every .glass-* selector branch is frost-gated and never takeover-gated', () => {
    // A selector LIST is only as safe as its weakest branch — a combined
    // ":root[data-x] .glass-a, .glass-b" leaves the second branch bare.
    const violations: string[] = []
    for (const r of glassRules) {
      for (const branch of selectorBranches(r.selector)) {
        if (!/\.glass-[a-z-]+/i.test(branch)) continue
        if (!frostGateAttributes.some((a) => branch.includes(`[${a}]`))) {
          violations.push(`${r.file} ${branch} — no frost attribute`)
        }
        if (takeoverGateAttributes.some((a) => branch.includes(`[${a}]`))) {
          violations.push(`${r.file} ${branch} — takeover attribute`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('no rule hides an element under a frost attribute', () => {
    const hiding = allRules
      .filter((r) => hasFrostAttr(r) && /(visibility\s*:\s*hidden|display\s*:\s*none)/.test(r.body))
      .map((r) => `${r.file} ${r.selector}`)
    expect(hiding).toEqual([])
  })

  test('hide rules on shell attributes key only on takeover attributes', () => {
    const bad = allRules
      .filter(
        (r) =>
          /visibility\s*:\s*hidden/.test(r.body) &&
          /\[data-/.test(r.selector) &&
          !hasTakeoverAttr(r),
      )
      .map((r) => `${r.file} ${r.selector}`)
    expect(bad).toEqual([])
  })
})

describe('glass gate — images', () => {
  test('no .glass-* selector contains an img descendant', () => {
    const bad = glassRules.filter((r) => /(^|[\s>+~])img([\s>+~.#:[\]]|$)/i.test(r.selector)).map((r) => `${r.file} ${r.selector}`)
    expect(bad).toEqual([])
  })
})
