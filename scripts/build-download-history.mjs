#!/usr/bin/env bun
/**
 * Builds history.json for the downloads host from the git tags.
 *
 * Every `v<semver>` tag becomes one release entry: its date, how many
 * commits it carried, and up to MAX_HIGHLIGHTS feat/fix/perf subjects as
 * the "what changed" record. The downloads Worker merges this with the
 * versioned object prefixes in the manorama-downloads bucket, so a release
 * shows its notes even when its assets were never uploaded.
 *
 * Usage: bun scripts/build-download-history.mjs [outfile]
 *        bunx wrangler r2 object put manorama-downloads/history.json \
 *          --file history.json --content-type application/json --remote
 */
import { execFileSync } from 'node:child_process'

const MAX_HIGHLIGHTS = 8
const REPO = 'https://github.com/thecont1/manorama'

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim()

const tags = git('tag', '-l', 'v*', '--sort=v:refname')
  .split('\n')
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))

const releases = []
for (let i = tags.length - 1; i >= 0; i--) {
  const tag = tags[i]
  const previous = tags[i - 1]
  const range = previous ? `${previous}..${tag}` : tag
  const date = git('log', '-1', '--format=%cs', tag)
  const total = Number(git('rev-list', '--count', range))
  const subjects = git('log', '--format=%h%x09%s', range)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t')
      return { sha, subject: rest.join('\t') }
    })
    .filter(({ subject }) => /^(feat|fix|perf|refactor)(\(|:)/.test(subject))
  // git log is newest-first: the head of the list is what the tag closed on.
  const highlights = subjects.slice(0, MAX_HIGHLIGHTS).map(({ sha, subject }) => ({
    sha,
    subject,
    url: `${REPO}/commit/${sha}`,
  }))
  releases.push({
    version: tag.slice(1),
    tag,
    date,
    commits: total,
    highlights,
  })
}

const history = { generated: new Date().toISOString().slice(0, 10), repo: REPO, releases }
const out = process.argv[2] ?? 'history.json'
await Bun.write(out, `${JSON.stringify(history, null, 2)}\n`)
console.log(`${releases.length} releases → ${out}`)
for (const release of releases) {
  console.log(`  v${release.version}  ${release.date}  ${release.commits} commits  ${release.highlights.length} highlights`)
}
