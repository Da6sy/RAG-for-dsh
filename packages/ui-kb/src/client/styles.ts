/**
 * The ClueHarness presentation layer: one injected stylesheet carrying
 * (1) the accent-token override and (2) the clue surface classes.
 *
 * V1-UI revision (2026-09-19): these classes no longer define a visual language
 * of their own. Every measurement and color ROLE is taken from dsh's own
 * settings surfaces, read out of the shipped `dsh-client-ui-settings-models`
 * bundle:
 *
 *   section      max-width 720px · column · gap 12px · `--dsw-alias-label-primary`
 *   title        16px / 500 / 24px        intro   14px / 22px · label-tertiary
 *   row card     1px `--dsw-alias-border-l2` · radius 12px · padding 12px 14px
 *   row name     14px / 500 / 22px        row tag  11px / 16px · radius 4px · border-l3
 *   field label  12px / 500 / 18px · label-secondary, inputs 32px tall / radius 8
 *   errors       12px / 18px · state-error-primary   notices 12px / 18px · state-warn-label
 *   code         `--ds-font-family-code`, 13px for identifiers
 *
 * The point: a ClueHarness page and a dsh page must be indistinguishable in
 * typography, spacing, radii, borders and color roles. Nothing here invents a
 * font size, a radius or a hue; a value that is not in the list above is a bug
 * in this file.
 *
 * The ONE deliberate override is the accent ramp: every accent in the dsh shell
 * resolves through `var(--dsw-static-deepseek-*)`, and the light/dark alias
 * blocks REFERENCE those statics, so redefining the ramp once on `body` (a later
 * sheet at equal specificity) re-accents the whole shell — dsh's own pages
 * included — in ClueHarness teal. It changes the ACCENT only: surfaces, borders
 * and text ramps stay exactly dsh's.
 *
 * @module @clue-harness/ui-kb/client/styles
 */

/** The style tag's identity (idempotence + disposal). */
const TAG_ID = 'clue-ui-kb'

/** The full sheet: accent override + component classes. */
export const CLUE_SHEET = `
/* ── accent: the deepseek-blue ramp → clue teal ramp (accents only) ────── */
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

/* ── page frame ────────────────────────────────────────────────────────── */
.clue-sec {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  min-width: 0;
}
.clue-heading { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0; }
.clue-eyebrow { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 500; line-height: 18px; letter-spacing: 0; text-transform: none; }
.clue-heading h2 { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; letter-spacing: 0; }
.clue-heading p { margin: 0; max-width: none; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.clue-counter { color: var(--dsw-alias-label-primary); font-size: 20px; font-weight: 500; line-height: 28px; min-width: 0; text-align: left; font-variant-numeric: tabular-nums; }
.clue-counter small { display: inline; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); margin: 0 0 0 6px; }

/* ── cards & rows ──────────────────────────────────────────────────────── */
.clue-card {
  display: flex; flex-direction: column; gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: none; box-shadow: none;
  min-width: 0; overflow-wrap: anywhere;
}
.clue-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.clue-card-title { font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-primary); }
.clue-card-text { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; padding: 0; background: none; border-radius: 0; }
.clue-list { display: flex; flex-direction: column; gap: 8px; max-height: 520px; overflow-y: auto; padding: 0; border: 0; background: none; }
.clue-row {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: none; cursor: pointer; min-width: 0;
}
.clue-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.clue-row-active { border-color: var(--dsw-alias-brand-primary, var(--dsw-static-deepseek-500)); background: var(--dsw-alias-interactive-bg-hover); }
.clue-split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 12px; align-items: start; }
.clue-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 0; }
.clue-spacer { flex: 1; }
.clue-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: none; }

/* ── fields: dsh stacks a 12/500 label ABOVE a full-width control ──────── */
.clue-field { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; font-size: 14px; line-height: 22px; }
.clue-field-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; letter-spacing: 0; text-transform: none; }
/* An INLINE variant for a badge beside a label (status dots, switches). */
.clue-field-inline { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; }
.clue-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.clue-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.clue-input, .clue-select, .clue-polish-text {
  box-sizing: border-box; height: 32px; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px; min-width: 0; max-width: 100%;
}
.clue-input { width: 100%; flex: 1 1 auto; }
.clue-input-narrow { width: 100%; flex: 1 1 auto; }
.clue-select { cursor: pointer; width: 100%; max-width: none; }
.clue-input:focus-visible, .clue-select:focus-visible, .clue-polish-text:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, var(--dsw-static-deepseek-500)); outline-offset: 1px; }
.clue-inline-form { display: flex; flex: 1 1 100%; flex-wrap: wrap; gap: 8px; align-items: center; }
.clue-search { flex: 1 1 200px; min-width: 120px; max-width: 320px; }

/* ── badges: dsh's row tag ─────────────────────────────────────────────── */
.clue-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 16px; font-weight: 400;
  background: none; white-space: nowrap;
}
.clue-pill-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.clue-pill-warn { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-label); }
.clue-pill-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.clue-pill-muted { color: var(--dsw-alias-label-tertiary); }
.clue-dim, .clue-count, .clue-cite-annot { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.clue-cite-annot { color: var(--dsw-alias-state-warn-label); }
.clue-mono { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 13px; }
.clue-signal-pos { color: var(--dsw-alias-state-success-primary); }
.clue-signal-neg { color: var(--dsw-alias-state-error-primary); }
.clue-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; padding: 8px 10px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; }
.clue-notice { flex: 1 1 100%; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-module-platform); border: 0; border-radius: 8px; padding: 8px 10px; }
.clue-empty { padding: 24px 16px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; background: none; }
.clue-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.clue-orphan { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-label); background: var(--dsw-alias-bg-module-platform); }
.clue-history { display: flex; flex-direction: column; gap: 8px; border-left: 1px solid var(--dsw-alias-border-l2); padding-left: 12px; }
.clue-docblock { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.clue-dochead, .clue-chunk-head, .clue-cite-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.clue-chunk { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.clue-excerpt {
  display: block; white-space: pre-wrap; word-break: break-word;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 8px; padding: 8px 10px;
}

/* ── citation cards (in the conversation) ──────────────────────────────── */
.clue-cite { display: flex; flex-direction: column; gap: 6px; width: 100%; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); background: none; border-radius: 12px; padding: 12px 14px; box-sizing: border-box; min-width: 0; }
.clue-cite-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 4px; margin-left: -4px; border: 0; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 500; line-height: 18px; cursor: pointer; }
.clue-cite-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.clue-cite-hits { display: flex; flex-direction: column; gap: 6px; }
.clue-cite-hit { background: var(--dsw-alias-bg-module-platform); border: 0; padding: 8px 10px; border-radius: 8px; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; }

/* ── drawer (session knowledge) ────────────────────────────────────────── */
.clue-drawer-scrim { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35)); z-index: 60; display: flex; justify-content: flex-end; }
.clue-drawer {
  width: min(460px, 92vw); height: 100%;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.12));
  display: flex; flex-direction: column; gap: 12px; padding: 14px 16px;
  overflow: hidden; box-sizing: border-box; color: var(--dsw-alias-label-primary);
}
.clue-drawer-head { display: flex; align-items: flex-start; gap: 10px; }
.clue-drawer-title { flex: 1; min-width: 0; }
.clue-drawer-title h3 { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.clue-drawer-title code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 13px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.clue-drawer-tabs { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 6px; }
.clue-drawer-tabs button { border: 0; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; font-weight: 500; line-height: 18px; padding: 4px 10px; border-radius: 14px; cursor: pointer; }
.clue-drawer-tabs button.clue-tab-on { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-brand-primary, var(--dsw-static-deepseek-500)); }
.clue-drawer-body { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.clue-drawer-foot { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.clue-drow { border: 1px solid var(--dsw-alias-border-l2); background: none; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.clue-drow-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.clue-drow-text { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }

/* ── menus & workspace bar ─────────────────────────────────────────────── */
.clue-menu-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; width: 100%; }
.clue-menu-label { font-size: 14px; line-height: 22px; }
.clue-menu-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.clue-menuselect { display: inline-flex; min-width: 0; }
.clue-menuselect-label { display: inline-block; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clue-menuselect-caret { font-size: 9px; opacity: .7; transition: transform .12s ease; }
.clue-menuselect-caret-open { transform: rotate(180deg); }
.clue-workspace-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: none; }
.clue-workspace-bar .clue-select { width: auto; min-width: 220px; flex: 1 1 260px; }
.clue-workspace-bar .clue-field-label { flex: none; }

/* ── inline polish editor ──────────────────────────────────────────────── */
.clue-polish { display: flex; flex-direction: column; gap: 8px; }
.clue-polish-text { height: auto; min-height: 96px; padding: 8px 10px; resize: vertical; font-family: inherit; }

/* ── tool-call badge in the conversation ───────────────────────────────── */
.clue-kbbtn-mark { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.clue-kbbtn-text { color: var(--dsw-alias-label-primary); }
.clue-kbbtn-count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 14px; text-align: center; }

/* ── brand marks (the one place ClueHarness signs its name) ────────────── */
.clue-brand-name { font-size: 16px; font-weight: 500; line-height: 24px; letter-spacing: 0; }
.clue-brand-accent { color: var(--dsw-alias-brand-primary, var(--dsw-static-deepseek-500)); font-weight: 400; }

/* ── disclosure: expanded content stays inside the card, no nested chrome ─ */
.clue-sec details, .clue-card [class*="_disclosure"] { border: 0; }
.clue-disclosure-body { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 0; border: 0; background: none; }

/* ── the shared settings-page section header ───────────────────────────── */
.clue-sec-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; color: var(--dsw-alias-label-primary); }
.clue-sec-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.clue-sec-actions { display: flex; align-items: center; gap: 8px; }

@container (max-width: 650px) { .clue-split { grid-template-columns: minmax(0,1fr); } .clue-list { max-height: 240px; } }
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
  tag.textContent = CLUE_SHEET
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
