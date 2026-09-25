/**
 * The themed dropdown (M9.1) — why this exists instead of `<select>`.
 *
 * The workspace picker and the status filter were native `<select>`s. Their
 * popup is drawn by the OS, not the page: square corners, system colors, no
 * token in common with the rest of ClueHarness — the exact "点开的菜单是直角
 * 方框，跟整体 UI 不统一" complaint. Native selects also cannot show a second
 * line of metadata (the central library path under a workspace name).
 *
 * So this wraps dsh's own `Menu` primitive (anchored, token-driven, rounded,
 * Escape/outside-click handled, optional portal) with the tiny amount of state
 * a select needs: an open flag and a change callback. Same keyboard affordances
 * the rest of the shell has, because it IS the rest of the shell.
 *
 * @module @clue-harness/ui-kb/client/MenuSelect
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'

/** One choice: an id, the row label, and an optional dim second line. */
export interface MenuOption {
  id: string
  label: ReactNode
  /** Right-aligned dim hint (a path, a count). Native selects cannot render this. */
  hint?: string
  /** Error-colored row (used for destructive verbs). */
  danger?: boolean
  /** Not choosable (headings, unavailable workspaces). */
  disabled?: boolean
}

/**
 * A themed single-select dropdown.
 * @param props.value - the selected option id.
 * @param props.options - the choices, in display order.
 * @param props.onChange - called with the chosen id.
 * @param props.trigger - override for the closed-state label (default: the
 *   selected option's label).
 * @param props.placeholder - label when nothing matches.
 * @param props.ariaLabel - accessible name for the control.
 * @param props.compact - smaller button chrome.
 * @param props.portal - render the list into body (use inside overflow-clipped
 *   panes, e.g. the settings content column).
 * @returns the control.
 */
export function MenuSelect(props: {
  value: string
  options: readonly MenuOption[]
  onChange: (id: string) => void
  trigger?: ReactNode
  placeholder?: string
  ariaLabel?: string
  compact?: boolean
  portal?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = props.options.find((option) => option.id === props.value)
  const items: MenuItem[] = props.options.map((option) => ({
    id: option.id,
    label: option.hint === undefined
      ? option.label
      : (
        <span className="clue-menu-row">
          <span className="clue-menu-label">{option.label}</span>
          <span className="clue-menu-hint">{option.hint}</span>
        </span>
      ),
    danger: option.danger,
    disabled: option.disabled,
  }))
  return (
    <span className="clue-menuselect">
      <Menu
        open={open}
        anchor={(
          <Button
            size="sm"
            variant="outline"
            aria-label={props.ariaLabel ?? '选择'}
            onClick={() => { setOpen((previous) => !previous) }}
          >
            <span className="clue-menuselect-label">
              {props.trigger ?? selected?.label ?? props.placeholder ?? '未选择'}
            </span>
            <span aria-hidden className={`clue-menuselect-caret${open ? ' clue-menuselect-caret-open' : ''}`}>▾</span>
          </Button>
        )}
        items={items}
        selectedId={props.value}
        portal={props.portal === true}
        closeOnPointerLeave
        onSelect={(id) => {
          setOpen(false)
          props.onChange(id)
        }}
        onClose={() => { setOpen(false) }}
      />
    </span>
  )
}
