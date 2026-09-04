/**
 * Route your runtime's requests through this module:
 *   // Cloudflare Workers:
 *   //   export default { fetch: (request, env) => handleVendoRequest(request, env) };
 *   // Bun / Deno / Hono / Node: serve your /api/vendo routes through
 *   //   handleVendoRequest(request)
 *   // in the client entry — theme.json adopts the host brand (08 §4);
 *   // <VendoOverlay /> is the conversation panel (opens from a trigger or a slot):
 *   import { VendoOverlay, VendoProvider } from "@vendoai/vendo/react";
 *   import theme from "<path-to>/.vendo/theme.json";
 *   root.render(<VendoProvider baseUrl="/api/vendo" theme={theme}><App /><VendoOverlay /></VendoProvider>);
 * Deployed hosts must set VENDO_BASE_URL to their public origin
 * (credential forwarding fails closed without it — vendo doctor checks).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { cloudConnections, cloudSandbox, cloudTools, createVendo, guard, hostedStore, type HostAuthPreset } from "@vendoai/vendo/server";
import { resolveManoramaSession, type AccessEnv, type AccessJwtVerifier } from "../app/lib/session";
import { vendoProfile } from "./profile";

// The profile is BUNDLED at build time (vendo/profile.ts) — Cloudflare
// Workers have no filesystem at request time, and Vendo's default readers
// fail soft (no rules, no tools, no brief) rather than erroring. Importing
// the pieces here makes the Worker bundle carry them verbatim.

export interface VendoEnv extends AccessEnv {
  VENDO_API_KEY?: string;
  VENDO_CONSOLE_URL?: string;
  VENDO_BASE_URL?: string;
}

let vendo: ReturnType<typeof createVendo> | null = null;

const processEnv = () => (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};

/**
 * The SAME identity the Manorama management API enforces: a verified
 * Cloudflare Access session. Anonymous, malformed, expired, or mis-signed
 * requests resolve to a null principal and Vendo refuses them. The subject
 * is the immutable `cf-access:<sub>` id — never an email. The verified email
 * surfaces only through `auth.facts`.
 */
export function createVendoAuth(env: VendoEnv = {}, verifier?: AccessJwtVerifier): HostAuthPreset {
  const hostEnv = processEnv();
  const sessionEnv: AccessEnv = {
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN ?? hostEnv.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: env.CF_ACCESS_AUD ?? hostEnv.CF_ACCESS_AUD,
    CF_ACCESS_JWKS: env.CF_ACCESS_JWKS ?? hostEnv.CF_ACCESS_JWKS,
  };
  const session = (request: Request) => resolveManoramaSession(request, sessionEnv, verifier);
  return {
    principal: async (request) => {
      const resolved = await session(request);
      return resolved === null ? null : { kind: "user", subject: resolved.id };
    },
    facts: async (request) => {
      const resolved = await session(request);
      return resolved?.email === undefined ? undefined : { email: resolved.email };
    },
  };
}

/** Lazy singleton: constructed on the first request, never at module
    scope — Workers forbids I/O and timers there, and lazy is correct on
    every other runtime too. */
function getVendo(env: VendoEnv = {}) {
  if (vendo === null) {
    const hostEnv = processEnv();
    const apiKey = env.VENDO_API_KEY ?? hostEnv.VENDO_API_KEY;
    // The VENDO CONSOLE's origin — not your app's. Your app's public URL is VENDO_BASE_URL.
    const consoleUrl = (env.VENDO_CONSOLE_URL ?? hostEnv.VENDO_CONSOLE_URL ?? "https://console.vendo.run").replace(/\/+$/, "");
    const cloud = apiKey === undefined || apiKey === "" ? undefined : { apiKey, baseUrl: consoleUrl };
    vendo = createVendo({
      // Verify Manorama's trusted bearer session. Anonymous, malformed, expired,
      // or mis-signed sessions resolve to null and Vendo refuses them.
      auth: createVendoAuth(env),
      // The .vendo/policy.json document is authoritative — the profile feeds
      // the guard inline (replacing the file leg), and the explicit guard()
      // seam stays as the composition point for the rules it carries.
      guard: guard({
        policy: {
          rules: vendoProfile.policy.rules,
          directions: vendoProfile.policy.directions,
        },
      }),
      tools: vendoProfile.tools,
      // The bundled .vendo profile — every surface the composition would
      // otherwise read from disk (theme, brief, catalog, overrides, policy)
      // arrives in memory, valid on runtimes with no filesystem.
      profile: {
        theme: vendoProfile.theme,
        brief: vendoProfile.brief,
        catalog: vendoProfile.catalog,
        overrides: vendoProfile.overrides,
      },
      // With a Vendo Cloud key the infrastructure seams wire the Cloud
      // adapters EXPLICITLY (composition decides; blocks never read the
      // environment). Without one, pass your own adapters here — models,
      // store, connections, sandbox all accept custom implementations.
      ...(cloud === undefined ? {} : {
        models: { default: createAnthropic({ apiKey: cloud.apiKey, baseURL: `${cloud.baseUrl}/api/v1` })("vendo") },
        store: hostedStore(cloud),
        connections: cloudConnections(cloud),
        connectors: [cloudTools(cloud)],
        sandbox: cloudSandbox(cloud),
      }),
    });
  }
  return vendo;
}

/**
 * Delegates the given Request to the singleton Vendo instance's handler
 * and returns its Response.
 *
 * @param request - The incoming HTTP request
 * @param env - Environment variables (VENDO_API_KEY, VENDO_CONSOLE_URL, VENDO_BASE_URL)
 * @returns The response from the Vendo handler
 */
export function handleVendoRequest(request: Request, env: VendoEnv = {}): Promise<Response> {
  return getVendo(env).handler(request);
}
