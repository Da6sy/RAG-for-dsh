/**
 * `@clue-harness/ui-skin` node half.
 *
 * The skin is a browser feature, but its CONFIGURATION is a real dsh settings
 * section, not a localStorage side channel: this half declares the five groups
 * from design §3.4 as volatile fields, which makes dsh's settings service
 * describe the `ui-clue-skin` namespace and persist writes into the profile's
 * own patch. The browser half reads that namespace through
 * `ctx.configForms.get('ui-clue-skin')` and writes it back through the same
 * revision-fenced form.
 *
 * `auto: false` keeps the generic schema form off the Plugins page: this
 * package ships its own page (the documented posture for a feature that owns
 * its settings surface).
 *
 * @module @clue-harness/ui-skin
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.settings service merge.
import type {} from '@deepseek-ai/dsh-settings'
import {
  BG_FITS, BG_KINDS, BG_POSITIONS, BG_PRESETS, DEFAULT_SETTINGS, PERF_MODES, SETTINGS_NS,
} from './skin-config.ts'

/** Cordis plugin name (also the profile entry id and settings namespace). */
export const name = SETTINGS_NS

/**
 * The live settings section. Every field is `.volatile()` — dsh only describes
 * volatile fields as editable forms, and the browser page edits exactly these
 * scalars (the wallpaper BLOB itself never enters the profile; it lives in
 * browser IndexedDB).
 */
export const Config = z.object({
  bgKind: z.union([...BG_KINDS]).default(DEFAULT_SETTINGS.bgKind).volatile(),
  bgPreset: z.union([...BG_PRESETS]).default(DEFAULT_SETTINGS.bgPreset).volatile(),
  bgUrl: z.string().default(DEFAULT_SETTINGS.bgUrl).volatile(),
  bgFit: z.union([...BG_FITS]).default(DEFAULT_SETTINGS.bgFit).volatile(),
  bgPosition: z.union([...BG_POSITIONS]).default(DEFAULT_SETTINGS.bgPosition).volatile(),
  bgBlur: z.number().step(1).min(0).max(24).default(DEFAULT_SETTINGS.bgBlur).volatile(),
  maskOpacity: z.number().step(0.01).min(0).max(0.9).default(DEFAULT_SETTINGS.maskOpacity).volatile(),
  maskColor: z.string().default(DEFAULT_SETTINGS.maskColor).volatile(),
  glassPanels: z.boolean().default(DEFAULT_SETTINGS.glassPanels).volatile(),
  glassStrength: z.number().step(0.01).min(0).max(1).default(DEFAULT_SETTINGS.glassStrength).volatile(),
  glassBlur: z.number().step(1).min(0).max(24).default(DEFAULT_SETTINGS.glassBlur).volatile(),
  glassBorder: z.boolean().default(DEFAULT_SETTINGS.glassBorder).volatile(),
  bubbleLiquid: z.boolean().default(DEFAULT_SETTINGS.bubbleLiquid).volatile(),
  bubbleIntensity: z.number().step(0.01).min(0).max(1).default(DEFAULT_SETTINGS.bubbleIntensity).volatile(),
  bubbleReadability: z.boolean().default(DEFAULT_SETTINGS.bubbleReadability).volatile(),
  perfMode: z.union([...PERF_MODES]).default(DEFAULT_SETTINGS.perfMode).volatile(),
})

/** Host-side apply: only the form-page policy, no services. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
