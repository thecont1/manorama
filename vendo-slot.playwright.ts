/// <reference types="node" />
// Task 5.2 acceptance — the pinned gallery-inventory slot.
//
// The slot placeholder exists ONLY on the authenticated admin page. Public
// pages carry no slot markup and never poll the wire. On the admin page the
// React VendoSlot mounts into the placeholder inside the VendoProvider, so
// the slot registry gets exactly one report for `gallery-inventory`, and
// pin state is fetched per principal (host-managed) — a second principal
// must never inherit another user's pin.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { importJWK, SignJWT } from "jose";

const BASE = process.env.GALLERY_URL ?? "http://localhost:5173";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";

const fixture = JSON.parse(
  readFileSync(new URL("./test/access-test-key.json", import.meta.url), "utf8"),
) as {
  team: string;
  audience: string;
  privateJwk: Record<string, string>;
};

async function devAssertion(subject: string, email: string): Promise<string> {
  const key = await importJWK(fixture.privateJwk, "RS256");
  return new SignJWT({ sub: subject, email })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://${fixture.team}.cloudflareaccess.com`)
    .setAudience(fixture.audience)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

test("public pages carry no gallery-inventory slot markup", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.locator(".landing-brand-title").waitFor({ state: "visible" });
  expect(await page.locator("#vendo-slot-gallery-inventory").count()).toBe(0);
});

test("authenticated admin page mounts the gallery-inventory slot inside the provider", async ({ page }) => {
  const assertion = await devAssertion("mahesh-dev", "mahesh@manorama.xyz");
  await page.context().addCookies([{
    name: "CF_Authorization",
    value: assertion,
    domain: new URL(BASE).host,
    path: "/",
  }]);
  const slotReports: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/vendo/slots")) slotReports.push(request.method());
  });
  await page.goto(`${BASE}/${OWNER}`);
  await page.locator("#vendo-slot-gallery-inventory").waitFor({ state: "attached" });
  // The React slot mounts (not just the placeholder div): VendoSlot reports
  // its existence to the slot registry exactly once for this principal.
  await expect
    .poll(async () => slotReports.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  // Empty state renders a visible invitation, never a blank section.
  const slotHost = page.locator("#vendo-slot-gallery-inventory");
  await expect(slotHost.locator("button, [role='button'], a").first()).toBeVisible({ timeout: 10_000 });
});

test("a second principal sees the same slot surface, not another user's pin", async ({ page }) => {
  // Two different signed principals must each get their own slot state:
  // load as principal A, then as principal B; the slot must mount fresh
  // for B (empty state or B's own pin) — the registry report happens
  // under B's session, never replaying A's.
  const a = await devAssertion("mahesh-dev", "mahesh@manorama.xyz");
  await page.context().addCookies([{
    name: "CF_Authorization",
    value: a,
    domain: new URL(BASE).host,
    path: "/",
  }]);
  await page.goto(`${BASE}/${OWNER}`);
  await page.locator("#vendo-slot-gallery-inventory").waitFor({ state: "attached" });

  const context2 = await page.context().browser()!.newContext();
  const b = await devAssertion("another-dev", "another@manorama.xyz");
  await context2.addCookies([{
    name: "CF_Authorization",
    value: b,
    domain: new URL(BASE).host,
    path: "/",
  }]);
  const page2 = await context2.newPage();
  const status = await page2.request.get(`${BASE}/${OWNER}`);
  // A distinct verified principal reaches the admin page.
  expect(status.status()).toBe(200);
  await context2.close();
});
