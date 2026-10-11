"""Append the three new account tests to the end of the mobile account suite."""
from pathlib import Path
import sys

path = Path('native/islands/GalleryList.account.test.tsx')
s = path.read_text()

anchor = "\n})\n\ndescribe('native-only placement'"
if anchor not in s:
    sys.exit('anchor missing')

new = r"""
  test('the caption line invites one when there is none and saves the one given', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary({ caption: '' })] }),
      fallback: (url, init) => url === 'https://manorama.xyz/api/galleries/kashmir' && init?.method === 'PATCH'
        ? json({ gallery: accountSummary({ caption: 'Morning in the valley' }) })
        : new Response('{}', { status: 404 }),
    })
    const { container } = mountAccount()
    await settle()

    const idle = container.querySelector('.native-gallery-caption') as HTMLButtonElement
    expect(idle.textContent).toBe('Add a caption')
    expect(idle.className).toContain('is-empty')
    expect(idle.getAttribute('aria-label')).toBe('Add a caption to Kashmir')

    idle.click()
    await settle()
    const form = container.querySelector('.native-gallery-caption-edit') as HTMLFormElement
    expect(form).not.toBeNull()
    const input = form.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('aria-label')).toBe('Caption for Kashmir')
    input.value = 'Morning in the valley'
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
    form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    await settle()

    const patch = calls.find((call) => call.url === 'https://manorama.xyz/api/galleries/kashmir' && call.init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ caption: 'Morning in the valley' })
    expect((patch?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    // The sentence the server stored is the one the card then shows.
    expect((container.querySelector('.native-gallery-caption') as HTMLButtonElement).textContent).toBe('Morning in the valley')
    expect(container.querySelector('.native-gallery-caption-edit')).toBeNull()
  })

  test('the card offers the web actions as four square icons', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ sourceUrl: 'https://www.dropbox.com/sh/example' })] }) })
    const { container } = mountAccount()
    await settle()

    const actions = container.querySelector('.native-gallery-actions') as HTMLElement
    const buttons = [...actions.querySelectorAll('button')] as HTMLButtonElement[]
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Copy Kashmir link',
      'Open Kashmir source',
      'Refresh Kashmir from source',
      'Delete Kashmir',
    ])
    // Drawings, not words — the same four controls the web dashboard renders.
    expect(buttons.every((button) => button.querySelector('svg') !== null)).toBe(true)
    expect(actions.textContent).toBe('')
  })

  test('the menu leads with the brand and closes with a circled X', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary()] }) })
    const { container } = mountAccount()
    await settle()

    // The cloud-link sentence left the page for the menu; the field keeps its
    // accessible name, so the form is still announced in full.
    expect(container.querySelector('.native-gallery-import label')).toBeNull()
    expect(container.querySelector('.native-gallery-import input')?.getAttribute('aria-label'))
      .toBe('Public Dropbox, Google Drive, iCloud, or MEGA link')

    ;(container.querySelector('[aria-label="Account menu"]') as HTMLButtonElement).click()
    await settle()
    const drawer = container.querySelector('[data-account-drawer]') as HTMLElement
    const head = drawer.querySelector('.native-drawer-head') as HTMLElement
    expect(head.querySelector('.native-drawer-brand .landing-brand-mark')).not.toBeNull()
    expect(head.querySelector('.native-drawer-brand .brand-tld')?.textContent).toBe('.xyz')
    expect(head.querySelector('.landing-brand-intro')?.textContent).toContain('adj.')
    const close = head.querySelector('.native-drawer-close') as HTMLButtonElement
    expect(close.getAttribute('aria-label')).toBe('Close account menu')
    expect(close.querySelector('svg')).not.toBeNull()
    expect(drawer.textContent).toContain('Add a gallery from a public Dropbox, Google Drive, iCloud, or MEGA link')
  })
"""

s = s.replace(anchor, new + anchor, 1)
path.write_text(s)
print('inserted; file lines:', len(s.split('\n')))