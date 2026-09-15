# Kairos — UI Redesign Brief for Claude Code

## 0. What this task is (read this first)

This is a **visual redesign only**. You are restyling the existing Kairos app to match the design system below. You are **not**:
- changing any JavaScript logic, event handlers, API calls, state management, or backend code
- renaming or removing any existing element `id`, `class`, or `data-*` attribute that JS relies on (grep for it before renaming anything — if a script references it, keep it and add new classes alongside it instead of replacing it)
- changing routes, redirects, auth flow, or any functional behavior
- adding new features

If you're ever unsure whether a change is "just CSS" or touches functionality, **don't make it** — flag it instead and move on to the next item.

Implementation should be **real, thorough CSS** — a proper stylesheet (or cleanly organized sections within the existing `style.css` / new files like `design-tokens.css`, `components.css`), using CSS custom properties for every color/radius/blur value so the whole system is driven from one place. Not inline styles scattered through the HTML, not a quick minimal patch — this should hold up as a real design system, covering hover/focus/active/disabled states and responsive behavior, not just the default state.

---

## 1. Design tokens — the single source of truth

Reference images are attached (see `/reference-images`), but **this token list overrides them wherever they conflict.** The images were AI-generated mockups and are visually inconsistent with each other in several ways (detailed in Section 3) — don't average them out or copy each one's specific background treatment. Use these exact values everywhere, on every page:

```css
:root {
  /* Background */
  --bg-base-start: #06070B;
  --bg-base-end: #0D0F16;

  /* Glass */
  --glass-fill: rgba(255,255,255,0.08);       /* 6-10% white, use 0.08 as default */
  --glass-border: rgba(255,255,255,0.12);
  --glass-blur: 48px;
  --glass-radius-lg: 28px;   /* cards, panels, modals */
  --glass-radius-md: 20px;   /* buttons, inputs, chips */
  --glass-radius-sm: 14px;   /* small chips, tags */

  /* Accent gradient — THE signature color, used sparingly */
  --accent-start: #6E8CFF;   /* indigo */
  --accent-end:   #5BD8E0;   /* cyan */
  --accent-gradient: linear-gradient(135deg, var(--accent-start), var(--accent-end));

  /* Text */
  --text-primary: #F2F3F5;    /* off-white — NEVER pure #FFFFFF */
  --text-secondary: #9AA0AC;  /* muted gray-blue */

  /* Error/warning accent (only place a second hue is allowed) */
  --warn-color: #E8A55C; /* soft amber, e.g. error toasts, "stop sharing" */
}
```

**Non-negotiable rules:**
1. The orb is **always** the indigo→cyan gradient (`--accent-gradient`). Never render it in white, pink, pastel rainbow, or pure purple — one reference image (`15-memory-panel.jpg`) shows a teal/Saturn-ring version and another (`17-device-panel.jpg`) shows a white/pastel version — **both are wrong, ignore them.** Same two gradient stops, every single time the orb appears, on every page.
2. Background is **always** the `--bg-base-start → --bg-base-end` dark gradient with a very subtle grain/noise texture — no exceptions, no page gets a flat solid color, no page gets a different hue. This is the specific bug you flagged: compare `03-main-hud-listening.jpg` (rich, glowing, atmospheric background) against `08-reminders-panel-open.jpg` and `11-settings-page.jpg` (flat, murky, no atmosphere) — these should be the *same* background treatment, just occasionally with panels/cards on top of it. Build the background as one reusable component (a fixed-position layer with the gradient + a faint animated particle/glow layer behind the orb) and reuse it behind literally every screen, including settings, text chat, auth, admin, and both notification-heavy states.
3. Text is **always** `--text-primary` / `--text-secondary` — never pure white, never pure black, never dark text on a light card (see Section 3, item 4 — the Memory panel mockup flips to light cards with dark text; that's wrong, keep it dark-glass with light text like every other panel).

---

## 2. Logo — where it goes

Files are in `/logo`. Use these, don't design a new logo, don't fall back to a text "K" or an emoji anywhere:

| File | Use it for |
|---|---|
| `kairos-mark.svg` | Any full-color placement on a dark background: landing page nav, auth page (small, blurred, background), admin panel sidebar (replace the literal "K" glyph shown in `07-admin-dashboard.jpg` — that's a placeholder, not a final mark) |
| `kairos-wordmark.svg` | Landing page hero, any full logo lockup with the word "Kairos" next to it |
| `kairos-mark-mono-white.svg` | Small/flat placements: the text-chat header (`13-text-chat.jpg` shows a "✦ Kairos" text-only header — replace that glyph with this mark), any dark navbar |
| `favicon-32.png` / `favicon-16.png` | Browser tab favicon |
| `apple-touch-icon-180.png` | iOS home-screen icon |
| `icon-192.png` / `icon-512.png` | PWA manifest, "any" purpose icons |
| `icon-192-maskable.png` / `icon-512-maskable.png` | PWA manifest, "maskable" purpose icons (already has full-bleed background baked in — don't add another background around it) |

Wire the favicon/apple-touch-icon `<link>` tags and the PWA manifest icons array to these files. Don't touch anything else in the manifest (name, start_url, etc.) unless it's currently pointing at a broken/missing icon path.

---

## 3. Known problems in the reference images — ignore these, don't reproduce them

These images came out of an AI image generator and have artifacts that are **not** intentional design choices. Do not copy them:

1. **Literal hex codes rendered as visible text** — `02-onboarding-plan-step.jpg` and `07-admin-dashboard.jpg` show the strings `#F2F3F5` and `#9AA0AC` printed as if they were real UI copy. That's the image generator misreading a color spec as text. Ignore it — those are just the secondary-text color values, not content.
2. **Garbled/nonsense text** — `13-text-chat.jpg` has AI-mangled sentences ("Hi., Kairos, I'lt and your, taite across this chat with you.") and `11-settings-page.jpg` has a duplicated, half-broken "Plannerg" section. Don't reproduce the actual words — use real copy already present in the codebase (or clearly-written placeholder copy if none exists), just match the *layout and visual style*.
3. **Wrong icon sets on the HUD bottom bar** — several images invent their own icon row (a compass, a phone, a video camera, an ellipsis) that doesn't match Kairos's real 9 buttons. The real, correct set is: **Text, Reminders, Memory, File, Camera, Screen-share, Settings, History, Device** (confirmed from `index.htm`: `txt-btn`, `rem-btn`, `mem-btn`, `file-btn`, `cam-btn`, `screen-btn`, `set-btn`, `hist-btn`, `device-btn`). Use the real set, styled per this design system, not whatever a given mockup happened to draw.
4. **Memory panel polarity flip** — `15-memory-panel.jpg` renders as light-gray opaque cards with dark text, breaking from the dark-glass-with-light-text system every other panel uses. Rebuild it dark-glass, consistent with the Reminders and Device panels (which got it right).
5. **Orb color drift** — see Section 1, rule 1.
6. **Settings page duplicate "Plan" module** — `11-settings-page.jpg` shows the Plan/Upgrade section rendered twice in slightly different forms. Build it once.

---

## 4. Page-by-page checklist

For each item: the reference image (style/layout reference only, see Section 3 for what to ignore in it), the real file it belongs to, and any specific notes.

| # | Page/state | Reference image | Real file | Notes |
|---|---|---|---|---|
| 1 | Landing page | `01-landing-page.jpg` | `main.htm` | Good structure (nav, hero, orb, 3 feature cards) — but **use the actual existing landing page copy/content from `main.htm`**, don't replace real content with the mockup's placeholder text. Add the logo per Section 2. Cards need consistent padding/alignment — see Section 5. |
| 2 | Onboarding — plan step | `02-onboarding-plan-step.jpg` | `onboarding.htm` | Card style is close to correct, reuse for the Free/Pro comparison card. |
| 3 | Onboarding — other steps (name, voice pref, etc.) | *(none provided)* | `onboarding.htm` | No mockup exists for these — extrapolate from the plan-selection step's card style and the general token system. Keep the same progress-dot header. |
| 4 | Main HUD (orb + bottom bar) | `03-main-hud-listening.jpg`, `12-main-hud-full-with-toast.jpg` | `index.htm` | These two are the best-realized reference images — closest to the target background/orb treatment. Use them as the primary reference for the background component described in Section 1, rule 2. |
| 5 | Auth / login | `09-auth-login.jpg` | `auth.htm` | Layout is right (centered glass card, Google + WebAuthn buttons). Fix: tone down the background glow to the standard atmospheric background (not the bright localized cyan patch shown), and make the orb small/blurred/receded per the original brief, not sharp and floating alone. |
| 6 | Settings | `11-settings-page.jpg` | `settings.htm` | Left nav + sectioned cards layout is right. Fix the duplicate Plan module (Section 3.6) and use real copy, not garbled text. |
| 7 | Text chat interface | `13-text-chat.jpg` | `text.js` (renders the `text-panel` overlay) | Structure is close: header with mark + "Voice On" badge, no-bubble Kairos messages, glass-pill user messages, PDF-attached chip, input bar. Fix: keep Kairos messages consistently un-boxed (one message in the reference incorrectly gets a solid card background — don't do that), and use real reply text. |
| 8 | Reminders panel | `08-reminders-panel-open.jpg` | `Memory.js`/reminder UI in `script.js`/`ai.js` (dynamically rendered panel) | Panel layout/structure is good. Fix the background behind it per Section 1 rule 2, and use the real HUD icon row (Section 3.3) instead of the invented one. |
| 9 | Memory panel | `15-memory-panel.jpg` | `Memory.js` | Rebuild dark-glass (Section 3.4). Content structure (tag icon / lock icon / note icon per row, "No memories" empty state) is otherwise fine. |
| 10 | Device panel | `17-device-panel.jpg` | wherever `toggleDevicePanel()` renders its markup in `script.js` | Structure (3 stacked selects with icon + current value) is good. Fix the orb color (Section 1 rule 1) and background. |
| 11 | Camera overlay | *(none provided)* | `cam-btn` / `cam-feed` in `index.htm` + `toggleCamera()` in `script.js` | No mockup exists for this one specifically — `10-camera-overlay-watching.jpg` is close enough conceptually (blurred background scene, "Kairos is watching" pill, small docked orb, floating bottom buttons) to use as the template. Build it to match. |
| 12 | Screen-share overlay | `14-screen-share-overlay.jpg` | `screen-btn` / `toggleScreenShare()` in `script.js` | Good reference, matches spec well. Should visually pair with the Camera overlay (same chrome, different content). |
| 13 | Admin panel | `07-admin-dashboard.jpg` | `Admn.html` | Good structure and mostly good token usage already (stat cards, table). Fix: replace literal "K" logo with `kairos-mark.svg`, remove the literal hex-code text (Section 3.1), make the table header row use the same glass treatment as everything else instead of a flat solid gray bar. |
| 14 | Notifications — system toast | `06-system-toast.jpg` | wherever generic toasts render in `script.js` | |
| 15 | Notifications — voice listening pill | `05-voice-listening-pill.jpg` | listening-state UI in `ai.js`/`script.js` | |
| 16 | Notifications — reminder-fired toast | `04-reminder-fired-toast-card-style.jpg` | reminder-fired toast in `ai.js` | Card shape/border here is good reference for corner radius and glow border; ignore the macOS-style menu bar drawn at the top of the image, that's not part of Kairos. |
| 17 | Notifications — locked-feature notice | `16-locked-feature-toast.jpg` | plan-gate notification (pro-lock messages) | Good match to spec already. |
| 18 | Notifications — general | — | — | All four of the above should look like **one family**: same chip shape, corner radius, blur, and font — only icon/accent/size differs. Don't let each one drift into its own visual style the way the source images (each generated independently) slightly do. |
| 19 | Static pages (privacy, terms, manual, contact) | *(none provided)* | `privacy.html`, `terms.html`, `manual.htm`, `conctact.html` | No mockups — just apply the base dark background + glass card container + typography tokens so these don't look like unstyled leftover pages. Keep it simple: title, body text in `--text-primary`/`--text-secondary`, no need for elaborate layout. |

---

## 5. Consistency fixes to apply everywhere, not just where explicitly noted

- **Card/grid alignment:** on the landing page and anywhere else with a row of cards (feature cards, plan comparison cards, stat cards), enforce equal height, equal padding, and an even gap via CSS Grid or Flexbox with defined gap values — don't let card heights vary based on content length the way the mockups sometimes do.
- **No emoji as UI icons, anywhere.** The current codebase uses emoji characters as icons in a few places (e.g. a 📄 for PDF, a 🔒 for locked features, a ◈ diamond as a brand mark). Replace every one of these with a proper inline SVG icon in the same thin-stroke (1.5px) line-icon style already used for the HUD row icons, so icon weight/style is consistent app-wide. The only exception is the Kairos mark itself, which uses the logo files from Section 2, not the ◈ character.
- **Glass consistency:** every card/panel/modal/input in the app should pull from the same `--glass-fill` / `--glass-border` / `--glass-blur` / radius tokens. If you find a component that's currently a flat opaque fill instead of frosted glass, convert it.
- **Motion/transitions:** implement real CSS transitions, not instant show/hide, using these values everywhere they apply:
  - Quick feedback (button press/toggle): 120–150ms ease-out
  - Panel open/close (Reminders, Memory, Device, History): 280–320ms, `cubic-bezier(0.22, 1, 0.36, 1)`
  - Full-screen overlays (Camera, Screen-share, Text chat): 350–400ms, same curve, with a background blur that increases as it opens
  - Notification toasts in: 220ms fade+scale from 0.95→1; out: 180ms fade+scale to 0.97
  - Only one utility panel (Reminders/Memory/Device/History) open at a time — closing the old one should start slightly before the new one starts opening, not simultaneously.
  - The orb should dim slightly (lower opacity / soft blur) whenever any panel is open, and return to full clarity when everything is closed.
  - When a panel is opened via a voice command rather than a tap, the orb should do a quick brighten-and-scale pulse (~300ms) first, then a short pause (~150ms), before the panel animates in — this makes voice actions feel "heard" rather than instant. Tap-opened panels don't need this pulse, they can open close to immediately.
  - Nothing should slide in from fully off-screen (no `translateX(100%)` etc.) — use fade + scale-from-96% instead, anchored at the edge it visually emerges from. This is the specific "heavy" feeling to avoid.

---

## 6. Before you consider this done, check:

- [ ] Every page uses the exact same background gradient/atmosphere component — flip between two pages and the background shouldn't visibly change treatment, only what's on top of it changes
- [ ] The orb is the same two-color gradient (`#6E8CFF → #5BD8E0`) on every single screen it appears on
- [ ] No pure white (`#FFFFFF`) or pure black (`#000000`) text/backgrounds anywhere except where a token explicitly calls for it (e.g. inside the accent gradient itself)
- [ ] No emoji characters used as functional icons anywhere in the UI
- [ ] The Kairos logo (not a bare "K" or a placeholder) appears on: landing nav, auth page, admin sidebar, favicon, PWA icons, text-chat header
- [ ] All four notification types share one visual family
- [ ] Zero functional/JS/backend changes — a diff of this work should only touch CSS files and (only where unavoidable) class names added to existing HTML elements, never removed IDs or handlers
