/// <reference types="node" />
// The frost side of the gate — the counterpart to glass-freeze. With a shell
// attribute present, the G2a overrides repaint the viewer chrome and sheets
// with Tier-B glass values; the freeze spec proves the same document stays
// untouched when no attribute is set. Asserts the pill, sheet and scrim
// recipes, that the popover's ghost scrim stays transparent, and that
// prefers-contrast drops the repainted surfaces to the Tier-0 solid.
//
// The dev server serves the web bundle, which intentionally excludes
// glass.css — this spec injects the real stylesheet file (the same one the
// native/desktop bundles import) plus the document-start attribute a shell
// stamps. Bundle inclusion/exclusion itself is covered by the freeze spec
// and the dist checks.
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_OWNER, GALLERY_SLUG.

import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const DEV_ACCOUNT = "dbid:AAATESTowner1";
const GLASS_CSS = new URL("../app/styles/glass.css", import.meta.url).pathname;

const devEnv = (() => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    // .env.local exists only in a dev checkout.
  }
  return env;
})();

const sessionSecret = process.env.HOST_API_JWT_SECRET ?? devEnv.HOST_API_JWT_SECRET ?? "";

const sessionJwt = async (accountId = DEV_ACCOUNT): Promise<string> =>
  new SignJWT({ sub: accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(sessionSecret));

const BASE = process.env.GALLERY_URL ?? "http://localhost:8787";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "dev-dropbox";
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;

const test = base.extend({
  context: async ({ context }, use) => {
    if (sessionSecret) {
      await context.addCookies([{ name: "manorama_session", value: await sessionJwt(), url: BASE }]);
    }
    await use(context);
  },
});

const paint = (el: HTMLElement) => ({
  backdrop: getComputedStyle(el).backdropFilter,
  background: getComputedStyle(el).backgroundColor,
});

test.beforeEach(async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await request.post(`${BASE}/.dev-seed/reset`);
});

// Enter the gallery under the iOS shell marker — the attribute goes in the
// moment <html> is created (init scripts run before documentElement exists,
// so an observer catches its insertion — SceneDelegate's document-start
// timing). The real glass.css joins the cascade as the last sheet, exactly
// where the native bundle's import puts it. The curtain is dismissed so the
// chrome mounts.
const enterWithIosShell = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      document.documentElement.setAttribute("data-ios-shell", "");
      observer.disconnect();
    }).observe(document, { childList: true });
  });
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ path: GLASS_CSS });
  const curtain = page.locator("[data-curtain]");
  await expect(curtain).toBeVisible();
  await curtain.click();
  await expect(curtain).toBeHidden();
};

test("viewer chrome frosts under the shell gate", async ({ page }) => {
  await enterWithIosShell(page);
  const pill = page.locator("[data-chrome-bottom] .m-chrome-pill").first();
  await expect(pill).toBeAttached();
  expect(await pill.evaluate(paint)).toEqual({
    backdrop: "blur(16px) saturate(1.4)",
    background: "rgba(18, 18, 24, 0.3)",
  });
});

test("sheet frosts and the scrim dims under the gate", async ({ page }) => {
  await enterWithIosShell(page);
  await page.keyboard.press("i");
  const sheet = page.locator(".gallery-shell .m-sheet");
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate(paint)).toEqual({
    backdrop: "blur(24px) saturate(1.4)",
    background: "rgba(18, 18, 24, 0.4)",
  });
  const scrim = page.locator(".gallery-shell .m-scrim").first();
  expect(await scrim.evaluate(paint)).toEqual({
    backdrop: "blur(4px)",
    background: "rgba(0, 0, 0, 0.45)",
  });
});

test("the popover's ghost scrim stays transparent", async ({ page }) => {
  await enterWithIosShell(page);
  await page.getByRole("button", { name: "Gallery Settings" }).click();
  const sheet = page.locator(".gallery-shell .m-sheet");
  await expect(sheet).toBeVisible();
  const ghost = page.locator(".gallery-shell .m-scrim--ghost");
  expect(await ghost.evaluate(paint)).toEqual({
    backdrop: "none",
    background: "rgba(0, 0, 0, 0)",
  });
});

test("prefers-contrast drops the repainted surfaces to the Tier-0 solid", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await enterWithIosShell(page);
  const pill = page.locator("[data-chrome-bottom] .m-chrome-pill").first();
  await expect(pill).toBeAttached();
  expect(await pill.evaluate(paint)).toEqual({
    backdrop: "none",
    background: "rgba(16, 16, 18, 0.94)",
  });
  await page.keyboard.press("i");
  const sheet = page.locator(".gallery-shell .m-sheet");
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate(paint)).toEqual({
    backdrop: "none",
    background: "rgba(16, 16, 18, 0.94)",
  });
});
