/// <reference types="node" />
// Focused Vendo surface spec — Task 1.4 acceptance.
//
// The public gallery must stay free of the agent surface (no launcher, no
// wire polling); the authenticated owner admin page mounts it. The anonymous
// admin page is refused.
//
// Run against the dev server configured with the committed dev Access
// fixture (.env.local sets CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD/CF_ACCESS_JWKS
// from test/access-test-jwks.json):
//
//   bun run dev                        # http://localhost:5173
//   bunx playwright test vendo-surface
//
// Against a server WITHOUT the fixture (e.g. production behind real
// Cloudflare Access) the authenticated test skips; the public-surface
// guarantees still run.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { importJWK, SignJWT } from "jose";

const BASE = process.env.GALLERY_URL ?? "http://localhost:5173";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "italy-2018";

const fixture = JSON.parse(
  readFileSync(new URL("./test/access-test-key.json", import.meta.url), "utf8"),
) as {
  team: string;
  audience: string;
  privateJwk: Record<string, string>;
};

async function devAssertion(): Promise<string> {
  const key = await importJWK(fixture.privateJwk, "RS256");
  return new SignJWT({ sub: "mahesh-dev", email: "mahesh@manorama.xyz" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://${fixture.team}.cloudflareaccess.com`)
    .setAudience(fixture.audience)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

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
  await page.locator(".landing-brand-title").waitFor({ state: "visible" });
  expect(await page.locator("#vendo-root").count()).toBe(0);
  expect(await page.locator("[data-vendo-launcher]").count()).toBe(0);
});

test("anonymous admin request is refused and renders no surface", async ({ page, request }) => {
  const response = await request.get(`${BASE}/${OWNER}`);
  expect(response.status()).toBe(401);

  await page.goto(`${BASE}/${OWNER}`);
  await page.waitForLoadState("networkidle");
  expect(await page.locator("#vendo-root").count()).toBe(0);
  expect(await page.locator("button[data-vendo-launcher]").count()).toBe(0);
});

test("authenticated admin page shows the Ask Manu launcher and opens the panel", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": await devAssertion() });
  const response = await page.goto(`${BASE}/${OWNER}`);
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
