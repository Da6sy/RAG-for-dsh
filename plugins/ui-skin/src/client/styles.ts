/**
 * The skin stylesheet: one injected `<style>` carrying the whole visual
 * language. The browser controller only writes CSS custom properties and a
 * handful of `data-cl-xs-*` gates on `<html>`; this sheet is static, so a
 * config change is a variable write, never a DOM rebuild.
 *
 * Selector discipline is the design's core requirement (§3.2), and
 * `src/audit.ts` enforces it in tests:
 *
 * 1. tokens first — the shell is re-tinted by overriding four documented
 *    custom properties, never by reaching into component internals;
 * 2. semantic `data-*` hooks second — `[data-dockkit-pane]`,
 *    `[data-conversation-content]`, `[data-shortcut-modal="settings"]`, …;
 * 3. plugin-owned `cl-xs-*` classes for everything this plugin renders;
 * 4. element-level fallbacks only (`html`, `body`, `#root`).
 *
 * The single documented fallback is the conversation bubble: dsh's user
 * bubble has no semantic attribute, so the sheet matches the CSS-module LOCAL
 * name fragment (`[class*="bubble"]`) inside a semantic chat row. The
 * contract test pins the built dsh bundle's local name so an upstream rename
 * fails loudly instead of silently un-skinning the bubble.
 *
 * @module @clue-harness/ui-skin/client/styles
 */

/** The style tag's identity (idempotence + disposal). */
const TAG_ID = 'clue-ui-skin'

/** The full sheet. */
export const SKIN_SHEET = `
/* ── the contract with the controller: every value below is written on
      documentElement; the fallbacks are the light palette's defaults ─────── */
html {
  --cl-xs-wallpaper: none;
  --cl-xs-preview-wall: none;
  --cl-xs-image-size: cover;
  --cl-xs-image-position: center center;
  --cl-xs-image-blur: 0px;
  --cl-xs-image-scale: 1;
  --cl-xs-canvas: #ffffff;
  --cl-xs-mask: rgba(0, 0, 0, 0.38);
  --cl-xs-settings-mask: rgba(0, 0, 0, 0.24);
  --cl-xs-vignette: rgba(31, 41, 55, 0.12);
  --cl-xs-surface-base: rgba(255, 255, 255, 0.86);
  --cl-xs-surface-sidebar: rgba(255, 255, 255, 0.8);
  --cl-xs-surface-dialog: rgba(255, 255, 255, 0.96);
  --cl-xs-surface-composer: rgba(255, 255, 255, 0.89);
  --cl-xs-surface-terminal: rgba(255, 255, 255, 0.97);
  --cl-xs-surface-bubble: rgba(255, 255, 255, 0.6);
  --cl-xs-panel-filter: none;
  --cl-xs-chat-filter: none;
  --cl-xs-float-filter: none;
  --cl-xs-bubble-filter: none;
  --cl-xs-bubble-bg: rgba(255, 255, 255, 0.6);
  --cl-xs-bubble-shadow: none;
  --cl-xs-edge: rgba(255, 255, 255, 0.75);
  --cl-xs-edge-soft: rgba(15, 23, 42, 0.06);
  --cl-xs-accent: var(--dsw-alias-button-info-fill, var(--dsw-static-deepseek-500, rgb(65 118 230)));
  --cl-xs-danger: var(--dsw-alias-state-error-primary, #ec1313);
}

/* ── wallpaper: one fixed stack below every shell pixel ─────────────────── */
.cl-xs-wall {
  position: fixed;
  inset: 0;
  z-index: -1;
  display: none;
  pointer-events: none;
  overflow: hidden;
  background-color: var(--cl-xs-canvas);
}
html[data-cl-xs-on] .cl-xs-wall { display: block; }
.cl-xs-wall-image {
  position: absolute;
  inset: 0;
  background-image: var(--cl-xs-wallpaper);
  background-size: var(--cl-xs-image-size);
  background-position: var(--cl-xs-image-position);
  background-repeat: no-repeat;
  filter: blur(var(--cl-xs-image-blur));
  transform: scale(var(--cl-xs-image-scale));
  transform-origin: center center;
}
.cl-xs-wall-tone { position: absolute; inset: 0; background: var(--cl-xs-mask); }
.cl-xs-wall-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(125% 95% at 50% 0%, transparent 42%, var(--cl-xs-vignette) 100%);
}

/* ── the shell goes transparent; the surface tokens carry the glass tint ─── */
html[data-cl-xs-on] { background-color: var(--cl-xs-canvas); }
html[data-cl-xs-on] body { background: transparent; }
/* The renderer wraps the frame in a [data-slot="root"] element: the frame is
   its ONLY div child, so the old #root > div selector was hitting the slot
   wrapper, and #root > div > div:first-child was hitting the FRAME — that
   accidentally frosted the whole viewport and never touched the sidebar
   column. These selectors name the real depth. */
html[data-cl-xs-on] #root > [data-slot='root'] { background: transparent; }
html[data-cl-xs-on] #root [data-slot='root'] > div { background: transparent; }
/* The shell eases its grid tracks only while React's data-animating state is
   present. That state is written in a layout effect after the track update, so
   a toggle can meet the transition property and the new track for the first
   time together and miss the easing — while the right panel's own transform
   always eases, so only one side of the junction moves. The controller pre-arms
   this marker on pointerdown/keydown; :where(...) keeps specificity at 0 so the
   shell's own dragging / fullscreen / instant / reduced-motion transitions:none
   still win. */
@media (prefers-reduced-motion: no-preference) {
  :where(#root [data-slot='root'] > div[data-cl-xs-track-animating]) {
    transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
}

/* The 0.3s track animation reflows the whole frame, and during it the
   backdrop-filter on the large surfaces dominates the frame budget. While the
   shell reports data-animating, drop the frost on those surfaces; their tint
   stays, so the surface colour does not change, and the full frost returns the
   moment the track settles. This is a deliberate trade for frame pacing, not a
   permanent look change. */
@media (prefers-reduced-motion: no-preference) {
  html[data-cl-xs-on] #root [data-slot='root'] > div[data-animating] [data-conversation-content],
  html[data-cl-xs-on] #root [data-slot='root'] > div[data-animating] [data-composer-card],
  html[data-cl-xs-on] #root [data-slot='root'] > div[data-animating] [data-dockkit-pane],
  html[data-cl-xs-on] #root [data-slot='root'] > div[data-animating] [data-dockkit-float],
  html[data-cl-xs-on] #root [data-slot='root'] > div[data-animating] > div:has(> [data-slot='sidebar'])::before {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* Windows caption buttons are Electron's native titleBarOverlay, not DOM. The
   desktop preload measures this hidden probe's computed background and sends
   it to setTitleBarOverlay over windowsAppearance. The probe writes its colour
   inline, so only !important can make the caption fill transparent; the page
   glass then shows through. The controls' own hover stays native/Electron. */
html[data-cl-xs-on] body > span[style*='--dsw-specific-sidebar-fill'] {
  background-color: transparent !important;
}

/* The Windows centre's top-left 16px radius clips the conversation glass; with
   the frame transparent that notch showed the raw wallpaper. Fill only the
   notch (the area outside the radius) with the conversation surface and the
   same frost. The controller publishes the centre's frame-relative origin, so
   the patch follows the sidebar edge during a toggle. The filter lives on the
   frame's pseudo, never on the frame: the Windows caption controls and the KB
   drawer are fixed descendants of the frame. */
html[data-cl-xs-on][data-windows-titlebar] #root [data-slot='root'] > div::after {
  content: '';
  position: absolute;
  left: var(--cl-xs-center-left, 0px);
  top: var(--dsh-windows-titlebar-height, 40px);
  width: var(--dsh-windows-content-radius, 16px);
  height: var(--dsh-windows-content-radius, 16px);
  pointer-events: none;
  background: var(--cl-xs-surface-base);
  -webkit-backdrop-filter: var(--cl-xs-chat-filter);
  backdrop-filter: var(--cl-xs-chat-filter);
  -webkit-mask-image: radial-gradient(circle var(--dsh-windows-content-radius, 16px) at 100% 100%, transparent calc(var(--dsh-windows-content-radius, 16px) - 0.5px), #000 var(--dsh-windows-content-radius, 16px));
  mask-image: radial-gradient(circle var(--dsh-windows-content-radius, 16px) at 100% 100%, transparent calc(var(--dsh-windows-content-radius, 16px) - 0.5px), #000 var(--dsh-windows-content-radius, 16px));
}

/* The patch rides the frame's grid transition on the same curve; the marker is
   pre-armed by the controller so the start is deterministic. */
@media (prefers-reduced-motion: no-preference) {
  html[data-cl-xs-on][data-windows-titlebar] #root [data-slot='root'] > div[data-cl-xs-track-animating]::after {
    transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
}
html[data-cl-xs-on] body {
  --dsw-alias-bg-base: var(--cl-xs-surface-base);
  --dsw-specific-sidebar-fill: var(--cl-xs-surface-sidebar);
}

/* The sidebar column and the sidebar root both paint the sidebar fill; with an
   alpha on the token that would stack to near-opaque. The column stays clear
   and the root (and the token's other consumers) carries the tint. Frost lives
   on a pseudo layer, whose backdrop is the wallpaper.

   Why not put backdrop-filter on the column itself? Windows puts the sidebar
   toggle and the collapsed "new session" button at position: fixed inside this
   column. Any filter (even the clear preset's saturate-only) makes the column
   the containing block for those fixed descendants: they shift down by the
   titlebar height and are clipped when the collapsed column has width 0. The
   pseudo is a sibling layer, not an ancestor of the buttons, so they stay
   anchored to the viewport. z-index: 2 keeps them above the center column when
   the sidebar is collapsed; z-index alone does not create a containing block. */
html[data-cl-xs-on] #root [data-slot='root'] > div > div:has(> [data-slot='sidebar']) {
  position: relative;
  z-index: 2;
  background: transparent;
}
html[data-cl-xs-on] #root [data-slot='root'] > div > div:has(> [data-slot='sidebar'])::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  -webkit-backdrop-filter: var(--cl-xs-panel-filter);
  backdrop-filter: var(--cl-xs-panel-filter);
}
/* Windows desktop: the shell paints --dsw-alias-bg-base on the center column
   too, which stacks a SECOND opaque-ish layer under the conversation surface
   and collapses the wallpaper to near-black. Keep the column clear; the
   conversation root owns the single tint. */
html[data-cl-xs-on] #root [data-slot='root'] > div > div:has(> [data-slot='sidebar']) + div {
  background: transparent;
}

/* Layout containment only, on the two surfaces whose contents reflow every
   frame during a track toggle. Fixed overlays live outside them (the KB drawer
   is in the conversation header; dock floats are outside the panes), and paint
   containment is intentionally omitted so bubble shadows and pane highlights
   are not clipped. */
html[data-cl-xs-on] [data-conversation-content],
html[data-cl-xs-on] [data-dockkit-pane] {
  contain: layout;
}

/* The right panel's left edge is driven per frame by panel-sync while a track
   animates; keep its transform on its own compositor layer. */
html[data-cl-xs-on] [data-rightbar-col] [data-dockkit-host='dock'],
html[data-cl-xs-on] [data-rightbar-col] [data-dockkit-empty],
html[data-cl-xs-on] [data-rightbar-col] [data-dockkit-divider] {
  will-change: transform;
}

/* Chat region: the largest text surface, and the one that needs the frost. */
html[data-cl-xs-on] [data-conversation-content] {
  -webkit-backdrop-filter: var(--cl-xs-chat-filter);
  backdrop-filter: var(--cl-xs-chat-filter);
}
/* The session knowledge drawer (ui-kb) is position: fixed inside this header.
   A backdrop-filter here would become its containing block and collapse the
   full-screen scrim to the header's 76px box (the client report). Keep the
   header's glass tint from the conversation surface, but no frost on this bar:
   a 76px strip loses less than a broken drawer. Fixed overlays must never have
   a filtered ancestor — see the sidebar note above and the dock note below. */
html[data-cl-xs-on] header[data-window-drag] {
  background: transparent;
}

/* The right dock hosts fixed floating panes, so the column itself must not
   carry a filter. Frost each docked pane instead (the pane is not an ancestor
   of the fixed float); a floating pane already sits inside the float's own
   frost, so reset the inner pane there to avoid a double layer. */
html[data-cl-xs-on] [data-dockkit-pane] {
  -webkit-backdrop-filter: var(--cl-xs-panel-filter);
  backdrop-filter: var(--cl-xs-panel-filter);
}
html[data-cl-xs-on] [data-dockkit-float] [data-dockkit-pane] {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

/* Floating windows sit over content, so they frost what is behind them too. */
html[data-cl-xs-on] [data-dockkit-float] {
  background: var(--cl-xs-surface-dialog);
  -webkit-backdrop-filter: var(--cl-xs-float-filter);
  backdrop-filter: var(--cl-xs-float-filter);
}

/* The settings panel is glass like the rest of the shell, and its overlay mask
   is lightened while the skin is on: with the stock 50% black mask the
   wallpaper behind a 0.8 panel collapsed to black (the client report). The
   overlay is body-portaled; its first div child is the mask. */
html[data-cl-xs-on] body > div:has(> [data-shortcut-modal='settings']) > div:first-child {
  background: var(--cl-xs-settings-mask);
}
html[data-cl-xs-on] [data-shortcut-modal='settings'] {
  background: var(--cl-xs-surface-dialog);
  -webkit-backdrop-filter: var(--cl-xs-float-filter);
  backdrop-filter: var(--cl-xs-float-filter);
}

/* ── dock content surfaces: terminal + file viewer ────────────────────────
   The pane element itself carries data-dockkit-pane and paints the tabHost's
   --dsw-alias-bg-base, so scoping that token to a pane containing the surface
   gives the terminal/document ONE glass tint (the inner surfaces then stay
   transparent). The tint is a little stronger than the chat surface (13px
   monospace needs it) and still goes through the 4.5:1 guard. */
html[data-cl-xs-on] [data-dockkit-pane]:has([data-sidebar-terminal]) {
  --dsw-alias-bg-base: transparent;
}
/* The terminal's screen element keeps the tint (not transparent): dsh passes
   that computed background into the xterm theme, and xterm's minimum-contrast
   pass needs the real surface colour. The screen paints the tint, the xterm
   background itself is cleared below, so the pane still has ONE glass layer. */
html[data-cl-xs-on] [data-sidebar-terminal] {
  background: transparent;
  --dsw-alias-bg-base: var(--cl-xs-surface-terminal);
  --dsw-alias-bg-l2: var(--cl-xs-surface-composer);
}
/* xterm 6 ships the DOM renderer here (no canvas addon). The renderer writes
   the theme background inline on .xterm-scrollable-element; these overrides
   remove that opaque slab so the pane tint (and the wallpaper behind it) show.
   The classes are xterm's public DOM structure, not dsh CSS-module hashes. */
html[data-cl-xs-on] [data-sidebar-terminal] .xterm-viewport,
html[data-cl-xs-on] [data-sidebar-terminal] .xterm-scrollable-element,
html[data-cl-xs-on] [data-sidebar-terminal] .xterm-screen,
html[data-cl-xs-on] [data-sidebar-terminal] .xterm-rows {
  background-color: transparent !important;
}

html[data-cl-xs-on] [data-dockkit-pane]:has([data-document-preview]) {
  --dsw-alias-bg-base: transparent;
}
/* A floated terminal/document keeps its frame, shadow and frost, but not a
   second opaque fill behind the screen/viewer tint. */
html[data-cl-xs-on] [data-dockkit-float]:has([data-sidebar-terminal]),
html[data-cl-xs-on] [data-dockkit-float]:has([data-document-preview]) {
  background: transparent;
}
html[data-cl-xs-on] [data-document-preview] {
  background: var(--cl-xs-surface-document);
  --dsw-alias-bg-base: transparent;
  /* PDF pages and HTML previews keep their own content surface; the shallow
     veil lets the wallpaper read through the viewer chrome and code files. */
  --dsw-alias-bg-document-preview: var(--cl-xs-surface-document-veil);
  --dsw-alias-markdown-code-block: var(--cl-xs-surface-code);
  --dsw-alias-markdown-code-block-banner: var(--cl-xs-surface-code-banner);
  --dsw-alias-markdown-inline-code: var(--cl-xs-surface-inline-code);
}
html[data-cl-xs-on] [data-document-markdown] {
  background: transparent;
}

/* Composer: the most-looked-at control, so it gets the same glass as panels. */
html[data-cl-xs-on] [data-composer-card] {
  background: var(--cl-xs-surface-composer);
  -webkit-backdrop-filter: var(--cl-xs-panel-filter);
  backdrop-filter: var(--cl-xs-panel-filter);
}

/* A 1px inner highlight is what makes a translucent surface read as an edge
   instead of a smear. Painted as an overlay so no component geometry moves. */
html[data-cl-xs-border] [data-composer-card]::after,
html[data-cl-xs-border] [data-dockkit-float]::after,
html[data-cl-xs-border] [data-shortcut-modal='settings']::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: inset 0 1px 0 var(--cl-xs-edge), inset 0 0 0 1px var(--cl-xs-edge-soft);
}
html[data-cl-xs-border] #root [data-slot='root'] > div > div:has(> [data-slot='sidebar']) {
  box-shadow: inset -1px 0 0 var(--cl-xs-edge-soft);
}

/* ── liquid glass bubbles ───────────────────────────────────────────────────
   dsh's user bubble carries no semantic attribute; the local class name is
   the documented fallback (see audit + contract test). The recipe is three
   stacked translucent layers (sheen, tint, edge) over a backdrop blur. */
html[data-cl-xs-on][data-cl-xs-liquid] [data-chat-flow-kind='user'] [class*='bubble'],
html[data-cl-xs-on][data-cl-xs-liquid] [data-chat-flow-kind='steering'] [class*='bubble'],
html[data-cl-xs-on][data-cl-xs-liquid] [data-pending-steering] [class*='bubble'],
html[data-cl-xs-on][data-cl-xs-liquid] [data-submission-echo] [class*='bubble'] {
  background: var(--cl-xs-bubble-bg);
  -webkit-backdrop-filter: var(--cl-xs-bubble-filter);
  backdrop-filter: var(--cl-xs-bubble-filter);
  box-shadow: var(--cl-xs-bubble-shadow);
}

/* ── no backdrop support: keep the tint, drop the refraction ─────────────── */
@supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  html[data-cl-xs-on] #root [data-slot='root'] > div > div:has(> [data-slot='sidebar'])::before,
  html[data-cl-xs-on] [data-conversation-content],
  html[data-cl-xs-on] [data-dockkit-pane],
  html[data-cl-xs-on] [data-dockkit-float],
  html[data-cl-xs-on] [data-shortcut-modal='settings'],
  html[data-cl-xs-on] [data-composer-card] {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cl-xs-sec * { transition: none; }
}

/* ── the settings page ───────────────────────────────────────────────────
   Chrome vocabulary copied from the shipped settings surfaces (720px column,
   12px gaps, 12px card radius, 12/500 field labels, 11px badges) so the page
   is indistinguishable from a dsh-authored one. */
.cl-xs-sec {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.cl-xs-head { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.cl-xs-head-copy { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.cl-xs-eyebrow {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.cl-xs-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.cl-xs-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; }
.cl-xs-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.cl-xs-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
.cl-xs-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cl-xs-card-title { font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-primary); }
.cl-xs-card-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.cl-xs-grow { flex: 1; }

.cl-xs-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.cl-xs-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }
.cl-xs-badge-warn { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-label); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 55%, transparent); }
.cl-xs-badge-live { color: var(--cl-xs-accent); border-color: var(--cl-xs-accent); border-color: color-mix(in srgb, var(--cl-xs-accent) 55%, transparent); }
.cl-xs-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.cl-xs-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cl-xs-field-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.cl-xs-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.cl-xs-value { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.cl-xs-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.cl-xs-error { margin: 0; color: var(--cl-xs-danger); font-size: 12px; line-height: 18px; }
.cl-xs-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.cl-xs-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.cl-xs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; align-items: end; }

/* pill-style segmented choices: a toggle-button group, no tab semantics */
.cl-xs-choice { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.cl-xs-choice-btn {
  padding: 3px 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
}
.cl-xs-choice-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.cl-xs-choice-btn[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12); }
.cl-xs-choice-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.cl-xs-choice-btn:focus-visible { outline: 2px solid var(--cl-xs-accent); outline-offset: 1px; }

/* native range, tokenized */
.cl-xs-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 18px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}
.cl-xs-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--cl-xs-accent) 0 var(--cl-xs-fill, 50%),
    var(--dsw-alias-border-l3) var(--cl-xs-fill, 50%) 100%
  );
}
.cl-xs-range::-moz-range-track { height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l3); }
.cl-xs-range::-moz-range-progress { height: 4px; border-radius: 999px; background: var(--cl-xs-accent); }
.cl-xs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
}
.cl-xs-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
}
.cl-xs-range:focus-visible { outline: 2px solid var(--cl-xs-accent); outline-offset: 3px; border-radius: 4px; }
.cl-xs-range:disabled { cursor: not-allowed; opacity: 0.55; }

/* nine-grid position picker */
.cl-xs-pos { display: grid; grid-template-columns: repeat(3, 26px); gap: 4px; }
.cl-xs-pos-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}
.cl-xs-pos-btn::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.cl-xs-pos-btn:hover { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-interactive-bg-hover); }
.cl-xs-pos-btn[aria-pressed='true'] { border-color: var(--cl-xs-accent); }
.cl-xs-pos-btn[aria-pressed='true']::before { background: var(--cl-xs-accent); }
.cl-xs-pos-btn:focus-visible { outline: 2px solid var(--cl-xs-accent); outline-offset: 1px; }

/* preset chips */
.cl-xs-presets { display: flex; gap: 8px; flex-wrap: wrap; }
.cl-xs-preset {
  display: flex;
  flex: 1 1 150px;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cl-xs-preset:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cl-xs-preset[aria-pressed='true'] { border-color: var(--cl-xs-accent); box-shadow: 0 0 0 1px var(--cl-xs-accent); }
.cl-xs-preset:focus-visible { outline: 2px solid var(--cl-xs-accent); outline-offset: 2px; }
.cl-xs-preset-swatch { height: 42px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background-size: cover; background-position: center; }
.cl-xs-preset-copy { display: flex; flex-direction: column; gap: 1px; padding: 0 2px 2px; min-width: 0; }
.cl-xs-preset-name { font-size: 12px; font-weight: 500; line-height: 18px; }
.cl-xs-preset-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }

/* upload / drop zone */
.cl-xs-drop {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: none;
}
.cl-xs-drop-over { border-color: var(--cl-xs-accent); background: var(--dsw-alias-interactive-bg-hover); }
.cl-xs-thumb {
  flex: none;
  width: 66px;
  height: 42px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background-color: var(--dsw-alias-bg-module-platform);
  background-size: cover;
  background-position: center;
}
.cl-xs-drop-copy { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.cl-xs-drop-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; }
.cl-xs-drop-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; }
.cl-xs-drop-actions { display: flex; flex: none; gap: 6px; }
.cl-xs-hidden { display: none; }

/* URL row */
.cl-xs-url-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cl-xs-url-row .cl-xs-input { flex: 1; }
.cl-xs-input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
}
.cl-xs-input:focus-visible { outline: 2px solid var(--cl-xs-accent); outline-offset: 1px; }
.cl-xs-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  resize: vertical;
}

/* the inline live preview */
.cl-xs-preview {
  position: relative;
  height: 132px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  isolation: isolate;
  background: var(--dsw-alias-bg-base);
}
.cl-xs-preview-wall { position: absolute; inset: 0; background-image: var(--cl-xs-preview-wall); background-size: cover; background-position: center; }
.cl-xs-preview-tone { position: absolute; inset: 0; background: var(--cl-xs-mask); }
.cl-xs-preview-vignette { position: absolute; inset: 0; background: radial-gradient(125% 95% at 50% 0%, transparent 42%, var(--cl-xs-vignette) 100%); }
.cl-xs-preview-ui { position: absolute; inset: 0; display: flex; gap: 8px; padding: 10px; }
.cl-xs-preview-side,
.cl-xs-preview-dock {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 7px;
  border-radius: 8px;
  background: var(--cl-xs-surface-sidebar);
  -webkit-backdrop-filter: var(--cl-xs-panel-filter);
  backdrop-filter: var(--cl-xs-panel-filter);
}
.cl-xs-preview-side { width: 17%; }
.cl-xs-preview-dock { width: 21%; }
.cl-xs-preview-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-label-tertiary); opacity: 0.42; }
.cl-xs-preview-bar-strong { opacity: 0.7; }
.cl-xs-preview-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--cl-xs-surface-base);
}
.cl-xs-preview-line { height: 7px; border-radius: 4px; background: var(--dsw-alias-label-tertiary); opacity: 0.28; }
.cl-xs-preview-bubble {
  align-self: flex-end;
  max-width: 76%;
  padding: 6px 10px;
  border-radius: 12px;
  color: var(--dsw-alias-label-primary);
  font-size: 10px;
  line-height: 14px;
  background: var(--cl-xs-bubble-bg);
  box-shadow: var(--cl-xs-bubble-shadow);
  -webkit-backdrop-filter: var(--cl-xs-bubble-filter);
  backdrop-filter: var(--cl-xs-bubble-filter);
}
.cl-xs-preview-cta {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.28), transparent);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}
.cl-xs-preview-cta button {
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  padding: 2px 8px;
  cursor: pointer;
}
.cl-xs-preview-cta button:hover { background: rgba(255, 255, 255, 0.26); }
.cl-xs-preview-cta button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

/* footer facts */
.cl-xs-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.cl-xs-foot code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; }
`

/**
 * Install the sheet once per document; idempotent by tag id.
 * @returns a disposer removing the tag (effect-owned).
 */
export function installSkinStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-clue-ui="${TAG_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.clueUi = TAG_ID
  tag.textContent = SKIN_SHEET
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
