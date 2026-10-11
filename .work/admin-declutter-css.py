"""Native stylesheet side of the admin de-clutter.

In-place edits where a rule already exists, then one appended block for the
pieces that are new (caption line, icon actions, drawer brand, the editor).
Every anchor is asserted, so a mismatch stops rather than half-applying.
"""
from pathlib import Path
import sys

path = Path('native/styles.css')
s = path.read_text()


def apply(old: str, new: str, label: str) -> None:
    global s
    if old not in s:
        sys.exit(f'anchor missing: {label}')
    s = s.replace(old, new, 1)
    print('ok:', label)


# 1 — the page takes the whole width: the left gutter existed for the edge tab
apply(
    '.native-account-shell { display: block; width: 100%; max-width: none; height: auto; min-height: 100svh; overflow: visible; padding: max(24px, var(--native-safe-top)) 24px max(24px, var(--native-safe-bottom)) 56px; }',
    '.native-account-shell { display: block; width: 100%; max-width: none; height: auto; min-height: 100svh; overflow: visible; padding: max(20px, var(--native-safe-top)) 24px max(20px, var(--native-safe-bottom)) 24px; }',
    'account shell padding',
)

# 3 — one leading for the welcome block
apply(
    """  .native-account-side .admin-greeting p {
    margin-bottom: 8px;
    font-size: 15px;
    line-height: 1.28;
  }""",
    """  .native-account-side .admin-greeting p {
    margin: 0 0 10px;
    font-size: 15px;
    line-height: 1.5;
  }""",
    'greeting paragraph leading',
)

# 6 — the card now runs four text rows beside the cover
apply(
    """  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;""",
    """  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto auto auto;""",
    'card rows',
)
apply(
    '.native-gallery-list li > .native-gallery-cover-open { grid-column: 1; grid-row: 1 / span 2; }',
    '.native-gallery-list li > .native-gallery-cover-open { grid-column: 1; grid-row: 1 / -1; }',
    'cover spans every row',
)
apply(
    '.native-gallery-list li > .native-gallery-actions { grid-column: 2; grid-row: 2; }',
    """.native-gallery-list li > .native-gallery-caption,
.native-gallery-list li > .native-gallery-caption-edit { grid-column: 2; grid-row: 2; }
.native-gallery-list li > .native-gallery-link { grid-column: 2; grid-row: 3; }
.native-gallery-list li > .native-gallery-actions { grid-column: 2; grid-row: 4; }
.native-gallery-list li.is-cover-right > .native-gallery-row,
.native-gallery-list li.is-cover-right > .native-gallery-caption,
.native-gallery-list li.is-cover-right > .native-gallery-caption-edit,
.native-gallery-list li.is-cover-right > .native-gallery-link,
.native-gallery-list li.is-cover-right > .native-gallery-actions { grid-column: 1; }""",
    'caption, link and action rows',
)
apply(
    '.native-gallery-list li > .native-gallery-remove-confirm { grid-column: 1 / -1; grid-row: 3; }',
    '.native-gallery-list li > .native-gallery-remove-confirm { grid-column: 1 / -1; grid-row: 5; }',
    'remove confirmation row',
)
apply(
    """.native-gallery-list .native-gallery-actions button {
  min-width: 0;
  padding: 6px 9px;
  font-size: 11px;
  line-height: 1.2;
}""",
    """.native-gallery-list .native-gallery-actions button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  min-width: 0;
  padding: 0;
}
.native-gallery-list .native-gallery-actions button svg {
  width: 17px;
  height: 17px;
}""",
    'square icon actions',
)

# 5 — the menu's own padding matches the page's, so the brand lands in the same place
apply(
    """  padding: max(20px, var(--native-safe-top)) 20px max(20px, var(--native-safe-bottom));
  border-left: 1px solid rgba(var(--ink), .14);
  background: #151817;""",
    """  padding: max(20px, var(--native-safe-top)) 24px max(20px, var(--native-safe-bottom));
  border-left: 1px solid rgba(var(--ink), .14);
  background: #151817;""",
    'drawer padding matches page',
)

s += """

/* ── Account page de-clutter ───────────────────────────────────────────────
   Six fixes asked for after looking at the phone screen: the page no longer
   reserves a gutter for a tab that moved to the top-right; the welcome block
   keeps one leading from line to line; the gallery card carries title, caption,
   address and the same four square actions the web dashboard uses; and the
   menu opens with the brand in the page's own position, dismissed by a large
   circled X where the hamburger sits. */

/* The address line is a monospace block inside the greeting. The web's 3em
   margin under it is what made the welcome block's rhythm change from line to
   line; here it takes the same leading and the same gap as its neighbours, and
   the highlighted name stops changing the height of the line it wraps onto. */
.native-account-side .admin-greeting-url {
  margin: 0 0 10px;
  font-size: 15px;
  line-height: 1.5;
}
.native-account-side .admin-greeting-hello { margin-top: 0; }
.native-account-side .admin-greeting > :last-child { margin-bottom: 0; }
.native-account-side .admin-greeting-name {
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.native-gallery-caption {
  display: block;
  width: 100%;
  box-sizing: border-box;
  border: 0;
  border-radius: 0;
  margin: 0;
  padding: 0 2px 7px;
  background: transparent;
  color: rgba(var(--ink), .58);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.native-gallery-caption:hover { color: rgba(var(--ink), .8); }
.native-gallery-caption:focus-visible { outline: 2px solid rgb(var(--ink)); outline-offset: 2px; }
.native-gallery-caption.is-empty { color: rgba(var(--ink), .34); font-style: italic; }

.native-gallery-caption-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 7px;
}
.native-gallery-caption-edit input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  border: 1px solid rgba(var(--ink), .26);
  border-radius: 0;
  padding: 8px 10px;
  background: rgba(var(--ink), .04);
  color: rgb(var(--ink));
  font: inherit;
  font-size: 14px;
}
.native-gallery-caption-edit input::placeholder { color: rgba(var(--ink), .35); }
.native-gallery-caption-edit button {
  flex: 0 0 auto;
  min-height: 40px;
  margin: 0;
  padding: 0 12px;
  font-size: 13px;
}

.native-gallery-list .native-gallery-actions button {
  border-radius: 10px;
  color: rgba(var(--ink), .72);
}
.native-gallery-list .native-gallery-actions button:hover { color: rgb(var(--ink)); }
.native-gallery-list .native-gallery-actions .native-gallery-action--delete { color: rgba(255, 122, 122, .8); }
.native-gallery-list .native-gallery-actions .native-gallery-action--delete:hover { color: rgb(255, 122, 122); }

/* The menu's head: brand first, in the page's own position, with the dismissal
   pinned where the hamburger is. */
.native-drawer-head {
  align-items: flex-start;
  padding-right: 38px;
}
.native-drawer-brand {
  display: block;
  min-width: 0;
}
.native-drawer-brand .brand-mark-wrap {
  display: block;
  width: min(300px, 100%);
}
.native-drawer-brand .landing-brand-mark {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
}
.native-drawer-hint {
  margin: 0;
  color: rgba(var(--ink), .6);
  font-size: 13px;
  line-height: 1.5;
}
.native-drawer-close {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 14px);
  right: 14px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(var(--ink), .22);
  border-radius: 999px;
  background: transparent;
  color: rgb(var(--ink));
}
.native-drawer-close svg {
  width: 20px;
  height: 20px;
}
.native-drawer-close:hover { border-color: rgba(var(--ink), .7); }
.native-drawer-close:focus-visible {
  border-color: rgba(var(--ink), .7);
  color: rgb(var(--ink));
  outline: 2px solid rgb(var(--ink));
  outline-offset: 2px;
}

/* ── The gallery editor ────────────────────────────────────────────────────
   Resequencing is its only write, and it is made on the picker's matrix: the
   same cells, the same fixed viewport-relative height, aspect-true widths and
   zero gaps, with the photograph in hand carrying the picker's pink. */

.native-editor {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--gallery-canvas, #111312);
  color: rgb(var(--ink));
}
.native-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex: 0 0 auto;
  padding: max(20px, var(--native-safe-top)) 66px 10px 24px;
}
.native-editor-titles { min-width: 0; }
.native-editor-titles h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 500;
  letter-spacing: -.01em;
}
.native-editor-hint {
  margin: 6px 0 0;
  color: rgba(var(--ink), .6);
  font-size: 13px;
  line-height: 1.45;
}
.native-editor-note {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 24px 10px;
  color: rgba(var(--ink), .55);
  font-size: 12px;
  line-height: 1.45;
}
.native-editor-close {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 14px);
  right: 14px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(var(--ink), .22);
  border-radius: 999px;
  background: transparent;
  color: rgb(var(--ink));
  cursor: pointer;
}
.native-editor-close svg { width: 20px; height: 20px; }
.native-editor-close:hover { border-color: rgba(var(--ink), .7); }
.native-editor-close:focus-visible {
  border-color: rgba(var(--ink), .7);
  outline: 2px solid rgb(var(--ink));
  outline-offset: 2px;
}
.native-editor-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.native-editor .native-global-grid { justify-content: center; }
.native-editor .native-global-cell:disabled { opacity: .6; cursor: default; }
.native-editor-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  padding: 12px 24px max(20px, var(--native-safe-bottom));
  border-top: 1px solid rgba(var(--ink), .12);
}
.native-editor-actions button {
  flex: 1 1 auto;
  min-height: 48px;
  border: 1px solid rgba(var(--ink), .25);
  border-radius: 0;
  background: transparent;
  color: rgb(var(--ink));
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.native-editor-actions button:disabled { opacity: .4; cursor: default; }
.native-editor-actions .native-editor-save:not(:disabled) { border-color: rgba(var(--ink), .8); }
.native-editor-actions button:focus-visible { outline: 2px solid rgb(var(--ink)); outline-offset: 2px; }

@media (min-width: 900px) {
  .native-editor-head { padding: max(28px, var(--native-safe-top)) 80px 14px 40px; }
  .native-editor-note { padding-inline: 40px; }
  .native-editor-actions { padding-inline: 40px; }
}
"""

path.write_text(s)
print('native/styles.css written')