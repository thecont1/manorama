/// <reference types="node" />
// WebKit-only regression spec for the strip's end-of-gallery bounds.
//
// The strip track is `width: max-content` over `flex: 0 0 auto` frames.
// A strip video frame whose stage is measured now carries an explicit px
// width; before that it fell back to `aspect-ratio` alone, and WebKit let
// the poster `img.frame-ph`'s intrinsic width into the frame's
// max-content contribution even though `width: 100%` bounds the rendered
// box (Chromium resolves the same cycle the other way). The track then
// measures wider than the sum of its laid-out frames: the pan range
// overshoots "The End." card by the excess, the strip docks on empty
// canvas past the card, and Rewind cannot be reached. iPhone Safari is
// the affected engine.
//
// Runs only where `bunx playwright install webkit` has provided a WebKit
// binary; everywhere else the suite has no engine that exhibits the bug.

import { test as base, expect, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { SignJWT } from "jose";

const BASE = process.env.GALLERY_URL ?? "http://localhost:8787";
const SEED_ACCOUNT = "dbid:AAATESTowner1";
const SEED_OWNER = "thecontrarian";

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

const sessionCookie = async (accountId = SEED_ACCOUNT): Promise<string> =>
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

// The iPhone 13 device profile the bug was verified against: a 390x664
// layout viewport puts a 16:9 strip video frame at ~1180px wide, so the
// 2560px poster below inflates the track by ~1380px per video on WebKit.
test.use({
  browserName: "webkit",
  viewport: { width: 390, height: 664 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
});

const webkitAvailable = (() => {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
})();

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

const testPng = (width: number, height: number, rgb: [number, number, number] = [88, 64, 128]) => {
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
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
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

const svgPlaceholder = (width: number, height: number) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`;

// A video slide whose poster PNG is far wider than the staged frame — the
// intrinsic-vs-used gap that inflated the track on WebKit. `src` stays
// empty: the layout under test is the poster's, and no playable bytes are
// needed to measure it.
const fixtureVideo = (id: string, posterSrc: string) => ({
  type: "video" as const,
  id,
  filename: `${id}.mp4`,
  src: "",
  mimeType: "video/mp4" as const,
  width: 1920,
  height: 1080,
  durationSeconds: 5,
  poster: { src: posterSrc, width: 1920, height: 1080 },
  alt: `${id} test video`,
  c2pa: false as const,
  placeholder: svgPlaceholder(1920, 1080),
  variants: [{ width: 320, src: posterSrc, format: "png" }],
});

const fixturePhoto = (id: string, width: number, height: number, rgb: [number, number, number]) => ({
  id,
  filename: `${id}.png`,
  src: testPng(width, height, rgb),
  width,
  height,
  alt: `${id} test image`,
  c2pa: false,
  placeholder: svgPlaceholder(width, height),
});

// Eight items — videos and photographs interleaved, the last a still — so
// the strip exercises the mixed sequence a real gallery carries. A unique
// slug per run keeps respawns from tripping the duplicate-slug conflict.
const galleryImages = () => {
  const poster = testPng(2560, 1440, [64, 88, 160]);
  return [
    fixturePhoto("wk-p0", 1200, 900, [88, 64, 128]),
    fixtureVideo("wk-v1", poster),
    fixturePhoto("wk-p2", 1000, 1250, [128, 88, 64]),
    fixtureVideo("wk-v3", poster),
    fixturePhoto("wk-p4", 1400, 1050, [64, 128, 88]),
    fixtureVideo("wk-v5", poster),
    fixturePhoto("wk-p6", 900, 900, [110, 70, 120]),
    fixturePhoto("wk-p7", 1600, 1200, [70, 110, 130]),
  ];
};

test.describe("strip endcap bounds on WebKit", () => {
  test.skip(!webkitAvailable, "requires `bunx playwright install webkit`");

  test("the endcard docks flush with the stage's right edge and Rewind rides home", async ({
    page,
    request,
  }) => {
    const slug = `endcap-webkit-${Date.now().toString(36)}`;
    const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
      data: {
        accountId: SEED_ACCOUNT,
        galleries: [{ slug, images: galleryImages() }],
      },
    });
    expect(spawn.status(), "dev-seed spawn — is this `bun run dev`?").toBe(200);
    const spawned = (await spawn.json()) as { results?: { ok?: boolean }[] };
    expect(spawned.results?.[0]?.ok, "spawned gallery was accepted").toBe(true);

    await page.goto(`${BASE}/${SEED_OWNER}/${slug}`, { waitUntil: "domcontentloaded" });
    const curtain = page.locator("[data-curtain]");
    // The curtain's pre-hydration replay can eat an early trusted tap, so
    // tap until it actually hides rather than asserting on the first try.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const curtainBox = await curtain.boundingBox();
      if (!curtainBox) break;
      await page.touchscreen.tap(curtainBox.x + curtainBox.width / 2, curtainBox.y + curtainBox.height / 2);
      try {
        await expect(curtain).toBeHidden({ timeout: 2_500 });
        break;
      } catch {
        // Still visible — the tap never reached the curtain's handler.
      }
    }
    await expect(curtain).toBeHidden({ timeout: 10_000 });

    const track = page.locator("[data-track]");
    const stage = page.locator("[data-stage]");
    const endcap = page.locator("[data-endcard]");
    await expect(endcap).toHaveCount(1);
    const stageBox = await stage.boundingBox();

    /* The track must never measure wider than its laid-out frames — the
       inflated read is what used to park the endcard off-stage. Video
       frames are the only children that could contribute an intrinsic
       width here; photos carry explicit staged px widths. The laid-out
       extent of the last card includes its own trailing canvas gutter:
       with Blank retired every gallery carries the 10px strip margins,
       and the track legitimately ends one gutter past the card's border
       box. Without Blank there is no zero-margin configuration left to
       measure, so the gutter is folded into the expectation rather than
       the stage being reseeded onto a retired preference. */
    await expect
      .poll(
        async () =>
          endcap.evaluate((el) => {
            const trackEl = el.parentElement as HTMLElement;
            const trailing = parseFloat(getComputedStyle(el).marginRight) || 0;
            return Math.abs(
              trackEl.offsetWidth - (el.offsetLeft + el.offsetWidth + trailing),
            );
          }),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(1);

    // The strip's glide is transform-driven; "settled" means two reads
    // 160ms apart agree. A drag that lands mid-glide is swallowed, so every
    // gesture below waits for rest first.
    const stripSettled = async () =>
      expect
        .poll(
          async () => {
            const a = await track.evaluate((el) => el.style.transform);
            await new Promise((resolve) => setTimeout(resolve, 160));
            const b = await track.evaluate((el) => el.style.transform);
            return a === b;
          },
          { timeout: 8_000 },
        )
        .toBe(true);

    // Reaching the last photograph alone keeps the card disarmed.
    await page.keyboard.press("End");
    await expect.poll(async () => track.evaluate((el) => el.style.transform)).toContain("translate3d");
    await stripSettled();

    // Dragging past the last photograph is the touch path to the card: the
    // reveal joins it to the pan range and the gesture carries into it.
    // Its margin box must dock flush with the stage's right edge — under
    // the inflated track the strip parked on canvas past the card
    // instead. The border box itself sits one gutter inside, exactly like
    // the second test's dockedDelta measures.
    const dragPastEnd = async () => {
      await page.mouse.move(stageBox!.x + stageBox!.width - 20, stageBox!.y + stageBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(stageBox!.x + stageBox!.width - 1400, stageBox!.y + stageBox!.height / 2, { steps: 14 });
      await page.mouse.up();
    };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await dragPastEnd();
      await stripSettled();
      if (await endcap.evaluate((el) => !el.hasAttribute("inert"))) break;
    }
    await expect
      .poll(async () => {
        const box = await endcap.boundingBox();
        if (!box) return Infinity;
        const marginRight = await endcap.evaluate(
          (el) => parseFloat(getComputedStyle(el).marginRight) || 0,
        );
        return Math.abs(box.x + box.width + marginRight - (stageBox!.x + stageBox!.width));
      }, { timeout: 10_000 })
      .toBeLessThan(2);

    // A real tap on Rewind runs the strip home — the position readout and
    // the left edge both return to the first photograph.
    const reset = endcap.getByRole("button", { name: /^rewind$/i });
    const resetBox = await reset.boundingBox();
    expect(resetBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
    await page.touchscreen.tap(resetBox!.x + resetBox!.width / 2, resetBox!.y + resetBox!.height / 2);
    await expect(page.locator("[data-chrome-position]")).toHaveText("1 of 8", { timeout: 10_000 });
    await expect
      .poll(async () => Math.abs((await track.boundingBox())!.x - stageBox!.x), { timeout: 10_000 })
      .toBeLessThan(2);
  });

  // A canvas switch restages the strip while "The End." card is docked.
  // The original bug (repro: /tmp/dark-switch2.mjs against
  // manorama.xyz/vidzee/singapore) was a Blank → Dark switch shrinking
  // the track under a stale transform and parking the card off the left
  // edge with Rewind unreachable. Blank has since been retired — every
  // canvas carries the same 10px margin, so the switch must leave the
  // dock exactly where it was. Both directions of the surviving pairing
  // are exercised: the re-dock still runs, and a settled card that
  // drifts at all is the regression.
  test("a canvas switch while docked on the endcard holds the flush dock, both directions", async ({
    page,
    request,
  }) => {
    const slug = `endcap-canvas-${Date.now().toString(36)}`;
    const spawn = await request.post(`${BASE}/.dev-seed/spawn`, {
      data: {
        accountId: SEED_ACCOUNT,
        galleries: [{ slug, images: galleryImages() }],
      },
    });
    expect(spawn.status(), "dev-seed spawn — is this `bun run dev`?").toBe(200);
    const spawned = (await spawn.json()) as { results?: { ok?: boolean }[] };
    expect(spawned.results?.[0]?.ok, "spawned gallery was accepted").toBe(true);

    await page.goto(`${BASE}/${SEED_OWNER}/${slug}`, { waitUntil: "domcontentloaded" });
    const curtain = page.locator("[data-curtain]");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const curtainBox = await curtain.boundingBox();
      if (!curtainBox) break;
      await page.touchscreen.tap(curtainBox.x + curtainBox.width / 2, curtainBox.y + curtainBox.height / 2);
      try {
        await expect(curtain).toBeHidden({ timeout: 2_500 });
        break;
      } catch {
        // Still visible — the tap never reached the curtain's handler.
      }
    }
    await expect(curtain).toBeHidden({ timeout: 10_000 });

    const track = page.locator("[data-track]");
    const stage = page.locator("[data-stage]");
    const endcap = page.locator("[data-endcard]");
    await expect(endcap).toHaveCount(1);
    const stageBox = await stage.boundingBox();

    const stripSettled = async () =>
      expect
        .poll(
          async () => {
            const a = await track.evaluate((el) => el.style.transform);
            await new Promise((resolve) => setTimeout(resolve, 160));
            const b = await track.evaluate((el) => el.style.transform);
            return a === b;
          },
          { timeout: 8_000 },
        )
        .toBe(true);

    // Same path to the docked card as the first test: End, then drags
    // past the last photograph until the reveal joins the card to the
    // pan range and the gesture carries it flush to the right edge.
    await page.keyboard.press("End");
    await expect.poll(async () => track.evaluate((el) => el.style.transform)).toContain("translate3d");
    await stripSettled();
    const dragPastEnd = async () => {
      await page.mouse.move(stageBox!.x + stageBox!.width - 20, stageBox!.y + stageBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(stageBox!.x + stageBox!.width - 1400, stageBox!.y + stageBox!.height / 2, { steps: 14 });
      await page.mouse.up();
    };
    // The card's margin box — border box plus its trailing gutter — is
    // what docks flush: Dark/Light give the card the same 10px right
    // margin every strip frame carries, so its border box rightly sits
    // one gutter inside the stage edge.
    const dockedDelta = async () => {
      const box = await endcap.boundingBox();
      if (!box) return Infinity;
      const marginRight = await endcap.evaluate(
        (el) => parseFloat(getComputedStyle(el).marginRight) || 0,
      );
      return Math.abs(box.x + box.width + marginRight - (stageBox!.x + stageBox!.width));
    };
    // Keep dragging until the card is revealed AND actually docked —
    // breaking on the reveal alone can leave the strip short of the end
    // when a gesture's momentum dies early.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await dragPastEnd();
      await stripSettled();
      const revealed = await endcap.evaluate((el) => !el.hasAttribute("inert"));
      if (revealed && (await dockedDelta()) < 5) break;
    }
    const expectDockedFlush = async () => {
      await expect.poll(dockedDelta, { timeout: 10_000 }).toBeLessThan(2);
      // Rewind must be reachable — fully inside the stage, not parked
      // off the left edge the way the stale transform left it.
      const rewindBox = await endcap.getByRole("button", { name: /^rewind$/i }).boundingBox();
      expect(rewindBox).not.toBeNull();
      expect(rewindBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
      expect(rewindBox!.x + rewindBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width);
      expect(rewindBox!.y).toBeGreaterThanOrEqual(stageBox!.y);
      expect(rewindBox!.y + rewindBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height);
    };
    await expectDockedFlush();

    // Chrome up, then Gallery Settings → Canvas. The segmented control's
    // radios are the canvas choices; the sheet stays open across picks.
    await page.touchscreen.tap(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2);
    await page.getByRole("button", { name: /gallery settings/i }).first().click({ timeout: 5_000 });
    const canvas = page.getByRole("radiogroup", { name: "Canvas" });
    // The gallery mounted on the Dark default; switching to Light
    // repaints the field without changing the frame margins, and the
    // re-dock that runs must resettle the card at the same flush end.
    await canvas.getByRole("radio", { name: "Light" }).click({ timeout: 5_000 });
    await expectDockedFlush();
    await canvas.getByRole("radio", { name: "Dark" }).click({ timeout: 5_000 });
    // And back — the charcoal pairing holds the dock just as surely.
    await expectDockedFlush();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // Still docked and reachable: Rewind runs home.
    const reset = endcap.getByRole("button", { name: /^rewind$/i });
    const resetBox = await reset.boundingBox();
    expect(resetBox).not.toBeNull();
    await page.touchscreen.tap(resetBox!.x + resetBox!.width / 2, resetBox!.y + resetBox!.height / 2);
    await expect(page.locator("[data-chrome-position]")).toHaveText("1 of 8", { timeout: 10_000 });
    await expect
      .poll(async () => Math.abs((await track.boundingBox())!.x - stageBox!.x), { timeout: 10_000 })
      .toBeLessThan(2);
  });
});
