/**
 * The surface plan: how opaque each glass layer has to be, and the resulting
 * contrast ratios. Pure math — the browser controller feeds it the live theme
 * colours and the wallpaper's measured average, then writes the returned
 * alphas into CSS variables.
 *
 * The guard's direction matters: the recipe's design alpha comes first (that
 * is the look), and the contrast floor may only RAISE it to keep text
 * legible. A dark-theme glass over a bright photo therefore deepens on its
 * own instead of asking the user to notice and fix it.
 *
 * @module @clue-harness/ui-skin/plan
 */
import {
  CONTRAST_MIN, backdropEndpoints, composite, contrastRatio, minAlphaForContrast, worstContrast,
  type RGB,
} from './contrast.ts'
import { resolveMaskColor, type SkinSettings, type SkinTheme } from './skin-config.ts'
import { parseColor } from './contrast.ts'

/** The alpha decision for every surface the skin paints. */
export interface SurfacePlan {
  /** The base surface (`--dsw-alias-bg-base`): conversation, dock panes, chrome. */
  baseAlpha: number
  /** The left sidebar column (drawn by `--dsw-specific-sidebar-fill`). */
  sidebarAlpha: number
  /** The settings dialog panel. */
  dialogAlpha: number
  /** The composer card over the conversation surface. */
  composerAlpha: number
  /** The liquid-glass bubble over the conversation surface. */
  bubbleAlpha: number
  /** The terminal container: intentionally near-opaque for glyph contrast. */
  terminalAlpha: number
  /** Lowest text contrast across the content-bearing surfaces. */
  minContrast: number
  /** Bubble text contrast specifically (may differ when the guard is off). */
  bubbleContrast: number
  /** Whether every content surface reached {@link CONTRAST_MIN}. */
  ok: boolean
}

/** Inputs the controller hands the plan. */
export interface PlanInput {
  settings: SkinSettings
  theme: SkinTheme
  /** The theme's opaque surface colour. */
  surface: RGB
  /** The theme's primary body-text colour. */
  text: RGB
  /** The wallpaper's average sRGB grey (0–255), or undefined when not measured. */
  averageGrey: number | undefined
}

/** Clamp into the alpha range a glass surface may use. */
function alpha(value: number): number {
  return Math.min(1, Math.max(0.5, value))
}

/**
 * Derive every surface alpha, applying the 4.5:1 guard.
 * @param input - settings, theme identity and the measured colours.
 * @returns the plan; every alpha is a legal CSS opacity.
 */
export function computeSurfacePlan(input: PlanInput): SurfacePlan {
  const { settings, theme, surface, text } = input
  const mask = parseColor(resolveMaskColor(settings, theme)) ?? { r: 0, g: 0, b: 0 }
  const [backdropLo, backdropHi] = backdropEndpoints(input.averageGrey ?? 128, mask, settings.maskOpacity)
  const backdrops = [backdropLo, backdropHi]

  const glass = settings.glassPanels
  // Low-power mode keeps the glass language but caps how far it goes: the
  // controller drops the blur to 4px, and the surface stays closer to solid so
  // the effect survives without GPU headroom.
  const strength = settings.perfMode === 'low'
    ? Math.min(settings.glassStrength, 0.25)
    : settings.glassStrength
  // The design curve: 0.82/0.72 (dark/light) at strength 0, down to
  // 0.52/0.42 at strength 1. The tint has to
  // stay below the backdrop's brightness for the wallpaper to read through it
  // (a 0.75+ dark tint over a dim scrim is indistinguishable from flat black —
  // the W1 pixel check caught exactly that). Light glass starts lower: white
  // over a pastel image washes out. Both values are design-first; the guard
  // below may only raise them.
  const baseStart = theme === 'dark' ? 0.82 : 0.72
  const baseDesign = glass ? baseStart - 0.30 * strength : 0.90
  const sidebarDesign = baseDesign - 0.08
  const dialogDesign = baseDesign + 0.06
  const composerDesign = baseDesign + 0.08
  const terminalDesign = Math.min(0.92, baseDesign + 0.08)
  const bubbleDesign = settings.bubbleLiquid ? 0.62 - 0.26 * settings.bubbleIntensity : 0.62

  const floorForBackdrop = Math.max(
    minAlphaForContrast(surface, text, backdropLo),
    minAlphaForContrast(surface, text, backdropHi),
  )
  const baseAlpha = alpha(Math.max(baseDesign, floorForBackdrop))
  const sidebarAlpha = alpha(Math.max(sidebarDesign, floorForBackdrop))
  const dialogAlpha = alpha(Math.max(dialogDesign, floorForBackdrop))
  // The terminal/document pane keeps a slightly stronger tint than the chat
  // surface so 13px monospace glyphs stay legible, but it is glass, not a slab;
  // the 4.5:1 floor still applies to it.
  const terminalAlpha = alpha(Math.max(terminalDesign, floorForBackdrop))

  // The conversation is the base surface; bubbles and the composer sit ON it,
  // so their backdrop is the already-composited conversation colour.
  const conversationBackdrops = backdrops.map(backdrop => composite(surface, baseAlpha, backdrop))
  const floorOverConversation = Math.max(
    minAlphaForContrast(surface, text, conversationBackdrops[0]!),
    minAlphaForContrast(surface, text, conversationBackdrops[1]!),
  )
  const composerAlpha = alpha(Math.max(composerDesign, floorOverConversation))
  // Bubbles get their own floor: they sit in front of an already-tinted
  // conversation surface, so a lower alpha is still legible and reads more
  // like glass. The readability guard may raise it above the design value.
  const bubbleAlpha = Math.min(1, Math.max(0.38, settings.bubbleReadability
    ? Math.max(bubbleDesign, floorOverConversation)
    : bubbleDesign))

  const conversationContrast = worstContrast(surface, text, baseAlpha, backdrops)
  const sidebarContrast = worstContrast(surface, text, sidebarAlpha, backdrops)
  const dialogContrast = worstContrast(surface, text, dialogAlpha, backdrops)
  const composerContrast = worstContrast(surface, text, composerAlpha, conversationBackdrops)
  const bubbleContrast = worstContrast(surface, text, bubbleAlpha, conversationBackdrops)
  const terminalContrast = worstContrast(surface, text, terminalAlpha, backdrops)
  // A switched-off bubble layer cannot fail its own contrast target.
  const relevantBubble = settings.bubbleLiquid ? bubbleContrast : Number.POSITIVE_INFINITY
  const minContrast = Math.min(
    conversationContrast, sidebarContrast, dialogContrast, composerContrast, relevantBubble, terminalContrast,
  )

  return {
    baseAlpha,
    sidebarAlpha,
    dialogAlpha,
    composerAlpha,
    bubbleAlpha,
    terminalAlpha,
    minContrast: Math.round(minContrast * 100) / 100,
    bubbleContrast: Math.round(bubbleContrast * 100) / 100,
    ok: minContrast >= CONTRAST_MIN && (!settings.bubbleLiquid || bubbleContrast >= CONTRAST_MIN),
  }
}

/** Re-export the contrast helpers the UI/tests want without a second import path. */
export { CONTRAST_MIN, contrastRatio, relativeLuminance } from './contrast.ts'
