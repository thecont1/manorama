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
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";

const DEV_ACCOUNT = "dbid:AAATESTowner1";
const GLASS_CSS = fileURLToPath(new URL("../app/styles/glass.css", import.meta.url));

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

// Enter the gallery under a shell marker — the attribute goes in the
// moment <html> is created (init scripts run before documentElement exists,
// so an observer catches its insertion — SceneDelegate's document-start
// timing). The real glass.css joins the cascade as the last sheet, exactly
// where the native bundle's import puts it. The curtain is dismissed so the
// chrome mounts. `attrs` stamps extra document attributes the same way —
// data-reduced-transparency is SceneDelegate's own stamp.
const enterWithShell = async (page: import("@playwright/test").Page, attrs: Record<string, string>) => {
  await page.addInitScript((extraAttrs) => {
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      for (const [name, value] of Object.entries(extraAttrs)) {
        document.documentElement.setAttribute(name, value);
      }
      observer.disconnect();
    }).observe(document, { childList: true });
  }, attrs);
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ path: GLASS_CSS });
  const curtain = page.locator("[data-curtain]");
  await expect(curtain).toBeVisible();
  await curtain.click();
  await expect(curtain).toBeHidden();
};

const enterWithIosShell = (page: import("@playwright/test").Page, attrs: Record<string, string> = {}) =>
  enterWithShell(page, { "data-ios-shell": "", ...attrs });

const enterWithMacosShell = (page: import("@playwright/test").Page, attrs: Record<string, string> = {}) =>
  enterWithShell(page, { "data-macos-shell": "1", ...attrs });

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

type Rgba = [number, number, number, number];
const rgba = (css: string): Rgba => {
  if (/^#[\da-f]{6}$/i.test(css)) {
    return [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16), 1];
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(css);
  if (!match) throw new Error(`Unsupported computed colour: ${css}`);
  const [r, g, b, a = 1] = match[1].split(/[,\s]+/).map(Number);
  return [r, g, b, a];
};
const composite = (foreground: Rgba, background: Rgba): Rgba => [
  foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
  foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
  foreground[2] * foreground[3] + background[2] * (1 - foreground[3]),
  1,
];
const luminance = (colour: Rgba) => {
  const linear = colour.slice(0, 3).map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

// Sample real rendered text and its inherited tokens, not a hypothetical white
// label. Uniform white is the worst bright backdrop: blur cannot darken it.
// Ignoring Info's dim scrim is conservative and also covers the ghost popover.
const assertMacosSheetContrast = async (sheet: import("@playwright/test").Locator, info: boolean) => {
  const samples = info
    ? [{ selector: ".m-sheet-title", token: "--m-ink" }, { selector: ".m-info-row dt", token: "--m-secondary" }, { selector: ".m-quiet-copy", token: "" }]
    : [{ selector: ".m-sheet-label", token: "--m-ink" }, { selector: ".m-actiongroup-label", token: "--m-meta" }, { selector: ".m-sheet-hint", token: "" }];
  const readings = await sheet.evaluate((panel, selectors) => {
    const style = getComputedStyle(panel);
    return {
      background: style.backgroundColor,
      text: selectors.map(({ selector, token }) => {
        const element = panel.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing contrast sample ${selector}`);
        const textStyle = getComputedStyle(element);
        return { selector, colour: textStyle.color, token: token ? textStyle.getPropertyValue(token).trim() : "" };
      }),
    };
  }, samples);
  const background = composite(rgba(readings.background), [255, 255, 255, 1]);
  for (const sample of readings.text) {
    const ink = rgba(sample.colour);
    if (sample.token) expect(ink, sample.selector).toEqual(rgba(sample.token));
    const foreground = composite(ink, background);
    const ratio = (Math.max(luminance(foreground), luminance(background)) + 0.05)
      / (Math.min(luminance(foreground), luminance(background)) + 0.05);
    expect.soft(ratio, `${sample.selector} over white: ${sample.colour} on ${readings.background}`).toBeGreaterThanOrEqual(4.5);
  }
};

test("macOS Settings and Info retain readable frost over a bright photograph", async ({ page }) => {
  await enterWithMacosShell(page);
  await page.getByRole("button", { name: "Gallery Settings", exact: true }).click();
  let sheet = page.locator(".gallery-shell .m-sheet");
  await expect(sheet).toBeVisible();
  // This must be sampled on the sheet: its nested .m-dark wrapper can
  // override a token that looked correct when read on .gallery-shell.
  expect.soft(await sheet.evaluate(paint)).toEqual({
    backdrop: "blur(24px) saturate(1.4)",
    background: "rgba(18, 18, 24, 0.9)",
  });
  await assertMacosSheetContrast(sheet, false);
  expect(await page.locator(".m-scrim--ghost").evaluate(paint)).toEqual({
    backdrop: "none", background: "rgba(0, 0, 0, 0)",
  });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.keyboard.press("i");
  sheet = page.locator(".gallery-shell .m-sheet");
  await expect(sheet).toBeVisible();
  expect.soft(await sheet.evaluate(paint)).toEqual({
    backdrop: "blur(24px) saturate(1.4)",
    background: "rgba(18, 18, 24, 0.9)",
  });
  await assertMacosSheetContrast(sheet, true);
});

for (const accessibility of ["increased contrast", "reduced transparency"] as const) {
  test(`macOS ${accessibility} replaces viewer frost with the solid fallback`, async ({ page }) => {
    if (accessibility === "increased contrast") await page.emulateMedia({ contrast: "more" });
    await enterWithMacosShell(page, accessibility === "reduced transparency" ? { "data-reduced-transparency": "" } : {});
    const solid = { backdrop: "none", background: "rgba(16, 16, 18, 0.94)" };
    const pill = page.locator("[data-chrome-bottom] .m-chrome-pill").first();
    expect(await pill.evaluate(paint)).toEqual(solid);
    await page.getByRole("button", { name: "Gallery Settings", exact: true }).click();
    const sheet = page.locator(".gallery-shell .m-sheet");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(paint)).toEqual(solid);
    await assertMacosSheetContrast(sheet, false);
    expect(await page.locator(".m-scrim--ghost").evaluate(paint)).toEqual({
      backdrop: "none", background: "rgba(0, 0, 0, 0)",
    });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.keyboard.press("i");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(paint)).toEqual(solid);
    await assertMacosSheetContrast(sheet, true);
    expect(await page.locator(".gallery-shell .m-scrim:not(.m-scrim--ghost)").evaluate(paint)).toEqual({
      backdrop: "none", background: "rgba(0, 0, 0, 0.45)",
    });
  });
}

test("a shell-stamped data-reduced-transparency drops to the same Tier-0 solid", async ({ page }) => {
  // The media query cannot fire for a shell-side accessibility toggle —
  // SceneDelegate stamps the attribute instead, and it must hit the same
  // Tier-0 declarations prefers-reduced-transparency does.
  await enterWithIosShell(page, { "data-reduced-transparency": "" });
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
