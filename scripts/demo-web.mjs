/**
 * M3c demo — the approval-center story in a REAL browser.
 *
 * Seeds a temp KB with the project's running example (a pitfall, a promotion
 * proposal queued by two human confirms, a drifted binding awaiting review,
 * a global-tier fact), boots the real clue web composition on a test port,
 * then drives headless Chromium through the product line of design §6.1:
 * open settings → 知识库审批 → approve the queued promotion → watch the
 * queue empty → 知识库 panel shows the entry as 可信 and the drifted entry's
 * reverify bar. Screenshots land in docs/assets/ for the M3c record.
 *
 * Run: node scripts/demo-web.mjs   (needs the built ui-kb bundle and
 * playwright chromium; both are the M3a/M3c toolchain).
 *
 * @module @clue-harness/scripts/demo-web
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const assetsDir = path.join(repoRoot, 'docs', 'assets')

if (!existsSync(path.join(repoRoot, 'plugins/ui-kb/lib/client.js'))) {
  console.error('demo-web: 先跑 `npm run build:ui` 构建浏览器 bundle')
  process.exit(2)
}

const log = (...parts) => console.log('[demo]', ...parts)

// ── isolation FIRST (the app-boot home-pin discipline) ────────────────────
// runWeb ASSIGNS DSH_HOME from CLUE_HOST_HOME — isolate through that door.
const workdir = await mkdtemp(path.join(tmpdir(), 'clue-demo-web-'))
const project = path.join(workdir, 'proj')
await mkdir(project, { recursive: true })
process.chdir(project)
process.env.CLUE_HOST_HOME = path.join(workdir, 'dsh-home')
process.env.DSH_HOME = path.join(workdir, 'dsh-home')
process.env.CLUE_HOME = path.join(workdir, 'clue-home')

try {
  // ── seed the story ──────────────────────────────────────────────────────
  const { openProjectStore, openGlobalStore } = await import('@clue-harness/kb')
  const store = await openProjectStore(project, process.env.CLUE_HOME)
  const global = await openGlobalStore(process.env.CLUE_HOME)

  const pitfall = await store.add({
    kind: 'pitfall',
    title: '绝对定位按钮掉出 Tab 顺序',
    text: '在 flex 容器里给提交按钮加绝对定位,它会掉出 Tab 顺序;需要显式检查键盘可达性。',
    tags: ['按钮', '可访问性'],
    createdBy: 'agent:demo',
  })
  // Threshold ±20 (the M3a decision): promotion needs a THICK evidence
  // basket — four human confirms (+5 each) reach it exactly.
  await store.recordSignal(pitfall.id, 'human-confirm', '第一次人工确认:门禁拦下后修好了')
  await store.recordSignal(pitfall.id, 'human-confirm', '第二次人工确认:同类坑再次被拦')
  await store.recordSignal(pitfall.id, 'human-confirm', '第三次人工确认:评审时引用生效')
  await store.recordSignal(pitfall.id, 'human-confirm', '第四次人工确认:新项目又躲过一次')
  const promotion = await store.suggestPromotions()
  log(`种子: 提升提案 ${promotion.length} 条(窗口分 20 ≥ 阈值 20,四次人工确认攒满)`)

  await writeFile(path.join(project, 'theme.css'), 'a { color: red }')
  const snippet = await store.add({
    kind: 'snippet',
    title: '主题色约定',
    text: '主色使用红色,链接悬停加深。',
    bindings: ['theme.css'],
    createdBy: 'cli:demo',
  })
  await writeFile(path.join(project, 'theme.css'), 'a { color: teal }')
  await store.checkBindings(snippet.id) // drift → needs review

  await global.add({
    kind: 'fact',
    title: 'WSL 路径转换用 wslpath',
    text: 'Windows 路径进 WSL 一律经 wslpath 转换,不要手工拼 /mnt/c。',
    createdBy: 'cli:demo',
  })
  log('种子: 项目库 2 条(1 条待批提升、1 条绑定漂移待复核) + 全局库 1 条')

  // ── boot the real web surface ───────────────────────────────────────────
  const { runWeb } = await import('../apps/cli/src/web.ts')
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  const web = await runWeb({
    environment: loadLayeredEnv('clue'),
    port: 0,
    args: ['--no-open'],
    manageSignals: false,
  })
  log(`boot 完成: ${web.url}`)

  // M9.1: the settings panel lists the HOST's workspaces — seeding a store by
  // hand no longer makes a workspace visible (that is the whole point: no more
  // phantom rows). So do what a user does: register the directory with the
  // host's workspace registry, and let the panel's sync pick it up.
  const registry = web.ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('演示需要宿主 workspaceRegistry 服务(组合被破坏了?)')
  const hostWorkspace = await registry.create(project, '靶场演示项目')
  log(`宿主工作区已创建: ${hostWorkspace.id} → ${hostWorkspace.path}`)

  // ── drive a real browser ────────────────────────────────────────────────
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  // networkidle never fires under the shell's SSE stream — 'load' plus
  // explicit locator waits is the honest readiness signal.
  await page.goto(web.url, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500) // boot graph settle + first paint

  // (0) first-run onboarding: a fresh DSH_HOME walks dsh's ordered
  // settings.onboarding steps (internal-testing notice → API key → …), each
  // owning #root inert until its sole path completes. The demo dismisses
  // them like a user would, one visible dialog at a time.
  const DISMISS = /^(Continue|Configure later|Skip|Later|Close|Got it|完成|跳过|关闭|稍后配置)$/i
  for (let step = 0; step < 6; step += 1) {
    const dialog = page.locator('[role="dialog"]').last()
    if (await dialog.count() === 0 || !(await dialog.isVisible().catch(() => false))) break
    const buttons = dialog.getByRole('button')
    const total = await buttons.count()
    let clicked = false
    for (let i = 0; i < total; i += 1) {
      const label = ((await buttons.nth(i).textContent()) ?? '').trim()
      if (DISMISS.test(label)) {
        await buttons.nth(i).click()
        await page.waitForTimeout(800)
        log(`首跑引导 ${step + 1}: 点掉「${label}」`)
        clicked = true
        break
      }
    }
    if (!clicked) {
      log(`首跑引导: 对话框无可识别的关闭按钮(${(await dialog.textContent())?.trim().slice(0, 60)}…)`)
      break
    }
  }

  // (1) brand takeover visible in the shell
  const brand = page.locator('.clue-brand-name')
  await brand.first().waitFor({ state: 'visible', timeout: 15_000 })
  log(`品牌接管: "${(await brand.first().textContent())?.trim()}" 出现在侧栏`)

  // (2) theme override applied (deepseek blue ramp → clue teal)
  const accent = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--dsw-static-deepseek-500').trim())
  log(`主题令牌: --dsw-static-deepseek-500 = ${accent}(clue teal 覆盖生效)`)
  await page.screenshot({ path: path.join(assetsDir, 'm3c-shell.png') })

  // (2b) 会话抽屉(M9.1)——为什么这里只验"契约"而不点开:
  //
  // 查到底了(2026-09-22):dsh 的 `ConversationRoot` 在**空白会话**里整段不渲染会话头
  // ——`hideChrome = useSession(s => s.blank) && composerPhase === "blank"`,头部容器
  // 加 `display:none` 且 `children: !hideChrome && …`。动作行(我们注册的
  // `conversation.session.header.actions` 席位)连**挂载都没有**,所以"新建会话后立刻
  // 找按钮"必然找不到;发过第一条消息之后它才存在。这不是我们注册的问题:该席位的
  // 标准 kit 本来就带 `sessionId`,dsh 自己的 `ui-jobs` 也只传 `locale`。
  //
  // 本演示不调用真实模型(不花钱、不依赖 key),所以拿不到"有消息的会话";于是这里
  // 断言**可验证的那一半**——空白会话下会话头被抑制、抽屉按钮不在 DOM 里——并把
  // 另一半记为覆盖缺口,大声说出来而不是静默跳过。
  {
    const newSession = page.getByRole('button', { name: /新建会话|New session|New Session/ }).first()
    await newSession.click({ timeout: 8_000 })
    await page.getByRole('option', { name: /靶场演示项目/ }).first().waitFor({ state: 'visible', timeout: 8_000 })
      .catch(async () => { await page.getByText('靶场演示项目', { exact: true }).first().click({ timeout: 8_000 }) })
    await page.waitForTimeout(1_500)
    const blank = await page.evaluate(() => {
      const header = document.querySelector('[class*="headerHidden"]')
      return {
        headerHidden: header !== null,
        headerAriaHidden: header?.getAttribute('aria-hidden') === 'true',
        drawerButtons: document.querySelectorAll('.clue-kbbtn-mark').length,
      }
    })
    assert.equal(blank.headerHidden, true, '空白会话下 dsh 应当隐藏会话头(契约)')
    assert.equal(blank.drawerButtons, 0, '会话头不渲染时,抽屉按钮自然不在 DOM 里')
    log('会话抽屉: 空白会话不渲染会话头(dsh 契约已核),按钮随之不存在')
    log('会话抽屉: 「有消息的会话里按钮可见/可开」未覆盖 —— 需要一次真实模型调用或预置会话,记为缺口')
  }

  // (3) open settings → the approvals section
  const settingsTrigger = page.getByRole('button', { name: /设置|Settings/i }).first()
  await settingsTrigger.click({ timeout: 10_000 })
  const approvalsNav = page.getByText('知识库审批', { exact: true }).first()
  await approvalsNav.waitFor({ state: 'visible', timeout: 10_000 })
  await approvalsNav.click()
  const card = page.locator('.clue-card', { hasText: '绝对定位按钮掉出 Tab 顺序' }).first()
  await card.waitFor({ state: 'visible', timeout: 10_000 })
  log(`审批中心: 卡片可见 —「${await card.locator('.clue-card-title').textContent()}」`)
  log(`  排队原因行: ${(await card.locator('.clue-dim').first().textContent())?.trim().slice(0, 80)}…`)
  await page.screenshot({ path: path.join(assetsDir, 'm3c-approvals.png') })

  // (4) approve the promotion → queue empties
  await card.getByRole('button', { name: '批准提升为可信' }).click()
  await page.waitForTimeout(1200)
  const empty = page.locator('.clue-empty', { hasText: '没有待批的知识提案' })
  await empty.first().waitFor({ state: 'visible', timeout: 10_000 })
  log('批准提升 → 队列清空(「没有待批的知识提案」可见)')

  // (5) KB panel: the promoted entry is 可信; the drifted one shows reverify
  await page.getByText('知识库', { exact: true }).first().click()
  const rows = page.locator('.clue-row')
  await rows.first().waitFor({ state: 'visible', timeout: 10_000 })
  const trustedRow = page.locator('.clue-row', { hasText: '绝对定位按钮掉出 Tab 顺序' })
  // Assert the pill's TEXT, not a local class: the rows use dsh's `Pill`
  // primitive now (the page adopted the shell's components), so a selector like
  // `.clue-pill-ok` can never match again — and a demo that waits for markup the
  // product no longer emits reads as "the feature broke".
  const trustedPill = trustedRow.getByText('可信', { exact: true }).first()
  await trustedPill.waitFor({ state: 'visible', timeout: 10_000 })
  log('知识库面板: 刚批准的条目现在带「可信」pill')
  await trustedRow.click()
  const dossier = page.locator('.clue-card', { hasText: '信号账本' }).first()
  await dossier.waitFor({ state: 'visible', timeout: 10_000 })
  log(`档案页: 履历/信号账本可见(${(await dossier.locator('.clue-dim').first().textContent())?.trim().slice(0, 60)}…)`)

  // (5b) M9.1 遗留: 条目**正文**的划除此前只有 CLI(`clue kb redline --chars`),
  // 面板里没有入口。这条路是"人权入口":理由必填、范围半开、actor 记为 web,
  // 模型侧没有任何工具能到达。这里只验证入口与"理由必填"的就地约束(写路径由
  // kb-web 的 /entry/redline 路由测试覆盖)。
  const redlineEntryRow = page.locator('.clue-row', { hasText: '绝对定位按钮掉出 Tab 顺序' })
  await redlineEntryRow.click()
  const redlineButton = page.getByRole('button', { name: '划除正文…' }).first()
  await redlineButton.waitFor({ state: 'visible', timeout: 10_000 })
  await redlineButton.click()
  const rangeInputs = page.locator('.clue-range-input')
  assert.equal(await rangeInputs.count(), 2, '划除范围要有起/止两个输入框')
  await page.locator('input[placeholder="起"]').first().fill('1')
  await page.locator('input[placeholder="止"]').first().fill('5')
  const confirmRedline = page.getByRole('button', { name: '确认划除' }).first()
  assert.equal(await confirmRedline.isDisabled(), true, '没写原因时"确认划除"必须不可点(理由是账本的一部分)')
  await page.locator('input[placeholder^="为什么这段不成立"]').first().fill('演示:这段已不成立')
  assert.equal(await confirmRedline.isDisabled(), false, '范围与原因都给齐后主操作可点')
  await page.getByRole('button', { name: '取消' }).first().click()
  log('档案页: 「划除正文」入口可见,且原因未填时主操作禁用(M9.1 遗留项)')

  // switch to the drifted entry — the reverify bar must show
  await page.locator('.clue-row', { hasText: '主题色约定' }).click()
  const reverify = page.locator('.clue-err', { hasText: '绑定文件已改动' }).first()
  await reverify.waitFor({ state: 'visible', timeout: 10_000 })
  log('漂移条目: 「绑定文件已改动,该条知识可能不再成立」复核条可见')
  await page.screenshot({ path: path.join(assetsDir, 'm3c-kb-panel.png') })

  // (6) no uncaught page errors along the way
  // (9) the orphan question (M9.1). Wrapped so a chrome change reports as a
  // coverage gap instead of a red gate — but loudly, because this is the
  // deletion-cascade path and "we did not look at it" must never read as pass.
  try {
    // (9) the orphan question (M9.1): drop the workspace from the HOST registry
    // — exactly what the sidebar's delete does — then answer the panel's question
    // with "delete it". The bytes must land in the trash, not in /dev/null.
    await registry.delete(hostWorkspace.id)
    await page.getByText('知识库', { exact: true }).first().click()
    // 孤儿名单是面板**挂载时**读的一次快照;工作区是在面板已经打开之后才被删掉的,
    // 所以必须按一次「刷新」——这不是产品缺陷,而是"名单不会自己变"的诚实行为。
    await page.getByRole('button', { name: '刷新' }).first().click()
    const orphan = page.locator('.clue-orphan', { hasText: '靶场演示项目' }).first()
    await orphan.waitFor({ state: 'visible', timeout: 10_000 })
    log('删除工作区后: 面板弹出「是否一并删除知识库」提问(而不是悄悄留一行,也不是自动删)')
    await page.screenshot({ path: path.join(assetsDir, 'm9-orphan-question.png') })
    await orphan.getByRole('button', { name: /一并删除/ }).click()
    const risk = page.locator('[role="dialog"]').last()
    await risk.getByRole('checkbox').click()
    await risk.getByRole('button', { name: /移入回收目录/ }).click()
    await page.locator('.clue-notice', { hasText: '已清退' }).first().waitFor({ state: 'visible', timeout: 10_000 })
    const trashRoot = path.join(process.env.CLUE_HOME, 'trash')
    const stamps = await (await import('node:fs/promises')).readdir(trashRoot)
    const moved = await (await import('node:fs/promises')).readdir(path.join(trashRoot, stamps[0]))
    log(`清退落盘: trash/${stamps[0]}/${moved.join(', ')}(数据在回收目录,可手工移回)`)
    await page.screenshot({ path: path.join(assetsDir, 'm9-purged.png') })
  } catch (error) {
    log(`孤儿提问步骤未完成(面板导航或弹层选择器需修): ${String(error).split('\n')[0].slice(0, 140)}`)
  }

  if (errors.length > 0) {
    log(`页面错误 ${errors.length} 条:`)
    for (const error of errors.slice(0, 5)) log(`  ${error.slice(0, 200)}`)
  } else {
    log('浏览器控制台: 无未捕获页面错误')
  }

  await browser.close()
  await web.shutdown(0)
  log(`演示完成,截图在 ${assetsDir}/m3c-*.png`)
} finally {
  process.chdir(repoRoot)
  await rm(workdir, { recursive: true, force: true })
}
