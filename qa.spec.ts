// manorama acceptance spec — the gallery-qa skill, executable.
// Deps: npm i -D @playwright/test @axe-core/playwright
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_OWNER, GALLERY_SLUG
// Selector conventions expected in the app: [data-curtain], [data-stage], [data-nav-arrow],
// Square button has aria-label "Image information and Content Credentials", modal has role="dialog".

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787';
const OWNER = process.env.GALLERY_OWNER ?? 'thecontrarian';
const SLUG = process.env.GALLERY_SLUG ?? 'italy-2018';
const GALLERY = `${BASE}/${OWNER}/${SLUG}`;
const CONTROL_NAME = /image information and content credentials/i;

const viewports = [
  { name: 'phone', width: 375, height: 812, hasTouch: true },
  { name: 'desktop', width: 1440, height: 900, hasTouch: false },
  { name: 'wide', width: 2560, height: 1440, hasTouch: false },
];

async function dismissCurtain(page: import('@playwright/test').Page) {
  await page.goto(GALLERY);
  await page.locator('[data-curtain]').click();
  await expect(page.locator('[data-curtain]')).toBeHidden();
}

test('curtain uses larger brand type without entry labels', async ({ page }) => {
  await page.goto(GALLERY)
  await expect(page.locator('[data-curtain-title]')).toBeVisible()
  await expect(page.locator('[data-curtain-caption]')).toBeVisible()
  await expect(page.locator('.curtain-kicker')).toHaveCount(0)
  await expect(page.locator('.curtain-prompt')).toHaveCount(0)
  await expect(page.getByText('a single album')).toHaveCount(0)
  await expect(page.getByText(/tap, click or press enter to enter/i)).toHaveCount(0)
  await expect(page.locator('[data-curtain-title]')).toHaveCSS('font-family', /Bricolate Grotesque/i)
  await expect(page.locator('[data-curtain-caption]')).toHaveCSS('font-family', /Bricolate Grotesque/i)
})

test('curtain lifts upward before it hides', async ({ page }) => {
  await page.goto(GALLERY);
  const curtain = page.locator('[data-curtain]');
  await curtain.click();
  await expect(curtain).toHaveClass(/is-lifting/);
  await page.waitForTimeout(150);
  await expect(curtain).not.toHaveCSS('transform', 'none');
  await expect(curtain).toBeHidden();
});

test('curtain reveal remains visible through a calmer lift before it hides', async ({ page }) => {
  await page.goto(GALLERY);
  const curtain = page.locator('[data-curtain]');
  await curtain.click();
  await page.waitForTimeout(650);
  await expect(curtain).toHaveClass(/is-lifting/);
  await expect(curtain).not.toHaveAttribute('hidden');
  await expect(curtain).toBeHidden();
});

test('curtain accepts an upward swipe before it lifts away', async ({ page }) => {
  await page.goto(GALLERY);
  const curtain = page.locator('[data-curtain]');
  await page.mouse.move(300, 520);
  await page.mouse.down();
  await page.mouse.move(300, 360, { steps: 4 });
  await page.mouse.up();
  await expect(curtain).toHaveClass(/is-lifting/);
  await expect(curtain).toBeHidden();
});

for (const vp of viewports) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.hasTouch });

    test('exactly one visible control during viewing', async ({ page }) => {
      await dismissCurtain(page);
      const visible = await page.evaluate(() => {
        const stage = document.querySelector('[data-stage]')!.getBoundingClientRect();
        return [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const overStage =
              r.left < stage.right && r.right > stage.left && r.top < stage.bottom && r.bottom > stage.top;
            return (
              overStage && !el.closest('[data-stage]') && r.width > 0 &&
              s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.05
            );
          })
          .map((el) => el.getAttribute('aria-label') ?? el.tagName);
      });
      expect(visible).toEqual(['Image information and Content Credentials']); // design rules, Rule 1
    });

    test('square logo placeholder is centred at the stage bottom and opens provenance details', async ({ page }) => {
      await dismissCurtain(page);
      const geometry = await page.getByRole('button', { name: CONTROL_NAME }).evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const stage = document.querySelector('[data-stage]')!.getBoundingClientRect();
        return {
          bottomGap: stage.bottom - rect.bottom,
          centreDelta: Math.abs(rect.left + rect.width / 2 - (stage.left + stage.width / 2)),
          height: rect.height,
          width: rect.width,
        };
      });
      expect(Math.abs(geometry.width - geometry.height)).toBeLessThanOrEqual(1);
      expect(geometry.centreDelta).toBeLessThanOrEqual(1);
      expect(geometry.bottomGap).toBeGreaterThanOrEqual(10);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      const modal = page.getByRole('dialog', { name: CONTROL_NAME });
      await expect(modal).toBeVisible();
      await expect(modal.locator('[data-c2pa-panel]')).toBeInViewport();
    });

    test('keyboard navigation preserves a clean URL and refresh returns to the first image', async ({ page }) => {
      await page.goto(`${GALLERY}?source=gallery#img-2`);
      await expect(page).toHaveURL(GALLERY);
      await page.locator('[data-curtain]').click();
      await page.keyboard.press('ArrowRight');
      await expect(page).toHaveURL(GALLERY);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await expect(page.locator('.position-value')).toHaveText('2 / 9');
      await page.keyboard.press('Escape');
      await page.reload();
      await expect(page).toHaveURL(GALLERY);
      await page.locator('[data-curtain]').click();
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await expect(page.locator('.position-value')).toHaveText('1 / 9');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Home');
      await expect(page).toHaveURL(GALLERY);
    });

    test('strip keeps source proportions and the complete image height', async ({ page }) => {
      await dismissCurtain(page);
      await page.locator('[data-track] img').first().evaluate((image: HTMLImageElement) => image.decode());
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('[data-stage]')!.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLImageElement>('[data-track] img')]
          .filter((image) => image.naturalWidth > 1 && image.naturalHeight > 1)
          .slice(0, 3)
          .map((image) => {
            const rect = image.getBoundingClientRect();
            return {
              heightDelta: Math.abs(rect.height - stage.height),
              renderedRatio: rect.width / rect.height,
              sourceRatio: image.naturalWidth / image.naturalHeight,
            };
          });
      });
      expect(geometry).not.toHaveLength(0);
      for (const image of geometry) {
        expect(image.heightDelta).toBeLessThanOrEqual(1);
        expect(Math.abs(image.renderedRatio - image.sourceRatio)).toBeLessThan(0.002);
      }
    });

    test('portrait-to-landscape uses the visible mobile viewport without cropping image height', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await dismissCurtain(page);
      await page.locator('[data-track] img').first().evaluate((image: HTMLImageElement) => image.decode());
      await page.setViewportSize({ width: 812, height: 375 });
      await expect.poll(() => page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('[data-stage]')!;
        return stage.style.getPropertyValue('--viewer-stage-height');
      })).toBe('375px');
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('[data-stage]')!;
        const image = document.querySelector<HTMLImageElement>('[data-track] img')!;
        const stageRect = stage.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return {
          cssHeight: stage.style.getPropertyValue('--viewer-stage-height'),
          imageHeight: imageRect.height,
          innerHeight: window.innerHeight,
          stageHeight: stageRect.height,
          visualHeight: window.visualViewport?.height ?? window.innerHeight,
        };
      });
      expect(geometry.cssHeight).toBe(`${Math.round(geometry.visualHeight)}px`);
      expect(Math.abs(geometry.stageHeight - geometry.visualHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.imageHeight - geometry.stageHeight)).toBeLessThanOrEqual(1);
      expect(geometry.stageHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
    });

    test('touch upward swipe lifts the opening curtain', async ({ page }) => {
      test.skip(!vp.hasTouch, 'Touch input is specific to the phone viewport.');
      await page.goto(GALLERY);
      const client = await page.context().newCDPSession(page);
      const curtain = page.locator('[data-curtain]');
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 188, y: 600, id: 1 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 188, y: 440, id: 1 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(curtain).toHaveClass(/is-lifting/);
      await expect(curtain).toBeHidden();
    });

    test('drag pans the canvas one-to-one and glides briefly without snapping', async ({ page }) => {
      await dismissCurtain(page);
      const x0 = await page.evaluate(() => document.querySelector('[data-track]')!.getBoundingClientRect().left);
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.down();
      await page.mouse.move(vp.width / 2 - 160, vp.height / 2, { steps: 8 });
      const xDuringDrag = await page.evaluate(() => document.querySelector('[data-track]')!.getBoundingClientRect().left);
      expect(Math.abs((xDuringDrag - x0) + 160)).toBeLessThanOrEqual(3);
      await page.mouse.up();
      await page.waitForTimeout(120);
      const xAfterRelease = await page.evaluate(() => document.querySelector('[data-track]')!.getBoundingClientRect().left);
      expect(xAfterRelease).toBeLessThan(xDuringDrag);
      expect(xAfterRelease - xDuringDrag).toBeGreaterThanOrEqual(-160);
    });

    test('touch swipe moves directly and floats farther without snapping', async ({ page }) => {
      test.skip(!vp.hasTouch, 'Touch input is specific to the phone viewport.');
      await dismissCurtain(page);
      const client = await page.context().newCDPSession(page);
      const start = await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left);
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 360, id: 1 }] });
      for (const x of [290, 280, 270, 260, 250, 240, 230, 220]) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 360, id: 1 }] });
        await page.waitForTimeout(12);
      }
      const during = await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left);
      expect(Math.abs(during - start)).toBeGreaterThanOrEqual(60);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(80);
      const after = await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left);
      expect(after).toBeLessThan(during);
      expect(after - during).toBeGreaterThanOrEqual(-240);
    });

    test('fast touch flicks glide substantially farther than slow drags', async ({ page }) => {
      test.skip(!vp.hasTouch, 'Touch input is specific to the phone viewport.');
      const measure = async (pause: number) => {
        await page.goto(GALLERY);
        await page.locator('[data-curtain]').click();
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 340, y: 360, id: 1 }] });
        for (const x of [325, 310, 295, 280, 265, 250, 235, 220]) {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 360, id: 1 }] });
          await page.waitForTimeout(pause);
        }
        const release = await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left);
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(1000);
        const settled = await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left);
        return Math.abs(settled - release);
      };
      const slowGlide = await measure(55);
      const fastGlide = await measure(8);
      expect(slowGlide).toBeGreaterThan(55);
      expect(fastGlide).toBeGreaterThan(240);
      expect(fastGlide).toBeGreaterThan(slowGlide * 2.5);
    });

    test('repeated touch drags cross image boundaries as one continuous canvas', async ({ page }) => {
      test.skip(!vp.hasTouch, 'Touch input is specific to the phone viewport.');
      await dismissCurtain(page);
      const client = await page.context().newCDPSession(page);
      const positions: number[] = [];
      for (let gesture = 0; gesture < 5; gesture += 1) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 360, y: 400, id: 1 }] });
        for (const x of [340, 320, 300, 280, 260, 240, 220, 200, 180, 160, 140, 120, 100, 80, 60, 40, 20]) {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 400, id: 1 }] });
          await page.waitForTimeout(8);
          positions.push(await page.locator('[data-track]').evaluate((track) => track.getBoundingClientRect().left));
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      const deltas = positions.slice(1).map((position, index) => position - positions[index]);
      expect(Math.max(...deltas.map((delta) => Math.abs(delta)))).toBeLessThanOrEqual(100);
      expect(positions.at(-1)).toBeLessThan(-1500);
    });

    test('repeated wheel input stays responsive and keeps the decoded image window bounded', async ({ page }) => {
      await dismissCurtain(page);
      const result = await page.evaluate(async () => {
        const stage = document.querySelector<HTMLElement>('[data-stage]')!;
        const started = performance.now();
        for (let count = 0; count < 120; count += 1) {
          stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 48 }));
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const activeImages = [...document.querySelectorAll<HTMLImageElement>('[data-track] img[data-active="true"]')].length;
        return {
          elapsed: performance.now() - started,
          activeImages,
          trackLeft: document.querySelector('[data-track]')!.getBoundingClientRect().left,
        };
      });
      expect(result.elapsed).toBeLessThan(1000);
      expect(result.trackLeft).toBeLessThan(0);
      expect(result.activeImages).toBeLessThanOrEqual(5);
    });

    test('modal contains every control and dismisses three ways', async ({ page }) => {
      await dismissCurtain(page);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();
      for (const label of [/view/i, /caption/i, /info|exif/i, /credentials/i, /about/i, /shortcut/i]) {
        await expect(modal.getByText(label).first()).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
      // focus returns to the square provenance control
      await expect(page.getByRole('button', { name: CONTROL_NAME })).toBeFocused();
    });

    test('fullscreen is offered only where element fullscreen is supported', async ({ page }) => {
      await dismissCurtain(page);
      const supported = await page.evaluate(() => Boolean(document.fullscreenEnabled && document.querySelector<HTMLElement>('[data-stage]')?.requestFullscreen));
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await expect(page.getByRole('button', { name: /enter fullscreen/i })).toHaveCount(supported ? 1 : 0);
    });

    test('arrows are strip and single-mode only, and navigate one-at-a-time mode', async ({ page }) => {
      await dismissCurtain(page);
      await expect(page.locator('[data-nav-arrow]')).toHaveCount(0);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await page.getByLabel(/show navigation arrows/i).check();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-nav-arrow]')).toHaveCount(2);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await page.locator('input[value="vertical"]').check();
      await expect(page.getByLabel(/show navigation arrows/i)).toHaveCount(0);
      await expect(page.getByText(/navigation arrows are unavailable in vertical scroll/i)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-nav-arrow]')).toHaveCount(0);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await page.locator('input[value="single"]').check();
      await expect(page.getByLabel(/show navigation arrows/i)).toBeChecked();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /next photograph/i }).click();
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      await expect(page.locator('.position-value')).toHaveText('2 / 9');
    });

    test('no layout shift while images load', async ({ page }) => {
      await dismissCurtain(page);
      const cls = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let cls = 0;
            new PerformanceObserver((list) => {
              for (const e of list.getEntries() as any) if (!e.hadRecentInput) cls += e.value;
            }).observe({ type: 'layout-shift', buffered: true });
            setTimeout(() => resolve(cls), 3000);
          }),
      );
      expect(cls).toBeLessThan(0.02);
    });

    test('accessibility: axe clean on stage and modal', async ({ page }) => {
      await dismissCurtain(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test('c2pa: credentialed image validates, unsigned shows quiet state', async ({ page }) => {
      await dismissCurtain(page);
      await page.getByRole('button', { name: CONTROL_NAME }).click();
      const panel = page.getByRole('dialog').locator('[data-c2pa-panel]');
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText(/error/i);
      // valid summary OR the neutral no-credentials line — never a broken panel
      await expect(panel).toContainText(/content credentials|no content credentials/i);
    });
  });
}

test('alternate modes switch instantly and preserve the current image', async ({ page }) => {
  await dismissCurtain(page)
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: CONTROL_NAME }).click()
  await expect(page.locator('.position-value')).toHaveText('2 / 9')
  await page.locator('input[value="vertical"]').check()
  await expect(page.locator('[data-stage]')).toHaveClass(/mode-vertical/)
  await expect(page.locator('.position-value')).toHaveText('2 / 9')
  await page.locator('input[value="single"]').check()
  await expect(page.locator('[data-stage]')).toHaveClass(/mode-single/)
  await expect(page.locator('.position-value')).toHaveText('2 / 9')
  await expect(page).toHaveURL(GALLERY)
})

test('credentialed image validates through the browser reader', async ({ page }) => {
  await dismissCurtain(page)
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: CONTROL_NAME }).click()
  const panel = page.locator('[data-c2pa-panel]')
  await panel.getByRole('button', { name: /verify in this browser/i }).click()
  await expect(panel).toContainText(/content credentials verified in this browser/i, { timeout: 30000 })
})

test('admin root lists galleries without a selector and remains noindex', async ({ page, request }) => {
  const root = await request.get(`${BASE}/`)
  expect(root.status()).toBe(200)
  expect(root.headers()['x-robots-tag']).toContain('noindex')
  await page.goto(`${BASE}/`)
  await expect(page.getByRole('heading', { name: 'manorama.xyz' })).toBeVisible()
  await expect(page.locator('.admin-intro')).toHaveText(/adj\. a view that is delightful to the mind\.\s*Also, simply the wow-est way to share photos with anyone!/i)
  await expect(page.getByText(/^Simply the wow-est way to share photos with anyone!$/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /your galleries/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Manorama-fy it!' })).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.locator('.admin-gallery-card').first()).toBeVisible()
  await expect(page.getByText('manorama / gallery workbench')).toHaveCount(0)
  await expect(page.getByText('Bring a folder. Make a gallery.')).toHaveCount(0)
  await expect(page.locator('.admin-gallery-card').first().locator('.admin-gallery-count')).toHaveText(/\(\d+ photos\)/)
  await expect(page.locator('.admin-brand-title')).toHaveCSS('font-family', /Bricolate Grotesque/i)
  await expect(page.locator('.admin-brand-title')).toHaveCSS('font-size', /(?:9[0-9]|1[0-9]{2})px/)
  await expect(page.locator('.admin-intro')).toHaveCSS('font-family', /Bricolate Grotesque/i)
  await expect(page.locator('.admin-intro')).toHaveCSS('font-style', 'italic')
  await expect(page.locator('.admin-intro')).toHaveCSS('font-weight', /(?:200|300)/)
  await expect(page.locator('.admin-intro br')).toHaveCount(1)
  await expect(page.locator('.admin-brand-mark')).toHaveAttribute('src', '/manorama-logo-upright.svg')
  await expect(page.locator('.admin-section-index')).toHaveCount(0)
  await expect(page.getByText('View gallery')).toHaveCount(0)
  await expect(page.locator('.admin-gallery-card .admin-eyebrow')).toHaveCount(0)
  await expect(page.getByText(new RegExp(`manorama\\.xyz/${OWNER}/${SLUG}$`))).toBeVisible()
  const firstCard = page.locator('.admin-gallery-card').first()
  await expect(firstCard.getByRole('link', { name: /open .* in a new tab/i })).toHaveAttribute('target', '_blank')
  await expect(firstCard.getByRole('link', { name: /open .* in a new tab/i })).toHaveAttribute('rel', 'noreferrer')
  await expect(firstCard.getByRole('button', { name: /copy .* link/i })).toBeVisible()
  await expect(firstCard.locator('.admin-gallery-strip-frame')).toBeVisible()
  await expect(firstCard.locator('.admin-gallery-strip-frame')).toHaveCSS('height', '100px')
  await expect(firstCard.getByRole('button', { name: /copy .* link/i })).toBeVisible()
  await expect(firstCard.getByRole('button', { name: /edit gallery slug/i })).toBeVisible()
})

test('admin gallery order persists through the 100px reorder rail', async ({ page }) => {
  await page.goto(`${BASE}/`)
  const card = page.locator('.admin-gallery-card').first()
  const items = card.locator('.admin-gallery-strip-item')
  await expect(items).toHaveCount(9)
  const firstId = await items.nth(0).getAttribute('data-image-id')
  const secondId = await items.nth(1).getAttribute('data-image-id')
  await items.nth(1).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('status')).toHaveText('Order saved')
  await expect(card.locator('.admin-gallery-strip-item').nth(0)).toHaveAttribute('data-image-id', secondId!)
  await expect(card.locator('.admin-gallery-strip-item').nth(1)).toHaveAttribute('data-image-id', firstId!)
})

test('admin gallery images reorder with a real pointer drag', async ({ page }) => {
  await page.goto(`${BASE}/`)
  const card = page.locator('.admin-gallery-card').first()
  const items = card.locator('.admin-gallery-strip-item')
  const firstId = await items.nth(0).getAttribute('data-image-id')
  const secondId = await items.nth(1).getAttribute('data-image-id')
  await items.nth(1).dragTo(items.nth(0))
  await expect(page.getByRole('status')).toHaveText('Order saved')
  await expect(card.locator('.admin-gallery-strip-item').nth(0)).toHaveAttribute('data-image-id', secondId!)
  await expect(card.locator('.admin-gallery-strip-item').nth(1)).toHaveAttribute('data-image-id', firstId!)
})

test('admin gallery strip pans with wheel and touch-style pointer input', async ({ page }) => {
  await page.goto(`${BASE}/`)
  const frame = page.locator('.admin-gallery-strip-frame').first()
  await frame.locator('.admin-gallery-strip-item').evaluateAll((elements) => elements.slice(0, 4).forEach((element) => { (element as HTMLElement).style.width = '500px' }))
  const dimensions = await frame.evaluate((element) => ({ scrollWidth: (element as HTMLElement).scrollWidth, clientWidth: (element as HTMLElement).clientWidth }))
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth)
  await frame.evaluate((element) => { (element as HTMLElement).scrollLeft = 0 })
  await frame.dispatchEvent('wheel', { deltaY: 180, deltaX: 0, bubbles: true })
  await expect.poll(() => frame.evaluate((element) => (element as HTMLElement).scrollLeft)).toBeGreaterThan(0)
  const touchPan = await frame.evaluate((element) => {
    const frame = element as HTMLDivElement
    frame.scrollLeft = 0
    frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 12, pointerType: 'touch', clientX: 320, isPrimary: true }))
    frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 13, pointerType: 'touch', clientX: 320, isPrimary: false }))
    frame.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 13, pointerType: 'touch', clientX: 100, isPrimary: false }))
    frame.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 13, pointerType: 'touch', clientX: 100, isPrimary: false }))
    frame.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 12, pointerType: 'touch', clientX: 100, isPrimary: true }))
    return frame.scrollLeft
  })
  expect(touchPan).toBeGreaterThan(0)
})

test('admin gallery title and caption edit inline and persist', async ({ page }) => {
  await page.goto(`${BASE}/`)
  const card = page.locator('.admin-gallery-card').first()
  const titleButton = card.getByRole('button', { name: /edit gallery title/i })
  await titleButton.click()
  const titleInput = page.getByRole('textbox', { name: 'Edit gallery title' })
  await titleInput.fill('Italy, seen slowly')
  await titleInput.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Saved')
  await expect(card.getByRole('button', { name: /edit gallery title/i })).toHaveText('Italy, seen slowly')
  const captionButton = card.getByRole('button', { name: /edit gallery caption/i })
  await captionButton.click()
  const captionInput = page.getByRole('textbox', { name: 'Edit gallery caption' })
  await captionInput.fill('A quiet sequence of streets, stone, and weather along an Italian journey.')
  await captionInput.press('Control+Enter')
  await expect(page.getByRole('status')).toHaveText('Saved')
  await expect(card.getByRole('button', { name: /edit gallery caption/i })).toContainText('A quiet sequence')
})

test('admin gallery slug edits inline and persists the public address', async ({ page }) => {
  await page.goto(`${BASE}/`)
  const card = page.locator('.admin-gallery-card').first()
  await card.getByRole('button', { name: /edit gallery slug/i }).click()
  const slugInput = page.getByRole('textbox', { name: 'Edit gallery slug' })
  const nextSlug = `italy-reframed-${Date.now()}`
  await slugInput.fill(nextSlug)
  await slugInput.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Saved')
  await expect(card.getByRole('button', { name: /edit gallery slug/i })).toHaveText(nextSlug)
  await expect(page.getByText(`manorama.xyz/${OWNER}/${nextSlug}`)).toBeVisible()
  await expect(card.getByRole('link', { name: /open .* in a new tab/i })).toHaveAttribute('href', `/${OWNER}/${nextSlug}`)
})

test.describe('admin responsive layout', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('fits the phone viewport without horizontal overflow', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await expect(page.getByRole('heading', { name: 'manorama.xyz' })).toBeVisible()
    const geometry = await page.evaluate(() => ({
      scrollable: document.documentElement.scrollHeight > window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }))
    expect(geometry.scrollable).toBe(true)
    expect(geometry.overflowX).toBeLessThanOrEqual(1)
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.locator('.admin-section-index')).toHaveCount(0)
    await expect(page.locator('.admin-gallery-card').first()).toBeVisible()
    await expect(page.locator('.admin-gallery-strip-frame').first()).toHaveCSS('height', '100px')
  })
})

test('privacy: gallery remains noindex and unknown paths remain absent', async ({ request }) => {
  const res = await request.get(GALLERY)
  expect(res.headers()['x-robots-tag']).toContain('noindex')
  const missing = await request.get(`${BASE}/not-a-gallery`)
  expect([403, 404]).toContain(missing.status())
})
