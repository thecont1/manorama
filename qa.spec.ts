// manorama acceptance spec — the gallery-qa skill, executable.
// Deps: npm i -D @playwright/test @axe-core/playwright
// Env: GALLERY_URL (default http://localhost:8787), GALLERY_SLUG (default "gallery")
// Selector conventions expected in the app: [data-curtain], [data-stage], [data-nav-arrow],
// dot button has aria-label "Gallery controls", modal has role="dialog".

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787';
const SLUG = process.env.GALLERY_SLUG ?? 'gallery';
const GALLERY = `${BASE}/${SLUG}`;

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
      expect(visible).toEqual(['Gallery controls']); // design rules, Rule 1
    });

    test('keyboard navigation and deep link', async ({ page }) => {
      await page.goto(`${GALLERY}#img-2`);
      await page.locator('[data-curtain]').click();
      await page.keyboard.press('ArrowRight');
      await expect(page).toHaveURL(/#img-3/);
      await page.keyboard.press('Home');
      await expect(page).toHaveURL(/#img-1/);
    });

    test('drag pans the canvas', async ({ page }) => {
      await dismissCurtain(page);
      const x0 = await page.evaluate(() => document.querySelector('[data-track]')!.getBoundingClientRect().left);
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.down();
      await page.mouse.move(vp.width / 2 - 200, vp.height / 2, { steps: 10 });
      await page.mouse.up();
      const x1 = await page.evaluate(() => document.querySelector('[data-track]')!.getBoundingClientRect().left);
      expect(x1).toBeLessThan(x0);
    });

    test('modal contains every control and dismisses three ways', async ({ page }) => {
      await dismissCurtain(page);
      await page.getByRole('button', { name: /gallery controls/i }).click();
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();
      for (const label of [/view/i, /caption/i, /info|exif/i, /credentials/i, /about/i, /shortcut/i]) {
        await expect(modal.getByText(label).first()).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(modal).not.toBeVisible();
      // focus returns to the dot
      await expect(page.getByRole('button', { name: /gallery controls/i })).toBeFocused();
    });

    test('arrows hidden by default, toggled from modal', async ({ page }) => {
      await dismissCurtain(page);
      await expect(page.locator('[data-nav-arrow]')).toHaveCount(0);
      await page.getByRole('button', { name: /gallery controls/i }).click();
      await page.getByLabel(/show navigation arrows/i).check();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-nav-arrow]')).toHaveCount(2);
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
      await page.getByRole('button', { name: /gallery controls/i }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test('c2pa: credentialed image validates, unsigned shows quiet state', async ({ page }) => {
      await dismissCurtain(page);
      await page.getByRole('button', { name: /gallery controls/i }).click();
      const panel = page.getByRole('dialog').locator('[data-c2pa-panel]');
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText(/error/i);
      // valid summary OR the neutral no-credentials line — never a broken panel
      await expect(panel).toContainText(/content credentials|no content credentials/i);
    });
  });
}

test('alternate modes switch instantly and preserve the current image', async ({ page }) => {
  await page.goto(`${GALLERY}#img-2`)
  await page.locator('[data-curtain]').click()
  await page.getByRole('button', { name: /gallery controls/i }).click()
  await page.locator('input[value="vertical"]').check()
  await expect(page.locator('[data-stage]')).toHaveClass(/mode-vertical/)
  await expect(page).toHaveURL(/#img-2/)
  await page.locator('input[value="single"]').check()
  await expect(page.locator('[data-stage]')).toHaveClass(/mode-single/)
  await expect(page).toHaveURL(/#img-2/)
})

test('credentialed image validates through the browser reader', async ({ page }) => {
  await page.goto(`${GALLERY}#img-2`)
  await page.locator('[data-curtain]').click()
  await page.getByRole('button', { name: /gallery controls/i }).click()
  const panel = page.locator('[data-c2pa-panel]')
  await panel.getByRole('button', { name: /verify in this browser/i }).click()
  await expect(panel).toContainText(/content credentials verified in this browser/i, { timeout: 30000 })
})

test('privacy: noindex header and no index page', async ({ request }) => {
  const res = await request.get(GALLERY);
  expect(res.headers()['x-robots-tag']).toContain('noindex');
  const root = await request.get(`${BASE}/`);
  expect([403, 404]).toContain(root.status());
});
