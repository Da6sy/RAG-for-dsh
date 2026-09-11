/**
 * The ClueHarness presentation layer: one injected stylesheet carrying
 * (1) the theme-token override and (2) the clue surface component classes.
 *
 * Theme strategy (verified against ui-theme's sheets): every accent in the
 * dsh shell resolves through `var(--dsw-static-deepseek-*)`, and the light
 * and dark alias blocks REFERENCE those statics instead of redefining them.
 * So redefining the static ramp once on `body` (a later sheet at equal
 * specificity wins the cascade) re-accents the whole shell — buttons,
 * selection, the sidebar active chip — in both themes, without chasing
 * individual alias tokens. Surface/neutral ramps stay untouched: the layout
 * keeps dsh's structure, only the accent identity becomes ClueHarness teal.
 *
 * Component classes consume the semantic alias tokens (`--dsw-alias-*`)
 * with literal fallbacks, so the clue surfaces track whichever theme the
 * shell is in. Injection is an effect: the tag is removed with the plugin
 * fiber (registration-is-effect discipline).
 *
 * @module @clue-harness/ui-kb/client/styles
 */

/** The style tag's identity (idempotence + disposal). */
const TAG_ID = 'clue-ui-kb'

/**
 * The full sheet: token override + component classes.
 */
export const CLUE_SHEET = `
/* ── ClueHarness accent: deepseek-blue ramp → clue teal ramp ───────────── */
body {
  --dsw-static-deepseek-50: rgb(240, 253, 250);
  --dsw-static-deepseek-100: rgb(204, 251, 241);
  --dsw-static-deepseek-200: rgb(153, 246, 228);
  --dsw-static-deepseek-300: rgb(94, 234, 212);
  --dsw-static-deepseek-400: rgb(45, 212, 191);
  --dsw-static-deepseek-450: rgb(25, 200, 180);
  --dsw-static-deepseek-500: rgb(13, 148, 136);
  --dsw-static-deepseek-600: rgb(10, 120, 111);
}

/* ── clue surfaces ─────────────────────────────────────────────────────── */
.clue-sec { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.clue-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.clue-toolbar .clue-spacer { flex: 1; }
.clue-count { color: var(--dsw-alias-label-dimmed, #888); font-size: 12px; }
.clue-select {
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 8px; padding: 0 8px; font-size: 12px; height: 28px;
}
.clue-search { flex: 1 1 160px; min-width: 120px; max-width: 260px; }
.clue-card {
  border: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.2));
  border-radius: 10px; padding: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
  display: flex; flex-direction: column; gap: 8px;
}
.clue-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.clue-card-title { font-weight: 600; font-size: 14px; }
.clue-card-text { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary, inherit); }
.clue-dim { color: var(--dsw-alias-label-dimmed, #888); font-size: 12px; }
.clue-mono { font-family: var(--ds-font-family-code, monospace); font-size: 11px; }
.clue-pill {
  display: inline-flex; align-items: center; border-radius: 999px;
  padding: 1px 8px; font-size: 11px; line-height: 18px; white-space: nowrap;
  border: 1px solid transparent;
}
.clue-pill-ok   { color: rgb(22, 163, 74);  background: rgba(34, 197, 94, .12);  border-color: rgba(34, 197, 94, .35); }
.clue-pill-muted{ color: var(--dsw-alias-label-dimmed, #777); background: rgba(127,127,127,.1); border-color: rgba(127,127,127,.3); }
.clue-pill-warn { color: rgb(180, 120, 10); background: rgba(245, 158, 11, .14); border-color: rgba(245, 158, 11, .4); }
.clue-pill-bad  { color: rgb(220, 80, 60);  background: rgba(239, 68, 68, .12);  border-color: rgba(239, 68, 68, .35); }
.clue-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.clue-empty { padding: 24px; text-align: center; color: var(--dsw-alias-label-dimmed, #888); }
.clue-err {
  color: rgb(220, 80, 60); background: rgba(239, 68, 68, .08);
  border: 1px solid rgba(239, 68, 68, .3); border-radius: 8px; padding: 8px 10px;
}
.clue-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; border: 1px solid transparent;
}
.clue-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.clue-row-active { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, rgb(13,148,136)); background: rgba(13,148,136,.06); }
.clue-split { display: grid; grid-template-columns: minmax(220px, 5fr) minmax(280px, 7fr); gap: 12px; align-items: start; }
@media (max-width: 720px) { .clue-split { grid-template-columns: 1fr; } }
.clue-list { display: flex; flex-direction: column; gap: 2px; max-height: 420px; overflow-y: auto; }
.clue-history { display: flex; flex-direction: column; gap: 4px; border-left: 2px solid rgba(13,148,136,.35); padding-left: 10px; }
.clue-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.clue-cite { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.clue-cite-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.clue-cite-toggle {
  width: 100%; border: none; background: transparent; cursor: pointer;
  color: inherit; font: inherit; text-align: left; padding: 2px 0;
  border-radius: 6px;
}
.clue-cite-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.clue-cite-hits { display: flex; flex-direction: column; gap: 4px; }
.clue-cite-hit {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  padding: 4px 8px; border-radius: 6px;
  background: rgba(13,148,136,.05); border: 1px solid rgba(13,148,136,.15);
}
.clue-cite-annot { color: rgb(180, 120, 10); font-size: 11px; }
.clue-brand-name {
  font-weight: 700; letter-spacing: .2px; white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
}
.clue-brand-accent { color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, rgb(13,148,136)); }
.clue-signal-pos { color: rgb(22, 163, 74); }
.clue-signal-neg { color: rgb(220, 80, 60); }
.clue-polish {
  display: flex; flex-direction: column; gap: 6px;
  border-left: 2px solid rgba(13,148,136,.4); padding-left: 10px;
}
.clue-polish-text {
  width: 100%; box-sizing: border-box; resize: vertical;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit;
}
.clue-polish-text:focus { border-color: var(--dsw-alias-brand-primary, rgb(13,148,136)); outline: none; }
`

/** Workbench theme overrides use public tokens, never upstream generated class names. */
const WORKBENCH_SHEET = `
body {
  --clue-paper: #fbfcf9; --clue-panel: #ffffff; --clue-wash: #f0f4ef;
  --clue-ink: #193430; --clue-muted: #5c716a; --clue-line: #d9e4dc;
  --clue-accent: #0d7466; --clue-amber: #95621c;
  --dsw-alias-bg-base: #fbfcf9;
  --dsw-specific-sidebar-fill: #f0f4ef;
  --dsw-alias-label-primary: #193430;
}
body[data-ds-dark-theme] {
  --clue-paper: #111c1b; --clue-panel: #192825; --clue-wash: #20332f;
  --clue-ink: #e2eee7; --clue-muted: #a2b9ad; --clue-line: #344b41;
  --clue-accent: #78dcc0; --clue-amber: #edc17c;
  --dsw-alias-bg-base: #111c1b;
  --dsw-specific-sidebar-fill: #15231f;
  --dsw-alias-label-primary: #e2eee7;
}
.clue-sec { color: var(--clue-ink); gap: 18px; line-height: 1.65; min-width: 0; container-type: inline-size; }
.clue-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 8px 0 18px; border-bottom: 1px solid var(--clue-line); }
.clue-eyebrow { font-size: 10px; letter-spacing: .16em; font-weight: 700; color: var(--clue-accent); text-transform: uppercase; }
.clue-heading h2 { font-size: 25px; letter-spacing: -.04em; line-height: 1.3; margin: 6px 0; font-weight: 650; }
.clue-heading p { margin: 0; max-width: 44ch; color: var(--clue-muted); font-size: 12px; }
.clue-counter { min-width: 54px; text-align: right; color: var(--clue-accent); font-size: 32px; line-height: 1.2; font-variant-numeric: tabular-nums; }
.clue-counter small { display: block; font-size: 10px; color: var(--clue-muted); margin-top: 5px; }
.clue-toolbar { padding: 12px; border: 1px solid var(--clue-line); background: var(--clue-wash); border-radius: 14px; gap: 8px; }
.clue-row:focus-visible, .clue-select:focus-visible, .clue-polish-text:focus-visible { outline: 2px solid var(--clue-accent); outline-offset: 3px; }
.clue-select,.clue-polish-text { background: var(--clue-panel); color: var(--clue-ink); border-color: var(--clue-line); max-width: 100%; }
.clue-card { background: var(--clue-panel); border-color: var(--clue-line); padding: 20px; gap: 14px; border-radius: 16px; box-shadow: 0 4px 18px rgba(10,34,28,.035); min-width: 0; overflow-wrap: anywhere; }
.clue-card-head { gap: 8px; }
.clue-card-title { font-size: 16px; letter-spacing: -.02em; }
.clue-card-text { color: var(--clue-ink); font-size: 13px; line-height: 1.85; padding: 12px 14px; border-radius: 10px; background: var(--clue-wash); }
.clue-dim,.clue-count { color: var(--clue-muted); }
.clue-pill { font-size: 10px; font-weight: 600; padding: 2px 8px; line-height: 18px; }
.clue-pill-ok { background: color-mix(in srgb, var(--clue-accent) 10%, transparent); color: var(--clue-accent); border-color: color-mix(in srgb, var(--clue-accent) 25%, transparent); }
.clue-pill-warn,.clue-cite-annot { color: var(--clue-amber); }
.clue-pill-muted { color: var(--clue-muted); background: var(--clue-wash); border-color: var(--clue-line); }
.clue-actions { gap: 8px; padding-top: 5px; }
.clue-empty { padding: 36px 20px; border: 1px dashed var(--clue-line); border-radius: 16px; background: var(--clue-paper); color: var(--clue-muted); }
.clue-split { grid-template-columns: minmax(0, 4fr) minmax(0, 7fr); gap: 16px; }
.clue-list { padding: 5px; border: 1px solid var(--clue-line); border-radius: 14px; background: var(--clue-panel); max-height: 580px; }
.clue-row { padding: 12px 10px; border-radius: 10px; gap: 7px; flex-wrap: wrap; }
.clue-row-active { border-color: var(--clue-accent); background: var(--clue-wash); }
.clue-history { gap: 12px; border-color: var(--clue-line); padding-left: 14px; }
.clue-card details { border-top: 1px solid var(--clue-line); padding-top: 10px; }
.clue-card summary { cursor: pointer; font-weight: 600; }
.clue-cite { color: var(--clue-ink); border: 1px solid var(--clue-line); background: var(--clue-paper); border-radius: 12px; padding: 12px; box-sizing: border-box; min-width: 0; }
.clue-cite-hit { background: var(--clue-wash); border-color: var(--clue-line); padding: 8px 10px; border-radius: 8px; overflow-wrap: anywhere; }
.clue-drawer-scrim { position: fixed; inset: 0; background: color-mix(in srgb, var(--clue-ink) 18%, transparent); z-index: 60; display: flex; justify-content: flex-end; }
.clue-drawer { width: min(460px, 92vw); height: 100%; background: var(--clue-paper); border-left: 1px solid var(--clue-line); box-shadow: -18px 0 46px rgba(10,34,28,.14); display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: hidden; box-sizing: border-box; }
.clue-drawer-head { display: flex; align-items: flex-start; gap: 10px; }
.clue-drawer-title { flex: 1; min-width: 0; }
.clue-drawer-title h3 { margin: 4px 0 2px; font-size: 18px; letter-spacing: -.03em; }
.clue-drawer-title code { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--clue-muted); word-break: break-all; }
.clue-drawer-tabs { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--clue-line); padding-bottom: 8px; }
.clue-drawer-tabs button { border: 0; background: none; color: var(--clue-muted); font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px; cursor: pointer; }
.clue-drawer-tabs button.clue-tab-on { background: var(--clue-wash); color: var(--clue-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--clue-accent) 28%, transparent); }
.clue-drawer-body { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }
.clue-drawer-foot { border-top: 1px solid var(--clue-line); padding-top: 8px; font-size: 11px; }
.clue-drow { border: 1px solid var(--clue-line); background: var(--clue-panel); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.clue-drow-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.clue-drow-text { font-size: 12.5px; line-height: 1.75; color: var(--clue-ink); }
.clue-kbbtn-mark { color: var(--clue-accent); font-size: 10px; }
.clue-kbbtn-count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--clue-amber); color: #fff; font-size: 10px; line-height: 16px; text-align: center; }
.clue-notice { flex: 1 1 100%; font-size: 12px; color: var(--clue-accent); background: color-mix(in srgb, var(--clue-accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--clue-accent) 22%, transparent); border-radius: 10px; padding: 8px 10px; }
.clue-orphan { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; padding: 10px 12px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--clue-amber) 40%, transparent); background: color-mix(in srgb, var(--clue-amber) 8%, transparent); }
.clue-orphan code { font-size: 11px; }
.clue-menu-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; width: 100%; }
.clue-menu-label { font-size: 12.5px; }
.clue-menu-hint { font-size: 10.5px; color: var(--clue-muted); font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); }
.clue-menuselect { display: inline-flex; min-width: 0; }
.clue-menuselect-label { display: inline-block; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clue-menuselect-caret { font-size: 9px; opacity: .7; transition: transform .12s ease; }
.clue-menuselect-caret-open { transform: rotate(180deg); }
.clue-workspace-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--clue-line); border-radius: 14px; background: var(--clue-panel); }
.clue-workspace-bar .clue-spacer { flex: 1; }
.clue-workspace-bar .clue-select { font-size: 12px; }
.clue-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.clue-field-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--clue-muted); font-weight: 700; }
.clue-input { flex: 1 1 220px; min-width: 0; padding: 6px 10px; border: 1px solid var(--clue-line); border-radius: 10px; background: var(--clue-wash); color: var(--clue-ink); font: inherit; font-size: 12px; }
.clue-input-narrow { flex: 0 1 180px; }
.clue-input:focus-visible { outline: 2px solid var(--clue-accent); outline-offset: 2px; }
.clue-inline-form { display: flex; flex: 1 1 100%; flex-wrap: wrap; gap: 8px; align-items: center; }
.clue-brand-name { font-size: 16px; letter-spacing: -.055em; font-weight: 750; }
.clue-brand-accent { color: var(--clue-accent); font-weight: 450; }
@container (max-width: 650px) { .clue-split { grid-template-columns: minmax(0,1fr); } .clue-list { max-height: 240px; } .clue-card { padding: 14px; } }
@media (prefers-reduced-motion: reduce) { .clue-sec *, .clue-cite * { transition: none !important; } }
`

/**
 * Install the sheet once per document; idempotent by tag id.
 * @returns a disposer removing the tag (effect-owned).
 */
export function installClueStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-clue-ui="${TAG_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.clueUi = TAG_ID
  tag.textContent = CLUE_SHEET + WORKBENCH_SHEET
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
