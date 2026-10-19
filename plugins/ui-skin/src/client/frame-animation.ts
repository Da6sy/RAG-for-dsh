/**
 * Deterministic sidebar/rightbar track animation.
 *
 * The shell's frame eases `grid-template-columns` only while its React state
 * carries `data-animating`. That state is written in a layout effect, so a
 * toggle can land in the same commit as the new track: the browser then meets
 * the transition property and the new value together for the first time and
 * performs no transition — the "sometimes it jumps" report. The right panel's
 * own transform is always animated, so when the track misses its easing only
 * one side of the junction moves.
 *
 * Pre-arming this marker on pointerdown/keydown, before the click's state
 * update, makes the transition property active first. The stylesheet rule uses
 * `:where(...)` (specificity 0) so the shell's own `transition: none` for a
 * drag, a fullscreen right column, an instant track, or reduced motion still
 * wins.
 *
 * The marker is a data attribute rather than a class: React does not manage
 * it, and the frame's className is a stable CSS-module class.
 *
 * @module @clue-harness/ui-skin/client/frame-animation
 */

/** The shell frame: the grid that owns the sidebar | centre | rightbar tracks. */
const FRAME_SELECTOR = "#root [data-slot='root'] > div"

/** The pre-arm marker; the stylesheet keys on this exact attribute. */
const MARK_ATTRIBUTE = 'data-cl-xs-track-animating'

/** Long enough for the shell's slow track transition (same 600 ms settle as the shell). */
const SETTLE_MS = 600

/**
 * Install the pointer/keyboard pre-arm on the document.
 * @returns a disposer for the plugin effect (removes listeners and the marker).
 */
export function installFrameAnimation(): () => void {
  if (typeof document === 'undefined') return () => {}

  let frame: HTMLElement | null = null
  let timer: number | undefined

  const resolve = (): HTMLElement | null => {
    if (frame === null || !frame.isConnected) {
      frame = document.querySelector<HTMLElement>(FRAME_SELECTOR)
    }
    return frame
  }

  const disarm = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    frame?.removeAttribute(MARK_ATTRIBUTE)
  }

  const arm = (): void => {
    const target = resolve()
    if (target === null) return
    target.setAttribute(MARK_ATTRIBUTE, '')
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      target.removeAttribute(MARK_ATTRIBUTE)
    }, SETTLE_MS)
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target
    // The toggles are buttons; the column resize handles are divs and must keep
    // the shell's "no track easing while dragging" behaviour.
    if (target instanceof Element && target.closest('button') !== null) arm()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    const editing = target instanceof HTMLElement
      && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
    // Modifier shortcuts toggle the bars from anywhere; plain keys only outside
    // an editor (typing in the composer must not arm the track).
    if (event.ctrlKey || event.metaKey || event.altKey || !editing) arm()
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    disarm()
  }
}
