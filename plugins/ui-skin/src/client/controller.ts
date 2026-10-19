/**
 * The skin controller: the only module that touches the document.
 *
 * Responsibilities, in order of the live pipeline:
 *
 * 1. **adopt** — normalize the settings section `ctx.configForms` serves,
 *    merging host updates without clobbering a field the user is dragging;
 * 2. **resolve** — decide which wallpaper source is paintable (a preset, an
 *    IndexedDB blob, or a loaded remote image);
 * 3. **plan** — derive every surface alpha through the 4.5:1 guard
 *    (`src/plan.ts`);
 * 4. **project** — write CSS custom properties and `data-cl-xs-*` gates on
 *    `<html>`; the stylesheet does the rest;
 * 5. **persist** — debounce changed fields into one revision-fenced
 *    `configForms.mutate`, and revert to the host value when it refuses.
 *
 * The theme is observed through `body[data-ds-dark-theme]` (the palette
 * selector the shell's own presenter writes), so the skin follows light/
 * dark/custom themes without depending on ui-theme's service.
 *
 * @module @clue-harness/ui-skin/client/controller
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_SETTINGS, IMAGE_TYPES, SETTINGS_NS, cssPosition, cssSize, normalizeSettings, presetOf,
  presetVariant, resolveMaskColor, validRemoteUrl,
  type SkinSettings, type SkinTheme,
} from '../skin-config.ts'
import { cssRgb, cssRgba, parseColor, type RGB } from '../contrast.ts'
import { THEME_FALLBACK } from '../skin-config.ts'
import { computeSurfacePlan, type SurfacePlan } from '../plan.ts'
import {
  deleteStoredWallpaper, formatBytes, loadRemoteWallpaper, measureImage, readStoredWallpaper,
  validateUpload, writeStoredWallpaper,
  type RemoteWallpaper, type StoredWallpaper,
} from './image-store.ts'

/** Fallback preview wallpaper when the user has not chosen one yet. */
const PREVIEW_LIGHT = 'linear-gradient(142deg, #dfe9ff 0%, #f6e7fb 46%, #d9f7ef 100%)'
const PREVIEW_DARK = 'linear-gradient(142deg, #15213a 0%, #241a3a 52%, #0f2a2a 100%)'

/** The SVG noise tile laid over bubble tint at ~2% opacity (design §3.6). */
const NOISE_LAYER = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.022'/%3E%3C/svg%3E")`

/** Every custom property the controller owns (removed on disposal). */
const APPLIED_PROPERTIES: readonly string[] = Object.freeze([
  '--cl-xs-wallpaper', '--cl-xs-preview-wall', '--cl-xs-image-size', '--cl-xs-image-position',
  '--cl-xs-image-blur', '--cl-xs-image-scale', '--cl-xs-canvas', '--cl-xs-mask', '--cl-xs-settings-mask', '--cl-xs-vignette',
  '--cl-xs-surface-base', '--cl-xs-surface-sidebar', '--cl-xs-surface-dialog',
  '--cl-xs-surface-composer', '--cl-xs-surface-terminal', '--cl-xs-surface-document',
  '--cl-xs-surface-code', '--cl-xs-surface-code-banner', '--cl-xs-surface-inline-code',
  '--cl-xs-surface-document-veil', '--cl-xs-surface-bubble',
  '--cl-xs-panel-filter', '--cl-xs-chat-filter', '--cl-xs-float-filter', '--cl-xs-bubble-filter',
  '--cl-xs-bubble-bg', '--cl-xs-bubble-shadow', '--cl-xs-edge', '--cl-xs-edge-soft',
  '--cl-xs-center-left',
])

/** Settings write debounce: long enough to coalesce a drag, short enough to feel saved. */
const SAVE_DELAY_MS = 240

/** Persistence health surfaced on the settings page. */
export type PersistState = 'loading' | 'ready' | 'readonly' | 'unavailable'

/** The immutable view the settings page renders. */
export interface SkinSnapshot {
  settings: SkinSettings
  theme: SkinTheme
  /** Whether a wallpaper is currently painted. */
  active: boolean
  persist: PersistState
  /** Metadata of the stored upload (undefined when none). */
  image: StoredWallpaper['meta'] | undefined
  /** Object URL of the stored upload, for the settings-page thumbnail. */
  preview: string | undefined
  /** Whether the config asks for an upload this browser does not have. */
  imageMissing: boolean
  /** Human-readable load/validation failure. */
  imageError: string | null
  /** Transient write notice (write refused, session-only wall, …). */
  notice: string | null
  plan: SurfacePlan
  /** A decode/persist pass is running. */
  busy: boolean
}

/** The resolved wallpaper paint. */
interface WallpaperPaint {
  active: boolean
  /** A complete CSS `background-image` value (or `none`). */
  wallpaper: string
  /** Average sRGB grey of the source, when measurable. */
  grey: number | undefined
  /** The config asks for an image that is not available here. */
  missing: boolean
}

/** Read the shell's current palette from the attribute its presenter owns. */
function currentTheme(): SkinTheme {
  return typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
}

/** Format a store URL for a CSS `url()` token. */
function cssUrl(url: string): string {
  return `url(${JSON.stringify(url)})`
}

/** Round to three decimals for CSS output. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Owns the wallpaper layers, the CSS projection and the settings write queue.
 * One instance per plugin fiber; disposal retracts everything it wrote.
 */
export class SkinController {
  private readonly form: ConfigForm<unknown>
  private readonly listeners = new Set<() => void>()
  private settings: SkinSettings = { ...DEFAULT_SETTINGS }
  private hostValue: SkinSettings = { ...DEFAULT_SETTINGS }
  private theme: SkinTheme = 'light'
  private persist: PersistState = 'loading'
  private plan: SurfacePlan = computeSurfacePlan({
    settings: this.settings,
    theme: 'light',
    surface: { r: 255, g: 255, b: 255 },
    text: { r: 15, g: 17, b: 21 },
    averageGrey: undefined,
  })
  private snapshot!: SkinSnapshot
  private imageMeta: StoredWallpaper['meta'] | undefined
  private imageUrl: string | undefined
  private imageMissing = false
  private imageError: string | null = null
  private notice: string | null = null
  private busy = false
  private remote: RemoteWallpaper | undefined
  private remoteUrl: string | undefined
  private remoteLoading: string | undefined
  /** The URL the current `remote` record was loaded from. */
  private remoteSourceUrl: string | undefined
  /** A URL whose load failed; never retried until the config changes. */
  private failedUrl: string | undefined
  private wall: HTMLDivElement | undefined
  private observer: MutationObserver | undefined
  /** Tracks the frame's inline grid target for the rounded-corner patch. */
  private frameStyleObserver: MutationObserver | undefined
  private frameBinder: MutationObserver | undefined
  private unsubscribe: (() => void) | undefined
  private timer: number | undefined
  private queue: Partial<SkinSettings> = {}
  private readonly pending = new Set<keyof SkinSettings>()
  private formLoaded = false
  private started = false
  private disposed = false
  private colors: { theme: SkinTheme; surface: RGB; text: RGB } | undefined
  private readonly backdrop: boolean

  /**
   * @param ctx - the plugin context (used only for the config form service).
   */
  constructor(private readonly ctx: ClientContext) {
    this.form = ctx.configForms.get<unknown>(SETTINGS_NS)
    this.theme = currentTheme()
    this.backdrop = typeof CSS !== 'undefined'
      && (CSS.supports('backdrop-filter', 'blur(2px)') || CSS.supports('-webkit-backdrop-filter', 'blur(2px)'))
    // Every field above this line is initialized; the view can be built safely.
    this.snapshot = this.buildSnapshot(this.resolveWallpaper())
  }

  /** Current immutable view for `useSyncExternalStore`. */
  readonly getSnapshot = (): SkinSnapshot => this.snapshot

  /** Subscribe to snapshot replacements. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Mount the wallpaper layers and adopt the host section. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.mountWall()
    this.unsubscribe = this.form.subscribe(() => { this.adoptForm() })
    this.observer = new MutationObserver(() => {
      const theme = currentTheme()
      if (theme === this.theme) return
      this.theme = theme
      this.colors = undefined
      this.apply()
      this.publish()
    })
    this.observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    this.observeFrameCorner()
    this.adoptForm()
    try {
      const stored = await readStoredWallpaper()
      if (!this.disposed && stored !== undefined) this.adoptImage(stored.blob, stored.meta)
    } catch {
      // A missing/unreadable store only means no wallpaper this session.
    }
    this.syncActivation()
    this.apply()
    this.publish()
  }

  /**
   * Publish the centre column's left edge relative to the frame. The Windows
   * centre carries a 16px top-left radius; the frame's pseudo paints only the
   * notch outside that radius with the conversation surface, so it reads the
   * frame's inline grid target (the sidebar track). The patch transitions left
   * with the same duration/easing as the grid while a toggle is armed, which
   * keeps it on the moving edge; steady resizes and drags stay instant.
   */
  private observeFrameCorner(): void {
    const root = document.documentElement
    let bound = false
    const bind = (): boolean => {
      const frame = document.querySelector<HTMLElement>("#root [data-slot='root'] > div")
      if (frame === null) return false
      const sync = (): void => {
        const match = /^\s*([\d.]+)px/.exec(frame.style.gridTemplateColumns)
        if (match !== null) {
          root.style.setProperty('--cl-xs-center-left', `${String(match[1])}px`)
        }
      }
      sync()
      this.frameStyleObserver = new MutationObserver(sync)
      this.frameStyleObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })
      bound = true
      return true
    }
    if (bind()) return
    this.frameBinder = new MutationObserver(() => {
      if (!bound && bind()) this.frameBinder?.disconnect()
    })
    this.frameBinder.observe(document.body, { childList: true, subtree: true })
  }

  /** Retract every DOM write this controller made. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.observer?.disconnect()
    this.frameStyleObserver?.disconnect()
    this.frameStyleObserver = undefined
    this.frameBinder?.disconnect()
    this.frameBinder = undefined
    this.wall?.remove()
    this.wall = undefined
    this.revokeImage()
    if (this.remoteUrl !== undefined) URL.revokeObjectURL(this.remoteUrl)
    this.remoteUrl = undefined
    const root = document.documentElement
    for (const property of APPLIED_PROPERTIES) root.style.removeProperty(property)
    for (const attribute of ['data-cl-xs-on', 'data-cl-xs-glass', 'data-cl-xs-border', 'data-cl-xs-liquid', 'data-cl-xs-perf', 'data-cl-xs-support']) {
      root.removeAttribute(attribute)
    }
    this.listeners.clear()
  }

  /** Merge one user edit into the section and persist it (debounced). */
  update(patch: Partial<SkinSettings>): void {
    if (this.disposed) return
    const previous = this.settings
    const next = normalizeSettings({ ...previous, ...patch })
    this.settings = next
    const changed = (Object.keys(patch) as (keyof SkinSettings)[])
      .filter(key => next[key] !== previous[key])
    for (const key of changed) this.pending.add(key)
    if (keyHas(patch, 'bgUrl')) this.failedUrl = undefined
    this.imageError = keyHas(patch, 'bgKind') || keyHas(patch, 'bgUrl') ? null : this.imageError
    this.syncActivation()
    this.apply()
    this.publish()
    if (changed.length > 0) this.scheduleSave(changed)
  }

  /** Restore every documented default (the stored image is kept for reuse). */
  reset(): void {
    if (this.disposed) return
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.queue = {}
    this.pending.clear()
    this.settings = { ...DEFAULT_SETTINGS }
    this.imageError = null
    this.notice = null
    this.apply()
    this.publish()
    if (this.persist !== 'ready') return
    const ops = (Object.keys(DEFAULT_SETTINGS) as (keyof SkinSettings)[])
      .map(key => ({ op: 'unset' as const, path: [key] }))
    void this.form.mutate(ops).then((ok) => {
      if (this.disposed) return
      if (!ok) this.notice = '恢复默认未能写入宿主，刷新后会回到已保存的设置'
      this.publish()
    }).catch(() => {
      if (this.disposed) return
      this.notice = '恢复默认未能写入宿主，刷新后会回到已保存的设置'
      this.publish()
    })
  }

  /** Decode, store and activate one uploaded image. */
  async pickImage(file: File): Promise<void> {
    if (this.disposed) return
    const invalid = validateUpload(file)
    if (invalid !== undefined) {
      this.imageError = invalid
      this.publish()
      return
    }
    this.busy = true
    this.imageError = null
    this.publish()
    try {
      const measured = await measureImage(file)
      if (this.disposed) return
      const meta = {
        name: file.name,
        type: file.type,
        bytes: file.size,
        width: measured.width,
        height: measured.height,
        grey: measured.grey,
        savedAt: Date.now(),
      }
      let persisted = true
      try {
        await writeStoredWallpaper(file, meta)
      } catch {
        persisted = false
      }
      if (this.disposed) return
      this.adoptImage(file, meta)
      this.update({ bgKind: 'image' })
      this.notice = persisted ? null : '背景图已生效，但浏览器拒绝持久化，刷新后需要重新上传'
    } catch (error) {
      this.imageError = `无法读取这张图片：${error instanceof Error ? error.message : String(error)}`
    } finally {
      this.busy = false
      this.publish()
    }
  }

  /** Remove the stored wallpaper (the config kind falls back to `none`). */
  async clearImage(): Promise<void> {
    await deleteStoredWallpaper()
    this.revokeImage()
    this.imageMeta = undefined
    this.imageError = null
    if (this.settings.bgKind === 'image') this.update({ bgKind: 'none' })
    else {
      this.apply()
      this.publish()
    }
  }

  /** Validate and adopt a remote wallpaper URL. */
  useUrl(url: string): void {
    const text = url.trim()
    if (text !== '' && !validRemoteUrl(text)) {
      this.imageError = '链接需要以 http:// 或 https:// 开头'
      this.publish()
      return
    }
    this.imageError = null
    this.update({ bgKind: 'url', bgUrl: text })
  }

  /** Dismiss the transient notice. */
  dismissNotice(): void {
    this.notice = null
    this.imageError = null
    this.publish()
  }

  // ── settings adoption ────────────────────────────────────────────────────

  /** Fold the Host form snapshot into local state. */
  private adoptForm(): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    this.persist = snapshot.status === 'ready'
      ? (snapshot.writable ? 'ready' : 'readonly')
      : snapshot.status === 'loading' ? 'loading' : 'unavailable'
    if (snapshot.value !== undefined && typeof snapshot.value === 'object') {
      const host = normalizeSettings(snapshot.value)
      const previous = this.hostValue
      this.hostValue = host
      if (!this.formLoaded || this.pending.size === 0) {
        this.settings = host
      } else {
        const merged: SkinSettings = { ...this.settings }
        for (const key of Object.keys(host) as (keyof SkinSettings)[]) {
          if (this.pending.has(key)) continue
          if (host[key] !== previous[key]) (merged as unknown as Record<string, unknown>)[key] = host[key]
        }
        this.settings = merged
      }
      this.formLoaded = true
    }
    if (this.started) {
      this.syncActivation()
      this.apply()
      this.publish()
      // A change made while the namespace was still loading had no revision
      // to write against; persist it now that the form is usable.
      if (this.persist === 'ready' && this.pending.size > 0 && this.timer === undefined) {
        this.scheduleSave([...this.pending])
      }
    }
  }

  /** Queue one debounced write batch for the given fields. */
  private scheduleSave(keys: readonly (keyof SkinSettings)[]): void {
    for (const key of keys) (this.queue as Record<string, unknown>)[key] = this.settings[key]
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => { void this.flush() }, SAVE_DELAY_MS)
  }

  /** Write the queued fields as one revision-fenced mutation. */
  private async flush(): Promise<void> {
    this.timer = undefined
    const keys = Object.keys(this.queue) as (keyof SkinSettings)[]
    if (keys.length === 0) return
    const patch = this.queue
    this.queue = {}
    if (this.persist !== 'ready') {
      for (const key of keys) this.pending.delete(key)
      if (this.persist === 'readonly') this.notice = '当前连接不允许保存设置，改动只在这个页面生效'
      this.publish()
      return
    }
    const ops = keys.map(key => ({ op: 'set' as const, path: [key], value: patch[key]! }))
    try {
      const ok = await this.form.mutate(ops)
      if (this.disposed) return
      for (const key of keys) this.pending.delete(key)
      if (!ok) {
        this.notice = '设置未能写入宿主，已回到保存前的值'
        this.adoptForm()
      } else if (this.notice !== null) {
        this.notice = null
        this.publish()
      }
    } catch {
      if (this.disposed) return
      for (const key of keys) this.pending.delete(key)
      this.notice = '设置保存失败（连接中断），改动只在这个页面生效'
      this.publish()
    }
  }

  // ── wallpaper resolution ─────────────────────────────────────────────────

  /** Adopt an in-memory image (upload or IndexedDB record). */
  private adoptImage(blob: Blob, meta: StoredWallpaper['meta']): void {
    this.revokeImage()
    this.imageMeta = meta
    this.imageUrl = URL.createObjectURL(blob)
  }

  /** Revoke the current upload object URL. */
  private revokeImage(): void {
    if (this.imageUrl !== undefined) URL.revokeObjectURL(this.imageUrl)
    this.imageUrl = undefined
  }

  /** Kick any asynchronous source resolution the current section requires. */
  private syncActivation(): void {
    const settings = this.settings
    if (settings.bgKind === 'image') {
      this.imageMissing = this.imageUrl === undefined
      return
    }
    this.imageMissing = false
    if (settings.bgKind !== 'url') return
    const url = settings.bgUrl
    if (url === '') return
    if (this.remoteSourceUrl === url) return
    if (this.failedUrl === url) return
    if (!validRemoteUrl(url)) {
      this.imageError = '链接需要以 http:// 或 https:// 开头'
      return
    }
    if (this.remoteLoading === url) return
    void this.preloadRemote(url)
  }

  /** Load a remote wallpaper; activation happens on success. */
  private async preloadRemote(url: string): Promise<void> {
    this.remoteLoading = url
    try {
      const resolved = await loadRemoteWallpaper(url)
      if (this.disposed) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.displayUrl)
        return
      }
      if (this.remoteUrl !== undefined) URL.revokeObjectURL(this.remoteUrl)
      this.remote = resolved
      this.remoteUrl = resolved.objectUrl ? resolved.displayUrl : undefined
      this.remoteSourceUrl = url
      this.failedUrl = undefined
      this.imageError = null
    } catch (error) {
      if (this.disposed) return
      this.remote = undefined
      this.remoteUrl = undefined
      this.remoteSourceUrl = undefined
      this.failedUrl = url
      this.imageError = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.remoteLoading === url) this.remoteLoading = undefined
      if (!this.disposed) {
        this.apply()
        this.publish()
      }
    }
  }

  /** The wallpaper the current section resolves to. */
  private resolveWallpaper(): WallpaperPaint {
    const settings = this.settings
    if (settings.bgKind === 'preset') {
      const variant = presetVariant(presetOf(settings.bgPreset), this.theme)
      return { active: true, wallpaper: variant.image, grey: variant.grey, missing: false }
    }
    if (settings.bgKind === 'image') {
      if (this.imageUrl !== undefined) {
        return {
          active: true,
          wallpaper: cssUrl(this.imageUrl),
          grey: this.imageMeta?.grey,
          missing: false,
        }
      }
      return { active: false, wallpaper: 'none', grey: undefined, missing: true }
    }
    if (settings.bgKind === 'url' && this.remote !== undefined && this.remoteSourceUrl === settings.bgUrl) {
      return { active: true, wallpaper: cssUrl(this.remote.displayUrl), grey: this.remote.grey, missing: false }
    }
    return { active: false, wallpaper: 'none', grey: undefined, missing: false }
  }

  // ── DOM projection ───────────────────────────────────────────────────────

  /** Mount the fixed wallpaper stack (idempotent). */
  private mountWall(): void {
    if (this.wall !== undefined || typeof document === 'undefined') return
    const wall = document.createElement('div')
    wall.className = 'cl-xs-wall'
    wall.setAttribute('aria-hidden', 'true')
    const image = document.createElement('div')
    image.className = 'cl-xs-wall-image'
    const tone = document.createElement('div')
    tone.className = 'cl-xs-wall-tone'
    const vignette = document.createElement('div')
    vignette.className = 'cl-xs-wall-vignette'
    wall.append(image, tone, vignette)
    document.body.append(wall)
    this.wall = wall
  }

  /** Read the theme's opaque surface and primary text colours. */
  private readColors(theme: SkinTheme): { surface: RGB; text: RGB } {
    if (this.colors !== undefined && this.colors.theme === theme) return this.colors
    const fallback = THEME_FALLBACK[theme]
    let surface = parseColor(fallback.surface)!
    let text = parseColor(fallback.text)!
    if (typeof document !== 'undefined') {
      const probe = document.createElement('span')
      probe.setAttribute('aria-hidden', 'true')
      probe.style.cssText = 'position:absolute;left:-10000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none'
      document.body.append(probe)
      const read = (token: string, fallbackColor: string): RGB => {
        probe.style.color = `var(${token}, ${fallbackColor})`
        return parseColor(getComputedStyle(probe).color) ?? parseColor(fallbackColor)!
      }
      try {
        surface = read(theme === 'dark' ? '--dsw-static-neutral-bluish-950' : '--dsw-static-neutral-bluish-00', fallback.surface)
        text = read('--dsw-alias-label-primary', fallback.text)
      } finally {
        probe.remove()
      }
    }
    this.colors = { theme, surface, text }
    return this.colors
  }

  /** Project the current settings onto `<html>` and the plan onto CSS vars. */
  private apply(): void {
    if (typeof document === 'undefined') return
    const paint = this.resolveWallpaper()
    const { surface, text } = this.readColors(this.theme)
    const settings = this.settings
    const plan = this.adaptPlan(computeSurfacePlan({
      settings,
      theme: this.theme,
      surface,
      text,
      averageGrey: paint.grey,
    }))
    this.plan = plan

    const root = document.documentElement
    const mask = parseColor(resolveMaskColor(settings, this.theme)) ?? { r: 0, g: 0, b: 0 }
    const perfLow = settings.perfMode === 'low'
    const glass = settings.glassPanels && this.backdrop
    const strength = settings.glassStrength
    // Frost is its own knob. `glassStrength` used to drive blur too, so a user
    // asking for "clear wallpaper" (high transparency + low frost) had no way
    // to express it — and blur(0) is now a real value, not a minimum.
    const blur = perfLow ? Math.min(4, settings.glassBlur) : settings.glassBlur
    const saturate = round(1.12 + strength * 0.28)
    const frost = (radius: number, extra = 0): string => {
      if (!glass) return 'none'
      const px = Math.max(0, Math.round(radius + extra))
      return px === 0
        ? `saturate(${String(saturate)})`
        : `blur(${String(px)}px) saturate(${String(saturate)})`
    }
    const panelFilter = frost(blur)
    // The chat/dock chrome and the bubbles are the expensive layers; low-power
    // mode drops them first and keeps only the capped panel frost.
    const chatFilter = glass && !perfLow ? frost(blur) : 'none'
    const floatFilter = glass ? frost(blur, blur > 0 && !perfLow ? 2 : 0) : 'none'
    const bubbleLiquid = settings.bubbleLiquid && !perfLow && this.backdrop
    const bubbleBlur = 3 + settings.bubbleIntensity * 9
    const bubbleFilter = bubbleLiquid ? `blur(${String(round(bubbleBlur))}px) saturate(1.4)` : 'none'
    const dark = this.theme === 'dark'
    const imageBlur = perfLow ? 0 : settings.bgBlur

    root.style.setProperty('--cl-xs-wallpaper', paint.active ? paint.wallpaper : 'none')
    root.style.setProperty('--cl-xs-preview-wall', paint.active ? paint.wallpaper : (dark ? PREVIEW_DARK : PREVIEW_LIGHT))
    root.style.setProperty('--cl-xs-image-size', cssSize(settings.bgFit))
    root.style.setProperty('--cl-xs-image-position', cssPosition(settings.bgPosition))
    root.style.setProperty('--cl-xs-image-blur', `${String(round(imageBlur))}px`)
    root.style.setProperty('--cl-xs-image-scale', String(round(1 + imageBlur / 140)))
    root.style.setProperty('--cl-xs-canvas', cssRgb(surface))
    root.style.setProperty('--cl-xs-mask', cssRgba(mask, settings.maskOpacity))
    root.style.setProperty('--cl-xs-settings-mask', dark ? 'rgba(6, 9, 16, 0.22)' : 'rgba(242, 245, 250, 0.35)')
    root.style.setProperty('--cl-xs-vignette', dark ? 'rgba(0, 0, 0, 0.34)' : 'rgba(31, 41, 55, 0.12)')
    root.style.setProperty('--cl-xs-surface-base', cssRgba(surface, plan.baseAlpha))
    root.style.setProperty('--cl-xs-surface-sidebar', cssRgba(surface, plan.sidebarAlpha))
    root.style.setProperty('--cl-xs-surface-dialog', cssRgba(surface, plan.dialogAlpha))
    root.style.setProperty('--cl-xs-surface-composer', cssRgba(surface, plan.composerAlpha))
    root.style.setProperty('--cl-xs-surface-terminal', cssRgba(surface, plan.terminalAlpha))
    // The file viewer uses the same pane tint; its inner document/code surfaces
    // only add a shallow veil so the wallpaper stays visible through them.
    root.style.setProperty('--cl-xs-surface-document', cssRgba(surface, plan.terminalAlpha))
    root.style.setProperty('--cl-xs-surface-document-veil', cssRgba(surface, 0.12))
    root.style.setProperty('--cl-xs-surface-code', cssRgba(surface, 0.2))
    root.style.setProperty('--cl-xs-surface-code-banner', cssRgba(surface, 0.12))
    root.style.setProperty('--cl-xs-surface-inline-code', cssRgba(surface, 0.16))
    root.style.setProperty('--cl-xs-surface-bubble', cssRgba(surface, plan.bubbleAlpha))
    root.style.setProperty('--cl-xs-panel-filter', panelFilter)
    root.style.setProperty('--cl-xs-chat-filter', chatFilter)
    root.style.setProperty('--cl-xs-float-filter', floatFilter)
    root.style.setProperty('--cl-xs-bubble-filter', bubbleFilter)
    root.style.setProperty('--cl-xs-bubble-bg', this.bubbleBackground(surface, plan.bubbleAlpha, dark))
    root.style.setProperty('--cl-xs-bubble-shadow', this.bubbleShadow(dark))
    root.style.setProperty('--cl-xs-edge', dark ? 'rgba(255, 255, 255, 0.26)' : 'rgba(255, 255, 255, 0.85)')
    root.style.setProperty('--cl-xs-edge-soft', dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.06)')

    root.toggleAttribute('data-cl-xs-on', paint.active)
    root.toggleAttribute('data-cl-xs-glass', glass)
    root.toggleAttribute('data-cl-xs-border', settings.glassBorder && paint.active)
    root.toggleAttribute('data-cl-xs-liquid', bubbleLiquid)
    root.toggleAttribute('data-cl-xs-perf', perfLow)
    root.toggleAttribute('data-cl-xs-support', !this.backdrop)
  }

  /**
   * Raise every surface alpha a little when backdrop-filter is unavailable:
   * the glass is then a flat tint and needs more body to stay readable.
   */
  private adaptPlan(plan: SurfacePlan): SurfacePlan {
    if (this.backdrop) return plan
    const lift = (value: number): number => Math.min(1, value + 0.06)
    return {
      ...plan,
      baseAlpha: lift(plan.baseAlpha),
      sidebarAlpha: lift(plan.sidebarAlpha),
      dialogAlpha: lift(plan.dialogAlpha),
      composerAlpha: lift(plan.composerAlpha),
      bubbleAlpha: lift(plan.bubbleAlpha),
      terminalAlpha: lift(plan.terminalAlpha),
    }
  }

  /** The multi-layer liquid-glass background for user bubbles. */
  private bubbleBackground(surface: RGB, alpha: number, dark: boolean): string {
    const intensity = this.settings.bubbleIntensity
    const white = (value: number): string => `rgba(255, 255, 255, ${String(round(value))})`
    const sheen = dark ? 0.18 : 0.62
    const side = dark ? 0.09 : 0.3
    const wash = dark ? 0.04 : 0.16
    const layers = [
      `radial-gradient(140% 115% at 6% 0%, ${white(sheen * intensity)} 0%, transparent 58%)`,
      `radial-gradient(125% 110% at 100% 100%, ${white(side * intensity)} 0%, transparent 62%)`,
      `linear-gradient(135deg, ${white(wash * intensity)}, transparent 46%, ${white((wash * 0.6) * intensity)})`,
    ]
    if (intensity > 0.05) layers.push(NOISE_LAYER)
    layers.push(cssRgba(surface, alpha))
    return layers.join(', ')
  }

  /** The bubble's edge/highlight depth, soft in both schemes. */
  private bubbleShadow(dark: boolean): string {
    const intensity = this.settings.bubbleIntensity
    if (!this.settings.bubbleLiquid) return 'none'
    return dark
      ? `inset 0 1px 0 rgba(255, 255, 255, ${String(round(0.2 + 0.12 * intensity))}), inset 0 0 0 1px rgba(255, 255, 255, ${String(round(0.05 + 0.05 * intensity))}), 0 1px 2px rgba(0, 0, 0, 0.22), 0 10px 24px -16px rgba(0, 0, 0, 0.5)`
      : `inset 0 1px 0 rgba(255, 255, 255, 0.9), inset 0 0 0 1px rgba(255, 255, 255, ${String(round(0.5 + 0.2 * intensity))}), 0 1px 2px rgba(16, 24, 40, 0.06), 0 10px 24px -18px rgba(16, 24, 40, 0.3)`
  }

  // ── snapshot ─────────────────────────────────────────────────────────────

  /** Build the immutable view. */
  private buildSnapshot(paint: WallpaperPaint): SkinSnapshot {
    return Object.freeze({
      settings: this.settings,
      theme: this.theme,
      active: paint.active,
      persist: this.persist,
      image: this.imageMeta,
      preview: this.imageUrl,
      imageMissing: paint.missing,
      imageError: this.imageError,
      notice: this.notice,
      plan: this.plan,
      busy: this.busy,
    })
  }

  /** Publish one new snapshot to React. */
  private publish(): void {
    if (this.disposed) return
    this.snapshot = this.buildSnapshot(this.resolveWallpaper())
    for (const listener of [...this.listeners]) listener()
  }
}

/** Whether a partial patch owns a key (exactOptionalPropertyTypes-safe). */
function keyHas<K extends keyof SkinSettings>(patch: Partial<SkinSettings>, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key)
}

/** Re-export so the settings page can format upload sizes without a second import. */
export { formatBytes, IMAGE_TYPES }
