/// <reference types="node" />
// The web freeze — the Liquid Glass design system is gated to native shells.
// This spec loads the viewer and the admin with NO shell attributes and
// snapshots the frozen selectors' computed styles. An ungated edit — a glass
// rule leaking to manorama.xyz, a frozen base declaration changed — fails
// here. It also asserts no backdrop-filter ancestor sits within 3 levels of
// a viewer or picker image (named exempt dims excluded by name).
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_OWNER, GALLERY_SLUG.

import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const DEV_ACCOUNT = "dbid:AAATESTowner1";

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

const test = base.extend({
  context: async ({ context }, use) => {
    // Origin-scoped cookie, never a context-wide header — and only when a
    // secret exists at all, so unauthenticated runs still execute.
    if (sessionSecret) {
      await context.addCookies([{ name: "manorama_session", value: await sessionJwt(), url: BASE }]);
    }
    await use(context);
  },
});

const BASE = process.env.GALLERY_URL ?? "http://localhost:8787";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "dev-dropbox";
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;

// The frozen base declarations (app/styles.css) — the values manorama.xyz and
// the homepage demo keep while shells restyle under the frost gate. For
// .admin-gallery-strip-frame the frozen computed value is `none`: the
// owner-approved single-row restyle (a later, equal-specificity rule) beats
// the blur(48px) declaration — the freeze snapshots what the web computes.
const FROZEN: Record<string, { backdrop: string; background?: string }> = {
  ".m-chrome-pill": { backdrop: "blur(12px)", background: "rgba(10, 10, 10, 0.62)" },
  ".curtain": { backdrop: "blur(28px) saturate(1.1)" },
  ".filmstrip-scrim": { backdrop: "blur(76px) saturate(0.16) brightness(0.42)", background: "rgba(10, 10, 10, 0.72)" },
  ".viewer-filmstrip": { backdrop: "blur(112px) saturate(0.16) brightness(0.44)", background: "rgba(10, 12, 12, 0.76)" },
  ".admin-gallery-strip-frame": { backdrop: "none" },
};

// Dims that may sit behind/near images by design — exempt from the ancestor
// check by name, never by depth.
const EXEMPT_DIMS = [".native-global-view", ".filmstrip-scrim", ".curtain", ".viewer-filmstrip"];

const shellAttributes = ["data-ios-shell", "data-android-shell", "data-macos-shell", "data-macos-glass", "data-ios-glass", "data-android-glass"];

test.beforeEach(async ({ request, page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await request.post(`${BASE}/.dev-seed/reset`);
});

const dismissCurtain = async (page: import("@playwright/test").Page) => {
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  await expect(curtain).toBeVisible();
  await curtain.click();
  await expect(curtain).toBeHidden();
};

test("no shell attribute leaks into a web document", async ({ page }) => {
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const attrs = await page.evaluate((names) => names.filter((n) => document.documentElement.hasAttribute(n)), shellAttributes);
  expect(attrs).toEqual([]);
});

test("viewer chrome and curtain keep their frozen paint", async ({ page }) => {
  // The curtain is the entry surface — read its backdrop while it is up;
  // the chrome pills mount once the curtain lifts.
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator(".curtain");
  await expect(curtain).toBeVisible();
  const curtainBackdrop = await curtain.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(curtainBackdrop).toBe(FROZEN[".curtain"].backdrop);

  await curtain.click();
  await expect(page.locator("[data-curtain]")).toBeHidden();
  const pill = page.locator("[data-chrome-bottom] .m-chrome-pill").first();
  await expect(pill).toBeAttached();
  const pillBackdrop = await pill.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(pillBackdrop).toBe(FROZEN[".m-chrome-pill"].backdrop);
  const pillBg = await pill.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(pillBg).toBe(FROZEN[".m-chrome-pill"].background);
});

test("picker surfaces keep their frozen paint", async ({ page }) => {
  await dismissCurtain(page);
  await page.keyboard.press("g");
  await page.waitForSelector(".viewer-filmstrip", { state: "attached", timeout: 10_000 });
  for (const selector of [".filmstrip-scrim", ".viewer-filmstrip"] as const) {
    const el = page.locator(selector).first();
    const backdrop = await el.evaluate((node) => getComputedStyle(node).backdropFilter);
    expect(backdrop).toBe(FROZEN[selector].backdrop);
    const bg = await el.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(bg).toBe(FROZEN[selector].background);
  }
});

test("admin strip frame keeps its frozen paint", async ({ page }) => {
  test.skip(!sessionSecret, "HOST_API_JWT_SECRET unavailable — admin session cannot be minted");
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const strip = page.locator(".admin-gallery-strip-frame").first();
  if ((await strip.count()) === 0) {
    test.info().annotations.push({ type: "note", description: "no strip gallery seeded — selector absent, nothing frozen to assert" });
    return;
  }
  const backdrop = await strip.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(backdrop).toBe(FROZEN[".admin-gallery-strip-frame"].backdrop);
});

test("no backdrop-filter ancestor within 3 levels of a viewer or picker image", async ({ page }) => {
  await dismissCurtain(page);
  await page.keyboard.press("g");
  await page.waitForSelector(".viewer-filmstrip", { state: "attached", timeout: 10_000 });
  const { count, offenders } = await page.evaluate((exempt) => {
    const hits: string[] = [];
    const imgs = document.querySelectorAll(".viewer-frame img, .viewer-filmstrip-item img");
    for (const img of imgs) {
      let node: Element | null = img.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (exempt.some((s) => node!.matches(s))) break;
        if (getComputedStyle(node).backdropFilter !== "none") {
          hits.push(`${img.getAttribute("src")?.slice(0, 40)} <- ${node.tagName}.${node.className} depth ${depth}`);
        }
      }
    }
    return { count: imgs.length, offenders: hits };
  }, EXEMPT_DIMS);
  // An empty match means the probe looked at nothing — that is a failure,
  // not a pass.
  expect(count).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
