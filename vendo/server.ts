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
import { canonicalUri } from "@vendoai/mcp";
import { cloudConnections, cloudSandbox, cloudTools, createVendo, guard, hostedStore, type HostAuthPreset } from "@vendoai/vendo/server";
import { resolveManoramaSession, type SessionEnv } from "../app/lib/dropbox-session";
import { getUserByDropboxId } from "../app/lib/user-repository";
import { vendoProfile } from "./profile";

// The profile is BUNDLED at build time (vendo/profile.ts) — Cloudflare
// Workers have no filesystem at request time, and Vendo's default readers
// fail soft (no rules, no tools, no brief) rather than erroring. Importing
// the pieces here makes the Worker bundle carry them verbatim.

export interface VendoEnv extends SessionEnv {
  VENDO_API_KEY?: string;
  VENDO_CONSOLE_URL?: string;
  VENDO_BASE_URL?: string;
  VENDO_MCP_BROKER_URL?: string;
  VENDO_MCP_FEDERATION_SECRET?: string;
}

let vendo: ReturnType<typeof createVendo> | null = null;

const processEnv = () => (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};

/**
 * The SAME identity the Manorama management API enforces: a verified
 * Dropbox session. Anonymous, malformed, expired, or mis-signed
 * requests resolve to a null principal and Vendo refuses them. The
 * subject is the immutable `dropbox:<account id>` — never an email. The
 * verified email surfaces only through `auth.facts`.
 */
export function createVendoAuth(env: VendoEnv = {}): HostAuthPreset {
  const hostEnv = processEnv();
  const sessionEnv: SessionEnv = {
    HOST_API_JWT_SECRET: env.HOST_API_JWT_SECRET ?? hostEnv.HOST_API_JWT_SECRET,
    DB: env.DB,
  };
  const session = (request: Request) => resolveManoramaSession(request, sessionEnv);
  return {
    principal: async (request) => {
      const resolved = await session(request);
      return resolved === null ? null : { kind: "user", subject: resolved.id };
    },
    facts: async (request) => {
      const resolved = await session(request);
      return resolved?.email === undefined ? undefined : { email: resolved.email };
    },
    // The MCP door's host-identity seam: a signed-in Manorama session maps to
    // its `dropbox:<id>` subject; a request without one is sent through the
    // Dropbox login and returned to the door's authorization URL via `next`.
    oauth: {
      session: async (request, ctx) => {
        const resolved = await session(request);
        if (resolved) return { subject: resolved.id };
        const login = new URL("/auth/dropbox", request.url);
        login.searchParams.set("next", ctx.returnTo);
        return Response.redirect(login.toString(), 302);
      },
      principal: async (subject) => {
        const dropboxAccountId = subject.startsWith("dropbox:") ? subject.slice("dropbox:".length) : subject;
        const user = await getUserByDropboxId(dropboxAccountId, sessionEnv);
        return user ? { kind: "user", subject } : null;
      },
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
    // The env pair Vendo reads via process.env (invisible to workerd) is
    // passed explicitly: VENDO_MCP_BROKER_URL fronts the MCP door with the
    // hosted broker, VENDO_MCP_FEDERATION_SECRET answers its signed
    // login handshake.
    const brokerUrl = env.VENDO_MCP_BROKER_URL ?? hostEnv.VENDO_MCP_BROKER_URL;
    const federationSecret = env.VENDO_MCP_FEDERATION_SECRET ?? hostEnv.VENDO_MCP_FEDERATION_SECRET;
    vendo = createVendo({
      // Verify Manorama's trusted bearer session. Anonymous, malformed,
      // expired, or mis-signed sessions resolve to null and Vendo refuses
      // them.
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
      ...(brokerUrl === undefined ? {} : {
        mcp: {
          remoteAs: { issuer: new URL(brokerUrl).origin, audience: canonicalUri(brokerUrl) },
          ...(federationSecret === undefined ? {} : { federation: { secret: federationSecret } }),
        },
      }),
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
