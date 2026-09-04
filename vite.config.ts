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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}))
