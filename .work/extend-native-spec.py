"""Collect the requested evidence: the de-cluttered admin, the caption line in
place, and the editor reached from a gallery's cover."""
from pathlib import Path
import sys

p = Path('native-vault-controls.playwright.ts')
s = p.read_text()

old = """    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-admin.png`, fullPage: true })
    await menu.click()"""
new = """    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-admin.png`, fullPage: true })

    // The page runs to both edges now that the account tab lives at the top.
    const shellPadding = await page.locator('.native-account-shell')
      .evaluate((node) => getComputedStyle(node).paddingLeft)
    if (viewport.width < 820) expect(shellPadding).toBe('24px')

    // The card reads title, caption, address — and the same four square actions
    // the web dashboard renders. Drawings, not words.
    const firstCard = cards.first()
    const firstActions = firstCard.locator('.native-gallery-actions')
    const actionLabels = await firstActions.locator('button')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
    expect(actionLabels.length).toBeGreaterThanOrEqual(2)
    expect(await firstActions.evaluate((node) => node.textContent)).toBe('')
    expect(await firstActions.locator('button svg').count()).toBe(actionLabels.length)
    const actionBox = (await firstActions.locator('button').first().boundingBox())!
    expect(Math.abs(actionBox.width - actionBox.height)).toBeLessThanOrEqual(1)

    // The caption line edits in place; a gallery without one is invited to add
    // it rather than left blank.
    const captionLine = firstCard.locator('.native-gallery-caption')
    await expect(captionLine).toBeVisible()
    if (((await captionLine.textContent()) ?? '').includes('Add a caption')) {
      await captionLine.click()
      await expect(firstCard.locator('.native-gallery-caption-edit input')).toBeFocused()
      await page.keyboard.press('Escape')
    }

    // The cover opens this gallery's editor: the picker's matrix, in order.
    // One photograph is picked up and put down, and only that order is saved.
    await firstCard.locator('.native-gallery-cover-open').click()
    const editor = page.locator('[data-gallery-editor]')
    await expect(editor).toBeVisible()
    const cells = editor.locator('.native-global-grid .native-global-cell')
    await expect(cells.first()).toBeVisible()
    const cellCount = await cells.count()
    expect(cellCount).toBeGreaterThan(1)
    const heights = await cells.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))
    expect(new Set(heights).size).toBe(1)
    const orderBefore = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-photo')))
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-editor.png`, fullPage: false })
    await cells.nth(cellCount - 1).click()
    await expect(cells.nth(cellCount - 1)).toHaveClass(/is-active/)
    await expect(editor.locator('.native-editor-note')).toContainText('in hand')
    await cells.first().click()
    const orderAfter = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-photo')))
    expect(orderAfter[0]).toBe(orderBefore[cellCount - 1])
    await editor.locator('.native-editor-save').click()
    await expect(editor.locator('.native-editor-note')).toContainText('saved')
    const report = await (await request.get(`${base}/__capture/report`)).json() as {
      patches?: { url: string; body: { order?: string[] } }[]
    }
    const saved = (report.patches ?? []).at(-1)
    expect(saved?.url).toContain('/api/galleries/')
    expect(saved?.body.order).toEqual(orderAfter)
    await editor.locator('[aria-label="Close the editor"]').click()
    await expect(editor).toHaveCount(0)

    await menu.click()"""

if old not in s:
    sys.exit('spec anchor missing')
p.write_text(s.replace(old, new, 1))
print('ok: spec extended')