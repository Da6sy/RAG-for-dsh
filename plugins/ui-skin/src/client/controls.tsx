/**
 * Small form controls for the skin page, built from the same tokens the
 * shipped settings surfaces use. `Button` and `Switch` come from
 * ui-primitives (a baseline module the client bundle may extern); the range,
 * choice group and nine-grid picker are local because dsh has no primitive
 * for them and the design asks for a visual position control.
 *
 * @module @clue-harness/ui-skin/client/controls
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

/** A titled card in the settings column. */
export function Card({ title, hint, actions, children }: {
  title: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="cl-xs-card">
      <div className="cl-xs-card-head">
        <span className="cl-xs-card-title">{title}</span>
        <span className="cl-xs-grow" />
        {actions}
      </div>
      {hint !== undefined && <p className="cl-xs-card-hint">{hint}</p>}
      {children}
    </section>
  )
}

/** A labeled field wrapper. */
export function Field({ label, value, hint, children }: {
  label: string
  value?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="cl-xs-field">
      <div className="cl-xs-field-head">
        <span className="cl-xs-label">{label}</span>
        {value !== undefined && <span className="cl-xs-value">{value}</span>}
      </div>
      {children}
      {hint !== undefined && <p className="cl-xs-hint">{hint}</p>}
    </div>
  )
}

/** One native range row. */
export function SliderRow({ id, label, value, min, max, step, display, onChange, disabled = false, hint }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (next: number) => void
  disabled?: boolean
  hint?: string
}) {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <div className="cl-xs-field">
      <div className="cl-xs-field-head">
        <label className="cl-xs-label" htmlFor={id}>{label}</label>
        <span className="cl-xs-value">{display}</span>
      </div>
      <input
        id={id}
        className="cl-xs-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--cl-xs-fill': `${String(percent)}%` } as CSSProperties}
        onChange={(event) => { onChange(Number(event.currentTarget.value)) }}
      />
      {hint !== undefined && <p className="cl-xs-hint">{hint}</p>}
    </div>
  )
}

/** A pill-style toggle group (no tab semantics, no hidden panels). */
export function ChoiceRow<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div className="cl-xs-field">
      <span className="cl-xs-label">{label}</span>
      <div className="cl-xs-choice" role="group" aria-label={label}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className="cl-xs-choice-btn"
            aria-pressed={option.value === value}
            title={option.title}
            disabled={disabled}
            onClick={() => { onChange(option.value) }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A label + hint + switch row. */
export function ToggleRow({ label, hint, checked, onChange, disabled = false }: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="cl-xs-field">
      <div className="cl-xs-row">
        <span className="cl-xs-label">{label}</span>
        <span className="cl-xs-grow" />
        <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      </div>
      {hint !== undefined && <p className="cl-xs-hint">{hint}</p>}
    </div>
  )
}

/** The nine-grid background anchor. */
export function PositionPicker({ value, onChange }: {
  value: string
  onChange: (next: string) => void
}) {
  const cells: { key: string; label: string }[] = [
    { key: 'top-left', label: '左上' }, { key: 'top', label: '顶部居中' }, { key: 'top-right', label: '右上' },
    { key: 'left', label: '左侧居中' }, { key: 'center', label: '居中' }, { key: 'right', label: '右侧居中' },
    { key: 'bottom-left', label: '左下' }, { key: 'bottom', label: '底部居中' }, { key: 'bottom-right', label: '右下' },
  ]
  return (
    <div className="cl-xs-pos" role="group" aria-label="背景位置">
      {cells.map(cell => (
        <button
          key={cell.key}
          type="button"
          className="cl-xs-pos-btn"
          aria-pressed={value === cell.key}
          aria-label={cell.label}
          title={cell.label}
          onClick={() => { onChange(cell.key) }}
        />
      ))}
    </div>
  )
}

/**
 * A ghost action that arms on first click and acts on the second.
 * @param props.label - resting label.
 * @param props.confirmLabel - armed label, shown for four seconds.
 * @param props.onConfirm - invoked by the second click.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled = false }: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  return (
    <Button
      size="sm"
      variant={armed ? 'outline' : 'ghost'}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
          return
        }
        setArmed(true)
        window.setTimeout(() => { setArmed(false) }, 4000)
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  )
}
