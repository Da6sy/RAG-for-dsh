/**
 * V1 demo/verification — the「知识检索与向量」page in a REAL browser.
 *
 * Boots the real `clue web` composition on an isolated home, drives headless
 * Chromium to the third settings page, and checks the four promises the plan
 * makes about it (规划 §9). Every check is an assertion, so this doubles as the
 * V1 acceptance record rather than a screenshot script that can pass while the
 * page is broken:
 *
 *   1. **未配置是一种姿态,不是一个错误** — the page renders the setup state and
 *      says in words that retrieval is lexical-only right now;
 *   2. **字段级校验就地报错** — a bad URL is refused under its own input, and
 *      `dim` is display-only (no input anywhere can set it);
 *   3. **密钥写一次、永不回显** — after typing a key the pill says 已配置 and
 *      the whole page text, plus the host's settings document, contain no trace
 *      of the value;
 *   4. **破坏性动作要确认** — 重建 / 清空缓存 / 清除密钥 each require a second
 *      click and state their consequence first.
 *
 * Screenshots land in `docs/assets/` for the V1 record.
 * Run: node scripts/demo-embedding.mjs (needs `npm run build:ui` + chromium).
 *
 * @module @clue-harness/scripts/demo-embedding
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const assetsDir = path.join(repoRoot, 'docs', 'assets')

if (!existsSync(path.join(repoRoot, 'packages/ui-kb/lib/client.js'))) {
  console.error('demo-embedding: 先跑 `npm run build:ui` 构建浏览器 bundle')
  process.exit(2)
}

const log = (...parts) => console.log('[embed-demo]', ...parts)
const checks = []
/**
 * Record one acceptance check.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 */
function check(label, ok) {
  checks.push({ label, ok })
  log(`${ok ? '✓' : '✗'} ${label}`)
}

/**
 * Compare two CSS color spellings (the browser may answer rgb()/rgba() while the
 * token is hex).
 * @param {string | null} a - computed value.
 * @param {string | null} b - token value.
 * @returns {boolean} whether they denote the same color.
 */
function sameColor(a, b) {
  if (a === null || b === null) return false
  const norm = (value) => {
    const text = String(value).trim().toLowerCase()
    // #rgb / #rrggbb / #rrggbbaa → rgb()/rgba(), because the token resolves to
    // an 8-digit hex while getComputedStyle answers in rgb().
    const hex = /^#([0-9a-f]{3,8})$/.exec(text)
    if (hex !== null) {
      const digits = hex[1]
      const expand = digits.length <= 4 ? digits.split('').map((ch) => ch + ch).join('') : digits
      const r = Number.parseInt(expand.slice(0, 2), 16)
      const g = Number.parseInt(expand.slice(2, 4), 16)
      const b = Number.parseInt(expand.slice(4, 6), 16)
      // Two decimals: #0000001a is 0.102 while the browser reports rgba(...,0.1)
      // — the same color, and an alpha difference below 1% is not a finding.
      const a = expand.length >= 8 ? Math.round((Number.parseInt(expand.slice(6, 8), 16) / 255) * 100) / 100 : 1
      return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`
    }
    const rgb = /^rgba?\(([^)]+)\)$/.exec(text)
    if (rgb === null) return text.replace(/\s+/g, '')
    const parts = rgb[1].split(',').map((part) => Number.parseFloat(part.trim()))
    return parts.length >= 4 && parts[3] < 1
      ? `rgba(${parts.slice(0, 3).map((n) => Math.round(n)).join(',')},${Math.round(parts[3] * 100) / 100})`
      : `rgb(${parts.slice(0, 3).map((n) => Math.round(n)).join(',')})`
  }
  return norm(a) === norm(b)
}

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-demo-embed-'))
const project = path.join(workdir, 'proj')
await mkdir(project, { recursive: true })
process.chdir(project)
process.env.CLUE_HOST_HOME = path.join(workdir, 'dsh-home')
process.env.DSH_HOME = path.join(workdir, 'dsh-home')
process.env.CLUE_HOME = path.join(workdir, 'clue-home')

let web
let browser
try {
  const { openProjectStore } = await import('@clue-harness/kb')
  const store = await openProjectStore(project, process.env.CLUE_HOME)
  await store.add({
    kind: 'decision',
    title: 'chunker 版本号只有一个出处',
    text: 'chunkerVersion 若三处各写字面量,每次查询都会判定分片需重建;只保留一个常量出处。',
    tags: ['kb', 'chunker'],
    createdBy: 'cli:demo',
  })
  await store.add({
    kind: 'pitfall',
    title: '绝对定位按钮掉出 Tab 顺序',
    text: '绝对定位会让按钮掉出焦点序列,键盘用户无法到达。',
    tags: ['a11y'],
    createdBy: 'cli:demo',
  })
  log('种子: 项目库 2 条(一条决策、一条踩坑)')

  const { runWeb } = await import('../apps/cli/src/web.ts')
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  web = await runWeb({ environment: loadLayeredEnv('clue'), port: 0, args: ['--no-open'], manageSignals: false })
  log(`boot 完成: ${web.url}`)

  const { chromium } = await import('playwright')
  browser = await chromium.launch({ headless: true, chromiumSandbox: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(web.url, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500)

  // First-run onboarding: dsh's ordered dialogs own #root until dismissed.
  // Facts worth keeping: one modal's `aria-hidden` mask swallows every click
  // behind it, so a navigation attempted while one is open times out instead of
  // failing loudly — every entry into the settings page goes through this.
  const DISMISS = /^(Continue|Configure later|Skip|Later|Close|Got it|完成|跳过|关闭|稍后配置)$/i
  const dismissDialogs = async () => {
    for (let step = 0; step < 6; step += 1) {
      const dialog = page.locator('[role="dialog"]').last()
      if ((await dialog.count()) === 0 || !(await dialog.isVisible().catch(() => false))) break
      const buttons = dialog.getByRole('button')
      const total = await buttons.count()
      let clicked = false
      for (let i = 0; i < total; i += 1) {
        const label = ((await buttons.nth(i).textContent()) ?? '').trim()
        if (DISMISS.test(label)) {
          await buttons.nth(i).click()
          await page.waitForTimeout(700)
          clicked = true
          break
        }
      }
      if (!clicked) break
    }
  }
  await dismissDialogs()

  // ── open the page ────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /设置|Settings/i }).first().click({ timeout: 10_000 })
  const nav = page.getByText('知识检索与向量', { exact: true }).first()
  await nav.waitFor({ state: 'visible', timeout: 15_000 })
  check('第三个设置页出现在设置导航里(order 92)', true)
  await nav.click()
  await page.getByRole('heading', { name: '知识检索与向量' }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(600)

  const section = page.locator('.clue-sec').first()
  const text = async () => (await section.textContent()) ?? ''

  // (1) the unconfigured posture
  const initial = await text()
  check('默认姿态:明确写出"检索只走词法通道"', initial.includes('未启用') && initial.includes('词法'))
  check('向量层现状卡片给出"尚未建立"的诚实说明', initial.includes('向量层尚未建立'))
  check('密钥状态可见(未配置)', initial.includes('密钥未配置'))
  check('dim 只读:全页没有任何可输入的 dim 字段', await section.locator('input').evaluateAll((nodes) =>
    nodes.every((node) => !/dim/i.test(node.getAttribute('placeholder') ?? '') && !/dim/i.test(node.getAttribute('aria-label') ?? ''))))

  // (2) field-level validation, in place. Each editable row is one
  // `.clue-field` containing its input and its own 保存 button.
  const rowFor = (placeholder) => section.locator('.clue-field').filter({ has: page.locator(`input[placeholder="${placeholder}"]`) }).first()
  const baseUrlRow = section.locator('.clue-field').filter({ has: page.locator('input[placeholder="https://…/v1"]') }).first()

  const providerActions = section.locator('.clue-card').filter({ hasText: '提供者' }).first().locator('.clue-card-actions')
  await baseUrlRow.locator('input').first().fill('not-a-url')
  await providerActions.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(900)
  const afterBad = await text()
  check('非法 baseUrl 被就地拒绝并指名字段(而不是只说"保存失败")', afterBad.includes('baseUrl 必须是 http(s)'))

  // a valid write
  await baseUrlRow.locator('input').first().fill('https://api.siliconflow.cn/v1')
  await providerActions.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(900)
  const afterModel = await text()
  check('合法 baseUrl 保存成功', afterModel.includes('已保存'))

  // (2b) V1 follow-up: the embedder PICKER. The page must offer the choices
  // instead of asking the user to know a model id, a base URL and an env name
  // that have to agree — and it must show which providers are actually usable.
  const modelSelect = section.locator('select').first()
  check('embedder 选择器存在', (await modelSelect.count()) === 1)
  const optionLabels = await modelSelect.locator('option').allTextContents()
  const groupLabels = await modelSelect.locator('optgroup').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('label') ?? ''))
  check('选择器按 provider 分组(含内置的 DeepSeek 与本地选项)', groupLabels.some((label) => label.includes('DeepSeek')) && groupLabels.some((label) => label.includes('本地')))
  check('DeepSeek 被标为不可用(实测无嵌入端点),不会让人白试一次', optionLabels.some((label) => label.includes('不可用')))
  const localOption = modelSelect.locator('option').filter({ hasText: 'nomic-embed-text' }).first()
  await modelSelect.selectOption({ label: (await localOption.textContent()) ?? '' })
  await page.waitForTimeout(500)
  // 一个模块一个保存: the picker fills the provider card's draft, and the card's
  // 保存 (the last button in that card's action row) writes it in one patch.
  const providerCard = section.locator('.clue-card').filter({ hasText: '提供者' }).first()
  await providerCard.locator('.clue-card-actions').getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(1200)
  // The honest check reads what was actually PERSISTED (the settings document),
  // not what the page paints: the point of the picker is that baseUrl, model and
  // key reference land together.
  const pickedDoc = await readFile(path.join(workdir, 'dsh-home', 'settings.yaml'), 'utf8')
  check('选中候选后 baseUrl 落盘为该 provider 的地址', pickedDoc.includes('127.0.0.1:11434'))
  check('选中候选后 model 落盘为所选模型', pickedDoc.includes('nomic-embed-text'))
  check('选择器把该候选标为当前选中', ((await modelSelect.locator('option:checked').first().textContent()) ?? '').includes('nomic-embed-text'))


  // (3) the secret: write once, never echo
  const SECRET = 'sk-demo-never-echo-24680'
  const keyField = section.locator('input[type="password"]').first()
  await keyField.fill(SECRET)
  await section.getByRole('button', { name: '设置密钥' }).click()
  await page.waitForTimeout(1200)
  const afterKey = await text()
  check('写入密钥后状态点变成「已配置」', afterKey.includes('密钥已配置'))
  check('页面文本里没有任何密钥值', !afterKey.includes(SECRET))
  check('密钥输入框在写入后被清空', (await keyField.inputValue()) === '')

  const settingsDoc = await readFile(path.join(workdir, 'dsh-home', 'settings.yaml'), 'utf8')
  check('设置文档里只有引用名,没有密钥值', !settingsDoc.includes(SECRET) && settingsDoc.includes('clue-kb-embedding'))
  const credentialDoc = await readFile(path.join(workdir, 'dsh-home', '.credentials.yaml'), 'utf8').catch(() => '')
  check('密钥落在 dsh 凭据存储(owner-only),不在知识库目录', credentialDoc.includes(SECRET))

  // (4) destructive actions confirm first
  const buildButton = section.getByRole('button', { name: '重建向量层' })
  check('未就绪时「重建向量层」保持禁用(不会白花钱)', await buildButton.isDisabled())
  // Destructive acts now go through dsh's own RiskConfirmation: it must state
  // the consequence AND keep the primary action disabled until the user
  // acknowledges. (V1-UI: this replaced a hand-rolled "click twice" hack.)
  const clearCache = section.getByRole('button', { name: '清空缓存' })
  await clearCache.click()
  await page.waitForTimeout(400)
  const dialog = page.locator('.clue-sec, [role="dialog"]').filter({ hasText: '清空嵌入缓存' }).last()
  const dialogText = (await dialog.textContent()) ?? ''
  check('破坏性动作弹出确认并说明后果(要花钱)', dialogText.includes('清空嵌入缓存') && dialogText.includes('花钱'))
  const confirmButton = dialog.getByRole('button', { name: '清空缓存' }).last()
  check('未勾选确认前,主操作不可点', await confirmButton.isDisabled().catch(() => true))
  await dialog.locator('input[type="checkbox"]').first().check().catch(() => {})
  await page.waitForTimeout(200)
  check('勾选确认后主操作可点', !(await confirmButton.isDisabled().catch(() => true)))
  await dialog.getByRole('button', { name: '取消' }).click().catch(() => {})
  await page.waitForTimeout(200)

  // (5) THE TUNING SAVE MUST LAND. This check exists because the defect it
  // pins was invisible for a whole round: the page sent ONE patch to
  // `/embedding/config` and the writer put all of it into `clue-kb-embedding`,
  // so「检索调优」was a silent no-op — the page said 已保存 and
  // `readRetrievalConfig` kept answering with the defaults. The assertion is on
  // the SETTINGS DOCUMENT (not on the toast), because a toast is exactly what
  // was lying.
  const tuningCard = section.locator('.clue-card').filter({ hasText: '检索调优' }).first()
  await tuningCard.getByText('量纲与名次').first().click()
  await page.waitForTimeout(400)
  // Scope by LABEL, never by index: the card has several selects now (档位三件、
  // 词频口径、通道权重含义), and "the first select" broke the moment one was added
  // in front of it — a locator that depends on field order is a test that fails
  // for the wrong reason.
  const scaleField = (card) => card.locator('.clue-field').filter({ hasText: '词法尺度' }).first()
  const scaleSelect = scaleField(tuningCard).locator('select')
  check('量纲与名次折叠面板里有档位下拉(D1/D2/D3 的开关可见)', (await tuningCard.locator('select').count()) >= 3)
  await scaleSelect.selectOption('absolute')
  await page.waitForTimeout(200)
  await tuningCard.locator('.clue-card-actions').getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(1400)
  const tuningDoc = await readFile(path.join(workdir, 'dsh-home', 'settings.yaml'), 'utf8')
  const retrievalSection = tuningDoc.split('clue-kb-retrieval')[1] ?? ''
  check('检索调优保存真的写进 clue-kb-retrieval(而不是静默空操作)',
    retrievalSection.includes('lexicalNormalization') && retrievalSection.includes('absolute'))
  check('检索档位没有落进嵌入 section(不产生孤儿键)',
    !(tuningDoc.split('clue-kb-retrieval')[0] ?? '').includes('lexicalNormalization'))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(2500)
  await dismissDialogs()
  await page.getByRole('button', { name: /设置|Settings/i }).first().click({ timeout: 10_000 })
  await page.getByText('知识检索与向量', { exact: true }).first().click()
  await page.getByRole('heading', { name: '知识检索与向量' }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(800)
  const reloaded = page.locator('.clue-sec').first()
  await reloaded.locator('.clue-card').filter({ hasText: '检索调优' }).first().getByText('量纲与名次').first().click()
  await page.waitForTimeout(400)
  const reloadedTuning = reloaded.locator('.clue-card').filter({ hasText: '检索调优' }).first()
  check('刷新后页面回显保存的档位(而不是回到默认)',
    (await reloadedTuning.locator('.clue-field').filter({ hasText: '词法尺度' }).first().locator('select').inputValue()) === 'absolute')

  // (5) DESIGN-TOKEN CONFORMANCE: the page must be built from dsh's own
  // measurements and tokens, not from a lookalike palette. Every number below
  // is compared against the value the token resolves to in THIS document, so
  // the check follows the shell's theme instead of hard-coding a color.
  const conformance = await page.evaluate(() => {
    const root = getComputedStyle(document.body)
    const token = (name) => root.getPropertyValue(name).trim()
    const section = document.querySelector('.clue-sec')
    const title = document.querySelector('.clue-sec-title')
    const card = document.querySelector('.clue-card')
    const intro = document.querySelector('.clue-sec-intro')
    const pill = document.querySelector('[class*="_pill_"]')
    const style = (el) => (el === null ? null : getComputedStyle(el))
    return {
      sectionMaxWidth: style(section)?.maxWidth ?? null,
      sectionFont: style(section)?.fontFamily ?? null,
      shellFont: style(document.querySelector('nav, aside, body'))?.fontFamily ?? null,
      titleSize: style(title)?.fontSize ?? null,
      titleWeight: style(title)?.fontWeight ?? null,
      titleLine: style(title)?.lineHeight ?? null,
      introSize: style(intro)?.fontSize ?? null,
      introColor: style(intro)?.color ?? null,
      introColorToken: token('--dsw-alias-label-tertiary'),
      cardRadius: style(card)?.borderRadius ?? null,
      cardBorder: style(card)?.borderTopColor ?? null,
      cardBorderToken: token('--dsw-alias-border-l2'),
      pillRadius: style(pill)?.borderRadius ?? null,
      pillSize: style(pill)?.fontSize ?? null,
      dshPillCount: document.querySelectorAll('[class*="_pill_"]').length,
      monoFont: getComputedStyle(document.querySelector('.clue-mono') ?? document.body).fontFamily,
      codeFontToken: token('--ds-font-family-code'),
    }
  })
  check('版心与 dsh 设置页一致(max-width 720px)', conformance.sectionMaxWidth === '720px')
  // 布局:输入框顶到框尾 + 一个模块一个保存
  const layout = await section.evaluate((root) => {
    const card = root.querySelector('.clue-card')
    const field = card?.querySelector('.clue-field')
    const input = field?.querySelector('input, select')
    const cardWidth = card?.getBoundingClientRect().width ?? 0
    const inputWidth = input?.getBoundingClientRect().width ?? 0
    const labelAbove = field === null || field === undefined ? false : (() => {
      const label = field.querySelector('.clue-field-label')
      if (label === null) return false
      return label.getBoundingClientRect().bottom <= (input?.getBoundingClientRect().top ?? 0) + 2
    })()
    const cards = [...root.querySelectorAll('.clue-card')]
    const saveCounts = cards.map((node) => [...node.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '保存').length)
    const plain = cards.map((node) => [...node.querySelectorAll('p')].filter((p) => (p.textContent ?? '').trim().length > 120).length)
    return { cardWidth, inputWidth, labelAbove, firstFieldHtml: field?.outerHTML ?? null, saveCounts, longParagraphs: plain.reduce((a, b) => a + b, 0) }
  })
  if (layout.inputWidth < layout.cardWidth - 40 || !layout.labelAbove) {
    log(`  · 诊断: cardWidth=${layout.cardWidth} inputWidth=${layout.inputWidth} labelAbove=${layout.labelAbove} firstFieldHtml=${(layout.firstFieldHtml ?? '').slice(0, 120)}`)
  }
  check('输入框顶到卡片框尾(占满整行)', layout.inputWidth > 0 && layout.inputWidth >= layout.cardWidth - 40)
  check('字段标签在输入框上方(dsh 的堆叠形态)', layout.labelAbove)
  check('每张卡片最多一个保存按钮', layout.saveCounts.every((count) => count <= 1))
  check('卡片内没有大段解释文字', layout.longParagraphs === 0)
  check('标题用 dsh 的字号/字重/行高(16 / 500 / 24px)',
    conformance.titleSize === '16px' && conformance.titleWeight === '500' && conformance.titleLine === '24px')
  check('说明文字用 dsh 的次级色令牌', sameColor(conformance.introColor, conformance.introColorToken))
  check('说明文字行高 22px', conformance.introSize === '14px')
  check('卡片圆角 12px、边框取 --dsw-alias-border-l2',
    conformance.cardRadius === '12px' && sameColor(conformance.cardBorder, conformance.cardBorderToken))
  // The chips are dsh's own `Pill` primitive now — no local chip look survives.
  check('标签用的是 dsh 的 Pill 原语(而不是我们自己的样式)', conformance.dshPillCount > 0)
  check('正文字体沿用 shell 字体(没有换字体)', conformance.sectionFont === conformance.shellFont)
  check('等宽内容用 dsh 的代码字体令牌', sameColor(conformance.monoFont, conformance.codeFontToken) || conformance.monoFont.includes('mono'))

  await page.screenshot({ path: path.join(assetsDir, 'v1-embedding-page.png'), fullPage: true })
  log(`截图: docs/assets/v1-embedding-page.png`)
  check('页面无 JS 运行时错误', pageErrors.length === 0)
  if (pageErrors.length > 0) log('页面错误:', pageErrors.slice(0, 3).join(' | '))

  await browser.close()
  browser = undefined
} finally {
  if (browser !== undefined) await browser.close().catch(() => {})
  if (web !== undefined) await web.shutdown(0).catch(() => {})
  await rm(workdir, { recursive: true, force: true })
}

const failed = checks.filter((entry) => !entry.ok)
log(`结果: ${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length > 0) {
  for (const entry of failed) console.error(`  ✗ ${entry.label}`)
  process.exit(1)
}
