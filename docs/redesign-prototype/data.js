// Sample data for the manorama redesign prototype.
// Photographs are the owner's own frames, cut from the iPhone screenshots supplied with the brief.
// Gallery names, captions, dates and device figures are sample values to be replaced with real data.
const DIMS = {"cafe-guitar":[233,312],"cage-dog":[419,312],"cage":[233,312],"cappuccino":[1230,915],"chilli":[472,312],"church-garden":[204,313],"church":[1141,856],"couple-wall":[232,312],"drinking":[417,313],"dusk-town":[416,312],"hill-town":[419,312],"leaves-a":[420,312],"leaves-b":[419,312],"motorbike":[1230,914],"pair-orange":[419,312],"rooftops":[464,313],"town-terraces":[422,313],"window":[239,313]};

// Average colour of each frame: the placeholder a streamed thumbnail shows until its bytes arrive (TECH-SPEC: item placeholder).
const TONE = {"cafe-guitar": "#7c6f71", "cage-dog": "#746f6e", "cage": "#746c71", "cappuccino": "#6e7074", "chilli": "#7b696c", "church-garden": "#54595a", "church": "#7a7787", "couple-wall": "#6a6c6f", "drinking": "#4c3647", "dusk-town": "#544f55", "hill-town": "#453f44", "leaves-a": "#4b353e", "leaves-b": "#5a4747", "motorbike": "#7a6f6c", "pair-orange": "#43444c", "rooftops": "#746c76", "town-terraces": "#656c6f", "window": "#acaaaf"};

const ALT = {
  "church": "A white church spire against a pale sky, seen from a balcony",
  "rooftops": "Tin rooftops stepping down a hillside under overhead wires",
  "window": "A woman leaning out of an upstairs window of a white house",
  "town-terraces": "Houses packed in terraces up a hill in late afternoon light",
  "hill-town": "A hillside town at dusk with a church among the houses",
  "dusk-town": "The town spread across a ridge under a pink dusk sky",
  "church-garden": "Two people sitting on a wall below a red-roofed church",
  "couple-wall": "A couple in grey hoodies seated against a stone wall",
  "pair-orange": "A woman in an orange sweater beside a man in a denim jacket",
  "cafe-guitar": "A man with a guitar at a wooden table in a cafe window",
  "cappuccino": "A man in a leather jacket drinking coffee below a chalk menu",
  "leaves-a": "Two friends among dark red leaves",
  "leaves-b": "Three friends half hidden by dark red leaves",
  "motorbike": "A rider on a motorbike beside a pink stall at a night fair",
  "chilli": "Contestants at a chilli eating contest, one holding up a pepper",
  "drinking": "A girl in a red sweatshirt drinking from a can in a crowd",
  "cage": "A boxer seen from behind through a chain-link cage",
  "cage-dog": "A face pressed close to chain-link fencing"
};

// The crops are stand-ins for originals about four times their size. Declared dimensions are scaled so the
// viewer's never-upscale rule (TECH-SPEC: images fit the stage and are never upscaled past natural size) can be
// honoured in CSS without the demo frames rendering as thumbnails.
const SCALE = 4;
// Content Credentials: which originals carry a C2PA manifest (TECH-SPEC: item "C2PA state").
// Dropbox and MEGA serve originals, so credentials survive; iCloud shared albums serve web derivatives
// and are never marked c2pa. Sample values.
const C2PA = new Set(["church", "window", "pair-orange", "cappuccino", "leaves-b", "town-terraces"]);
const MANIFEST = { app: "Adobe Lightroom Classic", issuer: "Adobe Inc.", signed: "22 Oct 2026, 18:40" };
const EXIF = ["FUJIFILM X100V · 23mm · f/2.8 · 1/250 s · ISO 400", "FUJIFILM X100V · 23mm · f/4 · 1/500 s · ISO 200", "FUJIFILM X100V · 23mm · f/2 · 1/60 s · ISO 1600", "FUJIFILM X100V · 23mm · f/5.6 · 1/1000 s · ISO 160"];
function photo(id, i) {
  const [w, h] = DIMS[id].map(v => v * SCALE);
  return { id, file: `img/${id}.jpg`, w, h, tone: TONE[id], c2pa: C2PA.has(id), exif: EXIF[i % EXIF.length], alt: ALT[id], name: String(i + 1).padStart(2, "0") + "a" };
}

const ACCOUNT = {
  name: "Vidya Rao",
  owner: "vidya-rao-2",
  signIn: [{ provider: "Apple", email: "vidya.rao@icloud.com" }],
  tier: "Free",
  galleryLimit: 3,
  vaultCapMB: 256
};

const GALLERIES = [
  {
    slug: "cinder-fen-fall",
    caption: "Shillong, the week before the rains stopped",
    source: "Dropbox",
    sourceUrl: "dropbox.com/scl/fo/k2r8…/cinder-fen-fall",
    added: "24 Oct 2026",
    scanned: "Today, 21:54",
    device: { mode: "save", saved: 9 },  // saving to the encrypted vault
    sizeMB: 61.4,
    photos: ["church","rooftops","window","town-terraces","hill-town","dusk-town","church-garden","couple-wall","pair-orange","cafe-guitar","cappuccino","leaves-a","leaves-b"]
  },
  {
    slug: "night-market",
    caption: "",
    source: "iCloud",
    sourceUrl: "icloud.com/sharedalbum/#B0x5…",
    added: "11 Oct 2026",
    scanned: "11 Oct, 19:02",
    device: { mode: "stream", saved: 0 },
    sizeMB: 22.8,
    photos: ["motorbike","chilli","drinking","cage","cage-dog"]
  }
].map(g => ({ ...g, photos: g.photos.map((id, i) => { const p = photo(id, i); if (g.source === "iCloud") p.c2pa = false; return p; }) }));

// Vault use is the sum of what is actually saved, pro rata by photograph.
function savedMB(g) { return g.device.saved === 0 ? 0 : +(g.sizeMB * g.device.saved / g.photos.length).toFixed(1); }

// Checks: figures shown in more than one place must agree.
GALLERIES.forEach(g => {
  console.assert(g.device.saved <= g.photos.length, `${g.slug}: saved exceeds count`);
  console.assert(g.device.mode !== "stream" || g.device.saved === 0, `${g.slug}: streaming gallery holds saved photos`);
});
console.assert(GALLERIES.length <= ACCOUNT.galleryLimit, "free account over its gallery limit");

/* Verbatim from https://manorama.xyz/privacy (app/routes/privacy.tsx), 1 October 2026. */
const PRIVACY = {
 "updated": "Last updated: 1 October 2026",
 "sections": [
  {
   "h": "",
   "p": [
    "Manorama is a place to share and look at photographs. This policy covers manorama.xyz, the Manorama mobile app, and the Manorama desktop app for macOS, Windows, and Linux. Start with the part that sounds like you; if you both view and publish galleries, both parts apply."
   ]
  },
  {
   "h": "Who this is for",
   "p": [
    "## Just looking",
    "Open a public gallery link without an account. We do not keep a history of galleries you view or run page-view analytics. A link is unlisted, not private: anyone who has it can open it. When the native app is installed and the platform association is active, a public two-segment Manorama link may open in the app instead of the browser. A direct Dropbox, Google Drive, iCloud, or MEGA URL remains the provider’s link; only when someone deliberately wraps a supported public folder or album as https://manorama.xyz/<provider-url> may the native app receive an import intent. After sign-in, that intent sends the provider URL to Manorama to create the gallery; a signed-out app waits for sign-in. Your browser may remember display choices; the app may keep encrypted offline copies on your device.",
    "## Making galleries",
    "Sign in with Apple, Google, or Dropbox. We keep your account ID, name, email (which may be an Apple private-relay address), public address, plan, and the details needed to show your galleries. You can link more than one sign-in method to the same account. We never see your sign-in password or keep the provider’s sign-in token. Photos stay at the source; deleting a gallery here never deletes the originals.",
    "## Pro",
    "Paid plans use the same account data. On mobile, RevenueCat and your app store handle purchases; on the web, Stripe does. Manorama receives plan status, not card details. You can keep more galleries and a larger device vault. You may still see Manorama’s own labeled placements, but not third-party ad-network placements."
   ]
  },
  {
   "h": "Where photographs go",
   "p": [
    "For a cloud-source gallery, your photographs and videos stay with the public source you chose: Dropbox, Google Drive, iCloud Shared Albums, or MEGA. For each gallery, we keep its title, caption, public source link, media names and descriptive details, order, and any expiry date. When someone opens a gallery, Manorama fetches media from that source and passes it through to the viewer; we do not keep copies of ordinary image or video bytes on our server. Today only iCloud Shared Albums can include video — the other sources supply photographs. Source services may process requests under their own privacy policies. A shared album or folder must remain publicly reachable for a cloud-source gallery to work.",
    "The desktop app can also scan a folder you choose on that computer. Its local catalogue keeps the folder path and file list on the device; the catalogue metadata may sync to Manorama and contains only a title, source type, item count, device identifier, and device label. Opening, rescanning, launching, or mounting a folder does not upload the original files. If you explicitly choose Share, the app uploads supported originals to your connected Dropbox or Google Drive, creates a public provider link, and sends Manorama that link plus the gallery metadata. Local paths, file lists, and image bytes are not sent to the Manorama Worker.",
    "If an image includes Content Credentials — information about where an image came from and how it changed — verification happens on the viewer’s device when requested. We do not upload its provenance record for that check. Link previews may fetch a cover image transiently; they are not a stored photo library. One exception: MEGA galleries can hold originals in a format browsers cannot display, so the server decrypts a small preview photo on request. Those previews are held in a bounded in-memory cache — at most 200 entries, roughly 60MB — which is discarded when the server restarts. They are never written to our database or to durable storage."
   ]
  },
  {
   "h": "On your device",
   "p": [
    "The web app may remember gallery display choices and the editor’s theme in browser storage. These preferences are not sent to Manorama. Clearing site data removes them.",
    "The mobile app can keep photographs and gallery details in a vault — the app’s encrypted, app-private storage on your device — for offline viewing. Download to encrypted vault is the default for newly opened still-image galleries; Stream from cloud when needed avoids starting a new vault fill, while existing encrypted copies remain available. Galleries that include video are not cached for offline use today. The vault’s keys stay on that device and its files are excluded from cloud backup. Vault copies are readable through Manorama’s vault APIs only: they are not exported as ordinary photographs and should not appear in Files, Photos, Finder, or another image viewer. A cached image is either the source’s own bytes or a smaller version the source provides; nothing from the vault is saved to Manorama’s servers.",
    "The optional photo picker switch lives on the signed-in native account page, not inside each gallery. When enabled, it is a device-local contact sheet of photographs already held in the encrypted vault. It decrypts thumbnails only on the device, lazily as needed, and sends neither image bytes nor the contact sheet to Manorama. Native local compute may also persist compact versioned feature records in that same vault for grouping and sequencing suggestions; it does not send image bytes, thumbnails, vectors, or feature records to the Worker. Offline copies and local records stay until the app evicts them, you remove a gallery from the vault, you choose “Forget everything,” or you uninstall the app. Removing an online gallery or account does not automatically clear copies already on another device; clear the local vault separately.",
    "The desktop app keeps its catalogue — the local folders and cards you have opened and your linked galleries — on your device, along with its app-private session and provider connection records. It does not provide the mobile cloud-gallery encrypted-vault guarantee. Desktop local-folder publication is a separate, explicit Share action as described above."
   ]
  },
  {
   "h": "Ads and purchases",
   "p": [
    "Today the website and apps show only Manorama’s labeled house placements. On the website, signed-in paying viewers see only house placements. We plan non-personalized third-party website ads in gallery strips for visitors without a sign-in and signed-in Free viewers; these ads are not enabled yet. A paid viewer must sign in on the web for us to recognize their plan; while signed out, they appear anonymous. We will identify the website ad provider and explain its data use, consent choices, and browser storage before enabling it. In the mobile app, Google AdMob ads for Free users are also planned but not enabled. Even non-personalized ad providers may receive technical request data such as IP address and device details. We do not plan to request Apple’s advertising identifier.",
    "RevenueCat and your app store process purchases and restores on mobile; Stripe processes them on the web. They may process purchase, device, and account-linked information under their own policies. Manorama receives active-plan status and purchase-event references to set your plan — never your payment-card details. A purchase made in the app and one made on the web update the same account plan."
   ]
  },
  {
   "h": "Cookies, retention, and your choices",
   "p": [
    "Looking at a gallery without signing in does not require a Manorama login cookie. Signing in on the web uses short-lived safety cookies, a login cookie lasting up to seven days, and a returning-visitor hint lasting up to one year. Signing out clears the login cookie; you can clear the returning hint with browser site data. In the apps, a sign-in token is kept in secure device storage.",
    "An owner’s account and retained gallery details remain until deleted. A Free owner’s extra temporary galleries expire after 30 days unless upgraded in time. You can delete a gallery from your dashboard; that removes its Manorama record, not the source files.",
    "You can delete your account yourself, from your dashboard or in the app under account settings. Deletion removes your account, gallery records, device catalogue, and linked sign-in methods from Manorama. It does not delete files at the photo source, and app stores or Stripe keep their own billing records under their policies. You can also ask us to access, correct, or export your account information. Rights vary by location, and service providers may keep their own records under their policies."
   ]
  },
  {
   "h": "Services and what comes next",
   "p": [
    "Cloudflare hosts Manorama and may handle request details such as IP address and time for delivery and security. Apple, Google, or Dropbox handles sign-in, depending on which you choose. The linked photo provider supplies the media. The website and apps may request fonts from Google. RevenueCat and the app store handle mobile purchases; Stripe handles web purchases. If you install the app through the App Store or TestFlight, Apple may share crash reports, diagnostics, and any tester feedback you choose to send, under Apple's own policies and your device settings. We do not sell your account or gallery records or use them to personalize ads.",
    "We are exploring opt-in, session-only nearby sharing and on-device photo suggestions. These are not active collection or sharing practices today. We will update this policy before any of them changes what leaves your device or who receives it."
   ]
  },
  {
   "h": "Contact and changes",
   "p": [
    "For privacy questions or requests, contact Mahesh Shantaram. If our practices change, we will update this page and its date."
   ]
  }
 ]
};
window.MANO = { ACCOUNT, GALLERIES, savedMB, DIMS, MANIFEST, PRIVACY };
