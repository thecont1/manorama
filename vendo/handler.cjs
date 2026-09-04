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
const { jwt } = require('@vendoai/vendo/auth/jwt')

// Load the policy at module scope so the rules are bundled into the runtime
// regardless of filesystem access — Vendo's default file loader uses
// node:fs/promises, which is unavailable on Cloudflare Workers and silently
// returns no rules, leaving destructive operations unguarded.
const policyFile = require('../.vendo/policy.json')

// Load the tool catalog at module scope so the declarations are bundled into
// the runtime — Vendo's default reader uses node:fs, which is unavailable on
// Cloudflare Workers and silently returns no tools, leaving the assistant
// unable to call any host route (scan, create, update, delete, etc.).
const toolsFile = require('../.vendo/tools.json')

let vendo = null

/**
 * Lazy singleton: constructed on the first request, never at module scope —
 * Workers forbids I/O and timers there, and lazy is correct on every other
 * runtime too. Configures a local PGlite store, and wires cloud
 * connections/tools/sandbox/model when a VENDO_API_KEY is present.
 */
function createVendoAuth(env = {}) {
  const processEnv = globalThis.process?.env ?? {}
  return jwt({ secret: () => env.HOST_API_JWT_SECRET ?? processEnv.HOST_API_JWT_SECRET })
}

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
      auth: createVendoAuth(env),
      guard: guard({ policy: { rules: policyFile.rules, directions: policyFile.directions } }),
      tools: toolsFile.tools,
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

/**
 * Delegates the given Request to the singleton Vendo instance's handler
 * and returns its Response.
 *
 * @param {Request} request - The incoming HTTP request
 * @param {object} env - Environment variables (VENDO_API_KEY, VENDO_CONSOLE_URL)
 * @returns {Promise<Response>} The response from the Vendo handler
 */
function handleVendoRequest(request, env) {
  return getVendo(env).handler(request)
}

module.exports = { createVendoAuth, handleVendoRequest }
