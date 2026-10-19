/**
 * `@clue-harness/ui-skin` — the client-safe half of the skin model.
 *
 * Everything in this module is pure: no React, no DOM, no Cordis, no dsh
 * imports. Both halves of the plugin depend on it — the Host half builds the
 * settings schema defaults from {@link DEFAULT_SETTINGS}, the browser half
 * normalizes whatever the settings service answers with
 * {@link normalizeSettings} and renders from it. Keeping one source of truth
 * is why a schema default can never drift from the rendered default.
 *
 * Units and vocabulary follow the design document
 * (`docs/设计规划_前端UI美化插件.md` §3.4): every numeric knob is a bounded
 * scalar, every enum a closed set, and an invalid value degrades to the
 * documented default instead of throwing — a corrupt profile section must
 * never keep the shell from booting.
 *
 * @module @clue-harness/ui-skin/config
 */

/**
 * The profile entry id, the settings namespace and the plugin's diagnostic
 * name are one string: the cordis patch inserts the row as `ui-clue-skin`,
 * the settings service keys forms by that entry id, and the browser half asks
 * `ctx.configForms.get` for exactly this namespace.
 */
export const SETTINGS_NS = 'ui-clue-skin'

/** Accepted upload types (the design's png/jpg/webp set). */
export const IMAGE_TYPES: readonly string[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])

/** Upload cap in bytes (design §3.5: 8 MB). */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** Image aspect/measurement metadata kept with an upload. */
export interface SkinImageMeta {
  /** Original file name, shown in the settings page. */
  name: string
  /** MIME type. */
  type: string
  /** Encoded size in bytes. */
  bytes: number
  /** Natural width in pixels. */
  width: number
  /** Natural height in pixels. */
  height: number
  /** Average sRGB grey (0–255), used by the readability guard. */
  grey: number
  /** Epoch milliseconds of the upload. */
  savedAt: number
}

/** Wallpaper sources. `image` is a browser-local upload, `url` a remote image. */
export const BG_KINDS = ['none', 'preset', 'image', 'url'] as const
export type BgKind = (typeof BG_KINDS)[number]

/** How the wallpaper fills the viewport (`auto` keeps the natural size). */
export const BG_FITS = ['cover', 'contain', 'auto'] as const
export type BgFit = (typeof BG_FITS)[number]

/** The nine background positions, keyed (not raw CSS) for a stable config surface. */
export const BG_POSITIONS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
] as const
export type BgPosition = (typeof BG_POSITIONS)[number]

/** The three bundled ambience presets (gradient wallpapers, no image needed). */
export const BG_PRESETS = ['aurora', 'dusk', 'mist'] as const
export type BgPreset = (typeof BG_PRESETS)[number]

/** Performance modes: `auto` keeps the full effect, `low` drops the expensive parts. */
export const PERF_MODES = ['auto', 'low'] as const
export type PerfMode = (typeof PERF_MODES)[number]

/** The resolved colour scheme the shell currently paints. */
export type SkinTheme = 'light' | 'dark'

/** One configurable surface layer. */
export interface SkinSettings {
  /** Which wallpaper source is active. */
  bgKind: BgKind
  /** The bundled gradient used when `bgKind` is `preset`. */
  bgPreset: BgPreset
  /** The remote image URL used when `bgKind` is `url`. */
  bgUrl: string
  /** Background sizing. */
  bgFit: BgFit
  /** Background anchor within the viewport. */
  bgPosition: BgPosition
  /** The wallpaper's own blur, in pixels (0–24). */
  bgBlur: number
  /** Scrim opacity over the wallpaper (0–0.9). */
  maskOpacity: number
  /** Scrim colour: `auto` (theme-derived) or `#rrggbb`. */
  maskColor: string
  /** Whether panel surfaces are frosted. */
  glassPanels: boolean
  /** Glass transparency: higher = more see-through (0–1). */
  glassStrength: number
  /** Panel frost radius in pixels (0–24); independent of transparency. */
  glassBlur: number
  /** Whether glass surfaces carry a 1px inner highlight edge. */
  glassBorder: boolean
  /** Whether conversation bubbles use the liquid-glass recipe. */
  bubbleLiquid: boolean
  /** Liquid-glass intensity: drives sheen, blur and transparency (0–1). */
  bubbleIntensity: number
  /** Whether the bubble surface is auto-deepened to keep ≥4.5:1 text contrast. */
  bubbleReadability: boolean
  /** Performance posture. */
  perfMode: PerfMode
}

/** Defaults, mirrored exactly by the Host schema (`src/index.ts`). */
export const DEFAULT_SETTINGS: Readonly<SkinSettings> = Object.freeze({
  bgKind: 'none',
  bgPreset: 'aurora',
  bgUrl: '',
  bgFit: 'cover',
  bgPosition: 'center',
  bgBlur: 0,
  // §3.4's 0.35 and §3.8's "dark themes get less scrim" contradict each other.
  // Resolved design: ONE opacity, theme-derived COLOUR, and 0.24 because the
  // W1 pixel check showed a heavier scrim + glass turns the wallpaper into
  // flat grey. The slider still goes to 0.9 when the user wants it muted.
  maskOpacity: 0.24,
  maskColor: 'auto',
  glassPanels: true,
  // `glassStrength` is transparency only; frost has its own knob so a user can
  // ask for "very see-through, barely frosted" — the W1 client report was
  // exactly that combination, and the old coupled curve could not express it.
  glassStrength: 0.5,
  glassBlur: 10,
  glassBorder: true,
  bubbleLiquid: true,
  bubbleIntensity: 0.5,
  bubbleReadability: true,
  perfMode: 'auto',
})

/** One preset's per-scheme gradient and its approximate average grey (0–255). */
export interface PresetVariant {
  /** A complete CSS `background-image` list. */
  image: string
  /** Average sRGB grey of the rendered gradient, used by the contrast guard. */
  grey: number
}

/** A bundled ambience: two scheme variants and display copy. */
export interface SkinPreset {
  id: BgPreset
  label: string
  hint: string
  light: PresetVariant
  dark: PresetVariant
}

/**
 * Three gradients designed to sit under glass: two soft radial lights over a
 * quiet base. They are intentionally low-frequency — a wallpaper with detail
 * fights the text; a wallpaper with light blooms makes the glass read.
 */
export const PRESETS: readonly SkinPreset[] = Object.freeze([
  {
    id: 'aurora',
    label: '极光',
    hint: '冷蓝与青绿交叠,适合深色',
    light: {
      image: 'radial-gradient(120% 95% at 10% 4%, #ffc4e6 0%, rgba(255,196,230,0) 58%), radial-gradient(95% 85% at 92% 10%, #b9d8ff 0%, rgba(185,216,255,0) 62%), radial-gradient(130% 110% at 48% 104%, #b9f6dd 0%, rgba(185,246,221,0) 58%), linear-gradient(152deg, #eef4ff 0%, #e2ecfa 100%)',
      grey: 225,
    },
    dark: {
      image: 'radial-gradient(120% 95% at 10% 4%, #3f7fd6 0%, rgba(63,127,214,0) 58%), radial-gradient(95% 85% at 92% 10%, #22a89a 0%, rgba(34,168,154,0) 62%), radial-gradient(130% 110% at 48% 104%, #6a45a8 0%, rgba(106,69,168,0) 58%), linear-gradient(152deg, #101d32 0%, #12243c 100%)',
      grey: 48,
    },
  },
  {
    id: 'dusk',
    label: '暮色',
    hint: '暖橘与梅紫收边,安静',
    light: {
      image: 'radial-gradient(115% 90% at 88% 6%, #ffcda3 0%, rgba(255,205,163,0) 58%), radial-gradient(100% 90% at 8% 12%, #d9c2ff 0%, rgba(217,194,255,0) 60%), radial-gradient(130% 120% at 50% 108%, #ffc2d8 0%, rgba(255,194,216,0) 60%), linear-gradient(160deg, #fff1e2 0%, #f1e8fb 100%)',
      grey: 228,
    },
    dark: {
      image: 'radial-gradient(115% 90% at 88% 6%, #b05a34 0%, rgba(176,90,52,0) 58%), radial-gradient(100% 90% at 8% 12%, #7a42a8 0%, rgba(122,66,168,0) 60%), radial-gradient(130% 120% at 50% 108%, #3a4f80 0%, rgba(58,79,128,0) 60%), linear-gradient(160deg, #20162a 0%, #16203a 100%)',
      grey: 46,
    },
  },
  {
    id: 'mist',
    label: '雾海',
    hint: '薄荷与雾蓝,通透',
    light: {
      image: 'radial-gradient(120% 95% at 14% 8%, #aef2e0 0%, rgba(174,242,224,0) 60%), radial-gradient(95% 85% at 90% 16%, #c2ddff 0%, rgba(194,221,255,0) 62%), radial-gradient(130% 110% at 50% 104%, #ded0ff 0%, rgba(222,208,255,0) 58%), linear-gradient(150deg, #e9f7f7 0%, #dfeaf2 100%)',
      grey: 226,
    },
    dark: {
      image: 'radial-gradient(120% 95% at 14% 8%, #28988a 0%, rgba(40,152,138,0) 60%), radial-gradient(95% 85% at 90% 16%, #2f6cb0 0%, rgba(47,108,176,0) 62%), radial-gradient(130% 110% at 50% 104%, #544a98 0%, rgba(84,74,152,0) 58%), linear-gradient(150deg, #102a2a 0%, #122236 100%)',
      grey: 46,
    },
  },
])

/** The preset record for an id (always resolves; unknown ids fall back to the first). */
export function presetOf(id: BgPreset): SkinPreset {
  return PRESETS.find(preset => preset.id === id) ?? PRESETS[0]!
}

/** The scheme variant of a preset. */
export function presetVariant(preset: SkinPreset, theme: SkinTheme): PresetVariant {
  return theme === 'dark' ? preset.dark : preset.light
}

/** Map the nine position keys onto CSS `background-position` values. */
export function cssPosition(position: BgPosition): string {
  switch (position) {
    case 'top-left': return 'left top'
    case 'top': return 'center top'
    case 'top-right': return 'right top'
    case 'left': return 'left center'
    case 'right': return 'right center'
    case 'bottom-left': return 'left bottom'
    case 'bottom': return 'center bottom'
    case 'bottom-right': return 'right bottom'
    default: return 'center center'
  }
}

/** Map the fit modes onto CSS `background-size` values. */
export function cssSize(fit: BgFit): string {
  return fit === 'auto' ? 'auto' : fit
}

/** Read one of the closed enums, falling back when the wire value is foreign. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** Clamp a numeric knob; non-finite input keeps the fallback. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Read a boolean knob. */
export function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** `#rgb` / `#rrggbb` → canonical `#rrggbb`; anything else → undefined. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return /^#[0-9a-f]{6}$/.test(text) ? text : undefined
}

/**
 * Normalize one settings section from the Host (or any partial object).
 * @param raw - the section the settings form answers with.
 * @returns a complete, in-range settings object; never throws.
 */
export function normalizeSettings(raw: unknown): SkinSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const maskColor = input['maskColor'] === 'auto' ? 'auto' : normalizeHex(input['maskColor']) ?? 'auto'
  return {
    bgKind: oneOf(input['bgKind'], BG_KINDS, DEFAULT_SETTINGS.bgKind),
    bgPreset: oneOf(input['bgPreset'], BG_PRESETS, DEFAULT_SETTINGS.bgPreset),
    bgUrl: typeof input['bgUrl'] === 'string' ? input['bgUrl'].trim() : DEFAULT_SETTINGS.bgUrl,
    bgFit: oneOf(input['bgFit'], BG_FITS, DEFAULT_SETTINGS.bgFit),
    bgPosition: oneOf(input['bgPosition'], BG_POSITIONS, DEFAULT_SETTINGS.bgPosition),
    bgBlur: clampNumber(input['bgBlur'], 0, 24, DEFAULT_SETTINGS.bgBlur),
    maskOpacity: clampNumber(input['maskOpacity'], 0, 0.9, DEFAULT_SETTINGS.maskOpacity),
    maskColor,
    glassPanels: boolOf(input['glassPanels'], DEFAULT_SETTINGS.glassPanels),
    glassStrength: clampNumber(input['glassStrength'], 0, 1, DEFAULT_SETTINGS.glassStrength),
    glassBlur: clampNumber(input['glassBlur'], 0, 24, DEFAULT_SETTINGS.glassBlur),
    glassBorder: boolOf(input['glassBorder'], DEFAULT_SETTINGS.glassBorder),
    bubbleLiquid: boolOf(input['bubbleLiquid'], DEFAULT_SETTINGS.bubbleLiquid),
    bubbleIntensity: clampNumber(input['bubbleIntensity'], 0, 1, DEFAULT_SETTINGS.bubbleIntensity),
    bubbleReadability: boolOf(input['bubbleReadability'], DEFAULT_SETTINGS.bubbleReadability),
    perfMode: oneOf(input['perfMode'], PERF_MODES, DEFAULT_SETTINGS.perfMode),
  }
}

/** One-click glass looks: transparency + frost pairs the settings page offers. */
export const GLASS_PRESETS: readonly { id: string; label: string; hint: string; strength: number; blur: number }[] = Object.freeze([
  { id: 'clear', label: '清晰', hint: '无模糊、最高通透,壁纸最清楚', strength: 1, blur: 0 },
  { id: 'balanced', label: '均衡', hint: '默认观感', strength: 0.5, blur: 10 },
  { id: 'frosted', label: '磨砂', hint: '重磨砂、低通透', strength: 0.35, blur: 20 },
])

/** The default scrim colour per scheme: a near-black cool and a near-white cool. */
export const AUTO_MASK: Readonly<Record<SkinTheme, string>> = Object.freeze({
  dark: '#0a0f18',
  light: '#f2f4f8',
})

/** The scheme's surface/text colours, used when computed styles are unavailable. */
export const THEME_FALLBACK: Readonly<Record<SkinTheme, { surface: string; text: string }>> = Object.freeze({
  light: { surface: '#ffffff', text: '#0f1115' },
  dark: { surface: '#151517', text: '#f1f3f5' },
})

/** Resolve the effective scrim colour (`auto` follows the scheme). */
export function resolveMaskColor(settings: SkinSettings, theme: SkinTheme): string {
  return settings.maskColor === 'auto' ? AUTO_MASK[theme] : normalizeHex(settings.maskColor) ?? AUTO_MASK[theme]
}

/** Whether a settings section would paint anything at all. */
export function hasWallpaper(settings: SkinSettings): boolean {
  return settings.bgKind !== 'none'
}

/** Validate a remote wallpaper URL (http/https only; CSP may still refuse it). */
export function validRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
