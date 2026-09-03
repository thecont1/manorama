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
import { cloudConnections, cloudSandbox, cloudTools, createVendo, guard, hostedStore } from "@vendoai/vendo/server";

export interface VendoEnv {
  VENDO_API_KEY?: string;
  VENDO_CONSOLE_URL?: string;
  VENDO_BASE_URL?: string;
}

let vendo: ReturnType<typeof createVendo> | null = null;

/** Lazy singleton: constructed on the first request, never at module
    scope — Workers forbids I/O and timers there, and lazy is correct on
    every other runtime too. */
function getVendo(env: VendoEnv = {}) {
  if (vendo === null) {
    const processEnv = globalThis.process?.env ?? {};
    const apiKey = env.VENDO_API_KEY ?? processEnv.VENDO_API_KEY;
    // The VENDO CONSOLE's origin — not your app's. Your app's public URL is VENDO_BASE_URL.
    const consoleUrl = (env.VENDO_CONSOLE_URL ?? processEnv.VENDO_CONSOLE_URL ?? "https://console.vendo.run").replace(/\/+$/, "");
    const cloud = apiKey === undefined || apiKey === "" ? undefined : { apiKey, baseUrl: consoleUrl };
    vendo = createVendo({
      // Who the wire's callers act as. This must resolve the SAME subject your
      // agent loop uses (the docs' chat routes set this demo principal), or apps
      // and approvals created in chat are invisible to the embeds, which call
      // this route directly. Replace both sides with your real session lookup.
      // Everything identity-shaped lives here: https://docs.vendo.run/howto/auth.
      auth: {
        principal: async () => ({ kind: "user" as const, subject: "demo-user" }),
      },
      guard: guard({ policy: {} }), // .vendo/policy.json: destructive asks, reads run
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
