/// <reference types="node" />
// "Add to Library" — a signed-in member's copy action in the Details chrome
// slot, and the visitor's Sign in pill that returns them to the gallery.
// The member is the seeded retention account (`retention-qa`, free tier,
// no galleries): adopting mints its first gallery, so the spec also proves
// the copy lands retained and openable.

import { test as base, expect } from "@playwright/test";
import { showChrome } from "./playwright-helpers";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const MEMBER_ACCOUNT = "dbid:AAATESTretention";

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
const sessionCookie = async (accountId: string): Promise<string> =>
  `manorama_session=${await new SignJWT({ sub: accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(sessionSecret))}`;

const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ Cookie: await sessionCookie(MEMBER_ACCOUNT) });
    await use(context);
  },
});

const BASE = process.env.GALLERY_URL ?? "http://localhost:8787";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "dev-dropbox";
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;

test.beforeEach(async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reset = await request.post(`${BASE}/.dev-seed/reset`);
  expect(reset.status(), "dev seed reset — is this `bun run dev`?").toBe(204);
});

const enter = async (page: import("@playwright/test").Page, url = GALLERY) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  if (await curtain.isVisible()) await curtain.click();
  await showChrome(page);
};

test.describe("the role pill in the Details slot", () => {
  test("a member adds the gallery to their own library and lands on the copy", async ({ page }) => {
    await enter(page);
    const pill = page.locator("[data-chrome-bottom]").getByRole("button", { name: "Add to Library" });
    await expect(pill).toBeVisible();
    await pill.click();
    // The copy lands under the member's slug — dev-dropbox's title slugs
    // to `kashmir` — and the member is its owner now: Details is theirs.
    await page.waitForURL(/\/retention-qa\/kashmir$/, { timeout: 15_000 });
    await enter(page, page.url());
    await expect(
      page.locator("[data-chrome-bottom]").getByRole("button", { name: "Details" }),
    ).toBeVisible();
    await expect(page.locator("[data-chrome-bottom]").getByRole("button", { name: "Add to Library" })).toHaveCount(0);
  });

  test("a second adopt resolves to the existing copy, not a duplicate", async ({ page }) => {
    await enter(page);
    const pill = page.locator("[data-chrome-bottom]").getByRole("button", { name: "Add to Library" });
    await pill.click();
    await page.waitForURL(/\/retention-qa\/kashmir$/, { timeout: 15_000 });
    // Back on the owner's original — adopting again lands on the same copy.
    await enter(page);
    await pill.click();
    await page.waitForURL(/\/retention-qa\/kashmir$/, { timeout: 15_000 });
  });
});

test.describe("the visitor door", () => {
  test.use({ context: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  } });

  test("a visitor sees Sign in that round-trips back to the gallery", async ({ page }) => {
    await enter(page);
    const pill = page.locator("[data-chrome-bottom]").getByRole("link", { name: "Sign in" });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("href", `/?next=${encodeURIComponent(`/${OWNER}/${SLUG}`)}`);
    await pill.click();
    await page.waitForURL(/\/\?next=/, { timeout: 10_000 });
    // Every provider button carries the return path into the OAuth flow —
    // after sign-in the member lands back on the gallery, adopt-ready.
    const provider = page.locator(".signin-pill").first();
    await expect(provider).toHaveAttribute("href", new RegExp(`^/auth/\\w+\\?next=${encodeURIComponent(`/${OWNER}/${SLUG}`)}`));
    await expect(page.locator("[data-chrome-bottom]").getByRole("button", { name: "Add to Library" })).toHaveCount(0);
  });
});

