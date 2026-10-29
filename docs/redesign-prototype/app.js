(() => {
const { ACCOUNT, GALLERIES, savedMB } = window.MANO;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $("#app");

const state = {
  screen: "welcome",
  gi: 0,
  mode: "strip",
  bg: "none",
  arrows: false,
  pos: 0,
  sheet: null,
  order: null, picked: null, moved: new Set(), dirty: false
};

const SVG = {
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>'
};

const g = () => GALLERIES[state.gi];
const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
// Never upscaled past natural size (TECH-SPEC viewer contract). Natural CSS size = pixels / devicePixelRatio.
const cap = p => {
  const H = Math.round(p.h / dpr), W = Math.round(p.w / dpr);
  if (state.mode === "strip") return `style="height:min(100%,${H}px)"`;
  if (state.mode === "scroll") return `style="width:min(100%,${W}px);justify-self:center"`;
  return ""; // One by one is sized by fitOne()
};
const addr = gal => `manorama.xyz/${ACCOUNT.owner}/${gal.slug}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const deviceWord = gal => gal.device.mode === "stream" ? "Streams" : gal.device.saved >= gal.photos.length ? "On this iPhone" : `Saving ${gal.device.saved} of ${gal.photos.length}`;
const vaultUsed = () => +GALLERIES.reduce((s, x) => s + savedMB(x), 0).toFixed(1);

/* ───────── Design notes per screen ───────── */
const NOTES = {
  welcome: {
    h: "Welcome and sign-in",
    q: "What is this, and how do I start?",
    items: [
      ["On the screen", "The full wordmark, one sentence, three sign-in buttons, Apple first. No photographs: nobody has signed in yet, so there is nothing of theirs to show, and nothing of anyone else’s should stand in."],
      ["Taken away", "The dictionary tagline and the “WOW-est” line, the uppercase “Continue with” label, the icon orbs."],
      ["Why", "The brief asks this screen to answer one question. Everything a feature list would say is answered by the next screen working."]
    ]
  },
  library: {
    h: "Library",
    q: "Which gallery do I want to look at?",
    items: [
      ["Biggest thing", "Each gallery is a strip of its own first photographs at their true proportions, edge to edge. That is the strip viewer in miniature, so the library already looks like the product."],
      ["One tap, one menu", "Tap the strip or the name to open the viewer directly. Every other gallery action sits behind one ··· button: share, details, reorder, read again, remove."],
      ["The plan", "One quiet line at the foot that only counts. It turns into a sentence only when the next gallery would be temporary."],
      ["Sponsored", "A labelled slot directly under the title, above every gallery. It is shaped for a vertical photograph shown fit to height, and follows the same rules as everything else: never cropped, never over a photograph of yours."],
      ["The mark", "Centred in the top bar, at exactly the same box as on Gallery details, Settings and the curtain, so moving between screens never makes it jump."],
      ["Taken away", "The greeting, the owner-path field, the inline paste form (now its own sheet), the giant “Your galleries” heading and the row of five icon buttons."]
    ]
  },
  add: {
    h: "Add a gallery",
    q: "Will this link become a gallery?",
    items: [
      ["Two paths", "Paste a link, or choose a folder or photographs on this iPhone. Pasting names the provider and reads the folder at once; the photographs arrive as a strip, so the owner sees what they have before anything is created."],
      ["Errors", "Said in the provider’s own words, with what to change in that app: an iCloud Drive link is told to use a Photos shared album instead."],
      ["Words", "“Manorama-fy it!” becomes “Add gallery”. The name is prefilled from the folder and the public address is shown under it."],
      ["Limits", "Only when the free plan is full does the sheet say that this gallery will last 30 days. The provider list is gone: the field accepts what it accepts, and says so when it does not."]
    ]
  },
  viewer: {
    h: "Viewer",
    q: "No question. The photographs.",
    items: [
      ["Curtain", "A gallery opens on a frosted veil over its first photograph, with the mark, title, caption and count. One tap dissolves it: the words fade first, then the frost thins away and the same photograph comes up sharp, exactly where it was."],
      ["At rest", "Nothing but the photographs and a small position count in the corner. In Strip, every photograph is fit to the height of the canvas and never cropped; a hi-res frame is shown at its crispest."],
      ["Tap once", "One word per button. A top bar with Library on the left and the position on the right; no title, the curtain already said it. A bottom row: Display, Info and, for the owner, Details. No share button: sharing lives on Gallery details and the Library menu, and the viewer is for looking. It hides itself after three seconds. The end card offers Rewind and Library."],
      ["Sponsored", "A vertical frame, fit to height, at seeded in-sequence positions — never first or last. A placeholder until sponsored photographs exist."],
      ["Not here", "Storage, plan, editing, the brand pill. Someone who opens a shared link sees exactly this and nothing more."]
    ]
  },
  view: {
    h: "Display settings",
    q: "How should these photographs sit on the screen?",
    items: [
      ["Named for what it changes", "The button reads Display because it changes how the photographs are displayed. “View” left people asking: view what?"],
      ["Three settings", "Layout, canvas and arrows. All three change the screen behind the sheet as you touch them."],
      ["Arrows off the photographs", "Turning arrows on gives the canvas a 64px bar at the foot. The stage shrinks to make room, so the arrows never sit on a photograph in any layout."],
      ["How Strip moves", "Each press travels one screen width at most. If the current photograph ends sooner, the strip stops exactly where it ends, with the next photograph docked at the left edge. Ported from advanceStripByViewport in Viewer.tsx."],
      ["Moved out", "“Don’t download this gallery” and the progress bar go to Gallery details, under On this iPhone. “Back to your galleries” is the top bar. Fullscreen is dropped on iOS, where the viewer is already full screen, and stays on the web."],
      ["Gallery details moved", "It was a link at the foot of this sheet, where nobody looked. It is now its own word in the viewer’s bottom row, owners only."]
    ]
  },
  more: {
    h: "Gallery menu",
    q: "What else can I do with this gallery?",
    items: [
      ["Order", "Most frequent first: Share link, Gallery details, Reorder, Read the folder again. Remove is last and red."],
      ["Replaces", "The five unlabelled icon buttons under every gallery card."]
    ]
  },
  details: {
    h: "Gallery details",
    q: "What can I do with this gallery?",
    items: [
      ["One kind of control", "Below the header, everything is the same 56px row: icon, what it does, its current value, and a chevron or a switch. No text links and no pair of mismatched buttons. The header is the Library card again: the scrolling strip of every photograph, then the name, count, source and caption."],
      ["Order", "Looking at it (Open gallery, Share link), then changing it (Name, Caption, Reorder), then where it lives (Keep a copy, Read the folder again), and Remove on its own at the foot."],
      ["No Content Credentials here", "They are verified one photograph at a time, in the viewer’s Info sheet, never as a batch for the whole gallery."],
      ["Edits", "Name and Caption each open a small sheet with one field and Save. The address under the name follows it."]
    ]
  },
  info: {
    h: "Info",
    q: "What is this photograph, and can I trust it?",
    items: [
      ["Contents", "Position, file, size and camera settings, then Content Credentials, exactly the in-gallery information sheet of the viewer contract."],
      ["Credentials", "Opening the sheet on a photograph with credentials starts the check on the device. Verified photographs show who made and signed them, and open in the standalone C2PA viewer. Keyboard: I opens this sheet, Shift-I goes straight to the C2PA viewer."]
    ]
  },
  reorder: {
    h: "Reorder",
    q: "Is the sequence right?",
    items: [
      ["Model kept", "Tap to pick up, tap to place: it works with one thumb and needs no drag precision."],
      ["Never cropped", "Every photograph is the same height, and its width follows its own proportions, so a portrait reads as a portrait and a landscape as a landscape. Rows end where they end rather than stretching to fill the width."],
      ["State, not instructions", "The picked photograph is outlined in the one accent colour. A move needs no confirmation line: the photograph is already in its new place, and moved photographs keep their new position number until saved. Screen readers still hear each move."],
      ["Size", "A slider pinned to the bottom of the screen, within thumb reach, sets one height for every photograph, from 56px for an overview to 248px for a close look. Widths follow each photograph’s own proportions at every size."],
      ["Commit", "Cancel and Save at the top, as iOS does it. Save stays disabled until something moves."]
    ]
  },
  settings: {
    h: "Settings",
    q: "What are this account and this iPhone set to?",
    items: [
      ["Four groups", "Account, Plan, This iPhone, About. How photographs are displayed is no longer here; it lives in the viewer."],
      ["This iPhone", "What new galleries do by default (save an encrypted copy or stream), storage used against the real limit, and the photo picker."],
      ["The plan", "Usage at its true ratio and one secondary button. The App Store sheet is one tap further."],
      ["Taken away", "The product explainer paragraph, the dictionary tagline, monospace legal copy."]
    ]
  },
  privacy: {
    h: "Privacy policy",
    q: "What happens to my photographs and my account?",
    items: [
      ["Inside the app", "Privacy policy on the welcome screen and in Settings opens this screen, not Safari. Back returns to where you were."],
      ["One text", "The words are the ones at manorama.xyz/privacy (app/routes/privacy.tsx). In the real app both should read from one shared module, so the screen and the web page never drift."],
      ["Set for reading", "A single column of body text at 16px, headings in cream, no boxes or rules. The logo sits in the same place as on every other screen."]
    ]
  },
  share: {
    h: "Share",
    q: "How does this link reach someone?",
    items: [
      ["The phone’s own sheet", "Share link opens the system share sheet: navigator.share on the web, Share.share (UIActivityViewController) in the iOS app. It already offers Copy, AirDrop, Messages, WhatsApp, Mail and every other installed app, in the order this person uses them, so manorama doesn’t build its own list."],
      ["Fallback", "Only where there is no system sheet (some desktop browsers) does this short sheet appear: the address, then Copy link, WhatsApp, Messages and Email."],
      ["What is sent", "The gallery name, its caption and the address. No photograph is attached; the link opens on the curtain."]
    ]
  },
  pro: {
    h: "manorama Visionary",
    q: "What would paying change?",
    items: [["Three lines", "What changes, stated as before and after. No price is invented here; it comes from the App Store."]]
  }
};

function renderNotes(key) {
  const n = NOTES[key] || NOTES[state.screen];
  $("#notes").innerHTML = `
    <h2>${n.h}</h2>
    <p class="q">${n.q}</p>
    <dl>${n.items.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join("")}</dl>
    <p class="credit">Photographs: the owner’s own frames, cut from the supplied iPhone screenshots. Gallery names, captions and figures are sample data.</p>`;
  const target = key && ["add", "view"].includes(key) ? key : state.screen;
  $$("#index button").forEach(b => {
    const k = b.dataset.then || b.dataset.go;
    b.setAttribute("aria-current", String(k === target));
  });
}

/* ───────── Router ───────── */
function go(screen, opts = {}) {
  closeSheet(true);
  if (screen === "library") state.fromViewer = false;
  if (screen === "viewer" && opts.resume) state.curtain = false;
  else if (screen === "viewer" && state.screen !== "viewer") { state.pos = state.startAt || 0; state.startAt = 0; state.curtain = true; }
  state.screen = screen;
  $$(".screen").forEach(s => (s.hidden = s.id !== `s-${screen}`));
  app.dataset.immersive = String(screen === "viewer");
  ({ welcome: renderWelcome, library: renderLibrary, viewer: renderViewer, details: renderDetails, reorder: renderReorder, settings: renderSettings, privacy: renderPrivacy })[screen]?.();
  $(`#s-${screen}`).scrollTop = 0;
  renderNotes();
  if (!opts.silent) history.replaceState(null, "", `#${screen}`);
}

/* ───────── Welcome ───────── */
function renderWelcome() {}

/* ───────── Library ───────── */
/* Thumbnail rail. Every photograph of the gallery, at its own proportions.
   Kept on this iPhone: thumbnails come out of the vault, so they are there at once.
   Streamed (or not yet saved): each one shows the existing placeholder, then fetches only when it scrolls
   near view, so a long rail costs nothing until you look along it. The prototype adds 0.35 to 1.1s
   of latency per streamed thumbnail to stand in for the network. */
function stripHTML(gal) {
  const local = i => gal.device.mode === "save" && i < gal.device.saved;
  return gal.photos.map((p, i) => `<span class="th" data-at="${i}" style="--ar:${p.w} / ${p.h};--tone:${p.tone}">${
    local(i) ? `<img class="on" src="${p.file}" alt="${p.alt}" width="${p.w}" height="${p.h}" draggable="false">`
             : `<img data-src="${p.file}" alt="${p.alt}" width="${p.w}" height="${p.h}" draggable="false">`}</span>`).join("");
}
const railIO = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const img = e.target.querySelector("img[data-src]"); railIO.unobserve(e.target); if (!img) return;
    setTimeout(() => {
      img.onload = () => img.classList.add("on");
      img.src = img.dataset.src; img.removeAttribute("data-src");
    }, 350 + Math.random() * 750);
  });
}, { rootMargin: "0px 240px" }) : null;
function wireRails(root) {
  $$(".strip", root).forEach(rail => {
    $$(".th", rail).forEach(t => { if (t.querySelector("img[data-src]")) railIO ? railIO.observe(t) : (t.querySelector("img").src = t.querySelector("img").dataset.src); });
    if (rail.dataset.wired) return; rail.dataset.wired = "1";
    // Mouse drag pans the rail; capture waits for 6px of movement so an ordinary click still opens.
    let sx = null, sl = 0, moved = false;
    rail.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse" || e.button !== 0) return; sx = e.clientX; sl = rail.scrollLeft; moved = false; });
    rail.addEventListener("pointermove", e => {
      if (sx === null) return;
      const dx = e.clientX - sx;
      if (!moved && Math.abs(dx) > 6) { moved = true; rail.classList.add("dragging"); rail.setPointerCapture(e.pointerId); }
      if (moved) rail.scrollLeft = sl - dx;
    });
    const end = () => { sx = null; rail.classList.remove("dragging"); };
    rail.addEventListener("pointerup", end); rail.addEventListener("pointercancel", end);
    rail.addEventListener("click", e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  });
}
function renderLibrary() {
  const list = $("#lib-list");
  if (!GALLERIES.length) {
    list.innerHTML = `<div class="empty"><h3>No galleries yet</h3><p>Paste a link to a folder or album you already share. Nothing is copied or moved.</p><button class="btn btn-primary" data-open="add">Add a gallery</button></div>`;
  } else {
    list.innerHTML = GALLERIES.map((x, i) => {
      const saving = x.device.mode === "save" && x.device.saved < x.photos.length;
      return `<article class="gal" data-gi="${i}">
        <div class="strip" data-open-gallery="${i}" role="button" tabindex="0" aria-label="Open ${x.slug}">${stripHTML(x)}</div>
        <div class="gal-meta">
          <button class="t" data-open-gallery="${i}">
            <div class="gal-name">${x.slug}</div>
            <div class="gal-sub">${plural(x.photos.length, "photograph")}<span class="dot">·</span>${x.source}<span class="dot">·</span><span data-devword="${i}">${deviceWord(x)}</span></div>
            ${saving ? `<div class="meter" aria-hidden="true"><i data-meter="${i}" style="width:${(x.device.saved / x.photos.length) * 100}%"></i></div>` : ""}
            ${x.caption ? `<div class="gal-cap">${x.caption}</div>` : ""}
          </button>
          <button class="iconbtn" data-more="${i}" aria-label="More for ${x.slug}">${SVG.more}</button>
        </div>
      </article>`;
    }).join("");
  }
  wireRails(list);
  const used = GALLERIES.length, lim = ACCOUNT.galleryLimit;
  $("#lib-foot").innerHTML = used >= lim
    ? `<span>All <span class="num">${used} of ${lim}</span> free galleries used. A new one would last 30 days.</span><button class="textbtn" data-open="pro">Go Visionary</button>`
    : `<span><span class="num">${used} of ${lim}</span> free galleries</span><button class="textbtn" data-go="settings">Plan</button>`;
  renderFinding();
}
function renderFinding() {
  const el = $("#lib-finding"); if (!el) return;
  const saving = GALLERIES.find(x => x.device.mode === "save" && x.device.saved < x.photos.length);
  if (saving) el.innerHTML = `<b>${saving.slug}</b> is saving to this iPhone, ${saving.device.saved} of ${saving.photos.length}.`;
  else if (!GALLERIES.length) el.textContent = "";
  else {
    const kept = GALLERIES.filter(x => x.device.mode === "save").length;
    el.textContent = `${plural(GALLERIES.length, "gallery").replace("gallerys", "galleries")}, ${kept} kept on this iPhone.`;
  }
}

/* Simulated vault progress: one photograph every 1.6 s */
setInterval(() => {
  const x = GALLERIES.find(y => y.device.mode === "save" && y.device.saved < y.photos.length);
  if (!x) return;
  x.device.saved++;
  const i = GALLERIES.indexOf(x);
  // The photograph just saved now has a vault copy: its thumbnail shows at once, wherever it is on the rail.
  $$(`.gal[data-gi="${i}"] .th[data-at="${x.device.saved - 1}"] img[data-src], #details-body .th[data-at="${x.device.saved - 1}"] img[data-src]`).forEach(img => {
    img.onload = () => img.classList.add("on"); img.src = img.dataset.src; img.removeAttribute("data-src");
  });
  $$(`[data-meter="${i}"]`).forEach(m => (m.style.width = `${(x.device.saved / x.photos.length) * 100}%`));
  $$(`[data-devword="${i}"]`).forEach(e => (e.textContent = deviceWord(x)));
  renderFinding();
  if (state.screen === "details" && state.gi === i) renderDeviceBlock();
  if (state.screen === "settings") renderSettings(true);
  if (x.device.saved === x.photos.length && state.screen === "library") renderLibrary();
}, 1600);

/* ───────── Viewer ───────── */
let chromeTimer;
function showChrome(ms = 3000) {
  $("#chrome").classList.add("on");
  clearTimeout(chromeTimer);
  if (!state.sheet) chromeTimer = setTimeout(() => !state.sheet && $("#chrome").classList.remove("on"), ms);
}
function hideChrome() { clearTimeout(chromeTimer); $("#chrome").classList.remove("on"); }

function renderViewer() {
  const v = $("#s-viewer"), stage = $("#stage"), x = g();
  v.dataset.bg = state.bg; v.dataset.arrows = String(state.arrows); v.dataset.mode = state.mode;
  stage.className = `stage ${state.mode}-mode`;
  const ad = `<div class="ad" data-ad aria-label="Sponsored"><div class="plate">Vertical photograph,<br>fit to height</div><b>Sponsored</b></div>`;
  const end = `<div class="end"><div class="big">The end.</div><button class="btn btn-primary" data-restart aria-label="Back to the first photograph">Rewind</button><button class="btn btn-secondary" data-go="library">Library</button></div>`;
  if (state.mode === "one") {
    stage.innerHTML = oneHTML(state.pos);
    fitOne();
  } else {
    const n = x.photos.length, slot = n >= 8 ? Math.floor(n / 2) : -1; // production cadence is ~25; shortened so the demo shows one
    stage.innerHTML = x.photos.map((p, i) => `${i === slot ? ad : ""}<img src="${p.file}" alt="${p.alt}" width="${p.w}" height="${p.h}" data-i="${i}" ${cap(p)} ${i > 3 ? 'loading="lazy"' : ""}>`).join("") + end;
  }
  $("#c-title").textContent = x.slug;
  $("#c-cap").textContent = x.caption;
  $("#c-cap").hidden = !x.caption;
  $("#c-count").textContent = plural(x.photos.length, "photograph");
  $("#curtain").hidden = !state.curtain; $("#curtain").classList.remove("fading");
  $("#v-details").hidden = false; // owners only; a visitor on a shared link sees Display and Info
  updatePos();
  syncSegs();
  // Open at the chosen photograph (a tapped thumbnail, or the current one when the layout changes).
  if (state.mode !== "one" && state.pos > 0) {
    const el = $(`img[data-i="${state.pos}"]`, stage);
    if (el) {
      if (state.mode === "strip") stage.scrollLeft = Math.min(el.offsetLeft, stage.scrollWidth - stage.clientWidth);
      else stage.scrollTop = el.offsetTop;
    }
  }
  if (state.curtain) hideChrome(); else showChrome(2600);
}
$("#curtain").onclick = () => {
  const c = $("#curtain"); if (c.classList.contains("fading")) return;
  state.curtain = false;
  c.classList.add("fading");
  // Wait for the veil's own opacity to finish, not its children's quicker fade (those events bubble).
  const done = e => {
    if (e && (e.target !== c || e.propertyName !== "opacity")) return;
    c.removeEventListener("transitionend", done);
    c.hidden = true; c.classList.remove("fading"); showChrome(2600);
  };
  matchMedia("(prefers-reduced-motion: reduce)").matches ? setTimeout(done, 220) : c.addEventListener("transitionend", done);
};
function updatePos() {
  const n = g().photos.length, i = Math.min(state.pos, n - 1);
  const atEnd = state.pos >= n;
  $("#v-pos").textContent = atEnd ? "End" : `${i + 1} of ${n}`;
  $("#nav-count").textContent = atEnd ? "End" : `${i + 1} of ${n}`;
  $("#bubble").textContent = atEnd ? "" : i + 1;
  $("#bubble").style.opacity = atEnd ? 0 : "";
}
function trackScroll() {
  const stage = $("#stage");
  if (state.mode === "one") return;
  const imgs = $$("img", stage); if (!imgs.length) return;
  const horiz = state.mode === "strip";
  const mid = horiz ? stage.scrollLeft + stage.clientWidth / 2 : stage.scrollTop + stage.clientHeight / 2;
  let best = 0, bd = Infinity;
  imgs.forEach((im, k) => {
    const c = horiz ? im.offsetLeft + im.offsetWidth / 2 : im.offsetTop + im.offsetHeight / 2;
    const d = Math.abs(c - mid); if (d < bd) { bd = d; best = k; }
  });
  const end = $(".end", stage);
  const endVisible = horiz ? end.offsetLeft < stage.scrollLeft + stage.clientWidth * 0.6 : end.offsetTop < stage.scrollTop + stage.clientHeight * 0.6;
  state.pos = endVisible ? imgs.length : best;
  updatePos();
}
function step(d) {
  const n = g().photos.length;
  if (state.mode === "one") { oneTo((oneQueued ?? state.pos) + d); return; }
  const stage = $("#stage");
  const target = Math.max(0, Math.min(n, state.pos + d));
  const el = target === n ? $(".end", stage) : $(`img[data-i="${target}"]`, stage);
  if (!el) return;
  if (state.mode === "strip") stage.scrollTo({ left: el.offsetLeft - (stage.clientWidth - el.offsetWidth) / 2, behavior: "smooth" });
  else stage.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
}
/* Back to start: an eased run home, 0.75s whatever the distance — quick, never a jump. */
function restart() {
  hideChrome(); cancelAnimationFrame(navRaf); navDest = null;
  if (state.mode === "one") { oneTo(0); return; }
  const stage = $("#stage"), horiz = state.mode === "strip";
  const from = horiz ? stage.scrollLeft : stage.scrollTop;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from < 2) { stage.scrollTo({ left: 0, top: 0 }); return; }
  const dur = 750, t0 = performance.now(), ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  stage.style.scrollSnapType = "none";
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur), v = from * (1 - ease(k));
    horiz ? (stage.scrollLeft = v) : (stage.scrollTop = v);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
/* ───── One by one ─────
   Fit to width on a vertical screen, fit to height on a horizontal one. Never cropped: if the fitted
   side would overflow the other axis, the photograph is contained instead. Never upscaled past its
   natural size (pixels ÷ devicePixelRatio), per the viewer contract. */
function oneHTML(i) {
  const x = g(), p = x.photos[i];
  if (!p) return `<div class="end"><div class="big">The end.</div><button class="btn btn-primary" data-restart aria-label="Back to the first photograph">Rewind</button><button class="btn btn-secondary" data-go="library">Library</button></div>`;
  return `<img src="${p.file}" alt="${p.alt}" width="${p.w}" height="${p.h}" data-i="${i}">`;
}
function fitOne() {
  const stage = $("#stage"), img = $("img", stage); if (!img || state.mode !== "one") return;
  const p = g().photos[+img.dataset.i]; if (!p) return;
  const cs = getComputedStyle(stage), pad = parseFloat(cs.paddingLeft) || 0;
  const sw = stage.clientWidth - 2 * pad, sh = stage.clientHeight - 2 * pad;
  const ar = p.w / p.h, W = p.w / dpr, H = p.h / dpr;
  let w, h;
  if (sw <= sh) { w = Math.min(sw, W); h = w / ar; if (h > sh) { h = sh; w = h * ar; } }   // vertical screen: fit to width
  else { h = Math.min(sh, H); w = h * ar; if (w > sw) { w = sw; h = w / ar; } }           // horizontal screen: fit to height
  img.style.width = `${Math.floor(w)}px`; img.style.height = `${Math.floor(h)}px`;
}
addEventListener("resize", () => state.screen === "viewer" && fitOne());

/* Quick fade out (90ms), then the next photograph fades in (160ms) once it has decoded,
   so it never pops in half-drawn. Rapid presses collapse onto the latest destination. */
let oneBusy = false, oneQueued = null;
function oneTo(i) {
  const n = g().photos.length;
  i = Math.max(0, Math.min(n, i));
  if (i === state.pos && !oneBusy) return;
  if (oneBusy) { oneQueued = i; return; }
  oneBusy = true; state.pos = i; updatePos();
  const stage = $("#stage"), cur = stage.firstElementChild;
  const p = g().photos[i];
  const ready = p ? new Promise(r => { const im = new Image(); im.src = p.file; (im.decode ? im.decode() : Promise.resolve()).then(r, r); }) : Promise.resolve();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const out = reduce || !cur ? Promise.resolve() : new Promise(r => { cur.classList.add("is-out"); setTimeout(r, 90); });
  Promise.all([out, ready]).then(() => {
    stage.innerHTML = oneHTML(i);
    const el = stage.firstElementChild;
    if (!reduce) el.classList.add("is-in");
    fitOne();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.remove("is-in");
      setTimeout(() => {
        oneBusy = false;
        if (oneQueued !== null) { const q = oneQueued; oneQueued = null; oneTo(q); }
      }, reduce ? 0 : 160);
    }));
  });
}
function renderViewerStage() {
  const keep = $("#chrome").classList.contains("on");
  renderViewer();
  if (!keep) hideChrome();
}
function syncSegs() {
  requestAnimationFrame(fitOne); // canvas margin or the arrow bar changes the space available
  $$("#seg-mode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  $$("#seg-bg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.bg === state.bg)));
  $("#sw-arrows").setAttribute("aria-checked", String(state.arrows));
  $("#mode-hint").textContent = { strip: "Side by side, edge to edge", scroll: "Each photograph fits the width", one: "One at a time, swipe or tap" }[state.mode];
  $("#bg-hint").textContent = { none: "Photographs touch", dark: "10 px apart on grey", light: "10 px apart on paper" }[state.bg];
}

/* Touch: swipe in one-at-a-time mode */
let tx = null;
$("#stage").addEventListener("pointerdown", e => (tx = { x: e.clientX, y: e.clientY, t: Date.now() }));
$("#stage").addEventListener("pointerup", e => {
  if (!tx) return;
  const dx = e.clientX - tx.x, dy = e.clientY - tx.y, quick = Date.now() - tx.t < 400;
  if (e.target.closest(".end")) { tx = null; return; }
  if (state.mode === "one" && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  else if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && quick) {
    $("#chrome").classList.contains("on") ? hideChrome() : showChrome();
  }
  tx = null;
});
$("#stage").addEventListener("scroll", () => requestAnimationFrame(trackScroll), { passive: true });
/* Desktop wheel: vertical wheel pans the strip */
$("#stage").addEventListener("wheel", e => {
  if (state.mode !== "strip" || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault(); $("#stage").scrollLeft += e.deltaY;
}, { passive: false });
/* Strip arrows — a port of advanceStripByViewport in app/islands/Viewer.tsx.
   Forward: travel until the next frame's left edge docks at the stage's left edge, but never more than one
   stage width per press; inside a photograph wider than the stage that pages through in stage-width chunks
   and the final press docks the next frame exactly where the current one ends.
   Back: the lesser of one stage width or the part of the current frame still hidden to the left; when the
   frame is already docked, the distance belongs to the frame before it.
   Rapid presses accumulate from the pending destination, so press count becomes frames travelled.
   Ad plates and the end card are frames too. Back at the very start jumps to the last photograph. */
let navDest = null, navRaf = null;
function glideTo(stage, x, dur = 420) {
  cancelAnimationFrame(navRaf);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { stage.scrollLeft = x; navDest = null; return; }
  const from = stage.scrollLeft, t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 3);
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur);
    stage.scrollLeft = from + (x - from) * ease(k);
    if (k < 1) navRaf = requestAnimationFrame(tick); else navDest = null;
  };
  navRaf = requestAnimationFrame(tick);
}
function advanceStripByViewport(direction) {
  if (state.mode !== "strip") return step(direction);
  const stage = $("#stage"), vw = stage.clientWidth, max = Math.max(0, stage.scrollWidth - vw);
  const base = navDest ?? stage.scrollLeft;
  if (direction === 1 && base >= max - 1) return;
  if (direction === -1 && base <= 1) {
    const last = $(`img[data-i="${g().photos.length - 1}"]`, stage);
    navDest = Math.min(max, last ? last.offsetLeft : max); glideTo(stage, navDest, 600); return;
  }
  const frames = $$("img[data-i], [data-ad], .end", stage);
  let frame = frames[0] || null;
  for (const c of frames) { if (c.offsetLeft > base + 1) break; frame = c; }
  let advance;
  if (direction === 1) {
    const target = frame && frame.nextElementSibling;
    advance = Math.min(vw, Math.max(0, (target ? target.offsetLeft : base + vw) - base));
  } else {
    let remaining = frame ? base - frame.offsetLeft : 0;
    while (remaining <= 0 && frame) { frame = frame.previousElementSibling; remaining = frame ? base - frame.offsetLeft : 0; }
    advance = Math.min(vw, Math.max(0, remaining));
  }
  navDest = Math.max(0, Math.min(max, base + direction * advance));
  // On a Dark or Light canvas the first photograph sits after the canvas margin; docking it means 0.
  if (frames[0] && navDest <= frames[0].offsetLeft + 1) navDest = 0;
  glideTo(stage, navDest);
}
$("#prev").onclick = () => advanceStripByViewport(-1);
$("#next").onclick = () => advanceStripByViewport(1);

/* ───────── Share ─────────
   The platform's own share sheet: on iOS, UIActivityViewController (Capacitor's Share.share), which already
   lists Copy, AirDrop, Messages, WhatsApp, Mail and whatever else is installed, in the order the person uses them;
   on the web, navigator.share, which opens the same sheet on phones and on Safari, Edge and Chrome desktops.
   Only where neither exists (some desktop browsers, or an iframe that refuses it) does manorama show its own four rows. */
const shareData = x => ({ title: x.slug, text: x.caption ? `${x.slug}: ${x.caption}` : x.slug, url: `https://${addr(x)}` });
async function shareGallery() {
  const x = g(), d = shareData(x);
  closeSheet(true);
  if (navigator.share && (!navigator.canShare || navigator.canShare(d))) {
    try { await navigator.share(d); return; }
    catch (e) { if (e.name === "AbortError") return; } // dismissed: nothing to do. Refused: fall through.
  }
  $("#share-addr").innerHTML = addr(x).split("/").map(s => `<span style="white-space:nowrap">${s}</span>`).join("/<wbr>");
  openSheet("share");
}
function shareTo(kind) {
  const d = shareData(g()), body = encodeURIComponent(`${d.text} ${d.url}`);
  if (kind === "copy") {
    (navigator.clipboard?.writeText(d.url) || Promise.reject()).then(() => toast("Link copied"), () => toast(d.url));
  } else {
    const href = { whatsapp: `https://wa.me/?text=${body}`, sms: `sms:?&body=${body}`, email: `mailto:?subject=${encodeURIComponent(d.title)}&body=${body}` }[kind];
    window.open(href, "_blank", "noopener");
  }
  closeSheet();
}

/* ───────── Privacy policy ───────── */
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* The same words as app/routes/privacy.tsx, rendered as an app screen. A link to the website would leave
   the app for Safari; here back returns to wherever the reader came from. */
function renderPrivacy() {
  const from = state.privacyFrom || "settings";
  $("#p-back-l").textContent = from === "welcome" ? "Back" : "Settings";
  const P = window.MANO.PRIVACY;
  $("#privacy-body").innerHTML = `<p class="updated">${P.updated}</p>` + P.sections.map(s =>
    `<section>${s.h ? `<h3>${s.h}</h3>` : ""}${s.p.map(t => t.startsWith("## ") ? `<h4>${t.slice(3)}</h4>` : `<p>${esc(t).replace("contact Mahesh Shantaram", 'contact <a href="https://thecontrarian.in/#contact" target="_blank" rel="noopener">Mahesh Shantaram</a>')}</p>`).join("")}</section>`).join("");
}

/* ───────── Gallery details ───────── */
const ICON = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  name: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  caption: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16M4 11h16M4 16h10"/></svg>',
  reorder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/></svg>',
  cr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  keep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M12 8v6M9.5 11.5L12 14l2.5-2.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
};
const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 6l6 6-6 6"/></svg>';
const act = (attrs, icon, label, value = "", tail = CHEV, cls = "") =>
  `<button class="act ${cls}" ${attrs}>${ICON[icon]}<span class="l">${label}</span><span class="v">${value}</span>${tail}</button>`;

/* Gallery details: the gallery as an object, then everything you can do to or with it, as identical rows. */
function renderDetails() {
  const x = g();
  if (!x) return go("library");
  // Opened from the viewer: back returns to the same photograph, without the curtain.
  const back = $("#d-back");
  if (state.fromViewer) { back.removeAttribute("data-go"); back.dataset.resume = ""; $("#d-back-l").textContent = "Back"; back.setAttribute("aria-label", `Back to ${x.slug}`); }
  else { delete back.dataset.resume; back.dataset.go = "library"; $("#d-back-l").textContent = "Library"; back.removeAttribute("aria-label"); }
  const n = x.photos.length;
  $("#details-body").innerHTML = `
    <article class="gal d-gal" data-gi="${state.gi}">
      <div class="strip" data-open-gallery="${state.gi}" role="button" tabindex="0" aria-label="Open ${x.slug}">${stripHTML(x)}</div>
      <div class="gal-meta">
        <div class="t">
          <div class="gal-name">${x.slug}</div>
          <div class="gal-sub">${plural(n, "photograph")}<span class="dot">·</span>${x.source}<span class="dot">·</span><span data-devword="${state.gi}">${deviceWord(x)}</span></div>
          ${x.device.mode === "save" && x.device.saved < n ? `<div class="meter" aria-hidden="true"><i data-meter="${state.gi}" style="width:${(x.device.saved / n) * 100}%"></i></div>` : ""}
          ${x.caption ? `<div class="gal-cap">${x.caption}</div>` : ""}
          <div class="gal-addr">${addr(x).split("/").map(s => `<span style="white-space:nowrap">${s}</span>`).join("/<wbr>")}</div>
        </div>
      </div>
    </article>
    <div class="acts">
      ${act('data-go="viewer"', "open", "Open gallery")}
      ${act("data-share", "share", "Share link", `…/${x.slug}`)}
    </div>
    <div class="acts">
      ${act('data-edit="name"', "name", "Name", x.slug)}
      ${act('data-edit="caption"', "caption", "Caption", x.caption || "None")}
      ${act('data-go="reorder"', "reorder", "Reorder photographs", String(n))}
    </div>
    <div class="acts">
      <button class="act" id="d-keep" role="switch" aria-checked="false">${ICON.keep}<span class="l">Keep a copy</span><span class="v" id="d-keep-v"></span><span class="switch" aria-hidden="true"></span></button>
      ${act("data-refresh", "refresh", "Read the folder again", `<span id="d-scanned">${x.scanned.split(",")[0]}</span>`)}
    </div>
    <div class="acts">
      ${act("data-delete", "remove", "Remove gallery", "", "", "danger")}
    </div>
    <p class="acts-note">Removing it leaves every photograph in ${x.source}.</p>`;
  wireRails($("#details-body"));
  renderDeviceBlock();
  $("#d-keep").onclick = () => {
    if (x.device.mode === "save") { x.device.mode = "stream"; x.device.saved = 0; toast("Saved copies removed from this iPhone"); }
    else { x.device.mode = "save"; x.device.saved = 0; toast("Saving to this iPhone"); }
    renderDeviceBlock();
  };
}
function renderDeviceBlock() {
  const x = g(), row = $("#d-keep"); if (!row) return;
  const on = x.device.mode === "save", n = x.photos.length, s = x.device.saved;
  row.setAttribute("aria-checked", String(on));
  row.querySelector(".switch").setAttribute("aria-checked", String(on));
  $("#d-keep-v").textContent = !on ? "Streams" : s < n ? `${s} of ${n}` : `${savedMB(x).toFixed(1)} MB`;
}

/* Name and caption: one small sheet, one field, one Save. */
function openEdit(kind) {
  const x = g(); state.editKind = kind;
  $("#edit-h").textContent = kind === "name" ? "Name" : "Caption";
  $("#edit-lbl").textContent = kind === "name" ? "Gallery name" : "Shown on the curtain, under the name";
  const inp = $("#edit-in"); inp.value = kind === "name" ? x.slug : x.caption; inp.placeholder = kind === "name" ? "" : "Add a caption";
  const help = () => $("#edit-help").textContent = kind === "name" ? `manorama.xyz/${ACCOUNT.owner}/${slugify(inp.value) || "…"}` : "";
  inp.oninput = help; help();
  openSheet("edit");
}
const slugify = v => v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
$("#edit-save").onclick = () => {
  const x = g(), v = $("#edit-in").value.trim();
  if (state.editKind === "name") { const s = slugify(v); if (!s) return; x.slug = s; toast("Name saved. The address follows it."); }
  else { x.caption = v; toast(v ? "Caption saved" : "Caption removed"); }
  closeSheet(); renderDetails();
};

/* ───────── Content Credentials ─────────
   Verification is client-side and lazy (TECH-SPEC): nothing runs until asked, nothing is uploaded.
   States per photograph follow Viewer.tsx: idle → loading → verified | unavailable. */
const cred = {};
const CR_COPY = { idle: "Not checked", loading: "Checking…", verified: "Verified", unavailable: "Could not verify" };
function verify(p) {
  if (!p.c2pa) { cred[p.id] = "unavailable"; return Promise.resolve(); }
  if (cred[p.id] === "verified") return Promise.resolve();
  cred[p.id] = "loading"; refreshCred();
  return new Promise(r => setTimeout(() => { cred[p.id] = "verified"; refreshCred(); r(); }, 450 + Math.random() * 500));
}
function refreshCred() {
  if (state.sheet === "info") renderInfo();
}
/* Viewer: the in-gallery information sheet (I). Position, caption, EXIF, Content Credentials. */
function renderInfo() {
  const x = g(), n = x.photos.length, i = Math.min(state.pos, n - 1), p = x.photos[i], M = window.MANO.MANIFEST;
  $("#info-h").textContent = `Photograph ${i + 1} of ${n}`;
  const st = cred[p.id] || "idle";
  $("#info-body").innerHTML = `
    <dl class="kv info-kv"><dt>File</dt><dd>${p.name}.jpg</dd><dt>Size</dt><dd>${p.w} × ${p.h}</dd><dt>Camera</dt><dd>${p.exif}</dd></dl>
    <section class="info-sec">
      <h4>Content Credentials <span class="cr-mark">C2PA</span></h4>
      ${!p.c2pa ? `<p>This photograph carries no Content Credentials.</p>`
        : st === "loading" ? `<p>Checking Content Credentials on this iPhone…</p>`
        : st === "verified" ? `<p style="color:var(--text)">Content Credentials verified on this iPhone.</p>
            <dl class="kv info-kv"><dt>Made with</dt><dd>${M.app}</dd><dt>Signed by</dt><dd>${M.issuer}</dd><dt>Signed</dt><dd>${M.signed}</dd></dl>
            <button class="btn btn-secondary btn-block" data-c2pa-viewer>Open in the C2PA viewer</button>`
        : `<p>This photograph carries Content Credentials.</p>`}
    </section>`;
  // Spec: opening the sheet on a credentialed, unchecked photograph starts the check.
  if (p.c2pa && st === "idle") verify(p);
}
function openC2paViewer() {
  const p = g().photos[Math.min(state.pos, g().photos.length - 1)];
  const url = `https://c2pa.thecontrarian.in/?uri=${encodeURIComponent(new URL(p.file, location.href).href)}`;
  toast("Opens the C2PA viewer in a new tab");
  console.info("C2PA viewer:", url);
}

/* ───────── Reorder ───────── */
function renderReorder() {
  const x = g();
  if (!state.order) { state.order = x.photos.slice(); state.moved = new Set(); state.dirty = false; state.picked = null; $("#r-status").textContent = R_HINT; }
  $("#r-title").textContent = `Reorder ${x.slug}`;
  $("#r-save").disabled = !state.dirty;
  const grid = $("#r-grid");
  grid.style.setProperty("--cell-h", `${state.cellH || 88}px`); $("#r-size").value = state.cellH || 88;
  grid.classList.toggle("picking", state.picked !== null);
  grid.innerHTML = state.order.map((p, i) => `
    <button class="cell ${state.picked === i ? "picked" : ""} ${state.moved.has(p.id) ? "moved" : ""}" data-cell="${i}" aria-label="${p.alt}, position ${i + 1}" style="--ar:${p.w} / ${p.h}">
      <img src="${p.file}" alt="" width="${p.w}" height="${p.h}">
      ${state.moved.has(p.id) ? `<span class="pos">${i + 1}</span>` : ""}
    </button>`).join("");
}
const R_HINT = "Tap a photograph to pick it up, then tap where it goes.";
$("#r-grid").addEventListener("click", e => {
  const c = e.target.closest("[data-cell]"); if (!c) return;
  const i = +c.dataset.cell, n = state.order.length;
  if (state.picked === null) {
    state.picked = i;
    $("#r-status").innerHTML = `Picked up <b>${state.order[i].name}</b>. Tap where it goes.`;
    $("#r-announce").textContent = `Picked up ${state.order[i].name}. Tap where it goes.`;
  } else if (state.picked === i) {
    state.picked = null;
    $("#r-status").textContent = R_HINT;
    $("#r-announce").textContent = "Put back.";
  } else {
    const [p] = state.order.splice(state.picked, 1);
    state.order.splice(i, 0, p);
    state.moved.add(p.id); state.dirty = true; state.picked = null;
    // No visible confirmation: the photograph is already in its new place. Screen readers still hear it.
    $("#r-status").textContent = R_HINT;
    $("#r-announce").textContent = `Moved ${p.name} to position ${i + 1} of ${n}.`;
  }
  renderReorder();
});
$("#r-size").addEventListener("input", e => { state.cellH = +e.target.value; $("#r-grid").style.setProperty("--cell-h", `${state.cellH}px`); });
$("#r-save").onclick = () => {
  g().photos = state.order; state.order = null;
  toast("Order saved"); go("details");
};
$("#r-cancel").onclick = () => {
  const had = state.dirty; state.order = null;
  if (had) toast("Changes discarded");
  go("details");
};

/* ───────── Settings ───────── */
function renderSettings(partial) {
  const used = vaultUsed(), cap = ACCOUNT.vaultCapMB, n = GALLERIES.length, lim = ACCOUNT.galleryLimit;
  const newDefault = state.newDefault || "save";
  const html = `
    <section class="set-sec">
      <h3>Account</h3>
      <div class="panel">
        <button class="rowlink" data-toast="Edit name"><span>Name</span><span class="v">${ACCOUNT.name}</span>${SVG.chev}</button>
        <button class="rowlink" data-toast="Change your address. Every gallery link follows it."><span>Address</span><span class="v">manorama.xyz/${ACCOUNT.owner}</span>${SVG.chev}</button>
        <button class="rowlink" data-toast="Link Google or Dropbox to this account"><span>Sign in with</span><span class="v">${ACCOUNT.signIn.map(s => s.provider).join(", ")}</span>${SVG.chev}</button>
      </div>
    </section>
    <section class="set-sec" id="plan">
      <h3>Plan</h3>
      <div class="panel">
        <div class="usage"><b>${ACCOUNT.tier}</b><span>${n} of ${lim} galleries</span></div>
        <div class="meter" aria-hidden="true"><i style="width:${(n / lim) * 100}%"></i></div>
        <p class="note">Visionary keeps up to 99 galleries and gives more room on this iPhone.</p>
        <button class="btn btn-secondary" data-open="pro" style="margin-top:14px">Go Visionary</button>
      </div>
    </section>
    <section class="set-sec">
      <h3>This iPhone</h3>
      <p>These settings stay on this device.</p>
      <div class="panel">
        <div class="opt" style="margin-top:0">
          <div class="lbl">New galleries</div>
          <div class="seg" id="seg-new">
            <button data-new="save" aria-pressed="${newDefault === "save"}">Keep a copy</button>
            <button data-new="stream" aria-pressed="${newDefault === "stream"}">Stream only</button>
          </div>
        </div>
        <div class="usage" style="margin-top:20px"><span>Encrypted copies</span><span id="vault-use">${used.toFixed(1)} MB of ${cap} MB</span></div>
        <div class="meter" aria-hidden="true"><i id="vault-meter" style="width:${(used / cap) * 100}%"></i></div>
        <div class="switchrow" style="margin-top:12px">
          <div class="t"><b>Photo picker</b><span>Let galleries show photographs already saved on this iPhone. Everything stays encrypted and on the device.</span></div>
          <button class="switch" role="switch" aria-checked="${state.picker !== false}" id="sw-picker" aria-label="Photo picker"></button>
        </div>
      </div>
    </section>
    <section class="set-sec">
      <h3>About</h3>
      <div class="panel">
        <button class="rowlink" data-privacy><span>Privacy policy</span>${SVG.chev}</button>
        <button class="rowlink" data-go="welcome"><span>Sign out</span>${SVG.chev}</button>
      </div>
      <div class="danger-zone" style="margin:18px 0 0">
        <button class="textbtn danger" data-toast="Asks for confirmation, then deletes the account. Nothing at any provider is touched.">Delete account</button>
      </div>
    </section>`;
  if (partial && $("#vault-use")) {
    $("#vault-use").textContent = `${used.toFixed(1)} MB of ${cap} MB`;
    $("#vault-meter").style.width = `${(used / cap) * 100}%`;
    return;
  }
  $("#settings-body").innerHTML = html;
  $("#seg-new").onclick = e => { const b = e.target.closest("[data-new]"); if (!b) return; state.newDefault = b.dataset.new; renderSettings(); };
  $("#sw-picker").onclick = () => { state.picker = state.picker === false; renderSettings(); };
}

/* ───────── Add a gallery ───────── */
const SAMPLE = "https://www.dropbox.com/scl/fo/q7m2xk/shillong-december?rlkey=v3n8&dl=0";
function detect(u) {
  if (/icloud\.com\/iclouddrive/.test(u)) return { err: "That’s an iCloud Drive link. In Photos, share the album as a Shared Album and paste that link instead." };
  if (/dropbox\.com\/(scl\/fo|sh)\//.test(u)) return { p: "Dropbox", name: (u.match(/fo\/[^/]+\/([^/?#]+)/) || [])[1] };
  if (/drive\.google\.com\/drive\/(u\/\d\/)?folders\//.test(u)) return { p: "Google Drive" };
  if (/(icloud\.com\/sharedalbum|share\.icloud\.com\/photos)/.test(u)) return { p: "iCloud" };
  if (/mega\.nz\/(folder|collection)\//.test(u)) return { p: "MEGA" };
  return null;
}
let scanTimer;
function resetAdd() {
  $("#add-url").value = ""; $("#add-status").textContent = ""; $("#add-status").className = "status-line";
  $("#add-scan").hidden = true; $("#add-or").hidden = false; $("#add-device").hidden = false; $("#add-strip").innerHTML = "";
}
function scan() {
  clearTimeout(scanTimer);
  const u = $("#add-url").value.trim(), st = $("#add-status");
  $("#add-scan").hidden = true; $("#add-strip").innerHTML = ""; st.className = "status-line";
  if (!u) { st.textContent = ""; $("#add-or").hidden = false; $("#add-device").hidden = false; return; }
  const d = detect(u);
  if (!d) { st.className = "status-line err"; st.textContent = "This isn’t a Dropbox, Google Drive, iCloud or MEGA share link."; return; }
  if (d.err) { st.className = "status-line err"; st.textContent = d.err; return; }
  $("#add-or").hidden = true; $("#add-device").hidden = true;
  st.innerHTML = `${d.p} folder. Reading it…`;
  const pool = ["hill-town", "pair-orange", "cage", "rooftops", "drinking", "church-garden", "leaves-b"];
  const all = GALLERIES.flatMap(x => x.photos).concat(window.__pool || []);
  window.__pool = window.__pool || all.slice();
  const photos = pool.map(id => window.__pool.find(p => p.id === id)).filter(Boolean);
  let k = 0;
  $("#add-scan").hidden = false;
  const name = (d.name || "untitled-folder").toLowerCase();
  $("#add-name").value = name;
  $("#add-addr").textContent = `manorama.xyz/${ACCOUNT.owner}/${name}`;
  $("#add-go").disabled = true;
  const tick = () => {
    if (k < photos.length) {
      const p = photos[k++];
      $("#add-strip").insertAdjacentHTML("beforeend", `<img src="${p.file}" alt="${p.alt}" width="${p.w}" height="${p.h}">`);
      st.innerHTML = `${d.p} folder. Reading it… <b>${plural(k, "photograph")}</b>`;
      scanTimer = setTimeout(tick, 260);
    } else {
      const over = GALLERIES.length >= ACCOUNT.galleryLimit;
      st.innerHTML = `<b>${plural(k, "photograph")}</b> found in ${d.p}. 1 file skipped: notes.pdf.${over ? " Your free galleries are full, so this one will last 30 days." : ""}`;
      $("#add-go").disabled = false;
      $("#add-go").onclick = () => {
        const slug = $("#add-name").value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || name;
        GALLERIES.unshift({ slug, caption: "", source: d.p, sourceUrl: u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 34) + "…", added: "27 Oct 2026", scanned: "Today, 21:58",
          device: { mode: state.newDefault || "save", saved: 0 }, sizeMB: 31.6, photos: photos.slice() });
        state.gi = 0; closeSheet(); go("library"); toast(`${slug} added`);
      };
    }
  };
  scanTimer = setTimeout(tick, 500);
}
$("#add-url").addEventListener("input", () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 450); });
$("#add-paste").onclick = () => { $("#add-url").value = SAMPLE; scan(); };
$("#add-name").addEventListener("input", e => {
  $("#add-addr").textContent = `manorama.xyz/${ACCOUNT.owner}/${e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "…"}`;
});

/* ───────── Sheets, dialogs, toast ───────── */
function openSheet(name) {
  closeSheet(true);
  const el = name === "delete" ? $("#dlg-delete") : $(`#sh-${name}`);
  if (!el) return;
  if (name === "add") resetAdd();
  if (name === "more") $("#more-h").textContent = g().slug;
  if (name === "delete") $("#del-p").textContent = `${g().slug} leaves your galleries and its link stops working. The photographs stay in ${g().source}.`;
  if (name === "view") { syncSegs(); clearTimeout(chromeTimer); }
  if (name === "info") { clearTimeout(chromeTimer); }
  state.sheet = name;
  if (name === "info") renderInfo();
  $("#scrim").classList.add("on"); el.classList.add("on");
  renderNotes(name);
  setTimeout(() => (el.querySelector("input, .seg button[aria-pressed=true], button") || el).focus({ preventScroll: true }), 60);
}
function closeSheet(instant) {
  $$(".sheet.on, .dialog.on").forEach(s => s.classList.remove("on"));
  $("#scrim").classList.remove("on");
  const was = state.sheet; state.sheet = null;
  if (!instant) { renderNotes(); if ((was === "view" || was === "info") && state.screen === "viewer") showChrome(); }
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}

/* ───────── Global clicks ───────── */
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-open-gallery], [data-go], a");
  if (!t) return;
  const th = e.target.closest(".strip .th");
  state.startAt = th ? +th.dataset.at : 0;
  if (t.matches("[data-privacy]")) { state.privacyFrom = state.screen === "welcome" ? "welcome" : "settings"; go("privacy"); return; }
  if (t.matches("#p-back")) { go(state.privacyFrom || "settings"); return; }
  if (t.matches("[data-resume]")) { go("viewer", { resume: true }); return; }
  if (t.matches("[data-details]")) { state.fromViewer = true; go("details"); return; }
  if (t.matches("[data-go]")) {
    const then = t.dataset.then;
    if (t.closest("#index") && ["viewer", "details", "reorder"].includes(t.dataset.go) && !GALLERIES.length) return toast("Add a gallery first");
    if (t.closest("#index")) state.gi = 0;
    if (t.dataset.go === "reorder") state.order = null;
    go(t.dataset.go);
    if (then) setTimeout(() => openSheet(then), 120);
    return;
  }
  if (t.matches("[data-open-gallery]")) { state.gi = +t.dataset.openGallery; go("viewer"); return; }
  if (t.matches("[data-more]")) { state.gi = +t.dataset.more; openSheet("more"); return; }
  if (t.matches("[data-open]")) { openSheet(t.dataset.open); return; }
  if (t.matches("[data-close]")) { closeSheet(); return; }
  if (t.matches("[data-signin]")) { go("library"); toast(`Signed in as ${ACCOUNT.name}`); return; }
  if (t.matches("[data-share]")) { shareGallery(); return; }
  if (t.matches("[data-share-to]")) { shareTo(t.dataset.shareTo); return; }
  if (t.matches("[data-refresh]")) { closeSheet(true); g().scanned = "Today, 21:58"; const s = $("#d-scanned"); if (s) s.textContent = "Today"; toast("Read again. No new photographs."); renderNotes(); return; }
  if (t.matches("[data-delete]")) { openSheet("delete"); return; }
  if (t.matches("[data-edit]")) { openEdit(t.dataset.edit); return; }
  if (t.matches("[data-c2pa-viewer]")) { openC2paViewer(); return; }
  if (t.matches("[data-restart]")) { restart(); return; }
  if (t.matches("[data-toast]")) { toast(t.dataset.toast); return; }
  if (t.closest("#seg-mode")) { state.mode = t.dataset.mode; state.pos = Math.min(state.pos, g().photos.length - 1); renderViewer(); clearTimeout(chromeTimer); return; }
  if (t.closest("#seg-bg")) { state.bg = t.dataset.bg; $("#s-viewer").dataset.bg = state.bg; syncSegs(); return; }
  if (t.id === "sw-arrows") { state.arrows = !state.arrows; $("#s-viewer").dataset.arrows = String(state.arrows); syncSegs(); return; }
});
$("#scrim").onclick = () => closeSheet();
$("#del-go").onclick = () => {
  const x = g(); GALLERIES.splice(state.gi, 1); state.gi = 0;
  closeSheet(true); go("library"); toast(`Removed. Nothing was deleted from ${x.source}.`);
};
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.sheet) return closeSheet();
  if (state.screen !== "viewer" || state.sheet) return;
  if (e.key === "i" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); return openSheet("info"); }
  if (e.key === "I" && e.shiftKey) { e.preventDefault(); return openC2paViewer(); }
  if (state.curtain && (e.key === "Enter" || e.key === " " || e.key === "ArrowRight")) { e.preventDefault(); return $("#curtain").click(); }
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); advanceStripByViewport(1); }
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); advanceStripByViewport(-1); }
});
document.addEventListener("keydown", e => { const s = e.target.closest?.(".strip"); if (s && e.key === "Enter") s.click(); });

/* ───────── Fit the phone to the window on desktop ───────── */
function fit() {
  const d = $("#device");
  if (innerWidth <= 520 || innerHeight <= 500) { d.style.transform = ""; d.parentElement.style.height = ""; return; }
  const s = Math.min(1, (innerHeight - 64) / 932);
  d.style.transform = `scale(${s})`;
  d.parentElement.style.height = `${932 * s}px`;
}
addEventListener("resize", fit); fit();

const SCREENS = ["welcome", "library", "viewer", "details", "reorder", "settings", "privacy"];
addEventListener("hashchange", () => { const h = location.hash.slice(1); if (SCREENS.includes(h) && h !== state.screen) { if (h === "reorder") state.order = null; go(h, { silent: true }); } });
const start = location.hash.slice(1);
go(SCREENS.includes(start) ? start : "welcome", { silent: true });
})();
