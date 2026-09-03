/**
 * Vendo server handler — loaded via createRequire to bypass Vite's
 * ESM module runner (which can't handle CJS deps like @vercel/oidc, pg,
 * yaml, ajv, @modelcontextprotocol/sdk).
 *
 * Uses a LOCAL PGlite store for development, avoiding the Vendo Cloud
 * store 503 issue. Vendo Cloud is still used for the model (API key
 * forwarded to console.vendo.run/api/v1).
 */
const {
  cloudConnections,
  cloudSandbox,
  cloudTools,
  createVendo,
  guard,
  createStore,
  vendoModel,
} = require('@vendoai/vendo/server')

let vendo = null

function getVendo(env) {
  if (vendo === null) {
    const processEnv = globalThis.process?.env ?? {}
    const apiKey = env.VENDO_API_KEY ?? processEnv.VENDO_API_KEY
    const consoleUrl =
      (env.VENDO_CONSOLE_URL ?? processEnv.VENDO_CONSOLE_URL ?? 'https://console.vendo.run').replace(
        /\/+$/,
        '',
      )
    const cloud =
      apiKey === undefined || apiKey === ''
        ? undefined
        : { apiKey, baseUrl: consoleUrl }

    vendo = createVendo({
      auth: {
        principal: async () => ({ kind: 'user', subject: 'demo-user' }),
      },
      guard: guard({ policy: {} }),
      ...(cloud === undefined
        ? { store: createStore() }
        : {
            store: createStore(),
            models: {
              default: vendoModel('vendo'),
            },
            connections: cloudConnections(cloud),
            connectors: [cloudTools(cloud)],
            sandbox: cloudSandbox(cloud),
          }),
    })
  }
  return vendo
}

function handleVendoRequest(request, env) {
  return getVendo(env).handler(request)
}

module.exports = { handleVendoRequest }
