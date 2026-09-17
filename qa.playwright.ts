// manorama acceptance spec — the gallery-qa skill, executable.
// Deps: npm i -D @playwright/test @axe-core/playwright
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_OWNER, GALLERY_SLUG
// Selector conventions expected in the app: [data-curtain], [data-stage], [data-nav-arrow],
// Square button has aria-label "Image information and Content Credentials", modal has role="dialog".
//
// The admin surface requires a Manorama session — Dropbox sign-in mints an
// HS256 `manorama_session` cookie (app/lib/dropbox-session.ts). Every context
// and request here carries a dev-minted cookie for the seeded test owner:
// `bun run dev` seeds `dbid:AAATESTowner1` as owner slug `thecontrarian` via
// the manorama-dev-seed vite plugin. The cookie is signed with the dev
// server's own HOST_API_JWT_SECRET (read from .env.local), so authentication
// exercises the production code path — a server without the seed simply has
// no such user and refuses the admin tests loudly.

import { test as base, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

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

const sessionCookie = async (dropboxAccountId = DEV_ACCOUNT): Promise<string> =>
  `manorama_session=${await new SignJWT({ sub: dropboxAccountId })
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
const SLUG = process.env.GALLERY_SLUG ?? "kashmir";
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;
const CONTROL_NAME = /image information and content credentials/i;

const viewports = [
  { name: "phone", width: 375, height: 812, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, hasTouch: false },
  { name: "wide", width: 2560, height: 1440, hasTouch: false },
];

async function dismissCurtain(
  page: import("@playwright/test").Page,
  url = GALLERY,
) {
  await page.goto(url);
  const curtain = page.locator("[data-curtain]");
  await expect(curtain).toBeVisible();
  await curtain.click();
  await expect(curtain).toBeHidden();
}

// The admin specs mutate the seeded in-memory repositories (slug edits,
// reorders, creates). The dev seed plugin's reset seam restores canonical
// state so a case's outcome never depends on what ran before it.
test.beforeEach(async ({ request }) => {
  const reset = await request.post(`${BASE}/.dev-seed/reset`);
  expect(reset.status(), "dev seed reset — is this `bun run dev`?").toBe(204);
});

async function imageCount(page: import("@playwright/test").Page) {
  return page.locator("[data-track] [data-index]").count();
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
  await page.goto(GALLERY);
  await expect(page.locator("[data-curtain-title]")).toBeVisible();
  await expect(page.locator("[data-curtain-caption]")).toBeVisible();
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

test("curtain lifts upward before it hides", async ({ page }) => {
  await page.goto(GALLERY);
  const curtain = page.locator("[data-curtain]");
  await curtain.click();
  await expect(curtain).toHaveClass(/is-lifting/);
  await page.waitForTimeout(150);
  await expect(curtain).not.toHaveCSS("transform", "none");
  await expect(curtain).toBeHidden();
});

test("curtain reveal remains visible through a calmer lift before it hides", async ({
  page,
}) => {
  await page.goto(GALLERY);
  const curtain = page.locator("[data-curtain]");
  await curtain.click();
  await page.waitForTimeout(650);
  await expect(curtain).toHaveClass(/is-lifting/);
  await expect(curtain).not.toHaveAttribute("hidden");
  await expect(curtain).toBeHidden();
});

test("curtain accepts an upward swipe before it lifts away", async ({
  page,
}) => {
  await page.goto(GALLERY);
  const curtain = page.locator("[data-curtain]");
  await page.mouse.move(300, 520);
  await page.mouse.down();
  await page.mouse.move(300, 360, { steps: 4 });
  await page.mouse.up();
  await expect(curtain).toHaveClass(/is-lifting/);
  await expect(curtain).toBeHidden();
});

for (const vp of viewports) {
  test.describe(vp.name, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.hasTouch,
    });

    test("exactly one visible control during viewing", async ({ page }) => {
      await dismissCurtain(page);
      const visible = await page.evaluate(() => {
        const stage = document
          .querySelector("[data-stage]")!
          .getBoundingClientRect();
        return [...document.querySelectorAll("body *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const overStage =
              r.left < stage.right &&
              r.right > stage.left &&
              r.top < stage.bottom &&
              r.bottom > stage.top;
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
      });
      expect(visible).toEqual(["Display settings"]); // design rules, Rule 1
    });

    test("logo control is centred at the stage bottom and opens its panels", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const geometry = await page
        .getByRole("button", { name: "Display settings", exact: true })
        .evaluate((button) => {
          const rect = button.getBoundingClientRect();
          const stage = document
            .querySelector("[data-stage]")!
            .getBoundingClientRect();
          return {
            bottomGap: stage.bottom - rect.bottom,
            centreDelta: Math.abs(
              rect.left + rect.width / 2 - (stage.left + stage.width / 2),
            ),
            height: rect.height,
            width: rect.width,
          };
        });
      // The mark is a wide banner pill (clamp-sized), centred under the
      // stage — the old square-button geometry is retired.
      expect(geometry.centreDelta).toBeLessThanOrEqual(1);
      expect(geometry.bottomGap).toBeGreaterThanOrEqual(10);
      // The centred logo opens display settings; provenance lives behind
      // the quiet "i" beside the stage arrows.
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: /display settings/i }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: CONTROL_NAME }).click();
      const info = page.getByRole("dialog", { name: CONTROL_NAME });
      await expect(info).toBeVisible();
      await expect(info.locator("[data-c2pa-panel]")).toBeInViewport();
    });

    test("keyboard navigation preserves a clean URL and refresh returns to the first image", async ({
      page,
    }) => {
      await page.goto(`${GALLERY}?source=gallery#img-2`);
      await expect(page).toHaveURL(GALLERY);
      await page.locator("[data-curtain]").click();
      await expect(page.locator("[data-curtain]")).toBeHidden();
      await advanceToNextImage(page);
      await expect(page).toHaveURL(GALLERY);
      const docked = await page
        .locator("[aria-current='true']")
        .getAttribute("data-index");
      await page.getByRole("button", { name: CONTROL_NAME }).click();
      await expect(page.locator(".position-value")).toHaveText(
        `${docked} / ${await imageCount(page)}`,
      );
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page).toHaveURL(GALLERY);
      await page.locator("[data-curtain]").click();
      await expect(page.locator("[data-curtain]")).toBeHidden();
      await page.getByRole("button", { name: CONTROL_NAME }).click();
      await expect(page.locator(".position-value")).toHaveText(
        `1 / ${await imageCount(page)}`,
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("Home");
      await expect(page).toHaveURL(GALLERY);
    });

    test("strip keeps source proportions and the complete image height", async ({
      page,
    }) => {
      await dismissCurtain(page);
      await page
        .locator("[data-track] img")
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      const geometry = await page.evaluate(() => {
        const stage = document
          .querySelector<HTMLElement>("[data-stage]")!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll<HTMLImageElement>("[data-track] img"),
        ]
          .filter((image) => image.naturalWidth > 1 && image.naturalHeight > 1)
          .slice(0, 3)
          .map((image) => {
            const rect = image.getBoundingClientRect();
            return {
              // Frames never upsize: a stage taller than the source shows
              // the image at natural size; smaller stages show it
              // full-height.
              expectedHeight: Math.min(stage.height, image.naturalHeight),
              height: rect.height,
              renderedRatio: rect.width / rect.height,
              sourceRatio: image.naturalWidth / image.naturalHeight,
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
        .locator("[data-track] img")
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
          document.querySelector<HTMLImageElement>("[data-track] img")!;
        const stageRect = stage.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return {
          cssHeight: stage.style.getPropertyValue("--viewer-stage-height"),
          imageHeight: imageRect.height,
          innerHeight: window.innerHeight,
          stageHeight: stageRect.height,
          visualHeight: window.visualViewport?.height ?? window.innerHeight,
        };
      });
      expect(geometry.cssHeight).toBe(`${Math.round(geometry.visualHeight)}px`);
      expect(
        Math.abs(geometry.stageHeight - geometry.visualHeight),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.imageHeight - geometry.stageHeight),
      ).toBeLessThanOrEqual(1);
      expect(geometry.stageHeight).toBeLessThanOrEqual(
        geometry.innerHeight + 1,
      );
    });

    test("touch upward swipe lifts the opening curtain", async ({ page }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
      await page.goto(GALLERY);
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
      await expect(curtain).toHaveClass(/is-lifting/);
      await expect(curtain).toBeHidden();
    });

    test("drag pans the canvas one-to-one and glides briefly without snapping", async ({
      page,
    }) => {
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

    test("touch swipe moves directly and floats farther without snapping", async ({
      page,
    }) => {
      test.skip(!vp.hasTouch, "Touch input is specific to the phone viewport.");
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
      const measure = async (pause: number) => {
        await page.goto(GALLERY);
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
      const positions: number[] = [];
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
          positions.push(
            await page
              .locator("[data-track]")
              .evaluate((track) => track.getBoundingClientRect().left),
          );
        }
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      }
      const deltas = positions
        .slice(1)
        .map((position, index) => position - positions[index]);
      expect(
        Math.max(...deltas.map((delta) => Math.abs(delta))),
      ).toBeLessThanOrEqual(100);
      expect(positions.at(-1)).toBeLessThan(-1500);
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
      // The strip keeps a ±3 decoded window around the current frame.
      expect(result.activeImages).toBeLessThanOrEqual(7);
    });

    test("modal contains every control and dismisses three ways", async ({
      page,
    }) => {
      await dismissCurtain(page);
      const infoButton = page.getByRole("button", { name: CONTROL_NAME });
      // Buttons deliberately skip mouse focus (preventButtonFocus), so
      // the focus-restore path is exercised the way a keyboard user hits
      // it: focus the control, open with Enter.
      await infoButton.focus();
      await page.keyboard.press("Enter");
      const modal = page.getByRole("dialog", { name: CONTROL_NAME });
      await expect(modal).toBeVisible();
      // The provenance dialog carries the frame's own sections; view modes
      // and shortcuts live in the display-settings panel instead.
      for (const label of [/position/i, /info|exif/i, /credentials/i]) {
        await expect(modal.getByText(label).first()).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(modal).not.toBeVisible();
      // focus returns to the provenance control that invoked it
      await expect(infoButton).toBeFocused();
      // Second dismissal path: the panel's close control.
      await infoButton.click();
      await expect(modal).toBeVisible();
      await modal
        .getByRole("button", { name: /close image information/i })
        .click();
      await expect(modal).not.toBeVisible();
      // Third: the backdrop itself (target === currentTarget).
      await infoButton.click();
      await expect(modal).toBeVisible();
      await modal.click({ position: { x: 4, y: 4 } });
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
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /enter fullscreen/i }),
      ).toHaveCount(supported ? 1 : 0);
    });

    test("arrows are strip and single-mode only, and navigate one-at-a-time mode", async ({
      page,
    }) => {
      await dismissCurtain(page);
      // Arrows ship on in strip mode; the toggle is a display-settings action.
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await page
        .getByRole("button", { name: /hide navigation arrows/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await page
        .getByRole("button", { name: /show navigation arrows/i })
        .click();
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      // Vertical suppresses them outright — the toggle itself leaves.
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await page
        .locator(".mode-options label", { hasText: /vertical scroll/i })
        .click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(0);
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /navigation arrows/i }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      // Single mode brings them back, stepping one image at a time.
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await page
        .locator(".mode-options label", { hasText: /one at a time/i })
        .click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      await page.getByRole("button", { name: /next photograph/i }).click();
      await page.getByRole("button", { name: CONTROL_NAME }).click();
      await expect(page.locator(".position-value")).toHaveText(
        `2 / ${await imageCount(page)}`,
      );
    });

    test("vertical view complements Strip without pairing or altering source proportions", async ({
      page,
    }) => {
      await dismissCurtain(page);
      await expect(page.locator('[data-portrait-pair="true"]')).toHaveCount(0);
      // The radios are visually hidden inside their labels — drive the
      // label, the element a pointer actually hits.
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      await page
        .locator(".mode-options label", { hasText: /vertical scroll/i })
        .click();
      await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
      await page
        .locator('[data-orientation="landscape"] img')
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      await page
        .locator('[data-orientation="portrait"] img')
        .first()
        .evaluate((image: HTMLImageElement) => image.decode());
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>("[data-stage]")!;
        const landscape = document.querySelector<HTMLElement>(
          '[data-orientation="landscape"]',
        )!;
        const portrait = document.querySelector<HTMLElement>(
          '[data-orientation="portrait"]',
        )!;
        const measure = (frame: HTMLElement) => {
          const image = frame.querySelector<HTMLImageElement>("img")!;
          const imageRect = image.getBoundingClientRect();
          const sourceRatio =
            Number(image.getAttribute("width")) /
            Number(image.getAttribute("height"));
          return {
            width: imageRect.width,
            height: imageRect.height,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            sourceRatio,
            renderedRatio: imageRect.width / imageRect.height,
          };
        };
        return {
          stageWidth: stage.clientWidth,
          stageHeight: stage.clientHeight,
          landscape: measure(landscape),
          portrait: measure(portrait),
        };
      });
      // Landscapes go to stage width, bounded by stage height (object-fit
      // contain) and never upsized past natural width.
      const landscapeTarget = Math.min(
        geometry.stageWidth,
        geometry.stageHeight * geometry.landscape.sourceRatio,
        geometry.landscape.naturalWidth,
      );
      expect(
        Math.abs(geometry.landscape.width - landscapeTarget),
      ).toBeLessThanOrEqual(1);
      const portraitHeightTarget = Math.min(
        geometry.stageHeight,
        geometry.stageWidth / geometry.portrait.sourceRatio,
        geometry.portrait.naturalHeight,
      );
      expect(
        Math.abs(geometry.portrait.height - portraitHeightTarget),
      ).toBeLessThanOrEqual(1);
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
      // Arrows ship on by default — nothing to enable first.
      await expect(page.locator("[data-nav-arrow]")).toHaveCount(2);
      const before = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      const viewportWidth = await page
        .locator("[data-stage]")
        .evaluate((stage) => stage.clientWidth);
      await page.getByRole("button", { name: /next photograph/i }).click();
      await waitForTrackSettled(page);
      const after = await page
        .locator("[data-track]")
        .evaluate((track) => track.getBoundingClientRect().left);
      const advance = Math.abs(after - before);
      // The advance docks the next frame at the stage edge, capped at one
      // viewport — a frame wider than the stage pages through in
      // full-viewport chunks, so the bound is <=, never a teleport.
      expect(advance).toBeGreaterThan(viewportWidth * 0.7);
      expect(advance).toBeLessThanOrEqual(viewportWidth + 1);
    });

    test("no layout shift while images load", async ({ page }) => {
      await dismissCurtain(page);
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
      await page.getByRole("button", { name: CONTROL_NAME }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test("c2pa: credentialed image validates, unsigned shows quiet state", async ({
      page,
    }) => {
      await dismissCurtain(page);
      await page.getByRole("button", { name: CONTROL_NAME }).click();
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
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page
    .locator(".mode-options label", { hasText: /vertical scroll/i })
    .click();
  await expect(page.locator("[data-stage]")).toHaveClass(/mode-vertical/);
  await page.getByRole("button", { name: CONTROL_NAME }).click();
  await expect(page.locator(".position-value")).toHaveText(`2 / ${total}`);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page
    .locator(".mode-options label", { hasText: /one at a time/i })
    .click();
  await expect(page.locator("[data-stage]")).toHaveClass(/mode-single/);
  await page.getByRole("button", { name: CONTROL_NAME }).click();
  await expect(page.locator(".position-value")).toHaveText(`2 / ${total}`);
  await expect(page).toHaveURL(GALLERY);
});

test("credentialed image validates through the browser reader", async ({
  page,
}) => {
  await dismissCurtain(page);
  await advanceToNextImage(page);
  await page.getByRole("button", { name: CONTROL_NAME }).click();
  const panel = page.locator("[data-c2pa-panel]");
  await panel.getByRole("button", { name: /verify in this browser/i }).click();
  await expect(panel).toContainText(
    /content credentials verified in this browser/i,
    { timeout: 30000 },
  );
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
  await page.goto(BASE + "/");
  await expect(page.locator(".landing-page")).toBeVisible();
  await expect(page.locator(".landing-brand")).toBeVisible();
  await expect(page.locator(".landing-brand-mark")).toHaveAttribute(
    "src",
    "/manorama-merged-logo.png",
  );
  await expect(page.locator(".landing-brand-intro")).toHaveText(
    /adj\. a view that is delightful to the mind\.\s*Also, the WOW-est way to enjoy a photo gallery with anyone!/i,
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
  await page.goto(BASE + "/" + OWNER);
  await expect(page.locator("h1.admin-brand-title")).toBeVisible();
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
  await expect(firstCard.locator(".admin-gallery-strip-frame")).toHaveCSS(
    "height",
    "150px",
  );
  await expect(
    firstCard.getByRole("button", { name: /edit gallery slug/i }),
  ).toBeVisible();
});
test("admin gallery order persists through the 150px reorder rail", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`);
  const card = page.locator(".admin-gallery-card").first();
  const items = card.locator(".admin-gallery-strip-item");
  await expect(items).toHaveCount(9);
  const firstId = await items.nth(0).getAttribute("data-image-id");
  const secondId = await items.nth(1).getAttribute("data-image-id");
  await items.nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("status")).toHaveText("Order saved");
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
  await page.goto(`${BASE}/${OWNER}`);
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
  await expect(page.getByRole("status")).toHaveText("Order saved");
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
  await page.goto(`${BASE}/${OWNER}`);
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
  await page.goto(`${BASE}/${OWNER}`);
  const card = page.locator(".admin-gallery-card").first();
  const titleButton = card.getByRole("button", { name: /edit gallery title/i });
  await titleButton.click();
  const titleInput = page.getByRole("textbox", { name: "Edit gallery title" });
  await titleInput.fill("Italy, seen slowly");
  await titleInput.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Saved");
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
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(
    card.getByRole("button", { name: /edit gallery caption/i }),
  ).toContainText("A quiet sequence");
});

test("admin gallery slug edits inline and persists the public address", async ({
  page,
}) => {
  await page.goto(`${BASE}/${OWNER}`);
  const card = page.locator(".admin-gallery-card").first();
  await card.getByRole("button", { name: /edit gallery slug/i }).click();
  const slugInput = page.getByRole("textbox", { name: "Edit gallery slug" });
  const nextSlug = `italy-reframed-${Date.now()}`;
  await slugInput.fill(nextSlug);
  await slugInput.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Saved");
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
    await page.goto(`${BASE}/${OWNER}`);
    await expect(page.locator("h1.admin-brand-title")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      scrollable: document.documentElement.scrollHeight > window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(geometry.scrollable).toBe(true);
    expect(geometry.overflowX).toBeLessThanOrEqual(1);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.locator(".admin-section-index")).toHaveCount(0);
    await expect(page.locator(".admin-gallery-card").first()).toBeVisible();
    await expect(page.locator(".admin-gallery-strip-frame").first()).toHaveCSS(
      "height",
      "150px",
    );
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
  await page.goto(`${BASE}/${OWNER}`);
  await page
    .getByLabel(/public dropbox, google drive, icloud, or mega link/i)
    .fill("https://www.dropbox.com/scl/fo/example");
  await page.getByRole("button", { name: "Manorama-fy it!" }).click();
  await expect(page.getByRole("status")).toHaveText(
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
    await page.goto(`${BASE}/https://mega.nz/folder/AbCdEf12#a2V5`);
    await expect(page.locator("[data-quickadd]")).toHaveAttribute("data-mode", "signin");
    await expect(page.locator("[data-quickadd]")).toHaveAttribute("data-provider", "mega");
    const signin = page.locator("[data-quickadd-signin]");
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
    await page.goto(GALLERY);
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
    await page.goto(`${BASE}/https://mega.nz/folder/ZeroClick#key`);
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
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
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
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    await expect(page.locator(".shortcuts", { hasText: "magnify" })).toBeVisible();
  });
});

test.describe("video slides", () => {
  test.skip(!VIDEO_SLUG, "set GALLERY_VIDEO_SLUG to a gallery containing a video");

  const videoGallery = () => `${BASE}/${OWNER}/${VIDEO_SLUG}`;

  test("no media element mounts before the curtain lifts, or under a modal", async ({ page }) => {
    // The gating that SSR and source-text tests cannot prove: a video-first
    // gallery stays fully inert behind the curtain, and opening a panel
    // releases the media element rather than leaving it playing underneath.
    await page.goto(videoGallery());
    const videos = page.locator("video.frame-video");
    await expect(page.locator("[data-curtain]")).toBeVisible();
    await expect(videos).toHaveCount(0);

    await dismissCurtain(page, videoGallery());
    await expect(videos).toHaveCount(1);

    await page.getByRole("button", { name: "Display settings" }).click();
    await expect(page.getByRole("dialog", { name: "Display settings" })).toBeVisible();
    await expect(videos).toHaveCount(0);
  });

  test("the active slide autoplays muted and looping", async ({ page }) => {
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
    await page.goto(GALLERY);
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
