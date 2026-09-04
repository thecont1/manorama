import build from '@hono/vite-build/cloudflare-workers'
import adapter from '@hono/vite-dev-server/node'
import honox from 'honox/vite'
import { defineConfig } from 'vite'

export default defineConfig(() => ({
  plugins: [
    honox({
      devServer: {
        adapter,
        // Vite must handle source assets and Vendo config files. When these
        // are passed to Hono, they 404 because there is no matching route.
        // This list mirrors HonoX's defaults plus / .vendo/*.
        exclude: [
          /.*\.css$/,
          /.*\.ts$/,
          /.*\.tsx$/,
          /.*\.mdx?$/,
          /^\/\@.+$/,
          /\?t\=\d+$/,
          /^\/favicon\.ico$/,
          /^\/static\/.+/,
          /^\/node_modules\/.*/,
          /^\/\.vite\/.*/,
          /.*\.svelte$/,
          /.*\.vue$/,
          /.*\.js$/,
          /.*\.jsx$/,
          /.*\.mjs$/,
          /^\/app\/.+\.tsx?/,
          /^\/\.vendo\/.*/,
        ],
      },
      client: { input: ['/app/client.ts', '/app/vendo-client.tsx', '/app/styles.css'] },
    }),
    build(),
  ],
  ssr: {
    // These dependencies (pulled in through @vendoai/vendo's graph) ship
    // CommonJS builds that Vite's ESM module runner cannot evaluate
    // ("module is not defined" / "require is not defined"). Node's native
    // import handles them via the require condition, and the Cloudflare
    // Workers build handles CJS fine — only the dev-server SSR path needs
    // the externalization. Subpath entries also cover nested copies under
    // other packages' node_modules.
    external: [
      '@vercel/oidc',
      '@vercel/oidc/*',
      'pg',
      'pg/*',
      'yaml',
      'yaml/*',
      'ajv',
      'ajv/*',
      'ajv-formats',
      'ajv-formats/*',
      '@modelcontextprotocol/sdk',
      '@modelcontextprotocol/sdk/*',
    ],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}))
