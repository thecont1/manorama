"""Bring the native tests onto the redesigned admin contracts.

The card's shape changed (cover is its own opener, a caption line replaces the
subtitle, icon actions replace text chips) and the drawer's head now leads with
the brand. Each anchor is asserted.
"""
from pathlib import Path
import sys

# ── the editor test's duplicated setup line ────────────────────────────────
p = Path('native/islands/GalleryEditor.test.tsx')
s = p.read_text()
s = s.replace("""    installLocalStorage()
    const storage = installLocalStorage()""", """    const storage = installLocalStorage()""", 1)
p.write_text(s)
print('ok: editor test setup')

path = Path('native/islands/GalleryList.account.test.tsx')
s = path.read_text()


def apply(old: str, new: str, label: str) -> None:
    global s
    if old not in s:
        sys.exit(f'anchor missing: {label}')
    s = s.replace(old, new, 1)
    print('ok:', label)


# ── the card contract in the listing test ──────────────────────────────────
apply(
    """    const row = container.querySelector('.native-gallery-list button') as HTMLButtonElement | null
    expect(row).not.toBeNull()
    // The single cover takes a row of its own ahead of the copy. The second
    // fixture image proves mobile does not render the web's sequencing strip.
    const cover = row!.querySelector(':scope > .native-gallery-cover-row')
    expect(cover).not.toBeNull()
    expect(cover!.querySelectorAll('.native-gallery-thumb img')).toHaveLength(1)
    expect(cover!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/first.jpg')
    expect([...cover!.querySelectorAll('.native-gallery-thumb')].map((thumb) => thumb.className)).toEqual([
      'native-gallery-thumb',
    ])
    // Then title with its count, subtitle and address, each on its own line.
    expect([...(row!.children as unknown as Element[])].map((child) => child.className)).toEqual([
      'native-gallery-cover-row',
      'native-gallery-heading',
      'native-gallery-subtitle',
      'native-gallery-link',
    ])
    expect(row?.querySelector('.native-gallery-heading .native-gallery-meta')?.textContent).toBe('(12 items)')
    expect(row?.querySelector(':scope > .native-gallery-link')?.textContent).toBe('manorama.xyz/quiet-owner/kashmir')
    row!.click()
    await settle()

    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir')).toBe(true)
  })""",
    """    // The cover is its own opener, holding one column of the card across every
    // text row, so the four actions can sit beside the photograph rather than
    // under the whole card. The second fixture image proves mobile still does
    // not render the web's sequencing strip.
    const coverButton = container.querySelector('.native-gallery-cover-open') as HTMLButtonElement | null
    expect(coverButton).not.toBeNull()
    expect(coverButton!.querySelectorAll('.native-gallery-thumb img')).toHaveLength(1)
    expect(coverButton!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/first.jpg')
    expect([...coverButton!.querySelectorAll('.native-gallery-thumb')].map((thumb) => thumb.className)).toEqual([
      'native-gallery-thumb',
    ])
    expect(coverButton!.getAttribute('aria-label')).toBe('Edit the running order of Kashmir')
    // Title with its count, then the caption line, then the address: the order
    // the owner asked for, with the cover beside all four rows.
    const card = coverButton!.closest('li') as HTMLElement
    expect([...(card.children as unknown as Element[])].map((child) => child.className)).toEqual([
      'native-gallery-cover-open',
      'native-gallery-row native-gallery-row-with-thumb',
      'native-gallery-caption',
      'native-gallery-link',
      'native-gallery-actions',
    ])
    expect(card.querySelector('.native-gallery-heading .native-gallery-meta')?.textContent).toBe('(12 items)')
    expect(card.querySelector('.native-gallery-caption')?.textContent).toBe('A winter album')
    expect(card.querySelector('.native-gallery-link')?.textContent).toBe('manorama.xyz/quiet-owner/kashmir')

    // The cover opens the editor for this gallery, not the gallery itself.
    coverButton!.click()
    await settle()
    expect(container.querySelector('[data-gallery-editor]')).not.toBeNull()
    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir')).toBe(true)
    ;(container.querySelector('[data-gallery-editor] [aria-label="Close the editor"]') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('[data-gallery-editor]')).toBeNull()

    // The title row is what opens the gallery on the stage.
    ;(container.querySelector('.native-gallery-row-with-thumb') as HTMLButtonElement).click()
    await settle()
    expect(galleryCalls().filter((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir').length)
      .toBeGreaterThanOrEqual(2)
  })""",
    'listing card contract',
)

# ── new coverage ───────────────────────────────────────────────────────────
apply(
    """    expect(container.querySelector('.native-paywall-card')).not.toBeNull()
    expect(container.innerHTML).not.toContain('Subscriptions are unavailable right now. Please try again shortly.')
  })
})""",
    """    expect(container.querySelector('.native-paywall-card')).not.toBeNull()
    expect(container.innerHTML).not.toContain('Subscriptions are unavailable right now. Please try again shortly.')
  })

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

  test('the card offers the web dashboard\\'s four actions as square icons', async () => {
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

  test('the menu leads with the page\\'s brand and closes with a circled X', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary()] }) })
    const { container } = mountAccount()
    await settle()

    // The cloud-link sentence left the page for the menu; the field keeps its
    // accessible name so the form is still announced in full.
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
})""",
    'new account coverage',
)

path.write_text(s)
print('account tests written')