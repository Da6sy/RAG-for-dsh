/**
 * The "外观与背景" settings page: all five groups from design §3.9 over one
 * live preview. Every control writes straight through `SkinController` — the
 * page owns no visual state of its own except the URL draft and the drop
 * zone's hover flag, so the preview, the real shell and the persisted section
 * can never disagree.
 *
 * Typography, radii, borders and colour roles follow the shipped settings
 * surfaces (the ui-kb V1-UI discipline): 720px column, 12px gaps, 12px card
 * radius, 12/500 field labels, 11px badges.
 *
 * @module @clue-harness/ui-skin/client/Section
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  Button, IconLinkOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `settings.section` SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  GLASS_PRESETS, PRESETS, IMAGE_TYPES, presetVariant, resolveMaskColor,
  type BgFit, type BgKind, type BgPreset, type SkinSettings,
} from '../skin-config.ts'
import { formatBytes } from './image-store.ts'
import type { SkinController, SkinSnapshot } from './controller.ts'
import { Card, ChoiceRow, ConfirmButton, Field, PositionPicker, SliderRow, ToggleRow } from './controls.tsx'

/** The controller face the slot injects into this page. */
export interface SkinSectionFace {
  skin: SkinController
}

/** Composed props the renderer binds for the skin page. */
export type SkinSectionProps = PropsRuntime<'settings.section'> & InjectFace<SkinSectionFace>

/** Source labels, in the order the design lists them (plus the bundled presets). */
const SOURCE_OPTIONS: readonly { value: BgKind; label: string; title: string }[] = [
  { value: 'none', label: '无', title: '保持 dsh 原本的外观' },
  { value: 'preset', label: '氛围', title: '内置渐变背景,不需要图片' },
  { value: 'image', label: '本地图片', title: '上传一张图片,只保存在这台浏览器' },
  { value: 'url', label: '图片链接', title: '使用 http(s) 图片地址' },
]

/** Fill labels. */
const FIT_OPTIONS: readonly { value: BgFit; label: string }[] = [
  { value: 'cover', label: '铺满' },
  { value: 'contain', label: '完整' },
  { value: 'auto', label: '原始' },
]

/** One small status badge. */
function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'live'; children: ReactNode }) {
  const suffix = tone === undefined ? '' : ` cl-xs-badge-${tone}`
  return <span className={`cl-xs-badge${suffix}`}><span className="cl-xs-dot" />{children}</span>
}

/** Localized persistence note for the footer. */
function persistLabel(state: SkinSnapshot['persist']): string {
  switch (state) {
    case 'ready': return '自动保存'
    case 'loading': return '读取设置…'
    case 'readonly': return '只读连接 · 仅本页生效'
    default: return '设置不可用 · 仅本页生效'
  }
}

/** Percentage display for a 0–1 knob. */
function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/** One preview tile's skeleton bar. */
function Bar({ width, strong = false }: { width: string; strong?: boolean }) {
  return <div className={`cl-xs-preview-bar${strong ? ' cl-xs-preview-bar-strong' : ''}`} style={{ width }} />
}

/**
 * Render the appearance settings page.
 * @param props.skin - the injected controller (state + actions).
 * @returns the section body.
 */
export function SkinSection({ skin }: SkinSectionProps) {
  const snapshot = useSyncExternalStore(skin.subscribe, skin.getSnapshot)
  const { settings, plan } = snapshot
  const [urlDraft, setUrlDraft] = useState(settings.bgUrl)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { setUrlDraft(settings.bgUrl) }, [settings.bgUrl])

  const set = (patch: Partial<SkinSettings>): void => { skin.update(patch) }
  const pickFile = (file: File | undefined): void => {
    if (file !== undefined) void skin.pickImage(file)
  }
  const autoMask = settings.maskColor === 'auto'
  const thumbnail: CSSProperties | undefined = snapshot.preview === undefined
    ? undefined
    : { backgroundImage: `url(${JSON.stringify(snapshot.preview)})` }

  return (
    <section className="cl-xs-sec">
      <header className="cl-xs-head">
        <div className="cl-xs-head-copy">
          <span className="cl-xs-eyebrow">界面</span>
          <h2 className="cl-xs-title">外观与背景</h2>
          <p className="cl-xs-intro">
            一张背景铺满整个窗口,侧栏、停靠面板、设置页与对话气泡以玻璃浮在上面。所有改动即时生效并自动保存。
          </p>
        </div>
        <div className="cl-xs-head-actions">
          <Badge tone={snapshot.active ? 'live' : undefined}>{snapshot.active ? '已启用' : '未启用'}</Badge>
          <ConfirmButton label="恢复默认" confirmLabel="确认恢复?" onConfirm={() => { skin.reset() }} />
        </div>
      </header>

      {snapshot.persist === 'readonly' && (
        <p className="cl-xs-notice">当前连接不允许写入 profile,调整只在这个页面生效(刷新后恢复已保存的值)。</p>
      )}
      {snapshot.notice !== null && <p className="cl-xs-notice">{snapshot.notice}</p>}

      <Card
        title="即时预览"
        hint="示意当前背景、遮罩、面板玻璃与气泡的组合效果;关闭设置即可看到整个窗口的样子。"
        actions={(
          <Badge tone={plan.ok ? 'ok' : 'warn'}>
            {plan.ok ? `文字对比度 ${String(plan.minContrast)}:1` : `对比度偏低 ${String(plan.minContrast)}:1`}
          </Badge>
        )}
      >
        <div className="cl-xs-preview" aria-hidden="true">
          <div className="cl-xs-preview-wall" />
          <div className="cl-xs-preview-tone" />
          <div className="cl-xs-preview-vignette" />
          <div className="cl-xs-preview-ui">
            <div className="cl-xs-preview-side">
              <Bar width="72%" strong />
              <Bar width="54%" />
              <Bar width="64%" />
              <Bar width="46%" />
            </div>
            <div className="cl-xs-preview-main">
              <Bar width="58%" />
              <Bar width="42%" />
              <div className="cl-xs-preview-bubble">把界面变成你的样子</div>
            </div>
            <div className="cl-xs-preview-dock">
              <Bar width="66%" strong />
              <Bar width="48%" />
              <Bar width="58%" />
            </div>
          </div>
          {!snapshot.active && (
            <div className="cl-xs-preview-cta">
              <span>选择任一背景后立即生效</span>
              <button
                type="button"
                onClick={() => { set({ bgKind: 'preset', bgPreset: 'aurora' }) }}
              >
                试用「极光」
              </button>
            </div>
          )}
        </div>
        <div className="cl-xs-foot">
          <span>面板不透明度 {percent(plan.baseAlpha)}</span>
          <span>模糊 {String(Math.round(settings.glassBlur))}px</span>
          <span>气泡 {percent(plan.bubbleAlpha)}</span>
          <span>终端/文件 {percent(plan.terminalAlpha)}</span>
          <span className="cl-xs-grow" />
          <span>{persistLabel(snapshot.persist)}</span>
        </div>
      </Card>

      <Card
        title="背景"
        hint="本地上传只保存在这台浏览器的 IndexedDB(≤8 MB);链接图片由浏览器直接加载,跨域时护栏按保守范围估算亮度。"
      >
        <ChoiceRow
          label="背景来源"
          value={settings.bgKind}
          options={SOURCE_OPTIONS}
          onChange={(value) => { set({ bgKind: value }) }}
        />

        {settings.bgKind === 'none' && (
          <p className="cl-xs-hint">当前不改变外观。选「氛围」可以零成本试一下玻璃效果;想让壁纸更清楚,到「毛玻璃 → 观感」选「清晰」。</p>
        )}

        {settings.bgKind === 'preset' && (
          <div className="cl-xs-presets">
            {PRESETS.map((preset) => {
              const variant = presetVariant(preset, snapshot.theme)
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="cl-xs-preset"
                  aria-pressed={settings.bgPreset === preset.id}
                  onClick={() => { set({ bgKind: 'preset', bgPreset: preset.id as BgPreset }) }}
                >
                  <span className="cl-xs-preset-swatch" style={{ backgroundImage: variant.image }} />
                  <span className="cl-xs-preset-copy">
                    <span className="cl-xs-preset-name">{preset.label}</span>
                    <span className="cl-xs-preset-hint">{preset.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {settings.bgKind === 'image' && (
          <>
            <div
              className={`cl-xs-drop${dragOver ? ' cl-xs-drop-over' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
              onDragLeave={() => { setDragOver(false) }}
              onDrop={(event) => {
                event.preventDefault()
                setDragOver(false)
                pickFile(event.dataTransfer.files[0])
              }}
            >
              <div className="cl-xs-thumb" style={thumbnail} />
              <div className="cl-xs-drop-copy">
                <span className="cl-xs-drop-name">{snapshot.image?.name ?? '还没有背景图'}</span>
                <span className="cl-xs-drop-meta">
                  {snapshot.image === undefined
                    ? `PNG / JPEG / WebP,最大 8 MB`
                    : `${String(snapshot.image.width)}×${String(snapshot.image.height)} · ${formatBytes(snapshot.image.bytes)} · 平均亮度 ${percent(snapshot.image.grey / 255)}`}
                </span>
              </div>
              <div className="cl-xs-drop-actions">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconPlusOutlineRegular size={14} />}
                  disabled={snapshot.busy}
                  onClick={() => { fileRef.current?.click() }}
                >
                  {snapshot.busy ? '处理中…' : snapshot.image === undefined ? '选择图片' : '更换'}
                </Button>
                {snapshot.image !== undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconTrashOutlineRegular size={14} />}
                    onClick={() => { void skin.clearImage() }}
                  >
                    清除
                  </Button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept={IMAGE_TYPES.join(',')}
                className="cl-xs-hidden"
                onChange={(event) => {
                  pickFile(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </div>
            {snapshot.imageMissing && (
              <p className="cl-xs-notice">这张背景图只保存在上传它的浏览器里;在当前浏览器重新选择一张即可恢复。</p>
            )}
          </>
        )}

        {settings.bgKind === 'url' && (
          <div className="cl-xs-field">
            <span className="cl-xs-label">图片地址</span>
            <div className="cl-xs-url-row">
              <input
                className="cl-xs-input"
                type="url"
                inputMode="url"
                placeholder="https://…/wallpaper.jpg"
                value={urlDraft}
                onChange={(event) => { setUrlDraft(event.currentTarget.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    skin.useUrl(urlDraft)
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                icon={<IconLinkOutlineRegular size={14} />}
                onClick={() => { skin.useUrl(urlDraft) }}
              >
                应用
              </Button>
            </div>
            <p className="cl-xs-hint">外链可能被 CSP 或对方的跨域策略拦截;失败时改用本地上传。</p>
          </div>
        )}

        {snapshot.imageError !== null && <p className="cl-xs-error">{snapshot.imageError}</p>}

        <div className="cl-xs-grid">
          <ChoiceRow
            label="填充方式"
            value={settings.bgFit}
            options={FIT_OPTIONS}
            onChange={(value) => { set({ bgFit: value as BgFit }) }}
          />
          <Field label="位置">
            <PositionPicker value={settings.bgPosition} onChange={(value) => { set({ bgPosition: value as SkinSettings['bgPosition'] }) }} />
          </Field>
        </div>

        <SliderRow
          id="cl-xs-bg-blur"
          label="背景模糊"
          value={settings.bgBlur}
          min={0}
          max={24}
          step={1}
          display={`${String(Math.round(settings.bgBlur))}px`}
          onChange={(value) => { set({ bgBlur: value }) }}
          hint="只模糊壁纸本身;面板玻璃是层在它上面的第二重磨砂。"
        />
      </Card>

      <Card title="遮罩" hint="在壁纸与界面之间压一层色:越深越沉,越浅越透。自动模式跟随深浅色主题选黑或白。">
        <SliderRow
          id="cl-xs-mask-opacity"
          label="不透明度"
          value={settings.maskOpacity}
          min={0}
          max={0.9}
          step={0.01}
          display={percent(settings.maskOpacity)}
          onChange={(value) => { set({ maskOpacity: value }) }}
          hint="可读性护栏会在对比度不足时自动加深面板,不必为了文字把遮罩拉满。"
        />
        <ChoiceRow
          label="遮罩颜色"
          value={autoMask ? 'auto' : 'custom'}
          options={[
            { value: 'auto', label: '跟随主题' },
            { value: 'custom', label: '自定义' },
          ]}
          onChange={(value) => {
            if (value === 'auto') set({ maskColor: 'auto' })
            else set({ maskColor: resolveMaskColor(settings, snapshot.theme) })
          }}
        />
        {!autoMask && (
          <div className="cl-xs-row">
            <input
              className="cl-xs-color"
              type="color"
              aria-label="遮罩颜色"
              value={settings.maskColor}
              onChange={(event) => { set({ maskColor: event.currentTarget.value }) }}
            />
            <code className="cl-xs-hint">{settings.maskColor}</code>
            <span className="cl-xs-grow" />
            <span className="cl-xs-hint">当前主题的自动色:{resolveMaskColor({ ...settings, maskColor: 'auto' }, snapshot.theme)}</span>
          </div>
        )}
      </Card>

      <Card title="毛玻璃" hint="通透度与模糊分开控制:想要壁纸清楚,选「清晰」或把模糊拉到 0;右侧栏终端与文件查看也跟随这组参数。">
        <div className="cl-xs-field">
          <span className="cl-xs-label">观感</span>
          <div className="cl-xs-row">
            {GLASS_PRESETS.map(preset => {
              const active = Math.abs(settings.glassStrength - preset.strength) < 0.005
                && settings.glassBlur === preset.blur
              return (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={active ? 'outline' : 'ghost'}
                  title={preset.hint}
                  onClick={() => { set({ glassStrength: preset.strength, glassBlur: preset.blur }) }}
                >
                  {preset.label}
                </Button>
              )
            })}
          </div>
          <p className="cl-xs-hint">一键组合通透度与模糊;下面两项仍可细调。</p>
        </div>
        <ToggleRow
          label="面板玻璃"
          hint="作用于侧栏、对话区、停靠面板、浮动窗口、设置页与输入框。"
          checked={settings.glassPanels}
          onChange={(value) => { set({ glassPanels: value }) }}
        />
        <SliderRow
          id="cl-xs-glass-strength"
          label="通透度"
          value={settings.glassStrength}
          min={0}
          max={1}
          step={0.01}
          display={percent(settings.glassStrength)}
          onChange={(value) => { set({ glassStrength: value }) }}
          hint="数值越高,表面越透明、壁纸越明显;文字对比度由护栏兜底。"
        />
        <SliderRow
          id="cl-xs-glass-blur"
          label="模糊"
          value={settings.glassBlur}
          min={0}
          max={24}
          step={1}
          display={`${String(Math.round(settings.glassBlur))}px`}
          onChange={(value) => { set({ glassBlur: value }) }}
          hint="0 = 完全清晰;数值越大越磨砂。低功耗模式最多 4px。"
        />
        <ToggleRow
          label="高光描边"
          hint="在玻璃边缘加一条 1px 内高光,让面板有厚度。"
          checked={settings.glassBorder}
          onChange={(value) => { set({ glassBorder: value }) }}
        />
      </Card>

      <Card title="对话气泡" hint="液态玻璃:渐变高光 + 内描边 + 极低透明度噪声,不使用大面积光晕或重投影。">
        <ToggleRow
          label="液态玻璃"
          hint="只作用于你说的话(含正在发送的气泡);助手回复保持文档式阅读节奏。"
          checked={settings.bubbleLiquid}
          onChange={(value) => { set({ bubbleLiquid: value }) }}
        />
        <SliderRow
          id="cl-xs-bubble-intensity"
          label="强度"
          value={settings.bubbleIntensity}
          min={0}
          max={1}
          step={0.01}
          display={percent(settings.bubbleIntensity)}
          onChange={(value) => { set({ bubbleIntensity: value }) }}
        />
        <ToggleRow
          label="自动保证可读"
          hint={`气泡文字对比度 ${String(plan.bubbleContrast)}:1(目标 ≥ 4.5:1)。关闭后按强度直接取值。`}
          checked={settings.bubbleReadability}
          onChange={(value) => { set({ bubbleReadability: value }) }}
        />
      </Card>

      <Card title="性能" hint="backdrop-filter 由 GPU 合成;低功耗模式关闭模糊并加深表面,适合远程桌面或旧显卡。">
        <ChoiceRow
          label="性能模式"
          value={settings.perfMode}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'low', label: '低功耗' },
          ]}
          onChange={(value) => { set({ perfMode: value as SkinSettings['perfMode'] }) }}
        />
        <p className="cl-xs-hint">
          当前:{settings.perfMode === 'low' ? '面板模糊降到 4px,关闭气泡与背景模糊' : '按强度启用模糊'}
          {snapshot.theme === 'dark' ? ' · 深色主题' : ' · 浅色主题'}
        </p>
      </Card>

      <p className="cl-xs-foot">
        <IconSparkleRegular size={14} />
        <span>设置保存在 dsh profile(<code>ui-clue-skin</code>);背景图只保存在这台浏览器(IndexedDB)。恢复默认不会删除已上传的图片。</span>
      </p>
    </section>
  )
}
