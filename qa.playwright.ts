/// <reference types="node" />
// manorama acceptance spec — the gallery-qa skill, executable.
// Deps: npm i -D @playwright/test @axe-core/playwright
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_OWNER, GALLERY_SLUG
// Selector conventions expected in the app: [data-curtain], [data-stage], [data-nav-arrow].
// The stage carries no info button: `I` opens the in-gallery sheet, while
// `⇧I` deep-links into the standalone C2PA viewer (falling back to the
// in-gallery sheet for sources the viewer can't fetch).
// The info sheet's accessible name is its title — "Photograph N of M".
//
// The admin surface requires a Manorama session — Dropbox sign-in mints an
// HS256 `manorama_session` cookie (app/lib/session.ts). Every context
// and request here carries a dev-minted cookie for the seeded test owner:
// `bun run dev` seeds `dbid:AAATESTowner1` as owner slug `thecontrarian` via
// the manorama-dev-seed vite plugin. The cookie is signed with the dev
// server's own HOST_API_JWT_SECRET (read from .env.local), so authentication
// exercises the production code path — a server without the seed simply has
// no such user and refuses the admin tests loudly.

import { test as base, expect } from "@playwright/test";
import { showChrome } from "./playwright-helpers";
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { SignJWT } from "jose";

type PlaywrightApi = PlaywrightWorkerArgs["playwright"];

const DEV_ACCOUNT = "dbid:AAATESTowner1";

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

const sessionCookie = async (accountId = DEV_ACCOUNT): Promise<string> =>
  `manorama_session=${await new SignJWT({ sub: accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(sessionSecret))}`;

const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ Cookie: await sessionCookie() });
    await use(context);
  },
  request: async ({ playwright }, use) => {
    const request = await playwright.request.newContext({
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    await use(request);
    await request.dispose();
  },
});

const BASE = process.env.GALLERY_URL ?? "http://localhost:8787";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";
const SLUG = process.env.GALLERY_SLUG ?? "dev-dropbox";
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;
const CONTROL_NAME = /^(photograph|video) \d+ of \d+$/i;

const viewports = [
  { name: "phone", width: 375, height: 812, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, hasTouch: false },
  { name: "wide", width: 2560, height: 1440, hasTouch: false },
];

async function dismissCurtain(
  page: import("@playwright/test").Page,
  url = GALLERY,
) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  await expect(curtain).toBeVisible();
  await curtain.click();
  await expect(curtain).toBeHidden();
}

// The admin specs mutate the seeded in-memory repositories (slug edits,
// reorders, creates). The dev seed plugin's reset seam restores canonical
// state so a case's outcome never depends on what ran before it.
test.beforeEach(async ({ request, page }) => {
  // Reduced motion keeps animated chrome click-stable for every spec.
  // RULE: a spec that asserts an animation mid-flight (curtain fading,
  // the logo bob, sweeps) must re-emulate no-preference first — under
  // reduce the transitions collapse and intermediate states die fast.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reset = await request.post(`${BASE}/.dev-seed/reset`);
  expect(reset.status(), "dev seed reset — is this `bun run dev`?").toBe(204);
});

async function imageCount(page: import("@playwright/test").Page) {
  return page.locator("[data-track] [data-index]").count();
}

async function ensureStripSettled(page: import("@playwright/test").Page) {
  await expect
    .poll(async () => {
      const a = await page.evaluate(() => document.querySelector("[data-track]")!.getBoundingClientRect().left);
      await new Promise((r) => setTimeout(r, 160));
      const b = await page.evaluate(() => document.querySelector("[data-track]")!.getBoundingClientRect().left);
      return a === b;
    }, { timeout: 8000 })
    .toBe(true);
}

/** Opens the in-gallery info sheet via its I shortcut. */
async function openInfoDialog(page: import("@playwright/test").Page) {
  await page.keyboard.press("i");
}

async function ensureNavArrows(page: import("@playwright/test").Page) {
  if ((await page.locator("[data-nav-arrow]").count()) === 0) {
    await showChrome(page);
    await page
      .getByRole("button", { name: "Display", exact: true })
      .click();
    await page
      .getByRole("switch", { name: /^arrows$/i })
      .click();
    // The sheet stays open on a change — dismiss it before the stage is
    // needed, or the scrim eats the next click. Waiting for the scrim to
    // actually clear matters under load: Escape can land before the
    // sheet finishes mounting.
    await page.keyboard.press("Escape");
    await expect(page.locator(".m-scrim--open")).toHaveCount(0);
  }
}

// Arrow-key strip advances dock the next frame's left edge, and the
// reported index only updates once the >=1.1s settle glide completes.
// On viewports narrower than a frame, one press is a mid-frame chunk —
// keep pressing (bounded) until the docked frame actually changes.
async function advanceToNextImage(page: import("@playwright/test").Page) {
  const docked = () =>
    page.locator("[aria-current='true']").getAttribute("data-index");
  const before = await docked();
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("ArrowRight");
    const moved = await expect
      .poll(docked, { timeout: 2600 })
      .not.toBe(before)
      .then(() => true)
      .catch(() => false);
    if (moved) return;
  }
}

// Strip navigations glide with a distance-scaled ease (>=1.1s): a track
// position measured mid-flight is meaningless, so wait until translate3d
// holds still before asserting on it.
async function waitForTrackSettled(page: import("@playwright/test").Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const track = document.querySelector("[data-track]")!;
              const first = track.getBoundingClientRect().left;
              window.setTimeout(
                () =>
                  resolve(track.getBoundingClientRect().left === first),
                160,
              );
            }),
        ),
      { timeout: 9000 },
    )
    .toBe(true);
}

test("curtain uses larger brand type without entry labels", async ({
  page,
}) => {
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-curtain-title]")).toBeVisible();
  // Real albums may carry no caption — the element renders empty and
  // zero-height, so the contract is presence + typeface, not visibility.
  await expect(page.locator("[data-curtain-caption]")).toBeAttached();
  await expect(page.locator(".curtain-kicker")).toHaveCount(0);
  await expect(page.locator(".curtain-prompt")).toHaveCount(0);
  await expect(page.getByText("a single album")).toHaveCount(0);
  await expect(
    page.getByText(/tap, click or press enter to enter/i),
  ).toHaveCount(0);
  await expect(page.locator("[data-curtain-title]")).toHaveCSS(
    "font-family",
    /Bricolate Grotesque/i,
  );
  await expect(page.locator("[data-curtain-caption]")).toHaveCSS(
    "font-family",
    /Bricolate Grotesque/i,
  );
});

test("curtain is a frosted veil, not an opaque page", async ({ page }) => {
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  // The first photograph sits behind a 28px frost plus scrim — a veil
  // the photograph reads through, never a solid page in front of it.
  await expect(curtain).toHaveCSS("backdrop-filter", /blur\(28px\)/);
  // Reduced motion (the suite default) is a plain 0.2s fade.
  await expect(curtain).toHaveCSS("transition-duration", /0\.2s/);
});

test("curtain dissolves in place — nothing moves — before it hides", async ({
  page,
}) => {
  // The dissolve itself is asserted — under the suite-wide reduced
  // motion emulation the fade is 0.2s and `fading` is hard to catch,
  // so run it with motion on.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  await curtain.click();
  await expect(curtain).toHaveClass(/fading/);
  // The veil fades where it stands — no lift, no translate, ever.
  await expect(curtain).toHaveCSS("transform", "none");
  await expect(curtain).toBeHidden();
});

test("curtain words fade first while the frost keeps dissolving", async ({
  page,
}) => {
  // The 0.35s/1.1s split is asserted — motion required (see above).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  await curtain.click();
  // Words take 0.35s; the veil takes 1.1s — once the copy is gone the
  // frost must still be mid-flight, then the whole curtain hides.
  await expect(curtain.locator(".curtain-content")).toHaveCSS("opacity", "0");
  await expect(curtain).toHaveClass(/fading/);
  await expect(curtain).not.toHaveAttribute("hidden");
  await expect(curtain).toBeHidden();
});

test("curtain accepts an upward swipe before it dissolves", async ({
  page,
}) => {
  // Fading class asserted — motion required.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
  const curtain = page.locator("[data-curtain]");
  await page.mouse.move(300, 520);
  await page.mouse.down();
  await page.mouse.move(300, 360, { steps: 4 });
  await page.mouse.up();
  await expect(curtain).toHaveClass(/fading/);
  await expect(curtain).toBeHidden();
});

for (const vp of viewports) {
  test.describe(vp.name, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.hasTouch,
    });

    test("the G selector shows every photograph and jumps on click", async ({ page }) => {
      await dismissCurtain(page)
      const count = await imageCount(page)
      await page.keyboard.press("g")
      const strip = page.locator(".viewer-filmstrip")
      await expect(strip).toBeVisible()
      const box = await strip.boundingBox()
      expect(box).not.toBeNull()
      expect(Math.abs((box!.y + box!.height / 2) - vp.height / 2)).toBeLessThan(3)
      await expect(strip.locator("[data-grid-item]")).toHaveCount(count)
      await expect(strip.locator("[aria-current='true']")).toHaveCount(1)
      await strip.locator("[data-grid-item]").nth(Math.min(2, count - 1)).click()
      await expect(strip).toBeHidden()
      await ensureStripSettled(page)
      await expect(page.locator("[data-track] [aria-current='true']")).toHaveAttribute("data-index", String(Math.min(2, count - 1) + 1))
      // A stray Enter after the selector closes must not step the gallery
      // from the restored focus on the next-arrow (or any previous focus).
      await page.keyboard.press("Enter")
      await expect(strip).toBeVisible()
      await expect(page.locator("[data-track] [aria-current='true']")).toHaveAttribute("data-index", String(Math.min(2, count - 1) + 1))
    })

    test("drag-scrolling the selector doesn't navigate; Escape and scrim dismiss", async ({ page }) => {
      await dismissCurtain(page)
      const before = await page.locator("[data-track] [aria-current='true']").getAttribute("data-index")
      await page.keyboard.press("g")
      const frame = page.locator(".viewer-filmstrip-frame")
      const frameBox = await frame.boundingBox()
      expect(frameBox).not.toBeNull()
      // The picker is a wrapping matrix — on wide viewports thirty small
      // thumbs can fit without overflowing, which would leave nothing to
      // scroll. Force tall rows so the frame genuinely overflows.
      await frame.locator(".viewer-filmstrip-item").evaluateAll((items) =>
        items.forEach((item) => {
          (item as HTMLElement).style.height = "60vh";
        }),
      );
      const initial = await frame.evaluate((node) => node.scrollTop)
      await page.mouse.move(frameBox!.x + frameBox!.width / 2, frameBox!.y + frameBox!.height * .7)
      await page.mouse.down()
      await page.mouse.move(frameBox!.x + frameBox!.width / 2, frameBox!.y + frameBox!.height * .2, { steps: 5 })
      await page.mouse.up()
      await expect.poll(() => frame.evaluate((node) => node.scrollTop)).not.toBe(initial)
      await expect(frame).toBeVisible()
      await expect(page.locator("[data-track] [aria-current='true']")).toHaveAttribute("data-index", before!)
      await page.keyboard.press("Escape")
      await expect(frame).toBeHidden()
      await page.keyboard.press("g")
      await expect(frame).toBeVisible()
      // The full-screen filmstrip covers the scrim edge to edge, so a real
      // pointer can never reach it; dispatch the event to prove the scrim's
      // dismissal wiring still works.
      await page.locator(".filmstrip-scrim").dispatchEvent("pointerdown", { bubbles: true })
      await expect(frame).toBeHidden()
    })

    test("the selector pink box follows arrows and hover; Enter commits", async ({ page }) => {
      await dismissCurtain(page)
      const count = await imageCount(page)
      await page.keyboard.press("g")
      const strip = page.locator(".viewer-filmstrip")
      const active = strip.locator("[data-grid-active]")
      const startIndex = await active.evaluate((item) => {
        const items = [...item.parentElement!.querySelectorAll<HTMLElement>('[data-grid-item]')]
        return items.indexOf(item as HTMLElement)
      })
      await expect(active).toHaveCSS("box-shadow", /rgb\(252, 15, 192\)/)
      await page.keyboard.press("ArrowRight")
      await page.keyboard.press("ArrowRight")
      const arrowIndex = (startIndex + 2) % count
      await expect(strip.locator("[data-grid-item]").nth(arrowIndex)).toHaveAttribute("data-grid-active", "true")
      await expect(strip.locator("[data-grid-item]").nth(arrowIndex)).toBeFocused()
      const hoverIndex = (arrowIndex + 2) % count
      await strip.locator("[data-grid-item]").nth(hoverIndex).hover()
      await expect(strip.locator("[data-grid-item]").nth(hoverIndex)).toHaveAttribute("data-grid-active", "true")
      await expect(page.locator("[data-track] [aria-current='true']")).toHaveAttribute("data-index", String(startIndex + 1))
      await page.keyboard.press("Enter")
      await expect(strip).toHaveClass(/is-closing/)
      await expect(strip).toBeHidden()
      await expect(page.locator("[data-track] [aria-current='true']")).toHaveAttribute("data-index", String(hoverIndex + 1))
    })

    test("exactly one visible control during viewing", async ({ page }) => {
      await dismissCurtain(page);
      // The chrome's 3s window must lapse before the rest state counts —
      // wait for the bars to actually report hidden, not a fixed sleep.
      await expect(page.locator("[data-chrome-bottom]")).not.toHaveClass(/is-visible/, { timeout: 8000 });
      // The 200ms fade must finish too — hidden pills still carry opacity.
      await page.waitForTimeout(300);
      const audit = await page.evaluate(() => {
        const stage = document.querySelector("[data-stage]")!;
        const rect = stage.getBoundingClientRect();
        const visible = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const overStage =
              r.left < rect.right &&
              r.right > rect.left &&
              r.top < rect.bottom &&
              r.bottom > rect.top;
            return (
              overStage &&
              !el.closest("[data-stage]") &&
              el.matches('button, [role="button"], a') &&
              r.width > 0 &&
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              parseFloat(s.opacity) > 0.05
            );
          })
          .map((el) => el.getAttribute("aria-label") ?? el.tagName);
        return { visible, arrowBar: stage.classList.contains("has-arrow-bar") };
      });
      // Rule 1: nothing floats on the photograph. With arrows on, the
      // controls live in their own bar beneath the stage — zero overlap;
      // with them off, only the position count rides the corner.
      expect(audit.visible).toHaveLength(audit.arrowBar ? 0 : 1);
      if (!audit.arrowBar) expect(audit.visible[0]).toMatch(/^Photograph 1 of \d+/);
      await expect(page.locator(".stage-seq")).toBeVisible();
      await expect(page.locator(".stage-seq .stage-seq-num")).toHaveText("1");
    });

    test("chrome bars dock top and bottom and open their panels", async ({
      page,
    }) => {
      await dismissCurtain(page);
      await showChrome(page);
      const stage = await page
        .locator("[data-stage]")
        .evaluate((el) => el.getBoundingClientRect());
      const top = await page
        .locator("[data-chrome-top]")
        .evaluate((el) => el.getBoundingClientRect());
      const bottom = await page
        .locator("[data-chrome-bottom]")
        .evaluate((el) => el.getBoundingClientRect());
      // Top bar inside the stage's top edge; bottom row inside the bottom.
      expect(top.top).toBeGreaterThanOrEqual(stage.top - 1);
      expect(top.top).toBeLessThan(stage.top + 40);
      expect(bottom.bottom).toBeLessThanOrEqual(stage.bottom + 1);
      expect(bottom.bottom).toBeGreaterThan(stage.bottom - 60);
      // The owner session renders Library and the shared Details entry.
      await expect(
        page.locator("[data-chrome-library]"),
      ).toHaveAttribute("href", /\//);
      await expect(
        page.locator("[data-chrome-bottom]").getByRole("button", { name: "Details" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Display" }),
      ).toBeVisible();
      // Vertical scroll keeps the bars working in their docks.
      await page.getByRole("radio", { name: "Scroll" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await page.keyboard.press("Escape");
      await openInfoDialog(page);
      const info = page.getByRole("dialog", { name: CONTROL_NAME });
      await expect(info).toBeVisible();
      await expect(info.locator("[data-c2pa-panel]")).toBeInViewport();
    });

    test("controls surface when the curtain clears, then tuck away", async ({
      page,
    }) => {
      await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
      const bottom = page.locator("[data-chrome-bottom]");
      // No controls while the veil is up — only the curtain.
      await expect(bottom).not.toHaveClass(/is-visible/);
      await page.locator("[data-curtain]").click();
      await expect(page.locator("[data-curtain]")).toBeHidden();
      // The bars reveal themselves once the photograph is clear — the
      // visitor is not asked to discover the tap.
      await expect(bottom).toHaveClass(/is-visible/);
      await expect(page.locator("[data-chrome-top]")).toHaveClass(
        /is-visible/,
      );
      // Three idle seconds later they tuck away again.
      await expect(bottom).not.toHaveClass(/is-visible/, {
        timeout: 8000,
      });
      // Hidden bars are inert — nothing inside can take focus or a tap.
      await expect(bottom).toHaveAttribute("inert", "");
      await expect(bottom).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator("[data-chrome-top]")).toHaveAttribute(
        "inert",
        "",
      );
    });

    test("tap toggles chrome while wheel and drag never summon it", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const bottom = page.locator("[data-chrome-bottom]");
      const stage = page.locator("[data-stage]");
      await expect(bottom).not.toHaveClass(/is-visible/, { timeout: 8000 });
      const box = (await stage.boundingBox())!;
      // A wheel gesture moves photographs, not chrome.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 320);
      await page.waitForTimeout(300);
      await expect(bottom).not.toHaveClass(/is-visible/);
      // A tap toggles it on, a second tap toggles it off.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(bottom).toHaveClass(/is-visible/);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(bottom).not.toHaveClass(/is-visible/);
      // And a drag is travel, not a tap — it must not leave the bars on.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      await expect(bottom).not.toHaveClass(/is-visible/);
    });

    test("the skip button summons controls and focus holds them open", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const bottom = page.locator("[data-chrome-bottom]");
      await expect(bottom).not.toHaveClass(/is-visible/, { timeout: 8000 });
      // Tab is itself a reveal cue — the bars answer the keyboard before
      // any tab stop is reached.
      await page.keyboard.press("Tab");
      await expect(bottom).toHaveClass(/is-visible/);
      // Any other key sends them away again.
      await page.keyboard.press("Escape");
      await expect(bottom).not.toHaveClass(/is-visible/);
      // The skip button is the tab-order entry point: off-viewport until
      // focused, so activation is the DOM click a keyboard Enter sends.
      await page
        .getByRole("button", { name: "Show controls" })
        .dispatchEvent("click");
      await expect(bottom).toHaveClass(/is-visible/);
      await expect(
        page.getByRole("button", { name: "Display", exact: true }),
      ).toBeFocused();
      // Focus inside the chrome pauses the auto-hide — past three
      // seconds the bars are still up while a pill is focused.
      await page.waitForTimeout(3400);
      await expect(bottom).toHaveClass(/is-visible/);
    });

    test("a signed-out visitor gets neither Library nor Details", async ({
      browser,
    }) => {
      // No session cookie — the public-link visitor sees Display, Info
      // and the position count, and nothing that exits or edits.
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.hasTouch,
      });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
      await page.locator("[data-curtain]").click();
      const bottom = page.locator("[data-chrome-bottom]");
      await expect(bottom).toHaveClass(/is-visible/);
      await expect(page.locator("[data-chrome-library]")).toHaveCount(0);
      await expect(
        bottom.getByRole("button", { name: "Details" }),
      ).toHaveCount(0);
      await expect(
        bottom.getByRole("button", { name: "Display", exact: true }),
      ).toBeVisible();
      await expect(
        bottom.getByRole("button", { name: "Info", exact: true }),
      ).toBeVisible();
      // Position still opens the picker; no Share control exists.
      await expect(
        page.locator("[data-chrome-position]"),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^share$/i }),
      ).toHaveCount(0);
      await context.close();
    });

    test("keyboard navigation preserves a clean URL and refresh returns to the first image", async ({
      page,
    }) => {
      // `load` waits on every live provider image the viewer fetches, and
      // upstream latency is unbounded — a single slow original stalls the
      // event past the test timeout even though the page is fully usable
      // (verified: zero pending requests at stall). Sync on
      // domcontentloaded like the admin specs; the assertions below poll.
      await page.goto(`${GALLERY}?source=gallery#img-2`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page).toHaveURL(GALLERY);
      await page.locator("[data-curtain]").click();
      await expect(page.locator("[data-curtain]")).toBeHidden();
      await advanceToNextImage(page);
      await expect(page).toHaveURL(GALLERY);
      const docked = await page
        .locator("[aria-current='true']")
        .getAttribute("data-index");
      await openInfoDialog(page);
      await expect(
        page.getByRole("dialog", { name: `Photograph ${docked} of ${await imageCount(page)}` }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(GALLERY);
      await page.locator("[data-curtain]").click();
      await expect(page.locator("[data-curtain]")).toBeHidden();
      await openInfoDialog(page);
      await expect(
        page.getByRole("dialog", { name: `Photograph 1 of ${await imageCount(page)}` }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Home");
      await expect(page).toHaveURL(GALLERY);
    });

    test("strip keeps source proportions and the complete image height", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Measure only real photographs: every frame also mounts a .frame-ph
      // placeholder whose inline SVG has its own intrinsic size — a bare
      // `[data-track] img` sweep lets placeholders pass the naturalWidth>1
      // filter and fail the aspect check by exactly stage−naturalHeight.
      // .frame-img mounts only inside the ±3 active window; decode them all
      // so naturalWidth/naturalHeight are the real pixels, not 0.
      await page.evaluate(() =>
        Promise.all(
          [
            ...document.querySelectorAll<HTMLImageElement>(
              "[data-track] img.frame-img",
            ),
          ].map((image) => image.decode().catch(() => undefined)),
        ),
      );
      const geometry = await page.evaluate(() => {
        const stage = document
          .querySelector<HTMLElement>("[data-stage]")!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll<HTMLImageElement>(
            "[data-track] img.frame-img",
          ),
        ]
          .filter((image) => image.naturalWidth > 1 && image.naturalHeight > 1)
          .slice(0, 3)
          .map((image) => {
            const rect = image.getBoundingClientRect();
            const frame = image
              .closest<HTMLElement>(".viewer-frame")!
              .getBoundingClientRect();
            const naturalRatio = image.naturalWidth / image.naturalHeight;
            return {
              // Contain-fit runs against the frame's real box: its
              // aspect-ratio comes from *stored* manifest dims, which can
              // drift ~0.2% from the decoded pixels (thumbnail-probed vs
              // original). Never upsized past natural size.
              expectedHeight: Math.min(
                frame.height,
                frame.width / naturalRatio,
                image.naturalHeight,
              ),
              height: rect.height,
              renderedRatio: rect.width / rect.height,
              sourceRatio: naturalRatio,
            };
          });
      });
      expect(geometry).not.toHaveLength(0);
      for (const image of geometry) {
        expect(Math.abs(image.height - image.expectedHeight)).toBeLessThanOrEqual(
          1,
        );
        expect(Math.abs(image.renderedRatio - image.sourceRatio)).toBeLessThan(
          0.002,
        );
      }
    });

    test("portrait-to-landscape uses the visible mobile viewport without cropping image height", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await dismissCurtain(page);
      await page
        .locator("[data-track] img.frame-img")
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      await page.setViewportSize({ width: 812, height: 375 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const stage = document.querySelector<HTMLElement>("[data-stage]")!;
            return stage.style.getPropertyValue("--viewer-stage-height");
          }),
        )
        .toBe("375px");
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>("[data-stage]")!;
        const image =
          document.querySelector<HTMLImageElement>(
            "[data-track] img.frame-img",
          )!;
        const stageRect = stage.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return {
          cssHeight: stage.style.getPropertyValue("--viewer-stage-height"),
          imageHeight: imageRect.height,
          innerHeight: window.innerHeight,
          stageHeight: stageRect.height,
          visualHeight: window.visualViewport?.height ?? window.innerHeight,
          // The arrow bar is a deliberate reservation, not a viewport
          // change: the stage (and so the image) is exactly 64px shorter.
          barOffset: stage.classList.contains("has-arrow-bar") ? 64 : 0,
        };
      });
      expect(geometry.cssHeight).toBe(`${Math.round(geometry.visualHeight)}px`);
      expect(
        Math.abs(geometry.stageHeight - (geometry.visualHeight - geometry.barOffset)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.imageHeight - geometry.stageHeight),
      ).toBeLessThanOrEqual(1);
      expect(geometry.stageHeight).toBeLessThanOrEqual(
        geometry.innerHeight + 1,
      );
    });

    test("touch upward swipe dissolves the opening curtain", async ({ page }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
      // Fading class asserted — motion required.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
      const client = await page.context().newCDPSession(page);
      const curtain = page.locator("[data-curtain]");
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 188, y: 600, id: 1 }],
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 188, y: 440, id: 1 }],
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(curtain).toHaveClass(/fading/);
      await expect(curtain).toBeHidden();
    });

    test("drag pans the canvas one-to-one and glides briefly without snapping", async ({
      page,
    }) => {
      // Glide only exists where motion is allowed — the suite-wide
      // reduced-motion fixture would correctly zero it.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await dismissCurtain(page);
      const x0 = await page.evaluate(
        () =>
          document.querySelector("[data-track]")!.getBoundingClientRect().left,
      );
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.down();
      await page.mouse.move(vp.width / 2 - 160, vp.height / 2, { steps: 8 });
      const xDuringDrag = await page.evaluate(
        () =>
          document.querySelector("[data-track]")!.getBoundingClientRect().left,
      );
      expect(Math.abs(xDuringDrag - x0 + 160)).toBeLessThanOrEqual(3);
      await page.mouse.up();
      await page.waitForTimeout(120);
      const xAfterRelease = await page.evaluate(
        () =>
          document.querySelector("[data-track]")!.getBoundingClientRect().left,
      );
      expect(xAfterRelease).toBeLessThan(xDuringDrag);
      expect(xAfterRelease - xDuringDrag).toBeGreaterThanOrEqual(-160);
    });

    test("the rest bubble neither swallows drags nor opens on a drag", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Wait out the chrome's 3s window so the bubble is the only control.
      await page.waitForTimeout(3300);
      const bubble = page.locator(".stage-seq");
      const box = (await bubble.boundingBox())!;
      // A drag starting ON the bubble pans the strip — the press replay
      // means the counter rides the stage instead of eating the gesture.
      const trackLeft = () =>
        page.evaluate(
          () =>
            document.querySelector("[data-track]")!.getBoundingClientRect().left,
        );
      const x0 = await trackLeft();
      const bx = box.x + box.width / 2;
      const by = box.y + box.height / 2;
      await page.mouse.move(bx, by);
      await page.mouse.down();
      await page.mouse.move(bx - 140, by, { steps: 8 });
      expect(Math.abs((await trackLeft()) - x0 + 140)).toBeLessThanOrEqual(3);
      await page.mouse.up();
      await page.waitForTimeout(300);
      // That drag did not open the picker.
      await expect(page.locator(".viewer-filmstrip:visible")).toHaveCount(0);
      // An honest tap on the bubble opens it.
      await bubble.click();
      await expect(page.locator(".viewer-filmstrip:visible")).toHaveCount(1);
      await page.keyboard.press("Escape");
    });

    test("vertical scroll answers a mouse drag", async ({ page }) => {
      await dismissCurtain(page);
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("radio", { name: "Scroll" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await page.keyboard.press("Escape");
      const stage = page.locator("[data-stage]");
      await page.mouse.move(vp.width / 2, vp.height - 200);
      await page.mouse.down();
      await page.mouse.move(vp.width / 2, vp.height - 360, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => stage.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(60);
      // Dragging back down returns toward the feed top.
      await page.mouse.move(vp.width / 2, vp.height - 360);
      await page.mouse.down();
      await page.mouse.move(vp.width / 2, vp.height - 200, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => stage.evaluate((el) => el.scrollTop))
        .toBeLessThan(60);
    });

    test("touch swipe moves directly and floats farther without snapping", async ({
      page,
    }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await dismissCurtain(page);
      const client = await page.context().newCDPSession(page);
      const start = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 300, y: 360, id: 1 }],
      });
      for (const x of [290, 280, 270, 260, 250, 240, 230, 220]) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: 360, id: 1 }],
        });
        await page.waitForTimeout(12);
      }
      const during = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      expect(Math.abs(during - start)).toBeGreaterThanOrEqual(60);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(80);
      const after = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      expect(after).toBeLessThan(during);
      expect(after - during).toBeGreaterThanOrEqual(-240);
    });

    test("fast touch flicks glide substantially farther than slow drags", async ({
      page,
    }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
      // Glide only exists where motion is allowed; emulation persists
      // across this spec's per-measure reloads.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const measure = async (pause: number) => {
        await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
        await page.locator("[data-curtain]").click();
        await expect(page.locator("[data-curtain]")).toBeHidden();
        const client = await page.context().newCDPSession(page);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 340, y: 360, id: 1 }],
        });
        for (const x of [325, 310, 295, 280, 265, 250, 235, 220]) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: 360, id: 1 }],
          });
          await page.waitForTimeout(pause);
        }
        const release = await page
          .locator("[data-track]")
          .evaluate((track) => track.getBoundingClientRect().left);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await page.waitForTimeout(1000);
        const settled = await page
          .locator("[data-track]")
          .evaluate((track) => track.getBoundingClientRect().left);
        return Math.abs(settled - release);
      };
      const slowGlide = await measure(55);
      const fastGlide = await measure(8);
      expect(slowGlide).toBeGreaterThan(55);
      expect(fastGlide).toBeGreaterThan(240);
      expect(fastGlide).toBeGreaterThan(slowGlide * 2.5);
    });

    test("repeated touch drags cross image boundaries as one continuous canvas", async ({
      page,
    }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
      await dismissCurtain(page);
      const client = await page.context().newCDPSession(page);
      // The product promise is the canvas under the finger being
      // continuous — but [data-track].left is not that contract. When a
      // live original finishes decoding, the heal path (Viewer.tsx
      // ~2110–2126) widens its frame and rewrites the transform by the
      // same delta so viewed pixels stay put: raw track coordinates can
      // teleport hundreds of px while nothing on screen moved. Measure
      // the frame under the finger instead — it must track move-by-move,
      // and only an abutting neighbour may take over under the point.
      const sample = (x: number) =>
        page.evaluate((fx) => {
          const registry = ((window as any).__touchProbe ??= new Map());
          const els = ((window as any).__touchProbeEls ??= []);
          const nextKey = ((window as any).__touchProbeKey ??= { value: 0 });
          const el = document
            .elementFromPoint(fx, 400)
            ?.closest<HTMLElement>("[data-index], [data-ad-frame], [data-endcard]");
          if (!el) return null;
          if (!registry.has(el)) {
            registry.set(el, nextKey.value);
            els[nextKey.value] = el;
            nextKey.value += 1;
          }
          return {
            key: registry.get(el) as number,
            left: el.getBoundingClientRect().left,
            width: el.offsetWidth,
          };
        }, x);
      const positions: ({ key: number; left: number; width: number; gesture: number } | null)[] = [];
      for (let gesture = 0; gesture < 5; gesture += 1) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 360, y: 400, id: 1 }],
        });
        for (const x of [
          340, 320, 300, 280, 260, 240, 220, 200, 180, 160, 140, 120, 100, 80,
          60, 40, 20,
        ]) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: 400, id: 1 }],
          });
          await page.waitForTimeout(8);
          const sampled = await sample(x);
          positions.push(sampled ? { ...sampled, gesture } : null);
        }
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        // Release continuity is the same contract — sample once more
        // under the resting finger after touchEnd lands. The next
        // gesture's finger lands elsewhere, so comparisons restart there.
        await page.waitForTimeout(16);
        const released = await sample(20);
        positions.push(released ? { ...released, gesture } : null);
      }
      const failures: string[] = [];
      for (let i = 1; i < positions.length; i += 1) {
        const prev = positions[i - 1];
        const curr = positions[i];
        if (!curr) {
          failures.push(`sample ${i}: no frame under the finger`);
          continue;
        }
        if (!prev || prev.gesture !== curr.gesture) continue;
        if (curr.key === prev.key) {
          if (Math.abs(curr.left - prev.left) > 100) {
            failures.push(
              `sample ${i}: the frame under the finger jumped ${(curr.left - prev.left).toFixed(0)}px`,
            );
          }
          continue;
        }
        // A new element under the finger is only legitimate as an
        // abutting handoff: frames hang edge-to-edge, so the adjacent
        // edges of the old and new frames must meet within tolerance.
        // A heal relayout can land between the two samples and leave
        // prev's rect stale, so a miss is re-measured atomically before
        // it counts.
        const adjacentGap = (a: { left: number; width: number }, b: { left: number; width: number }) =>
          b.left < a.left
            ? a.left - (b.left + b.width)
            : b.left - (a.left + a.width);
        let gap = adjacentGap(prev, curr);
        if (Math.abs(gap) > 100) {
          gap = await page.evaluate(([pk, ck]) => {
            const els = (window as any).__touchProbeEls as HTMLElement[] | undefined;
            const p = els?.[pk];
            const c = els?.[ck];
            if (!p || !c || !p.isConnected || !c.isConnected) return 0;
            const pr = p.getBoundingClientRect();
            const cr = c.getBoundingClientRect();
            return cr.left < pr.left
              ? pr.left - (cr.left + cr.width)
              : cr.left - (pr.left + pr.width);
          }, [prev.key, curr.key]);
        }
        if (Math.abs(gap) > 100) {
          failures.push(
            `sample ${i}: the finger teleported ${(curr.left - prev.left).toFixed(0)}px to a different frame`,
          );
        }
      }
      expect(failures).toEqual([]);
      // Total travel still uses the track: heal corrections only ever
      // pull it further left, so the one-sided bound stays honest.
      const travelled = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      expect(travelled).toBeLessThan(-1500);
    });

    test("repeated wheel input stays responsive and keeps the decoded image window bounded", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const result = await page.evaluate(async () => {
        const stage = document.querySelector<HTMLElement>("[data-stage]")!;
        const started = performance.now();
        for (let count = 0; count < 120; count += 1) {
          stage.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaY: 48,
            }),
          );
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const activeImages = [
          ...document.querySelectorAll<HTMLImageElement>(
            '[data-track] img[data-active="true"]',
          ),
        ].length;
        return {
          elapsed: performance.now() - started,
          activeImages,
          trackLeft: document
            .querySelector("[data-track]")!
            .getBoundingClientRect().left,
        };
      });
      expect(result.elapsed).toBeLessThan(1000);
      expect(result.trackLeft).toBeLessThan(0);
      // The strip keeps a ±3 decoded window around the current frame
      // plus a bounded MRU tail of recently-left frames (≤ 6) — 13 max.
      expect(result.activeImages).toBeLessThanOrEqual(13);
    });

    test("strip retains recently-panned frames beyond its decoded window", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const count = () =>
        page.locator('[data-track] img[data-active="true"]').count();
      // At rest only the ±3 window is decoded.
      await expect.poll(count).toBeLessThanOrEqual(7);
      // A long pan leaves frames behind the window still mounted — the
      // retention tail — while the whole set stays bounded.
      await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>("[data-stage]")!;
        const track = document.querySelector<HTMLElement>("[data-track]")!;
        const fifth = track.querySelector<HTMLElement>('[data-index="5"]')!;
        const currentX =
          stage.getBoundingClientRect().left - track.getBoundingClientRect().left;
        const steps = Math.ceil((fifth.offsetLeft - currentX + 48) / 48);
        for (let n = 0; n < steps; n += 1) {
          stage.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 48 }),
          );
        }
      });
      await expect
        .poll(async () =>
          Number(
            await page
              .locator('[data-track] [aria-current="true"]')
              .getAttribute("data-index"),
          ),
        )
        .toBeGreaterThanOrEqual(5);
      await expect.poll(count).toBeGreaterThan(7);
      expect(await count()).toBeLessThanOrEqual(13);
    });

    test("modal contains every control and dismisses three ways", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Buttons deliberately skip mouse focus (preventButtonFocus), so
      // the focus-restore path is exercised the way a keyboard user hits
      // it: focus the rest bubble, open the info sheet with I, then
      // dismiss — focus returns to the control that opened the chain.
      await page.waitForTimeout(3300);
      await page.locator(".stage-seq").focus();
      await page.keyboard.press("i");
      const modal = page.getByRole("dialog", { name: CONTROL_NAME });
      await expect(modal).toBeVisible();
      // The provenance sheet carries the frame's own rows; view modes
      // and shortcuts live in the Display sheet instead.
      for (const label of [/file/i, /size/i, /content credentials/i]) {
        await expect(modal.getByText(label).first()).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(modal).not.toBeVisible();
      // focus returns to the stage control that opened the chain
      await expect(page.locator(".stage-seq")).toBeFocused();
      // Second dismissal path: the panel's close control.
      await openInfoDialog(page);
      await expect(modal).toBeVisible();
      await modal
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(modal).not.toBeVisible();
      // Third: the sheet's scrim.
      await openInfoDialog(page);
      await expect(modal).toBeVisible();
      await page.locator(".m-scrim").click({ position: { x: 4, y: 4 } });
      await expect(modal).not.toBeVisible();
    });

    test("fullscreen is offered only where element fullscreen is supported", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const supported = await page.evaluate(() =>
        Boolean(
          document.fullscreenEnabled &&
          document.querySelector<HTMLElement>("[data-stage]")
            ?.requestFullscreen,
        ),
      );
      // Fullscreen lives in the display-settings panel.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await expect(
        page.getByRole("switch", { name: /fullscreen/i }),
      ).toHaveCount(supported ? 1 : 0);
    });

    test("arrows are opt-in for vertical, on elsewhere, and navigate", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Arrows ship on in strip mode except on coarse pointers, where the
      // toggle in display settings brings them back.
      await ensureNavArrows(page);
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page
        .getByRole("switch", { name: /^arrows$/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page
        .getByRole("switch", { name: /^arrows$/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await page.keyboard.press("Escape");
      // Vertical keeps the toggle but defaults arrows off — the feed
      // scrolls natively, so they appear only on request.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("radio", { name: "Scroll" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page
        .getByRole("switch", { name: /^arrows$/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await page.keyboard.press("Escape");
      // Enabled vertical arrows stack ↑ over ↓ at the bottom-right.
      await expect(page.locator("[data-nav-arrow]").first()).toHaveText("↑");
      await expect(page.locator("[data-nav-arrow]").last()).toHaveText("↓");
      const arrowsBox = await page
        .locator("[data-nav-arrow]")
        .evaluateAll((els) => {
          const stage = document
            .querySelector("[data-stage]")!
            .getBoundingClientRect();
          return els.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              top: r.top,
              rightDelta: stage.right - r.right,
              bottomDelta: stage.bottom - r.bottom,
            };
          });
        });
      // Second button sits below the first (a column), both docked to
      // the stage's right edge with the last one near the bottom corner.
      expect(arrowsBox[1].top).toBeGreaterThan(arrowsBox[0].top + 20);
      expect(arrowsBox[0].rightDelta).toBeLessThan(48);
      expect(arrowsBox[1].rightDelta).toBeLessThan(48);
      expect(arrowsBox[1].bottomDelta).toBeLessThan(48);
      // ↓ docks the next photograph at the feed's top edge — stepped
      // from the on-screen position, not a stale index — and ↑ returns.
      const stageTop = () =>
        page
          .locator("[data-stage]")
          .evaluate((el) => el.getBoundingClientRect().top);
      const frameTop = (n: number) =>
        page
          .locator(`[data-index='${n}']`)
          .evaluate((el) => el.getBoundingClientRect().top);
      await page.getByRole("button", { name: /next photograph/i }).click();
      await expect
        .poll(async () => Math.abs((await frameTop(2)) - (await stageTop())), {
          timeout: 4000,
        })
        .toBeLessThan(24);
      await page
        .getByRole("button", { name: /previous photograph/i })
        .click();
      await expect
        .poll(async () => Math.abs((await frameTop(1)) - (await stageTop())), {
          timeout: 4000,
        })
        .toBeLessThan(24);
      // Hiding again restores the quiet default.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page
        .getByRole("switch", { name: /^arrows$/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await page.keyboard.press("Escape");
      // Single mode brings them back, stepping one image at a time.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("radio", { name: "One by one" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await page.getByRole("button", { name: /next photograph/i }).click();
      // The two-beat fade commits the index after the out-fade + decode
      // — poll for the dock instead of reading the same frame.
      let docked = "1";
      await expect
        .poll(async () => {
          docked =
            (await page
              .locator("[data-stage] [aria-current='true']")
              .getAttribute("data-index")) ?? "1";
          return Number(docked);
        })
        .toBeGreaterThan(1);
      await openInfoDialog(page);
      await expect(
        page.getByRole("dialog", { name: `Photograph ${docked} of ${await imageCount(page)}` }),
      ).toBeVisible();
    });

    test("touch pointers start without nav buttons; enabled arrows dock at the bottom corners", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const coarse = await page.evaluate(() =>
        matchMedia("(pointer: coarse)").matches,
      );
      if (!coarse) {
        // Fine pointers keep the old default: arrows on, clustered.
        await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
        return;
      }
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await ensureNavArrows(page);
      const stage = await page
        .locator("[data-stage]")
        .evaluate((el) => el.getBoundingClientRect());
      const boxes = await page
        .locator("[data-nav-arrow]")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, bottom: r.bottom };
          }),
        );
      // ← hugs the bottom-left corner, → the bottom-right.
      expect(boxes[0].left).toBeLessThan(stage.left + stage.width * 0.3);
      expect(boxes[1].right).toBeGreaterThan(
        stage.right - stage.width * 0.3,
      );
      expect(boxes[0].bottom).toBeGreaterThan(stage.bottom - 100);
      expect(boxes[1].bottom).toBeGreaterThan(stage.bottom - 100);
    });

    test("the sequence bubble counts the active photograph and rides beside the nav buttons", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const seq = page.locator(".stage-seq");
      const seqNum = seq.locator(".stage-seq-num");
      await expect(seq).toBeVisible();
      await expect(seqNum).toHaveText("1");
      await expect(seq).toHaveAttribute(
        "aria-label",
        `Photograph 1 of ${await imageCount(page)} — open kashmir`,
      );

      // The bubble tracks the reported index as the strip advances.
      await advanceToNextImage(page);
      await expect(seqNum).toHaveText("2");

      // With arrows on, it floats left of the button cluster; with them
      // off it still docks at the bottom-right corner alone.
      const coarse = await page.evaluate(() =>
        matchMedia("(pointer: coarse)").matches,
      );
      if (!coarse) {
        // Hover stretches the circle into a pill: the bare count swaps
        // for the full tally plus the open hint.
        const restBox = await seq.boundingBox();
        await seq.hover();
        await expect(seq.locator(".stage-seq-tally")).toBeVisible();
        await expect(seq.locator(".stage-seq-tally")).toHaveText(
          `2 of ${await imageCount(page)} items`,
        );
        await expect(seq.locator(".stage-seq-hint")).toHaveText(
          /open picker/i,
        );
        const lit = await seq.evaluate((el) => ({
          opacity: getComputedStyle(el).opacity,
          events: getComputedStyle(el).pointerEvents,
        }));
        expect(lit.opacity).toBe("1");
        expect(lit.events).toBe("auto");
        // The circle animates into the pill — poll the box until the
        // expansion completes rather than reading one mid-flight frame.
        await expect
          .poll(async () => (await seq.boundingBox())!.width)
          .toBeGreaterThan(restBox!.width + 40);
        await page.mouse.move(0, 0);
        await expect(seqNum).toHaveText("2");
      }

      // The bubble is a button — clicking it raises the selector.
      await seq.click();
      await expect(page.locator(".viewer-filmstrip")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".viewer-filmstrip")).toBeHidden();
      await ensureNavArrows(page);
      const nextArrow = page.getByRole("button", {
        name: /next photograph/i,
      });
      if (!coarse) {
        // Hovering NEAR the counter (anywhere in the nav cluster)
        // wakes the pill too.
        await nextArrow.hover();
        await expect(seq.locator(".stage-seq-detail")).toHaveCSS(
          "opacity",
          "1",
        );
        await page.mouse.move(0, 0);
      }
      const seqBox = await seq.boundingBox();
      const nextBox = await nextArrow.boundingBox();
      expect(seqBox!.x + seqBox!.width).toBeLessThanOrEqual(nextBox!.x + 1);
      if (!coarse) {
        // In the reserved bar ← owns the far corner — the bubble rides
        // with → on the right, so it only has to precede the forward
        // arrow (asserted above).
        const prevBox = await page
          .getByRole("button", { name: /previous photograph/i })
          .boundingBox();
        const stageRect = await page
          .locator("[data-stage]")
          .evaluate((el) => el.getBoundingClientRect());
        expect(prevBox!.x).toBeLessThan(stageRect.left + stageRect.width * 0.3);
      }

      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page
        .getByRole("switch", { name: /^arrows$/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await expect(seq).toBeVisible();
      const bare = await seq.boundingBox();
      const stage = await page
        .locator("[data-stage]")
        .evaluate((el) => el.getBoundingClientRect());
      expect(bare!.x + bare!.width).toBeGreaterThan(stage.right - 80);
      expect(bare!.y + bare!.height).toBeGreaterThan(stage.bottom - 80);
    });

    test("one-at-a-time steps dissolve the next photograph in over the current one", async ({
      page,
    }) => {
      // The fade is motion — opt back out of the suite-wide
      // reduced-motion emulation so the transition actually runs. The
      // mode comes from persisted prefs, not the bobbing settings tab,
      // which is intentionally click-unstable under no-preference.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.context().addInitScript(
        (slug) =>
          window.localStorage.setItem(
            `manorama:view:${slug}`,
            JSON.stringify({ mode: "single" }),
          ),
        SLUG,
      );
      await dismissCurtain(page);
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
      await page.keyboard.press("ArrowRight");
      // Two beats: the outgoing frame fades out in 90ms, then the
      // incoming one fades in over 160ms once decoded — a guarded fade,
      // never a directional wipe (clip-path stays 'none' the whole way).
      // Assert the leaver first: it unmounts ~170ms after the incoming
      // frame commits.
      await expect(page.locator(".viewer-frame--leaving")).toHaveCount(1);
      await expect(page.locator(".viewer-frame--entering")).toHaveCount(1);
      const entering = page.locator(".viewer-frame--entering");
      expect(await entering.evaluate((el) => getComputedStyle(el).clipPath)).toBe("none");
      // Settles back into one clean frame on the new index.
      await expect(page.locator(".viewer-frame--leaving")).toHaveCount(0, { timeout: 3000 });
      await expect(page.locator(".viewer-frame--entering")).toHaveCount(0);
      await expect(page.locator("[aria-current='true']")).toHaveAttribute("data-index", "2");
    });

    test("vertical view complements Strip without pairing or altering source proportions", async ({
      page,
    }) => {
      // The walk decodes real provider originals — multi-MB fetches through
      // the proxy — so the per-frame wait needs headroom beyond 30s.
      test.setTimeout(120000);
      await dismissCurtain(page);
      await expect(page.locator('[data-portrait-pair="true"]')).toHaveCount(0);
      // The radios are visually hidden inside their labels — drive the
      // label, the element a pointer actually hits.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("radio", { name: "Scroll" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await page.keyboard.press("Escape");
      // Vertical mode mounts .frame-img only for the ACTIVE frame, so the
      // spec walks the sequence and samples each orientation the first
      // time a frame of that kind activates — real album order decides
      // which index that is, and an album may lack one entirely.
      const total = await imageCount(page);
      const samples: Record<
        string,
        {
          stageWidth: number; stageHeight: number; dpr: number;
          width: number; height: number;
          naturalWidth: number; naturalHeight: number;
          sourceRatio: number; renderedRatio: number;
        }
      > = {};
      for (let i = 0; i < total && !(samples.landscape && samples.portrait); i++) {
        const sample = await page.evaluate(async () => {
          const stage = document.querySelector<HTMLElement>("[data-stage]")!;
          const frame = document.querySelector<HTMLElement>(
            '.viewer-frame[aria-current="true"]',
          );
          const image =
            frame?.querySelector<HTMLImageElement>("img.frame-img");
          if (!frame || !image) return null;
          try {
            await Promise.race([
              image.decode(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("decode timeout")), 8000),
              ),
            ]);
          } catch {
            return null;
          }
          // decode() resolves before the onLoad heal that corrects staged
          // geometry when stored dims disagree with the real file — wait two
          // frames so the measurement sees the settled size.
          await new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => setTimeout(resolve, 60)),
            ),
          );
          const rect = image.getBoundingClientRect();
          return {
            orientation: frame.dataset.orientation!,
            stageWidth: stage.clientWidth,
            stageHeight: stage.clientHeight,
            dpr: window.devicePixelRatio,
            width: rect.width,
            height: rect.height,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            sourceRatio: image.naturalWidth / image.naturalHeight,
            renderedRatio: rect.width / rect.height,
          };
        });
        if (sample) samples[sample.orientation] ??= sample;
        if (i + 1 < total && !(samples.landscape && samples.portrait)) await advanceToNextImage(page);
      }
      if (!samples.landscape || !samples.portrait) {
        test.skip(true, "seeded album contains only one orientation");
      }
      const geometry = {
        stageWidth: samples.landscape!.stageWidth,
        stageHeight: samples.landscape!.stageHeight,
        landscape: samples.landscape!,
        portrait: samples.portrait!,
      };
      // Vertical scroll fits width-first: display width is the stage width
      // bounded by natural pixels at the effective DPR (capped at 2), and
      // height follows the source ratio — tall frames run long instead of
      // shrinking to the viewport.
      const effectiveDpr = Math.min(geometry.landscape.dpr || 1, 2);
      const landscapeTarget = Math.min(
        geometry.stageWidth,
        geometry.landscape.naturalWidth / effectiveDpr,
      );
      expect(
        Math.abs(geometry.landscape.width - landscapeTarget),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.landscape.height - landscapeTarget / geometry.landscape.sourceRatio),
      ).toBeLessThanOrEqual(2);
      const portraitTarget = Math.min(
        geometry.stageWidth,
        geometry.portrait.naturalWidth / effectiveDpr,
      );
      expect(
        Math.abs(geometry.portrait.width - portraitTarget),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.portrait.height - portraitTarget / geometry.portrait.sourceRatio),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(
          geometry.landscape.renderedRatio - geometry.landscape.sourceRatio,
        ),
      ).toBeLessThan(0.01);
      expect(
        Math.abs(
          geometry.portrait.renderedRatio - geometry.portrait.sourceRatio,
        ),
      ).toBeLessThan(0.01);
    });

    test("Strip arrows make a continuous sub-viewport advance", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Hidden by default on coarse pointers — enable where the run needs them.
      await ensureNavArrows(page);
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      const before = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      const viewportWidth = await page
        .locator("[data-stage]")
        .evaluate((stage) => stage.clientWidth);
      // The advance docks the NEXT FRAME's left edge at the stage edge,
      // capped at one viewport — on a phone a portrait frame is ~256px,
      // far under any fraction of the viewport, so the contract is the
      // docking distance itself, not a minimum travel.
      const docking = await page.locator("[data-stage]").evaluate((stage) => {
        const track = stage.querySelector<HTMLElement>("[data-track]")!;
        const base = -new DOMMatrixReadOnly(
          getComputedStyle(track).transform,
        ).e;
        const frames = [
          ...track.querySelectorAll<HTMLElement>(
            "[data-index], [data-ad-frame], [data-endcard]",
          ),
        ];
        let frame = frames[0] ?? null;
        for (const candidate of frames) {
          if (candidate.offsetLeft > base + 1) break;
          frame = candidate;
        }
        const next = frame?.nextElementSibling as HTMLElement | null;
        return { base, nextOffsetLeft: next?.offsetLeft ?? null };
      });
      const expected = Math.min(
        viewportWidth,
        Math.max(0, (docking.nextOffsetLeft ?? docking.base + viewportWidth) - docking.base),
      );
      await page.getByRole("button", { name: /next photograph/i }).click();
      await waitForTrackSettled(page);
      const after = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      const advance = Math.abs(after - before);
      expect(Math.abs(advance - expected)).toBeLessThanOrEqual(2);
      expect(advance).toBeLessThanOrEqual(viewportWidth + 1);
    });

    test("the strip ends on a 'The End.' card instead of wrapping", async ({
      page,
      playwright,
    }) => {
      // Spawned fixtures carry truthful dims — the strip never heals
      // mid-spec, so end-of-strip assertions aren't racing decode-time
      // width corrections. The finale is a sliver narrower than every
      // stage: it never reaches the left edge, which is what used to
      // stall the counter one short of the total.
      const request = await retentionApi(playwright);
      await spawnGalleries(request, [
        {
          slug: `endcap-${vp.name}`,
          images: [
            ...[0, 1, 2, 3, 4].map((i) => fixtureImage(`cap-w${i}`, 2400, 1600)),
            ...[5, 6, 7].map((i) => fixtureImage(`cap-p${i}`, 1200, 1800)),
            fixtureImage("cap-last", 300, 1200),
          ],
        },
      ]);
      await request.dispose();
      await dismissCurtain(page, `${BASE}/${RETENTION_OWNER}/endcap-${vp.name}`);
      const endcap = page.locator(".viewer-endcap");
      await expect(endcap).toHaveCount(1);
      await expect(endcap).toHaveText(/The\s*End\./);
      // A borderless faux frame: wordmark type 3×, 40px side padding,
      // full stage height — wider than the old fixed 100px.
      const stageBox = await page.locator("[data-stage]").boundingBox();
      const capBox = await endcap.boundingBox();
      expect(capBox!.width).toBeGreaterThan(110);
      expect(Math.abs(capBox!.height - stageBox!.height)).toBeLessThan(2);

      await ensureNavArrows(page);
      await page.keyboard.press("Escape");
      // Reaching the last photograph alone does NOT reveal the card —
      // the pan range ends at the photo's right edge. The counter still
      // counts it: the finale never reaches the left edge, so the docked
      // end must report the final image.
      const total = 9;
      await page.keyboard.press("End");
      await waitForTrackSettled(page);
      await expect(page.locator(".stage-seq .stage-seq-num")).toHaveText(`${total}`);
      const hidden = await endcap.boundingBox();
      expect(hidden!.x).toBeGreaterThanOrEqual(
        stageBox!.x + stageBox!.width - 1,
      );

      // Stepping past the end slides it in flush with the stage's right.
      await page.getByRole("button", { name: /next photograph/i }).click();
      await waitForTrackSettled(page);
      const shown = await endcap.boundingBox();
      expect(
        Math.abs(shown!.x + shown!.width - (stageBox!.x + stageBox!.width)),
      ).toBeLessThan(2);

      // The card carries a quiet Rewind that runs the strip home in a
      // fixed 0.75s ease-in-out and re-arms the reveal.
      const reset = endcap.getByRole("button", { name: /^rewind$/i });
      await expect(reset).toBeVisible();
      await reset.click();
      await waitForTrackSettled(page);
      await expect(page.locator(".stage-seq .stage-seq-num")).toHaveText("1");
      await expect(
        page.locator("[aria-current='true']"),
      ).toHaveAttribute("data-index", "1");
      const rearmed = await endcap.boundingBox();
      expect(rearmed!.x).toBeGreaterThanOrEqual(
        stageBox!.x + stageBox!.width - 1,
      );

      // Reveal it once more for the no-wrap checks.
      await page.keyboard.press("End");
      await waitForTrackSettled(page);
      await page.getByRole("button", { name: /next photograph/i }).click();
      await waitForTrackSettled(page);

      // And the arrow stops there — no wrap back to the first image.
      // (The card staying flush-right is the check: a healed frame can
      // legitimately re-anchor the track transform, so compare the
      // card's box rather than the track's origin.)
      await page.getByRole("button", { name: /next photograph/i }).click();
      await waitForTrackSettled(page);
      const stillShown = await endcap.boundingBox();
      expect(
        Math.abs(
          stillShown!.x + stillShown!.width - (stageBox!.x + stageBox!.width),
        ),
      ).toBeLessThan(2);
      // aria-current is the leftmost visible frame — on wide stages
      // that is an earlier photo, so the no-wrap check is "not 1".
      await expect(
        page.locator("[aria-current='true']"),
      ).not.toHaveAttribute("data-index", "1");

      // The card ends every layout — in Scroll it is a footer frame in
      // the feed itself rather than a slid-in faux frame.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("radio", { name: "Scroll" }).click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      const feedCard = page.locator(".viewer-endcap--feed");
      await expect(feedCard).toHaveCount(1);
      await expect(feedCard).toHaveText(/The\s*End\./);
      await expect(feedCard.getByRole("button", { name: /^rewind$/i })).toBeAttached();
    });

    test("enabled arrows live in a reserved 64px bar beneath the photographs", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const stage = page.locator("[data-stage]");
      await ensureNavArrows(page);
      await expect(stage).toHaveClass(/has-arrow-bar/);
      // The stage cedes exactly the bar: viewport minus 64px (plus any
      // safe-area inset, which is 0 in every matrix viewport).
      const geo = await page.evaluate(() => {
        const s = document.querySelector("[data-stage]")!.getBoundingClientRect();
        return {
          stageBottom: s.bottom,
          stageHeight: s.height,
          stageRight: s.right,
          viewportH: window.innerHeight,
          viewportW: window.innerWidth,
        };
      });
      expect(Math.abs(geo.stageBottom - (geo.viewportH - 64))).toBeLessThan(2);
      expect(Math.abs(geo.stageHeight - (geo.viewportH - 64))).toBeLessThan(2);
      // Both buttons sit inside the bar — below the stage, never on a
      // photograph — with ← at the left corner and → at the right.
      const bar = page.locator(".stage-arrows");
      const barBox = await bar.boundingBox();
      expect(Math.abs(barBox!.height - 64)).toBeLessThan(2);
      expect(barBox!.y).toBeGreaterThanOrEqual(geo.stageBottom - 1);
      const [prevBox, nextBox] = await page.locator("[data-nav-arrow]").evaluateAll(
        (els) => els.map((el) => el.getBoundingClientRect()),
      );
      expect(prevBox.top).toBeGreaterThanOrEqual(geo.stageBottom - 1);
      expect(nextBox.top).toBeGreaterThanOrEqual(geo.stageBottom - 1);
      expect(prevBox.left).toBeLessThan(geo.viewportW * 0.3);
      expect(nextBox.right).toBeGreaterThan(geo.viewportW * 0.7);
      // Turning arrows off hands the height straight back to the stage.
      await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
      await page.getByRole("switch", { name: /^arrows$/i }).click();
      await expect(stage).not.toHaveClass(/has-arrow-bar/);
      const restored = await page.evaluate(
        () => document.querySelector("[data-stage]")!.getBoundingClientRect().height,
      );
      expect(Math.abs(restored - geo.viewportH)).toBeLessThan(2);
    });

    test("one-by-one ends on the end card as an overlay; prev closes it", async ({
      page,
    }) => {
      await page.context().addInitScript(
        (slug) =>
          window.localStorage.setItem(
            `manorama:view:${slug}`,
            JSON.stringify({ mode: "single" }),
          ),
        SLUG,
      );
      await dismissCurtain(page);
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
      const card = page.locator(".viewer-endcap--single");
      await expect(card).not.toHaveClass(/is-open/);
      await expect(card).toBeHidden();
      await page.keyboard.press("End");
      // Next on the last photograph fades the card in over it.
      await page.keyboard.press("ArrowRight");
      await expect(card).toHaveClass(/is-open/);
      await expect(card).toHaveText(/The\s*End\./);
      await expect(card.getByRole("button", { name: /^rewind$/i })).toBeVisible();
      // The signed-in owner also gets the Library exit.
      await expect(
        card.getByRole("button", { name: /^library$/i }).or(card.getByRole("link", { name: /^library$/i })),
      ).toBeVisible();
      // Prev simply closes the card — the last photograph is still live.
      await page.keyboard.press("ArrowLeft");
      await expect(card).not.toHaveClass(/is-open/);
      await expect(page.locator("[aria-current='true']")).toHaveAttribute(
        "data-index",
        `${await imageCount(page)}`,
      );
      // Rewind from a fresh reveal lands on the first photograph.
      await page.keyboard.press("ArrowRight");
      await card.getByRole("button", { name: /^rewind$/i }).click();
      await expect(page.locator("[aria-current='true']")).toHaveAttribute("data-index", "1");
    });

    test("rewind is a fixed 0.75s ride home, or an instant jump under reduced motion", async ({
      page,
    }) => {
      const trackX = () =>
        page.locator("[data-track]").evaluate((el) => {
          const t = getComputedStyle(el).transform;
          return t === "none" ? 0 : new DOMMatrixReadOnly(t).e;
        });
      // Motion on first: the ride takes real time but lands inside a
      // bounded window — a deliberate return, never a wrap-jump.
      const rewindBtn = () =>
        page.locator("[data-endcard]").getByRole("button", { name: /^rewind$/i });
      const revealEndcard = async () => {
        // A narrow stage needs two presses: the first only end-docks the
        // last photograph, the second reveals the card. Wide stages do
        // it in one — the loop covers both without pressing past.
        const next = page.getByRole("button", { name: /next photograph/i });
        for (let i = 0; i < 8; i++) {
          await next.click();
          await waitForTrackSettled(page);
          const box = await rewindBtn().boundingBox();
          if (box && box.x + box.width / 2 < page.viewportSize()!.width) return;
        }
        throw new Error("endcard never slid on stage");
      };
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await dismissCurtain(page);
      await ensureNavArrows(page);
      await page.keyboard.press("End");
      await waitForTrackSettled(page);
      await revealEndcard();
      await rewindBtn().click();
      // Still travelling well after the click — not an instant snap.
      await page.waitForTimeout(300);
      expect(await trackX()).toBeLessThan(-1);
      // And it lands inside the fixed-duration ride, on the first photo.
      await expect.poll(trackX, { timeout: 2500 }).toBe(0);
      await expect(page.locator("[aria-current='true']")).toHaveAttribute("data-index", "1");
      // Reduced motion lands immediately — far inside the 750ms ride.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.keyboard.press("End");
      await waitForTrackSettled(page);
      await revealEndcard();
      const quickStart = Date.now();
      await rewindBtn().click();
      await expect(page.locator("[aria-current='true']")).toHaveAttribute("data-index", "1");
      expect(await trackX()).toBe(0);
      expect(Date.now() - quickStart).toBeLessThan(500);
    });

    test("dragging past the last photograph reveals the endcard", async ({
      page,
      playwright,
    }) => {
      const request = await retentionApi(playwright);
      await spawnGalleries(request, [
        {
          slug: `endcap-drag-${vp.name}`,
          images: [
            ...[0, 1, 2].map((i) => fixtureImage(`cap-d${i}`, 2400, 1600)),
            fixtureImage("cap-d-last", 300, 1200),
          ],
        },
      ]);
      await request.dispose();
      await dismissCurtain(page, `${BASE}/${RETENTION_OWNER}/endcap-drag-${vp.name}`);
      const stageBox = await page.locator("[data-stage]").boundingBox();
      await page.keyboard.press("End");
      await waitForTrackSettled(page);
      const endcap = page.locator(".viewer-endcap");
      expect(
        (await endcap.boundingBox())!.x,
      ).toBeGreaterThanOrEqual(stageBox!.x + stageBox!.width - 1);
      // A pull past the strip's end carries the card in with the drag.
      const cx = stageBox!.x + stageBox!.width / 2;
      const cy = stageBox!.y + stageBox!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 160, cy, { steps: 12 });
      await page.mouse.up();
      await waitForTrackSettled(page);
      const shown = await endcap.boundingBox();
      expect(shown!.x).toBeLessThan(stageBox!.x + stageBox!.width - 1);
    });

    test("no layout shift while images load", async ({ page, playwright }) => {
      // Runs on a spawned gallery whose manifest dims match the real
      // pixels: frames are born at their final geometry, so nothing
      // reflows. (Thumbnail-probed manifests self-correct on decode —
      // that reflow is the heal doing its job, not layout instability.)
      const request = await retentionApi(playwright);
      await spawnGalleries(request, [
        {
          slug: `cls-${vp.name}`,
          images: ["cls-a", "cls-b", "cls-c"].map((id, i) =>
            fixtureImage(id, 2400 - i * 200, 1600),
          ),
        },
      ]);
      await request.dispose();
      await dismissCurtain(page, `${BASE}/${RETENTION_OWNER}/cls-${vp.name}`);
      const cls = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let cls = 0;
            new PerformanceObserver((list) => {
              for (const e of list.getEntries() as any)
                if (!e.hadRecentInput) cls += e.value;
            }).observe({ type: "layout-shift", buffered: true });
            setTimeout(() => resolve(cls), 3000);
          }),
      );
      expect(cls).toBeLessThan(0.02);
    });

    test("accessibility: axe clean on stage and modal", async ({ page }) => {
      await dismissCurtain(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await openInfoDialog(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test("c2pa: credentialed image validates, unsigned shows quiet state", async ({
      page,
    }) => {
      await dismissCurtain(page);
      await openInfoDialog(page);
      const panel = page.getByRole("dialog").locator("[data-c2pa-panel]");
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText(/error/i);
      // valid summary OR the neutral no-credentials line — never a broken panel
      await expect(panel).toContainText(
        /content credentials|no content credentials/i,
      );
    });
  });
}

test("alternate modes switch instantly and preserve the current image", async ({
  page,
}) => {
  await dismissCurtain(page);
  await advanceToNextImage(page);
  const total = await imageCount(page);
  // Mode radios live in the display-settings panel and are visually
  // hidden — drive their labels. Position reports through the info dialog.
  await showChrome(page);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page
    .getByRole("radio", { name: "Scroll" })
    .click();
  await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
  await page.keyboard.press("Escape");
  await openInfoDialog(page);
  await expect(page.getByRole("dialog", { name: `Photograph 2 of ${total}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await showChrome(page);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page
    .getByRole("radio", { name: "One by one" })
    .click();
  await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
  await page.keyboard.press("Escape");
  await openInfoDialog(page);
  await expect(page.getByRole("dialog", { name: `Photograph 2 of ${total}` })).toBeVisible();
  await expect(page).toHaveURL(GALLERY);
});

test("`⇧I` deep-links the current image into the standalone C2PA viewer", async ({
  page,
  context,
  request,
}) => {
  const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: {
      accountId: "dbid:AAATESTretention",
      galleries: [
        {
          slug: "info-qa",
          layout: "strip",
          images: [
            {
              id: "i0",
              filename: "a.jpg",
              src: "/api/test/a.jpg",
              width: 800,
              height: 600,
              alt: "a",
            },
            {
              id: "i1",
              filename: "b.jpg",
              src: "/api/test/b.jpg",
              width: 800,
              height: 600,
              alt: "b",
            },
          ],
        },
      ],
    },
  });
  expect(spawn.ok()).toBe(true);
  await dismissCurtain(page, `${BASE}/retention-qa/info-qa`);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.keyboard.press("Shift+I"),
  ]);
  await expect
    .poll(() => popup.url())
    .toMatch(/^https:\/\/c2pa\.thecontrarian\.in\/\?uri=/);
  // The deep link carries the absolute image URL — relative proxy srcs are
  // resolved against the gallery origin before encoding.
  expect(decodeURIComponent(popup.url())).toContain(
    `${BASE}/api/test/a.jpg`,
  );
  await popup.close();
  // The gallery itself never navigated.
  await expect(page).toHaveURL(`${BASE}/retention-qa/info-qa`);
});

test("`⇧I` falls back to the in-gallery sheet when the viewer cannot fetch the source", async ({
  page,
  request,
}) => {
  const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: {
      accountId: "dbid:AAATESTretention",
      galleries: [
        {
          slug: "info-qa-data",
          layout: "strip",
          images: [
            {
              id: "d0",
              filename: "a.jpg",
              src: testPng(800, 600),
              width: 800,
              height: 600,
              alt: "a",
            },
            {
              id: "d1",
              filename: "b.jpg",
              src: testPng(800, 600),
              width: 800,
              height: 600,
              alt: "b",
            },
          ],
        },
      ],
    },
  });
  expect(spawn.ok()).toBe(true);
  await dismissCurtain(page, `${BASE}/retention-qa/info-qa-data`);
  // A data: URI cannot travel to the external viewer — the sheet opens in place.
  await page.keyboard.press("Shift+I");
  await expect(
    page.getByRole("dialog", { name: CONTROL_NAME }),
  ).toBeVisible();
});

test("the info sheet shows the photograph's caption", async ({
  page,
  request,
}) => {
  const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: {
      accountId: "dbid:AAATESTretention",
      galleries: [
        {
          slug: "caption-qa",
          images: [
            {
              id: "c-a",
              filename: "a.png",
              src: testPng(800, 600),
              width: 800,
              height: 600,
              alt: "a",
              caption: "Caption A",
            },
            {
              id: "c-b",
              filename: "b.png",
              src: testPng(800, 600),
              width: 800,
              height: 600,
              alt: "b",
            },
          ],
        },
      ],
    },
  });
  expect(spawn.ok()).toBe(true);
  await dismissCurtain(page, `${BASE}/retention-qa/caption-qa`);
  await openInfoDialog(page);
  const modal = page.getByRole("dialog", { name: CONTROL_NAME });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Caption A")).toBeVisible();
  // Uncaptioned items simply omit the row — advance and confirm.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowRight");
  await openInfoDialog(page);
  await expect(
    modal.getByRole("term", { name: /^caption$/i }),
  ).toHaveCount(0);
});

test.describe("display and info sheets", () => {
  test("layout and canvas segments apply live, stay open, and persist", async ({
    page,
  }) => {
    await dismissCurtain(page);
    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Display" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("radio", { name: "Scroll" }).click();
    await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
    await expect(dialog).toBeVisible();

    await dialog.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator(".viewer-stage.bg-dark")).toHaveCount(1);
    await expect(dialog).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissCurtain(page);
    await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
    await expect(page.locator(".viewer-stage.bg-dark")).toHaveCount(1);

    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await dialog.getByRole("radio", { name: "Strip" }).click();
    await dialog.getByRole("radio", { name: "Black" }).click();
    await expect(page.locator("[data-stage]")).toHaveClass(/mode-strip/);
    await expect(page.locator(".viewer-stage.bg-dark")).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissCurtain(page);
    await expect(page.locator("[data-stage]")).toHaveClass(/mode-strip/);
    await expect(page.locator(".viewer-stage.bg-dark")).toHaveCount(0);
  });

  test("escape closes the display sheet once and returns focus to its pill", async ({
    page,
  }) => {
    await dismissCurtain(page);
    await showChrome(page);
    const pill = page.getByRole("button", { name: "Display", exact: true });
    await pill.click();
    const dialog = page.getByRole("dialog", { name: "Display" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(pill).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("keyboard shortcuts render only where a fine pointer exists", async ({
    page,
  }) => {
    await dismissCurtain(page);
    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const fine = await page.evaluate(() => matchMedia("(pointer: fine)").matches);
    await expect(
      page.getByRole("dialog", { name: "Display" }).getByText("Keyboard shortcuts"),
    ).toHaveCount(fine ? 1 : 0);
  });

  test("axe is clean with the display sheet and the info sheet open", async ({
    page,
  }) => {
    await dismissCurtain(page);
    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Display" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await openInfoDialog(page);
    await expect(page.getByRole("dialog", { name: CONTROL_NAME })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("credentials queue: one check per flagged still, retry re-enqueues", async ({
  page,
  request,
}) => {
  const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: {
      accountId: "dbid:AAATESTretention",
      galleries: [
        {
          slug: "c2pa-queue-qa",
          images: [
            { id: "q-flag", filename: "flagged.png", src: "/c2pa-flagged.png", width: 800, height: 600, alt: "flagged", c2pa: true },
            { id: "q-plain", filename: "plain.png", src: "/c2pa-plain.png", width: 800, height: 600, alt: "plain" },
          ],
        },
      ],
    },
  });
  expect(spawn.ok()).toBe(true);

  let flaggedRequests = 0;
  let plainRequests = 0;
  await page.route("**/c2pa-flagged.png", (route) => {
    flaggedRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: Buffer.from(testPng(4, 4).split(",")[1], "base64"),
    });
  });
  await page.route("**/c2pa-plain.png", (route) => {
    plainRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: Buffer.from(testPng(4, 4).split(",")[1], "base64"),
    });
  });

  await dismissCurtain(page, `${BASE}/retention-qa/c2pa-queue-qa`);
  // The display fetch of the first frame may be in flight — wait for it
  // to settle so the deltas below isolate the credential checks.
  await expect.poll(() => flaggedRequests, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  const docked = () => page.locator("[data-stage] [aria-current='true']").getAttribute("data-index");
  await expect.poll(docked).toBe("1");
  const panel = page.locator("[data-c2pa-panel]");
  const dialog = page.getByRole("dialog", { name: CONTROL_NAME });
  // Keyboard arrows ride the strip glide, which coalesces on narrow
  // viewports — the picker's thumbnails commit the frame directly.
  const goToFrame = async (itemIndex: number, dockedIndex: string) => {
    // G opens the picker — the chrome pill is inert at rest, so the
    // keyboard path is the deterministic way in.
    await page.keyboard.press("g");
    await expect(page.locator(".viewer-filmstrip")).toBeVisible();
    await page.locator(".viewer-filmstrip-item").nth(itemIndex).click();
    await expect.poll(docked).toBe(dockedIndex);
    await expect(page.locator(".viewer-filmstrip")).toHaveCount(0);
  };

  // Flagged still: open Info → exactly one fetch of its source.
  const beforeFlag = flaggedRequests;
  await openInfoDialog(page);
  await expect(
    panel,
  ).toContainText(/checking content credentials|verified|could not be checked/i, { timeout: 30000 });
  await expect.poll(() => flaggedRequests - beforeFlag).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // The unflagged still next door never triggers a check — its panel is
  // the quiet no-credentials line, not the first photo's pending state.
  await goToFrame(1, "2");
  const beforePlain = flaggedRequests + plainRequests;
  await openInfoDialog(page);
  await expect(panel).toContainText(/carries no content credentials/i);
  await page.waitForTimeout(400);
  expect(flaggedRequests + plainRequests).toBe(beforePlain);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // Back on the flagged still: a settled check dedupes the repeat open;
  // when the outcome is unavailable the retry affordance re-enqueues it.
  await goToFrame(0, "1");
  const beforeRetry = flaggedRequests;
  await openInfoDialog(page);
  const retry = panel.getByRole("button", { name: /try again|verify on this device/i });
  if (await retry.count()) {
    await retry.click();
    await expect.poll(() => flaggedRequests - beforeRetry, { timeout: 15000 }).toBe(1);
  } else {
    expect(flaggedRequests).toBe(beforeRetry);
  }
});

test("a stalled image re-requests itself instead of staying blank", async ({
  page,
  request,
}) => {
  const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: {
      accountId: "dbid:AAATESTretention",
      galleries: [
        {
          slug: "watchdog-qa",
          images: [
            {
              id: "w-ok",
              filename: "a.png",
              src: testPng(800, 600),
              width: 800,
              height: 600,
              alt: "a",
            },
            {
              id: "w-dead",
              filename: "dead.png",
              src: "/api/test/definitely-missing.png",
              width: 800,
              height: 600,
              alt: "dead",
            },
          ],
        },
      ],
    },
  });
  expect(spawn.ok()).toBe(true);
  await dismissCurtain(page, `${BASE}/retention-qa/watchdog-qa`);
  // The dead source errors on arrival; the watchdog's fast-path re-requests
  // it cache-busted — no gesture, no reload button.
  const dead = page.locator("[data-image-id='w-dead'] .frame-img");
  await expect(dead).toHaveAttribute("src", /mreload=1/, { timeout: 20000 });
  // The healthy neighbour is never touched.
  await expect(
    page.locator("[data-image-id='w-ok'] .frame-img"),
  ).not.toHaveAttribute("src", /mreload/);
});

test("credentialed image validates through the browser reader", async ({
  page,
}) => {
  await dismissCurtain(page);
  const total = await imageCount(page);
  const panel = page.locator("[data-c2pa-panel]");
  const dialog = page.getByRole("dialog", { name: CONTROL_NAME });
  // Keyboard arrows ride the strip glide, which coalesces on narrow
  // viewports — the picker's thumbnails commit the frame directly.
  const goToFrame = async (itemIndex: number, dockedIndex: string) => {
    // G opens the picker — the chrome pill is inert at rest, so the
    // keyboard path is the deterministic way in.
    await page.keyboard.press("g");
    await expect(page.locator(".viewer-filmstrip")).toBeVisible();
    await page.locator(".viewer-filmstrip-item").nth(itemIndex).click();
    await expect.poll(docked).toBe(dockedIndex);
    await expect(page.locator(".viewer-filmstrip")).toHaveCount(0);
  };
  // Credentialed coverage is a property of the seeded album — iCloud
  // derivatives carry none, Dropbox/Drive/MEGA originals keep them — so
  // the spec walks forward to the first credentialed frame instead of
  // assuming a fixed index. A gallery with none is a skip, not a failure.
  for (let i = 0; i < Math.min(total, 8); i++) {
    await openInfoDialog(page);
    await expect(panel).toBeVisible();
    if (await panel.getByText(/no content credentials/i).count()) {
      await page.keyboard.press("Escape");
      if (i < total - 1) await advanceToNextImage(page);
      continue;
    }
    // Credentialed frames auto-verify when the panel opens; the explicit
    // button only survives if auto-verification hasn't started yet.
    const verify = panel.getByRole("button", {
      name: /verify on this device/i,
    });
    if (await verify.count()) await verify.click();
    await expect(panel).toContainText(
      /content credentials verified on this device/i,
      { timeout: 30000 },
    );
    return;
  }
  test.skip(true, "seeded gallery carries no credentialed images");
});

test("public root is a minimal Manorama landing page", async ({
  page,
  request,
}) => {
  const root = await request.get(BASE + "/");
  expect(root.status()).toBe(200);
  // Every HTML response has carried the noindex posture since v1 — the
  // landing page included.
  expect(root.headers()["x-robots-tag"] || "").toContain("noindex");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".landing-page")).toBeVisible();
  await expect(page.locator(".landing-brand")).toBeVisible();
  await expect(page.locator(".landing-brand-mark")).toHaveAttribute(
    "src",
    "/manorama-merged-logo.png",
  );
  await expect(page.locator(".landing-brand h1")).toHaveText(
    "A quieter place to look at photographs, on your own or with anyone.",
  );
  await expect(page.locator(".landing-brand-intro")).toHaveText(
    /Sign in to add public Dropbox, Google Drive, iCloud, or MEGA folders and albums\./,
  );
  await expect(page.locator(".admin-gallery-card")).toHaveCount(0);
});
test("owner admin lists galleries without a selector and remains noindex", async ({
  page,
  request,
}) => {
  const admin = await request.get(BASE + "/" + OWNER);
  expect(admin.status()).toBe(200);
  expect(admin.headers()["x-robots-tag"]).toContain("noindex");
  // domcontentloaded: the admin rail streams ~150 live provider thumbs,
  // so the load event legitimately outlasts a 30s goto. Every assertion
  // below polls a locator — none needs the load event itself.
  await page.goto(BASE + "/" + OWNER, { waitUntil: "domcontentloaded" });
  // The account chrome moved into the slide-out drawer (5e8495a); the
  // page's own h1 is now the galleries heading.
  await expect(page.locator("h1.admin-galleries-heading")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manorama-fy it!" }),
  ).toBeVisible();
  await expect(page.locator(".admin-gallery-card").first()).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("manorama / gallery workbench")).toHaveCount(0);
  await expect(page.getByText("Bring a folder. Make a gallery.")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".admin-gallery-card").first().locator(".admin-gallery-count"),
  ).toHaveText(/\(\d+ photos\)/);
  await expect(page.locator(".admin-brand-title")).toHaveCSS(
    "font-family",
    /Bricolate Grotesque/i,
  );
  // The tagline's italic lives on the <em> inside .admin-intro.
  await expect(page.locator(".admin-intro em").first()).toHaveCSS(
    "font-style",
    "italic",
  );
  await expect(page.locator(".admin-brand-logo")).toHaveAttribute(
    "src",
    "/manorama-merged-logo.png",
  );
  await expect(page.locator(".admin-section-index")).toHaveCount(0);
  await expect(page.getByText("View gallery")).toHaveCount(0);
  await expect(page.locator(".admin-gallery-card .admin-eyebrow")).toHaveCount(
    0,
  );
  // The public address is prefix + slug across sibling nodes inside
  // .admin-gallery-url — assert on the container's combined text. The
  // host is environment-specific (manorama.xyz in prod, localhost in
  // dev), so match the /<owner>/<slug> tail.
  await expect(
    page
      .locator(".admin-gallery-url")
      .filter({ hasText: `/${OWNER}/${SLUG}` }),
  ).toHaveCount(1);
  const firstCard = page.locator(".admin-gallery-card").first();
  await expect(
    firstCard.getByRole("link", { name: /open .* in a new tab/i }),
  ).toHaveAttribute("target", "_blank");
  await expect(firstCard.locator(".admin-gallery-strip-frame")).toBeVisible();
  // The Photo Editor is one horizontal row (owner-approved 2026-10-10):
  // the frame hugs the thumb row — clamp(96px,16dvh,208px) items plus
  // the frame's hairline borders — rather than a fixed pixel height.
  const stripFrameBox = (await firstCard
    .locator(".admin-gallery-strip-frame")
    .boundingBox())!;
  const stripItemBox = (await firstCard
    .locator(".admin-gallery-strip-item")
    .first()
    .boundingBox())!;
  expect(
    Math.abs(stripFrameBox.height - stripItemBox.height),
  ).toBeLessThanOrEqual(3);
  await expect(
    firstCard.getByRole("button", { name: /edit gallery slug/i }),
  ).toBeVisible();
});
test("admin gallery order persists through the 150px reorder rail", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".admin-gallery-card").first();
  const items = card.locator(".admin-gallery-strip-item");
  // Item count comes from the seeded album — only ≥2 is required to
  // prove a reorder.
  expect(await items.count()).toBeGreaterThan(1);
  const firstId = await items.nth(0).getAttribute("data-image-id");
  const secondId = await items.nth(1).getAttribute("data-image-id");
  await items.nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".admin-toast")).toHaveText("Order saved", { timeout: 20000 });
  await expect(
    card.locator(".admin-gallery-strip-item").nth(0),
  ).toHaveAttribute("data-image-id", secondId!);
  await expect(
    card.locator(".admin-gallery-strip-item").nth(1),
  ).toHaveAttribute("data-image-id", firstId!);
});

test("admin gallery images reorder with a real pointer drag", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".admin-gallery-card").first();
  const items = card.locator(".admin-gallery-strip-item");
  const firstId = await items.nth(0).getAttribute("data-image-id");
  const secondId = await items.nth(1).getAttribute("data-image-id");
  const frame = card.locator(".admin-gallery-strip-frame");
  await frame.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  await expect(frame).toBeInViewport();
  await frame.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect(items.nth(0)).toBeInViewport();
  await expect(items.nth(1)).toBeInViewport();
  // Item width comes from the decoded thumbnail's aspect — a lazy provider
  // thumb that has not arrived yet leaves the figure 0px wide and the drag
  // lands on the strip container instead of the item.
  await expect(items.nth(0).locator("img")).toHaveClass(/is-loaded/, { timeout: 30000 });
  await expect(items.nth(1).locator("img")).toHaveClass(/is-loaded/, { timeout: 30000 });
  const sourceBox = await items.nth(1).boundingBox();
  const targetBox = await items.nth(0).boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator(".admin-toast")).toHaveText("Order saved", { timeout: 20000 });
  await expect(
    card.locator(".admin-gallery-strip-item").nth(0),
  ).toHaveAttribute("data-image-id", secondId!);
  await expect(
    card.locator(".admin-gallery-strip-item").nth(1),
  ).toHaveAttribute("data-image-id", firstId!);
});

test("admin gallery strip pans with wheel and touch-style pointer input", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const frame = page.locator(".admin-gallery-strip-frame").first();
  await frame.locator(".admin-gallery-strip-item").evaluateAll((elements) =>
    elements.slice(0, 4).forEach((element) => {
      (element as HTMLElement).style.width = "500px";
    }),
  );
  const dimensions = await frame.evaluate((element) => ({
    scrollWidth: (element as HTMLElement).scrollWidth,
    clientWidth: (element as HTMLElement).clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  await frame.evaluate((element) => {
    (element as HTMLElement).scrollLeft = 0;
  });
  await frame.dispatchEvent("wheel", { deltaY: 180, deltaX: 0, bubbles: true });
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement).scrollLeft),
    )
    .toBeGreaterThan(0);
  const touchPan = await frame.evaluate((element) => {
    const frame = element as HTMLDivElement;
    frame.scrollLeft = 0;
    frame.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 12,
        pointerType: "touch",
        clientX: 320,
        isPrimary: true,
      }),
    );
    frame.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 13,
        pointerType: "touch",
        clientX: 320,
        isPrimary: false,
      }),
    );
    frame.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 13,
        pointerType: "touch",
        clientX: 100,
        isPrimary: false,
      }),
    );
    frame.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 13,
        pointerType: "touch",
        clientX: 100,
        isPrimary: false,
      }),
    );
    frame.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 12,
        pointerType: "touch",
        clientX: 100,
        isPrimary: true,
      }),
    );
    return frame.scrollLeft;
  });
  expect(touchPan).toBeGreaterThan(0);
});

test("admin gallery title and caption edit inline and persist", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".admin-gallery-card").first();
  const titleButton = card.getByRole("button", { name: /edit gallery title/i });
  await titleButton.click();
  const titleInput = page.getByRole("textbox", { name: "Edit gallery title" });
  await titleInput.fill("Italy, seen slowly");
  await titleInput.press("Enter");
  await expect(page.locator(".admin-toast")).toHaveText("Saved", { timeout: 20000 });
  await expect(
    card.getByRole("button", { name: /edit gallery title/i }),
  ).toHaveText("Italy, seen slowly");
  const captionButton = card.getByRole("button", {
    name: /edit gallery caption/i,
  });
  await captionButton.click();
  const captionInput = page.getByRole("textbox", {
    name: "Edit gallery caption",
  });
  await captionInput.fill(
    "A quiet sequence of streets, stone, and weather along an Italian journey.",
  );
  await captionInput.press("Control+Enter");
  await expect(page.locator(".admin-toast")).toHaveText("Saved", { timeout: 20000 });
  await expect(
    card.getByRole("button", { name: /edit gallery caption/i }),
  ).toContainText("A quiet sequence");
});

test("admin gallery slug edits inline and persists the public address", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".admin-gallery-card").first();
  await card.getByRole("button", { name: /edit gallery slug/i }).click();
  const slugInput = page.getByRole("textbox", { name: "Edit gallery slug" });
  const nextSlug = `italy-reframed-${Date.now()}`;
  await slugInput.fill(nextSlug);
  await slugInput.press("Enter");
  await expect(page.locator(".admin-toast")).toHaveText("Saved", { timeout: 20000 });
  await expect(
    card.getByRole("button", { name: /edit gallery slug/i }),
  ).toHaveText(nextSlug);
  await expect(
    page
      .locator(".admin-gallery-url")
      .filter({ hasText: `/${OWNER}/${nextSlug}` }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: /open .* in a new tab/i }),
  ).toHaveAttribute("href", `/${OWNER}/${nextSlug}`);
});

test.describe("admin responsive layout", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("fits the phone viewport without horizontal overflow", async ({
    page,
  }) => {
    await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1.admin-galleries-heading")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      scrollable: document.documentElement.scrollHeight > window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(geometry.scrollable).toBe(true);
    expect(geometry.overflowX).toBeLessThanOrEqual(1);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.locator(".admin-section-index")).toHaveCount(0);
    await expect(page.locator(".admin-gallery-card").first()).toBeVisible();
    const stripFrameBox = (await page
      .locator(".admin-gallery-strip-frame")
      .first()
      .boundingBox())!;
    const stripItemBox = (await page
      .locator(".admin-gallery-strip-item")
      .first()
      .boundingBox())!;
    expect(
      Math.abs(stripFrameBox.height - stripItemBox.height),
    ).toBeLessThanOrEqual(3);
  });
});

test("privacy: gallery remains noindex and unknown paths remain absent", async ({
  request,
}) => {
  const res = await request.get(GALLERY);
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
  const missing = await request.get(`${BASE}/not-a-gallery`);
  expect([403, 404]).toContain(missing.status());
});

test.describe("privacy policy page", () => {
  test("renders three persona cards and the shared sections semantically", async ({
    page,
  }) => {
    await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: /privacy policy/i }),
    ).toBeVisible();
    await expect(page.getByText(/last updated: 1 october 2026/i)).toBeVisible();
    await expect(
      page.locator(".policy-personas > section.policy-card"),
    ).toHaveCount(3);
    for (const name of ["Just looking", "Making galleries", "Pro"]) {
      await expect(page.getByRole("region", { name })).toBeVisible();
    }
    for (const name of [
      /who this is for/i,
      /where photographs go/i,
      /on your device/i,
      /ads and purchases/i,
      /cookies, retention, and your choices/i,
      /services and what comes next/i,
      /contact and changes/i,
    ]) {
      await expect(
        page.getByRole("heading", { level: 2, name }),
      ).toBeVisible();
    }
    const doc = page.locator(".policy-document");
    await expect(doc).toContainText(/encrypted, app-private storage on your device/i);
    await expect(doc).toContainText(/secure device storage/i);
    await expect(doc).toContainText(/house placements/i);
    await expect(doc).toContainText(/non-personalized third-party website ads/i);
    await expect(doc).toContainText(/revenuecat/i);
  });

  test("desktop lays the persona cards out in three columns", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
    const columns = await page
      .locator(".policy-personas")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBe(3);
  });

  test("phone stacks the cards in one column without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
    const columns = await page
      .locator(".policy-personas")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBe(1);
    const horizontalOverflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
    expect(await horizontalOverflow()).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 320, height: 812 });
    expect(await horizontalOverflow()).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 720, height: 900 });
    expect(await horizontalOverflow()).toBeLessThanOrEqual(0);
  });

  test("print emulation yields a legible black-on-white single column", async ({
    page,
  }) => {
    await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
    await page.emulateMedia({ media: "print" });
    const body = await page
      .locator("body")
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, color: s.color };
      });
    expect(body.background).toBe("rgb(255, 255, 255)");
    expect(body.color).toBe("rgb(0, 0, 0)");
    const paragraphColor = await page
      .locator(".policy-section p")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(paragraphColor).toBe("rgb(0, 0, 0)");
    const columns = await page
      .locator(".policy-personas")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBe(1);
  });

  test("axe finds no violations on the policy page", async ({ page }) => {
    await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test("Manorama-fication adds a gallery directly without an intermediate preview", async ({
  page,
}) => {
  await page.route("**/api/galleries", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        gallery: {
          slug: "auto-gallery",
          title: "Auto Gallery",
          caption: "",
          date: "",
          imageCount: 0,
          sourceUrl: "https://www.dropbox.com/scl/fo/example",
          createdAt: new Date().toISOString(),
          images: [],
        },
      }),
    });
  });
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  await page
    .getByLabel(/public dropbox, google drive, icloud, or mega link/i)
    .fill("https://www.dropbox.com/scl/fo/example");
  await page.getByRole("button", { name: "Manorama-fy it!" }).click();
  await expect(page.locator(".admin-toast")).toHaveText(
    "Done! Auto Gallery is at the top.",
  );
  await expect(
    page.locator(".admin-gallery-title", { hasText: "Auto Gallery" }),
  ).toBeVisible();
  await expect(page.locator(".dropbox-scan")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add gallery" })).toHaveCount(
    0,
  );
});


// ── Quick-add, magnifier, and video slides ───────────────────────────
// These exercise the four features added alongside the media union. They
// are written against the same BASE/OWNER/SLUG fixtures as the suite
// above; the video cases need a gallery containing at least one video
// (set GALLERY_VIDEO_SLUG to point at one, else they skip).

const VIDEO_SLUG = process.env.GALLERY_VIDEO_SLUG;

test.describe("quick-add interstitial", () => {
  test("a logged-out visitor sees the branded sign-in detour", async ({ browser }) => {
    // A fresh context: no Access header, no session.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/https://mega.nz/folder/AbCdEf12#a2V5`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-quickadd]")).toHaveAttribute("data-mode", "signin");
    await expect(page.locator("[data-quickadd]")).toHaveAttribute("data-provider", "mega");
    const signin = page.locator('[data-quickadd-signin][href*="/auth/dropbox"]');
    await expect(signin).toBeVisible();
    // The sign-in href must carry the WHOLE current URL, fragment included:
    // the MEGA key lives there and the server never sees it.
    const href = await signin.getAttribute("href");
    expect(href).toContain("/auth/dropbox?next=");
    expect(decodeURIComponent(href ?? "")).toContain("#a2V5");
    await context.close();
  });

  test("the interstitial is never indexed", async ({ request }) => {
    const response = await request.get(`${BASE}/https://mega.nz/folder/AbCdEf12`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
  });

  test("normal routes are not swallowed by the catch-all", async ({ page }) => {
    await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-quickadd]")).toHaveCount(0);
    await expect(page.locator("[data-curtain]")).toBeVisible();
  });

  test("a signed-in visitor gets zero-click creation", async ({ page }) => {
    let posted = false;
    await page.route("**/api/galleries", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posted = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ galleryUrl: `/${OWNER}/${SLUG}`, gallery: { slug: SLUG } }),
      });
    });
    await page.goto(`${BASE}/https://mega.nz/folder/ZeroClick#key`, { waitUntil: "domcontentloaded" });
    // The gallery page keeps loading media after the client-side
    // redirect, so networkidle never settles — assert the navigation and
    // the POST directly instead.
    await expect(page).toHaveURL(GALLERY, { timeout: 15000 });
    expect(posted).toBe(true);
  });
});

test.describe("M magnifier (desktop only)", () => {
  test("M summons a lens that follows the pointer, and Esc dismisses it", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    const page = await context.newPage();
    await dismissCurtain(page);

    await expect(page.locator(".magnifier-lens")).toHaveCount(1);
    await expect(page.locator(".magnifier-lens")).toBeHidden();

    await page.mouse.move(700, 450);
    await page.keyboard.press("m");
    const lens = page.locator(".magnifier-lens");
    await expect(lens).toBeVisible();
    // It replaces the cursor over the stage.
    await expect(page.locator(".viewer-stage")).toHaveClass(/is-magnified/);
    const first = await lens.boundingBox();

    await page.mouse.move(1000, 600);
    await page.waitForTimeout(120);
    const second = await lens.boundingBox();
    expect(second?.x).not.toBe(first?.x);

    await page.keyboard.press("Escape");
    await expect(lens).toBeHidden();

    // And M toggles it off as well as on.
    await page.keyboard.press("m");
    await expect(lens).toBeVisible();
    await page.keyboard.press("m");
    await expect(lens).toBeHidden();
    await context.close();
  });

  test("the lens magnifies the point under the cursor, not an offset of it", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    const page = await context.newPage();
    await dismissCurtain(page);

    // A marker injected into the stage is cloned into the lens world —
    // its transformed position must sit at the lens centre.
    const pt = { x: 400, y: 300 };
    await page.evaluate(({ x, y }) => {
      const marker = document.createElement("div");
      marker.className = "probe-dot";
      marker.style.cssText = `position:absolute;left:${x - 4}px;top:${y - 4}px;width:8px;height:8px;background:#f0f;z-index:99;`;
      document.querySelector("[data-stage]")!.appendChild(marker);
    }, pt);
    await page.mouse.move(pt.x, pt.y);
    await page.keyboard.press("m");
    await expect(page.locator(".magnifier-lens")).toBeVisible();
    await page.waitForTimeout(300);

    const probe = await page.evaluate(() => {
      const lens = document.querySelector(".magnifier-lens")!.getBoundingClientRect();
      const dot = document
        .querySelector(".magnifier-world .probe-dot")!
        .getBoundingClientRect();
      return {
        lens: { x: lens.left + lens.width / 2, y: lens.top + lens.height / 2 },
        dot: { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 },
      };
    });
    expect(Math.abs(probe.dot.x - probe.lens.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(probe.dot.y - probe.lens.y)).toBeLessThanOrEqual(3);
    await context.close();
  });

  test("the lens stays centred on the cursor in a scrolled vertical feed", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    const page = await context.newPage();
    await dismissCurtain(page);
    await showChrome(page);
      await page.getByRole("button", { name: "Display", exact: true }).click();
    await page.getByRole("radio", { name: "Scroll" }).click();
    await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
    await page.keyboard.press("Escape");

    // Deep-scroll the feed and wait for the track to settle — frame
    // heights heal as images decode, which grows scrollHeight and can
    // clamp an early scrollTop. The marker is then placed relative to
    // the *settled* scroll offset, straight under the cursor's viewport
    // point — that is where scroll-compensation matters.
    await page.evaluate(() => {
      document.querySelector("[data-stage]")!.scrollTop = 1500;
    });
    await page.waitForTimeout(1500);
    const pt = { x: 720, y: 450 };
    await page.evaluate(({ x, y }) => {
      const stage = document.querySelector("[data-stage]")!;
      const marker = document.createElement("div");
      marker.className = "probe-dot";
      marker.style.cssText = `position:absolute;left:${x - 4}px;top:${stage.scrollTop + y - 4}px;width:8px;height:8px;background:#f0f;z-index:99;`;
      stage.appendChild(marker);
    }, pt);
    await page.mouse.move(pt.x, pt.y);
    await page.keyboard.press("m");
    await expect(page.locator(".magnifier-lens")).toBeVisible();
    await page.waitForTimeout(300);

    const probe = await page.evaluate(() => {
      const lens = document.querySelector(".magnifier-lens")!.getBoundingClientRect();
      const dot = document
        .querySelector(".magnifier-world .probe-dot")!
        .getBoundingClientRect();
      return {
        lens: { x: lens.left + lens.width / 2, y: lens.top + lens.height / 2 },
        dot: { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 },
      };
    });
    expect(Math.abs(probe.dot.x - probe.lens.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(probe.dot.y - probe.lens.y)).toBeLessThanOrEqual(3);
    await context.close();
  });

  test("the lens is decorative — mirrored content is aria-hidden", async ({ page }) => {
    await dismissCurtain(page);
    await page.mouse.move(700, 450);
    await page.keyboard.press("m");
    await expect(page.locator(".magnifier-lens")).toHaveAttribute("aria-hidden", "true");
  });

  test("opening a modal dismisses the lens", async ({ page }) => {
    await dismissCurtain(page);
    await page.mouse.move(700, 450);
    await page.keyboard.press("m");
    await expect(page.locator(".magnifier-lens")).toBeVisible();
    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await expect(page.locator(".magnifier-lens")).toBeHidden();
  });

  test("absent on a coarse-pointer device", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    const page = await context.newPage();
    await dismissCurtain(page);
    await page.keyboard.press("m");
    await expect(page.locator(".magnifier-lens")).toHaveCount(0);
    await context.close();
  });

  test("the shortcut row appears only where the key works", async ({ page }) => {
    await dismissCurtain(page);
    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await expect(page.locator(".m-shortcut-list", { hasText: "magnify" })).toBeVisible();
  });
});

test.describe("video slides", () => {
  test.skip(!VIDEO_SLUG, "set GALLERY_VIDEO_SLUG to a gallery containing a video");

  const videoGallery = () => `${BASE}/${OWNER}/${VIDEO_SLUG}`;

  test("no media element mounts before the curtain dissolves, or under a modal", async ({ page }) => {
    // The gating that SSR and source-text tests cannot prove: a video-first
    // gallery stays fully inert behind the curtain, and opening a panel
    // releases the media element rather than leaving it playing underneath.
    await page.goto(videoGallery(), { waitUntil: "domcontentloaded" });
    const videos = page.locator("video.frame-video");
    await expect(page.locator("[data-curtain]")).toBeVisible();
    await expect(videos).toHaveCount(0);

    await dismissCurtain(page, videoGallery());
    await expect(videos).toHaveCount(1);

    await showChrome(page);
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Display" })).toBeVisible();
    await expect(videos).toHaveCount(0);
  });

  test("the active slide autoplays muted and looping", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await dismissCurtain(page, videoGallery());
    const video = page.locator("video.frame-video").first();
    await expect(video).toHaveCount(1);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("loop", true);
    await page.waitForTimeout(600);
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("only the active slide mounts a media element", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    // Adjacent frames are posters only — never a second <video>.
    expect(await page.locator("video.frame-video").count()).toBeLessThan(2);
  });

  test("leaving the slide pauses and rewinds it", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    await page.waitForTimeout(800);
    await advanceToNextImage(page);
    const remaining = await page.locator("video.frame-video").count();
    if (remaining > 0) {
      const video = page.locator("video.frame-video").first();
      await expect(video).toHaveJSProperty("currentTime", 0);
    }
  });

  test("the megaphone unmutes and the control is a real button", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    const unmute = page.getByRole("button", { name: /unmute video/i }).first();
    await expect(unmute).toBeVisible();
    await expect(unmute).toHaveAttribute("aria-pressed", "false");
    await unmute.click();
    await expect(page.locator("video.frame-video").first()).toHaveJSProperty("muted", false);
    await expect(page.getByRole("button", { name: /mute video/i }).first()).toHaveAttribute("aria-pressed", "true");
  });

  test("playback controls are keyboard operable", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    const toggle = page.getByRole("button", { name: /pause video|play video/i }).first();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(toggle).toBeFocused();
  });

  test("arrow keys stay pure sequence navigation over a video", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    const before = await page.locator("[aria-current='true']").getAttribute("data-index");
    await advanceToNextImage(page);
    const after = await page.locator("[aria-current='true']").getAttribute("data-index");
    expect(after).not.toBe(before);
  });

  test("reduced motion shows a poster and an explicit Play control", async ({ browser }) => {
    const context = await browser.newContext({
      reducedMotion: "reduce",
      extraHTTPHeaders: { Cookie: await sessionCookie() },
    });
    const page = await context.newPage();
    await dismissCurtain(page, videoGallery());
    await page.waitForTimeout(700);
    const video = page.locator("video.frame-video").first();
    if (await video.count()) await expect(video).toHaveJSProperty("paused", true);
    await expect(page.getByRole("button", { name: /play video/i }).first()).toBeVisible();
    await context.close();
  });

  test("the duration chip is present and announced only visually", async ({ page }) => {
    await dismissCurtain(page, videoGallery());
    const chip = page.locator(".video-chip").first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-hidden", "true");
    await expect(chip).toContainText("VIDEO");
  });
});

test.describe("per-gallery social cards", () => {
  test("the gallery page advertises its own OG image", async ({ page }) => {
    await page.goto(GALLERY, { waitUntil: "domcontentloaded" });
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(ogImage).toContain(`/api/og/${OWNER}/${SLUG}`);
    expect(await page.locator('meta[property="og:image:type"]').getAttribute("content")).toBe("image/jpeg");
  });

  test("the OG endpoint returns an image, never an error page", async ({ request }) => {
    const response = await request.get(`${BASE}/api/og/${OWNER}/${SLUG}`);
    expect([200, 302]).toContain(response.status());
    if (response.status() === 200) {
      expect(response.headers()["content-type"]).toContain("image/");
      expect(response.headers()["cache-control"]).toContain("max-age=86400");
    }
  });

  test("an unknown gallery still yields the fallback card", async ({ request }) => {
    const response = await request.get(`${BASE}/api/og/${OWNER}/definitely-not-a-gallery`, { maxRedirects: 0 });
    expect([302, 200]).toContain(response.status());
  });
});

// ---------------------------------------------------------------------------
// Retention policy + density-aware staging.
//
// These specs run against the second seeded owner (`dbid:AAATESTretention`,
// slug `retention-qa`, free tier, zero galleries after every reset) so their
// gallery counts never depend on which MANORAMA_DEV_SOURCE_* vars are set.
// Galleries are created through the `/.dev-seed/spawn` seam, which goes
// through the same createGalleryWithinLimit policy as the real API, and
// expired through `/.dev-seed/expire`, which runs the real expiry service.
// ---------------------------------------------------------------------------

const RETENTION_ACCOUNT = "dbid:AAATESTretention";
const RETENTION_OWNER = "retention-qa";
const DAY_MS = 24 * 60 * 60 * 1000;

// Minimal hand-rolled PNG: solid-colour 8-bit RGBA at exact dimensions, so
// staged-sizing specs decode real pixels with a known natural size — no
// provider fetch, no shared fixture file.
const pngCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const pngCrc32 = (buffer: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(typed));
  return Buffer.concat([length, typed, crc]);
};

const testPng = (width: number, height: number) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = 88;
      raw[px + 1] = 64;
      raw[px + 2] = 128;
      raw[px + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
};

const fixtureImage = (id: string, width: number, height: number) => ({
  id,
  filename: `${id}.png`,
  src: testPng(width, height),
  width,
  height,
  alt: `${id} test image`,
  c2pa: false,
  placeholder: testPng(8, Math.max(1, Math.round((8 * height) / width))),
});

const retentionApi = async (playwright: PlaywrightApi): Promise<APIRequestContext> =>
  playwright.request.newContext({
    extraHTTPHeaders: { Cookie: await sessionCookie(RETENTION_ACCOUNT) },
  });

type Spawned = { ok: boolean; slug?: string; retention?: string; expiresAt?: string | null; reason?: string };

const spawnGalleries = async (
  request: APIRequestContext,
  galleries: { slug: string; createdAt?: string; images?: unknown[] }[],
): Promise<Spawned[]> => {
  const response = await request.post(`${BASE}/.dev-seed/spawn`, {
    data: { accountId: RETENTION_ACCOUNT, galleries },
  });
  expect(response.status(), "dev-seed spawn").toBe(200);
  return ((await response.json()) as { results: Spawned[] }).results;
};

const setRetentionTier = async (request: APIRequestContext, tier: "free" | "pro") => {
  const response = await request.post(`${BASE}/.dev-seed/tier`, {
    data: { accountId: RETENTION_ACCOUNT, tier },
  });
  expect(response.status()).toBe(200);
};

const runExpiry = async (request: APIRequestContext) => {
  const response = await request.post(`${BASE}/.dev-seed/expire`, { data: {} });
  expect(response.status()).toBe(200);
  return (await response.json()) as { scanned: number; deleted: number; skipped: number; failed: number };
};

const slugs = (...names: string[]) => names.map((slug) => ({ slug }));

test.describe("retention policy", () => {
  test("a free account retains three galleries and overflow turns temporary", async ({ playwright }) => {
    const request = await retentionApi(playwright);
    const results = await spawnGalleries(request, slugs("ret-a", "ret-b", "ret-c", "ret-d"));
    expect(results.slice(0, 3).map((r) => r.retention)).toEqual(["retained", "retained", "retained"]);
    expect(results.slice(0, 3).every((r) => r.expiresAt === null)).toBe(true);
    expect(results[3].retention).toBe("pipeline");
    const expiresIn = Date.parse(results[3].expiresAt!) - Date.now();
    expect(expiresIn).toBeGreaterThan(29 * DAY_MS);
    expect(expiresIn).toBeLessThan(31 * DAY_MS);
    const listed = (await (await request.get(`${BASE}/api/galleries`)).json()).galleries;
    expect(listed.filter((g: { retention?: string }) => g.retention === "retained")).toHaveLength(3);
    const temp = listed.find((g: { slug: string }) => g.slug === "ret-d");
    expect(temp.retention).toBe("pipeline");
    expect(temp.expiresAt).toBeTruthy();
    await request.dispose();
  });

  test("temporary galleries stay public and deletable but reject every edit", async ({ playwright }) => {
    const request = await retentionApi(playwright);
    await spawnGalleries(request, slugs("lk-a", "lk-b", "lk-c", "lk-d"));
    const patch = await request.patch(`${BASE}/api/galleries/lk-d`, { data: { title: "renamed" } });
    expect(patch.status()).toBe(403);
    expect((await patch.json()).code).toBe("GALLERY_READ_ONLY");
    const refresh = await request.post(`${BASE}/api/galleries/lk-d/refresh`);
    expect(refresh.status()).toBe(403);
    const publicPage = await request.get(`${BASE}/${RETENTION_OWNER}/lk-d`);
    expect(publicPage.status()).toBe(200);
    const deleted = await request.delete(`${BASE}/api/galleries/lk-d`);
    expect(deleted.status()).toBe(200);
    const gone = await request.get(`${BASE}/${RETENTION_OWNER}/lk-d`);
    expect(gone.status()).toBe(404);
    await request.dispose();
  });

  test("upgrade promotes temporary galleries and unlocks edits, safely on retries", async ({ playwright }) => {
    const request = await retentionApi(playwright);
    await spawnGalleries(request, slugs("up-a", "up-b", "up-c", "up-d"));
    await setRetentionTier(request, "pro");
    const listed = (await (await request.get(`${BASE}/api/galleries`)).json()).galleries;
    const upgraded = listed.find((g: { slug: string }) => g.slug === "up-d");
    expect(upgraded.retention).toBe("retained");
    expect(upgraded.expiresAt).toBeNull();
    const patch = await request.patch(`${BASE}/api/galleries/up-d`, { data: { title: "unlocked" } });
    expect(patch.status()).toBe(200);
    await setRetentionTier(request, "pro");
    const again = await request.patch(`${BASE}/api/galleries/up-d`, { data: { caption: "still editable" } });
    expect(again.status()).toBe(200);
    await request.dispose();
  });

  test("the daily expiry deletes only expired temporary galleries and reruns harmlessly", async ({ playwright }) => {
    const request = await retentionApi(playwright);
    await spawnGalleries(request, [
      { slug: "ex-a" },
      { slug: "ex-b" },
      { slug: "ex-c" },
      { slug: "ex-old", createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString() },
      { slug: "ex-fresh" },
    ]);
    const counters = await runExpiry(request);
    expect(counters.deleted).toBe(1);
    const oldPage = await request.get(`${BASE}/${RETENTION_OWNER}/ex-old`);
    expect(oldPage.status()).toBe(404);
    const freshPage = await request.get(`${BASE}/${RETENTION_OWNER}/ex-fresh`);
    expect(freshPage.status()).toBe(200);
    expect((await runExpiry(request)).deleted).toBe(0);
    await request.dispose();
  });

  test("a paid account stops at ninety-nine retained galleries", async ({ playwright }) => {
    const request = await retentionApi(playwright);
    await setRetentionTier(request, "pro");
    const batch = await spawnGalleries(request, slugs(...Array.from({ length: 99 }, (_, i) => `cap-${i}`)));
    expect(batch.every((r) => r.ok && r.retention === "retained")).toBe(true);
    const over = await spawnGalleries(request, slugs("cap-99"));
    expect(over[0]).toMatchObject({ ok: false, reason: "limit" });
    await request.dispose();
  });

  test("the dashboard labels temporary galleries and keeps delete available", async ({ playwright, browser }) => {
    const request = await retentionApi(playwright);
    await spawnGalleries(request, slugs("ui-a", "ui-b", "ui-c", "ui-d"));
    await request.dispose();
    const context = await browser.newContext({
      extraHTTPHeaders: { Cookie: await sessionCookie(RETENTION_ACCOUNT) },
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/${RETENTION_OWNER}`, { waitUntil: "domcontentloaded" });
    // The retention disclosure lives in the account drawer now (5e8495a).
    await page.getByRole("button", { name: "Account menu", exact: true }).click();
    await expect(page.getByText(/Free accounts retain up to 3 editable galleries/)).toBeVisible();
    const card = page.locator('[data-gallery-card="ui-d"]');
    await expect(card).toContainText("Temporary ·");
    await expect(card.locator('a[href^="mailto:"]', { hasText: "Upgrade" })).toBeVisible();
    expect(await card.locator('[aria-disabled="true"]').count()).toBeGreaterThan(0);
    await expect(card.getByLabel("Delete ui-d")).toBeEnabled();
    await expect(page.locator('[data-gallery-card="ui-a"] [aria-disabled="true"]')).toHaveCount(0);
    await context.close();
  });
});

test.describe("density-aware staging", () => {
  const densityGallery = async (
    playwright: PlaywrightApi,
    slug: string,
    images: { id: string; w: number; h: number }[],
  ) => {
    const request = await retentionApi(playwright);
    await spawnGalleries(request, [
      { slug, images: images.map(({ id, w, h }) => fixtureImage(id, w, h)) },
    ]);
    await request.dispose();
    return `${BASE}/${RETENTION_OWNER}/${slug}`;
  };

  test("strip fits height-first but never invents pixels — low-res floats shorter", async ({ playwright, browser }) => {
    const url = await densityGallery(playwright, "d-strip", [
      { id: "wide", w: 2400, h: 1600 },
      { id: "tall", w: 1600, h: 2400 },
      { id: "sq", w: 1600, h: 1600 },
    ]);
    // The photostrip fills height-first only while the source has the
    // pixels for it at this density: 2400×1600 can feed the full stage
    // height at DPR 1 but not DPR 2 (needs ~1700 natural px), so it lands
    // at 800 — every displayed pixel is real. DPR 3 caps to 2, so it
    // matches. Expectations derive from the measured stage: with arrows
    // on, the stage is the viewport minus the reserved 64px bar.
    const cases = [{ dpr: 1 }, { dpr: 2 }, { dpr: 3 }];
    for (const expected of cases) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: expected.dpr,
      });
      const page = await context.newPage();
      await dismissCurtain(page, url);
      const stageHeight = await page
        .locator("[data-stage]")
        .evaluate((el) => el.getBoundingClientRect().height);
      // effectiveImageDpr caps the density ask at 2 — anything past
      // retina stages exactly like DPR 2.
      const wantH = Math.min(stageHeight, 1600 / Math.min(expected.dpr, 2));
      const wantW = wantH * 1.5;
      const img = page.locator("[aria-current='true'] .frame-img");
      await expect(img).toBeVisible();
      const box = await img.boundingBox();
      expect(Math.abs(box!.width - wantW)).toBeLessThan(2);
      expect(Math.abs(box!.height - wantH)).toBeLessThan(2);
      // A source with enough pixels still fills the stage — mixed-res
      // folders blend: 1600×2400 has 2400 px for the ~1700 DPR-2 asks.
      if (expected.dpr === 2) {
        const tall = page.locator("[data-image-id='tall'] .frame-img");
        await expect(tall).toBeVisible();
        const tallBox = await tall.boundingBox();
        expect(Math.abs(tallBox!.height - stageHeight)).toBeLessThan(2);
      }
      await context.close();
    }
  });

  test("vertical fits width-first and portraits run long without cropping", async ({ playwright, browser }) => {
    const url = await densityGallery(playwright, "d-vert", [
      { id: "tall", w: 1600, h: 2400 },
      { id: "wide", w: 2400, h: 1600 },
    ]);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.addInitScript((slug) => {
      window.localStorage.setItem(`manorama:view:${slug}`, JSON.stringify({ mode: "vertical" }));
    }, "d-vert");
    await dismissCurtain(page, url);
    const img = page.locator("[aria-current='true'] .frame-img");
    await expect(img).toBeVisible();
    const box = await img.boundingBox();
    expect(Math.abs(box!.width - 800)).toBeLessThan(2);
    expect(Math.abs(box!.height - 1200)).toBeLessThan(2);
    await context.close();
  });

  test("small images stay small, centred, and abut their neighbours", async ({ playwright, browser }) => {
    const url = await densityGallery(playwright, "d-tiny", [
      { id: "tiny", w: 120, h: 80 },
      { id: "tiny2", w: 160, h: 100 },
    ]);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await dismissCurtain(page, url);
    await expect(page.locator('.stage-seq')).toHaveAttribute('aria-label', 'Photograph 1 of 2 — open d-tiny');
    await expect(page.locator('[data-image-id="tiny"]')).toHaveAttribute('aria-current', 'true');
    const frame = page.locator("[aria-current='true']");
    const img = frame.locator(".frame-img");
    await expect(img).toBeVisible();
    const box = await img.boundingBox();
    const frameBox = await frame.boundingBox();
    expect(Math.abs(box!.width - 120)).toBeLessThan(2);
    expect(Math.abs(box!.height - 80)).toBeLessThan(2);
    // Plate-on-mount (ec00cfd): an undersized source keeps honest pixels
    // centred inside a frame that keeps the stage's full height, marked
    // with the mount class — the frame hugs the image in WIDTH only, so
    // neighbours still abut.
    expect(Math.abs(frameBox!.width - box!.width)).toBeLessThan(2);
    const stageHeight = (await page
      .locator("[data-stage]")
      .boundingBox())!.height;
    expect(Math.abs(frameBox!.height - stageHeight)).toBeLessThan(2);
    await expect(frame).toHaveClass(/viewer-frame--short/);
    const stageBox = await page.locator("[data-stage]").boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - (frameBox!.x + frameBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs(box!.y + box!.height / 2 - (stageBox!.y + stageBox!.height / 2))).toBeLessThan(2);
    // The next frame starts where this one ends — no one-image-per-page gap.
    const next = page.locator("[data-image-id='tiny2']");
    const nextBox = await next.boundingBox();
    expect(Math.abs(nextBox!.x - (frameBox!.x + frameBox!.width))).toBeLessThan(2);
    const canvas = await page.locator("[data-stage]").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(canvas).toBe("rgb(10, 10, 10)");
    await context.close();
  });

  test("matching manifest dimensions produce no layout shift", async ({ playwright, browser }) => {
    const url = await densityGallery(playwright, "d-cls", [
      { id: "a", w: 2000, h: 1333 },
      { id: "b", w: 1800, h: 1200 },
    ]);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await dismissCurtain(page, url);
    const cls = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let cls = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
              if (!shift.hadRecentInput) cls += shift.value ?? 0;
            }
          }).observe({ type: "layout-shift", buffered: true });
          setTimeout(() => resolve(cls), 2000);
        }),
    );
    expect(cls).toBeLessThan(0.02);
    await context.close();
  });

  test("only the active window plus its retention tail mounts full-size media", async ({ playwright, browser }) => {
    const url = await densityGallery(
      playwright,
      "d-window",
      Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, w: 1600, h: 1200 })),
    );
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await dismissCurtain(page, url);
    await expect(page.locator(".frame-ph")).toHaveCount(12);
    await expect(page.locator(".frame-img")).toHaveCount(4);
    // Index 4: the ±3 window is 7 frames, plus the MRU tail holds frame 0.
    for (let i = 0; i < 4; i += 1) await advanceToNextImage(page);
    await waitForTrackSettled(page);
    await expect(page.locator(".frame-img")).toHaveCount(8);
    // The tail is bounded: however far the strip advances, the window
    // plus retention never exceeds STRIP_WINDOW*2 + 1 + STRIP_RETAIN.
    for (let i = 0; i < 6; i += 1) await advanceToNextImage(page);
    await waitForTrackSettled(page);
    const mounted = await page.locator(".frame-img").count();
    expect(mounted).toBeLessThanOrEqual(13);
    await context.close();
  });
});

test.describe("PR #48 review fixes — touch counter", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  async function currentTrackX(page: import("@playwright/test").Page): Promise<number> {
    return page.evaluate(() => {
      const track = document.querySelector("[data-track]") as HTMLElement;
      const m = /translate3d\((-?[\d.]+)px/.exec(track.style.transform || "");
      return m ? parseFloat(m[1]) : NaN;
    });
  }

  test("dragging from the sequence counter pans the strip instead of opening the selector", async ({ page }) => {
    await dismissCurtain(page);
    await page.waitForTimeout(3300);
    await ensureStripSettled(page);
    const x0 = await currentTrackX(page);
    const seq = page.locator(".stage-seq");
    const box = await seq.boundingBox();
    expect(box, "counter visible").not.toBeNull();
    const sx = box!.x + box!.width / 2;
    const sy = box!.y + box!.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx - 240, sy, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".viewer-filmstrip")).toHaveCount(0);
    const x1 = await currentTrackX(page);
    expect(x1, `strip should pan from the counter drag (${x0} -> ${x1})`).not.toBe(x0);
  });

  test("tapping the sequence counter opens the selector", async ({ page }) => {
    await dismissCurtain(page);
    await page.waitForTimeout(3300);
    const seq = page.locator(".stage-seq");
    const box = await seq.boundingBox();
    expect(box, "counter visible").not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator(".viewer-filmstrip")).toBeVisible();
  });
});
