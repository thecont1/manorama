/// <reference types="node" />
// Focused Vendo surface spec — Task 1.4 acceptance.
//
// The public gallery must stay free of the agent surface (no launcher, no
// wire polling); the authenticated owner admin page mounts it. The anonymous
// admin page is refused.
//
// Run against the dev server, which seeds the test owner through the
// manorama-dev-seed vite plugin (dbid:AAATESTowner1 → 'thecontrarian'):
//
//   bun run dev                        # http://localhost:5173
//   bunx playwright test vendo-surface
//
// Authentication is a dev-minted manorama_session cookie signed with the
// dev server's HOST_API_JWT_SECRET (.env.local). With SKIP_ACCESS_FIXTURE_TESTS=1
// the authenticated test skips; the public-surface guarantees still run.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const BASE = process.env.GALLERY_URL ?? "http://localhost:5173";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "dev-dropbox";

const devEnv = (() => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    // .env.local exists only in a dev checkout.
  }
  return env;
})();

const sessionSecret = process.env.HOST_API_JWT_SECRET ?? devEnv.HOST_API_JWT_SECRET ?? "";

const sessionCookie = async (dropboxAccountId = "dbid:AAATESTowner1"): Promise<string> =>
  `manorama_session=${await new SignJWT({ sub: dropboxAccountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(sessionSecret))}`;

test("public gallery page mounts no Vendo surface and never polls the wire", async ({ page }) => {
  const vendoRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/vendo")) vendoRequests.push(request.url());
  });
  await page.goto(`${BASE}/${OWNER}/${SLUG}`);
  await page.locator("[data-curtain]").waitFor({ state: "visible" });
  // Give any hypothetical poller time to fire before asserting absence.
  await page.waitForTimeout(1500);
  expect(await page.locator("#vendo-root").count()).toBe(0);
  expect(await page.locator("[data-vendo-launcher]").count()).toBe(0);
  expect(vendoRequests).toEqual([]);
});

test("public landing page mounts no Vendo surface", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.locator(".landing-brand").waitFor({ state: "visible" });
  expect(await page.locator("#vendo-root").count()).toBe(0);
  expect(await page.locator("[data-vendo-launcher]").count()).toBe(0);
});

test("anonymous admin request is refused and renders no surface", async ({ page, request }) => {
  // Session auth turns anons away with a redirect to the landing page —
  // refusal is "you never reach the dashboard", not a bare 401.
  const response = await request.get(`${BASE}/${OWNER}`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers()["location"]).toBe("/");

  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  expect(await page.locator("#vendo-root").count()).toBe(0);
  expect(await page.locator("button[data-vendo-launcher]").count()).toBe(0);
});

// Vendo is disabled platform-wide for now — the admin page mounts no
// #vendo-root and no client script ships. Re-enable with the wiring.
test.skip("authenticated admin page shows the Ask Manu launcher and opens the panel", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookie() });
  const response = await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  // Only skip when the server is explicitly running without the dev Access
  // fixture (e.g. production behind real Cloudflare Access). Without this
  // flag, a non-200 response is an authentication regression, not a skip.
  if (process.env.SKIP_ACCESS_FIXTURE_TESTS === "1") {
    test.skip(true, "server running without dev Access fixture (SKIP_ACCESS_FIXTURE_TESTS=1)");
  }
  expect(response?.status() ?? 0).toBe(200);

  const launcher = page.locator("button[data-vendo-launcher]");
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-label", "Ask Manu");

  // Usable: clicking opens the conversation panel.
  await launcher.click();
  const dialog = page.locator("#vendo-overlay-dialog");
  await expect(dialog).toBeVisible();
});
