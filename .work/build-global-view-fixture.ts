// Compile the real GlobalView island for the isolated Screen 06 harness.
// The shipped native stylesheet and the component's own CSS are linked in the
// harness HTML; this plugin only removes the CSS import from the capture JS.
const result = await Bun.build({
  entrypoints: [new URL('./global-view-fixture.tsx', import.meta.url).pathname],
  outdir: '/tmp/capture-global',
  target: 'browser',
  plugins: [{
    name: 'capture-css-link',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }))
    },
  }],
})
if (!result.success) {
  for (const message of result.logs) console.error(message)
  throw new Error('Unable to build the GlobalView capture fixture')
}
for (const output of result.outputs) console.log(output.path)
