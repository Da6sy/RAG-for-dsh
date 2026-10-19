/**
 * WCAG contrast arithmetic for the skin's readability guard.
 *
 * The design asks for a measurable floor (`§3.6 可读性护栏`): body text and
 * bubble text stay at or above 4.5:1 over whatever the wallpaper + scrim +
 * glass stack composes to. Everything here is pure sRGB math on 0–255
 * channel triples, so the same functions run in unit tests and in the live
 * controller that decides each surface's alpha.
 *
 * @module @clue-harness/ui-skin/contrast
 */

/** One sRGB colour, channels 0–255. */
export interface RGB {
  r: number
  g: number
  b: number
}

/** WCAG's contrast target for normal-size text. */
export const CONTRAST_MIN = 4.5

/** A conservative spread around a wallpaper's average grey (sRGB units). */
export const LUMA_SPREAD = 34

/** Convert one sRGB channel (0–255) to linear-light (0–1). */
export function linearChannel(channel: number): number {
  const c = Math.min(255, Math.max(0, channel)) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance(color: RGB): number {
  return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b)
}

/** Contrast ratio between two sRGB colours, from 1 to 21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

/** Clamp a channel into the byte range. */
function byte(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)))
}

/** Composite a translucent foreground over an opaque background (sRGB space). */
export function composite(foreground: RGB, alpha: number, background: RGB): RGB {
  const a = Math.min(1, Math.max(0, alpha))
  return {
    r: byte(foreground.r * a + background.r * (1 - a)),
    g: byte(foreground.g * a + background.g * (1 - a)),
    b: byte(foreground.b * a + background.b * (1 - a)),
  }
}

/** Linear interpolation between two colours (`t` 0–1). */
export function mixColors(a: RGB, b: RGB, t: number): RGB {
  return composite(b, Math.min(1, Math.max(0, t)), a)
}

/** A neutral grey colour for an sRGB grey level. */
export function grey(level: number): RGB {
  const value = byte(level)
  return { r: value, g: value, b: value }
}

/** Format a colour as an `rgb()` CSS value. */
export function cssRgb(color: RGB): string {
  return `rgb(${String(color.r)} ${String(color.g)} ${String(color.b)})`
}

/** Format a colour as an `rgba()` CSS value. */
export function cssRgba(color: RGB, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000
  return `rgba(${String(color.r)}, ${String(color.g)}, ${String(color.b)}, ${String(a)})`
}

/** Parse `#rrggbb`, `#rgb`, `rgb(r g b)` or `rgb(r, g, b)` into channels. */
export function parseColor(value: string): RGB | undefined {
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{6})$/.exec(text)
  if (hex !== null) {
    const n = Number.parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short !== null) {
    const [r, g, b] = [short[1]!, short[2]!, short[3]!].map(digit => Number.parseInt(`${digit}${digit}`, 16))
    return { r, g, b }
  }
  const fn = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(text)
  if (fn !== null) {
    return { r: byte(Number(fn[1])), g: byte(Number(fn[2])), b: byte(Number(fn[3])) }
  }
  return undefined
}

/**
 * The smallest surface alpha that lifts text contrast to the target over ONE
 * given backdrop. Returns 1 when even an opaque surface cannot reach it.
 * @param surface - the opaque glass tint colour (theme surface).
 * @param text - the text colour that has to remain legible.
 * @param backdrop - the fully composed colour behind the surface.
 * @param target - minimum contrast ratio (default 4.5:1).
 */
export function minAlphaForContrast(
  surface: RGB,
  text: RGB,
  backdrop: RGB,
  target: number = CONTRAST_MIN,
): number {
  if (contrastRatio(surface, text) < target) return 1
  // 71 steps: 0.30–1.00. The lower bound matters — a floor search that starts
  // at 0.60 would silently raise every sub-0.60 design alpha (the W1 retune
  // hit exactly that). A fully transparent surface is never returned.
  for (let step = 0; step <= 70; step += 1) {
    const alpha = 0.30 + step * 0.01
    if (contrastRatio(composite(surface, alpha, backdrop), text) >= target) return alpha
  }
  return 1
}

/**
 * The backdrop colours a wallpaper can compose to: the average grey plus and
 * minus a conservative spread, each under the scrim.
 * @param averageGrey - the wallpaper's average sRGB grey (0–255).
 * @param mask - the scrim colour.
 * @param maskAlpha - the scrim opacity (0–1).
 * @param spread - half-width of the grey range (sRGB units).
 * @returns the darker and brighter composed endpoints.
 */
export function backdropEndpoints(
  averageGrey: number,
  mask: RGB,
  maskAlpha: number,
  spread: number = LUMA_SPREAD,
): readonly [RGB, RGB] {
  const lo = grey(Math.max(0, averageGrey - spread))
  const hi = grey(Math.min(255, averageGrey + spread))
  return [composite(mask, maskAlpha, lo), composite(mask, maskAlpha, hi)] as const
}

/**
 * The worst (lowest) contrast across a set of surface/backdrop combinations.
 * @param surface - the glass tint.
 * @param text - the text colour.
 * @param alpha - the surface alpha.
 * @param backdrops - every backdrop the surface can sit over.
 * @returns the minimum contrast ratio.
 */
export function worstContrast(surface: RGB, text: RGB, alpha: number, backdrops: readonly RGB[]): number {
  let worst = Number.POSITIVE_INFINITY
  for (const backdrop of backdrops) {
    worst = Math.min(worst, contrastRatio(composite(surface, alpha, backdrop), text))
  }
  return Number.isFinite(worst) ? worst : 1
}
