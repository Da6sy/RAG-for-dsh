/**
 * M9 demo — the two-level retrieval story in a REAL browser (proposal §8/M9-5).
 *
 * Seeds a temp KB with a spec document ingested through the real channel,
 * mounts it on two entries, boots the real clue web composition on an
 * ephemeral port, then drives headless Chromium through the acceptance line
 * the M9-5 row names: 面板点开知识 → 看到"原文 N 段" → 在分片浏览器里定位一段 →
 * 划除它 → 该段从检索与展示两侧消失 → 把一个混合质量条目拆成 superseded。
 *
 * Run: node scripts/demo-twolevel.mjs   (needs the built ui-kb bundle and
 * playwright chromium; both are the M3a/M3c toolchain).
 *
 * @module @clue-harness/scripts/demo-twolevel
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const assetsDir = path.join(repoRoot, 'docs', 'assets')

if (!existsSync(path.join(repoRoot, 'plugins/ui-kb/lib/client.js'))) {
  console.error('demo-twolevel: 先跑 `npm run build:ui` 构建浏览器 bundle')
  process.exit(2)
}

const log = (...parts) => console.log('[m9]', ...parts)

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-demo-m9-'))
const project = path.join(workdir, 'proj')
await mkdir(project, { recursive: true })
process.chdir(project)
process.env.CLUE_HOST_HOME = path.join(workdir, 'dsh-home')
process.env.DSH_HOME = path.join(workdir, 'dsh-home')
process.env.CLUE_HOME = path.join(workdir, 'clue-home')

let web
try {
  // ── seed: a spec document + two knowledge entries mounted on it ─────────
  const { openProjectStore } = await import('@clue-harness/kb')
  const { ingestFile, queryChunks } = await import('@clue-harness/rag')
  const store = await openProjectStore(project, process.env.CLUE_HOME)

  const spec = [
    '# 前端组件规范',
    '',
    '## 按钮',
    '',
    '按钮必须可被 Tab 选中,禁用态使用 aria-disabled 而不是 disabled 属性。',
    '',
    '## 表单',
    '',
    '表单提交按钮必须位于 form 元素内部,提交后通过 aria-live 区域播报结果。',
    '',
    '## 抽屉',
    '',
    '抽屉打开时焦点必须移入抽屉内部,关闭时焦点回到触发按钮。',
    '',
  ].join('\n')
  const specFile = path.join(project, 'spec.md')
  await writeFile(specFile, spec, 'utf8')
  const report = await ingestFile({ store, file: specFile })
  const docId = String(report.doc?.docId)
  log(`种子: ingest ${report.sourcePath} → ${docId}(${report.chunks.length} 段, chunker ${report.chunkerVersion})`)
  for (const chunk of report.chunks) {
    log(`  段${chunk.seq} 行 ${chunk.lines.start}-${chunk.lines.end} · ${chunk.headingPath || '(无标题)'}`)
  }

  const drawer = await store.add({
    kind: 'decision',
    title: '抽屉焦点管理',
    text: '抽屉打开时焦点移入内部,关闭时焦点回到触发按钮;这是目前唯一的焦点约定。',
    tags: ['可访问性', '抽屉'],
    createdBy: 'cli:demo',
  })
  await store.attachDoc(drawer.id, docId, { lines: [15, 15], quoteAnchor: '抽屉打开时焦点必须移入抽屉内部' })

  const buttons = await store.add({
    kind: 'pitfall',
    title: '按钮交互坑(一半已过时)',
    text: '按钮要可 Tab;旧的绝对定位方案 sunset-legacy 会让按钮掉出 Tab 顺序,该方案已废弃。',
    tags: ['按钮'],
    createdBy: 'cli:demo',
  })
  await store.attachDoc(buttons.id, docId, { lines: [5, 5], quoteAnchor: '按钮必须可被 Tab 选中' })
  log(`种子: 2 条知识挂载原文(${drawer.id}, ${buttons.id})`)

  // A third entry whose BOUND FILE changes after ingest: the orthogonal ⚑ flag
  // is what the approval workbench's 待复核 bucket resolves.
  const focusFile = path.join(project, 'focus.md')
  await writeFile(focusFile, '抽屉焦点: 打开时焦点移入抽屉内部。\n', 'utf8')
  const drifted = await store.add({
    kind: 'fact',
    title: '绑定会漂移的一条',
    text: '抽屉焦点约定写在本文件里;文件变了就该复核这条是否还成立。',
    bindings: ['focus.md'],
    createdBy: 'cli:demo',
  })
  await writeFile(focusFile, '抽屉焦点: 打开时焦点移入抽屉内部,关闭回到触发按钮。\n', 'utf8')
  await store.checkBindings(drifted.id)
  if ((await store.get(drifted.id))?.needsReview !== true) throw new Error('种子自检失败: 绑定漂移应当挂上 ⚑')
  log(`种子: 1 条挂 ⚑待复核(绑定文件 focus.md 已变: ${drifted.id})`)

  // The redline the demo will perform in the UI must have a real effect on the
  // second level, so prove the pre-state here: "表单" is retrievable.
  const before = await queryChunks({ store, docId }, { query: '播报结果' })
  if (before.length === 0) throw new Error('种子自检失败: 划除前应当能检索到表单段')
  log(`种子自检: 划除前 queryChunks("播报结果") 命中 ${before.length} 段(${before[0].lines.start}-${before[0].lines.end})`)

  // ── boot the real web surface (ephemeral port) ──────────────────────────
  const { runWeb } = await import('../apps/cli/src/web.ts')
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  web = await runWeb({
    environment: loadLayeredEnv('clue'),
    port: 0,
    args: ['--no-open'],
    manageSignals: false,
  })
  log(`boot 完成: ${web.url}`)

  const registry = web.ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('演示需要宿主 workspaceRegistry 服务(组合被破坏了?)')
  await registry.create(project, '两级检索靶场')
  log('宿主工作区已创建: 两级检索靶场')

  // ── drive a real browser ────────────────────────────────────────────────
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(web.url, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500)

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
        await page.waitForTimeout(600)
        clicked = true
        break
      }
    }
    if (!clicked) break
  }

  // (1) open settings → 知识库, pick the demo workspace
  const settingsTrigger = page.getByRole('button', { name: /设置|Settings/i }).first()
  await settingsTrigger.click({ timeout: 10_000 })
  const kbNav = page.getByText('知识库', { exact: true }).first()
  await kbNav.waitFor({ state: 'visible', timeout: 10_000 })
  await kbNav.click()
  await page.waitForTimeout(1500)
  // (2) open the entry that carries the原文 — the dossier must show the
  //     "原文层" badge and the chunk browser.
  // The dossier rows are addressed by CSS class + text: the shell renders the
  // panel inside its settings surface, so the panel's OWN selectors stay valid.
  const row = page.locator('.clue-row', { hasText: '抽屉焦点管理' }).first()
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  log('面板: 条目行可见')
  await row.click()
  await page.waitForTimeout(1200)
  // V1-UI: the badges are dsh's own Pill primitive now (its class is generated,
  // so select by the class-name FRAGMENT the primitive ships).
  const PILL = '[class*="_pill_"]'
  const badge = page.locator(PILL, { hasText: '原文层' }).first()
  await badge.waitFor({ state: 'visible', timeout: 10_000 })
  const browserBlock = page.locator('.clue-docblock').first()
  await browserBlock.waitFor({ state: 'visible', timeout: 10_000 })
  const chunkCount = await browserBlock.locator(PILL).first().textContent()
  log(`面板: 徽章可见 —「${chunkCount?.trim()}」`)
  const anchors = await browserBlock.locator('.clue-chunk-head .clue-mono').allTextContents()
  log(`分片浏览器: ${anchors.length} 个段锚点,首段 —「${anchors[0]?.trim()}」`)
  await page.screenshot({ path: path.join(assetsDir, 'm9-chunk-browser.png') })

  // (3) search inside the原文 for a phrase, then REDLINE that段 (the human act)
  const search = browserBlock.locator('input').first()
  await search.fill('播报结果')
  await search.press('Enter')
  await page.waitForTimeout(1200)
  const hit = page.locator('.clue-chunk', { hasText: 'aria-live' }).first()
  await hit.waitFor({ state: 'visible', timeout: 10_000 })
  log('查段: 「播报结果」命中到含 aria-live 的那一段')

  const reasonInput = browserBlock.locator('input[placeholder*="划除原因"]').first()
  await reasonInput.fill('表单规范已改版为 ds-form v2')
  await hit.getByRole('button', { name: '划除本段' }).click()
  await page.waitForTimeout(1500)
  log('划除: 已提交(原因进账本)')

  // The段 must be GONE from the second level: querying again returns nothing.
  const afterText = (await page.locator('.clue-docblock').first().textContent()) ?? ''
  if (afterText.includes('aria-live')) throw new Error('划除后该段仍在面板结果里出现')
  log('划除生效: 面板重查「播报结果」已无该段(显示侧过滤)')
  await search.fill('播报结果')
  await search.press('Enter')
  await page.waitForTimeout(1200)
  const emptyHits = await page.locator('.clue-docblock .clue-empty').count()
  if (emptyHits === 0) throw new Error('划除后查询仍返回了段')
  log('划除生效: 重查返回「没有命中的段」')
  await page.screenshot({ path: path.join(assetsDir, 'm9-redline.png') })

  // (4) the split: the mixed-quality entry becomes superseded
  const pitfallRow = page.locator('.clue-row', { hasText: '按钮交互坑' }).first()
  await pitfallRow.click()
  await page.waitForTimeout(800)
  const splitButton = page.getByRole('button', { name: /拆分该条目/ }).first()
  await splitButton.click()
  await page.locator('input[placeholder="新条目标题"]').first().fill('按钮要可 Tab(现行)')
  await page.locator('input[placeholder="新条目正文"]').first().fill('按钮必须可被 Tab 选中;绝对定位方案已废弃,不要再引用。')
  page.once('dialog', dialog => { void dialog.accept() })
  await page.getByRole('button', { name: '确认拆分' }).first().click()
  await page.waitForTimeout(1800)
  const supersededPill = page.locator(PILL, { hasText: '已拆分替代' }).first()
  await supersededPill.waitFor({ state: 'visible', timeout: 10_000 })
  log('拆分生效: 原条目现在显示「已拆分替代」pill(superseded 终态)')
  await page.screenshot({ path: path.join(assetsDir, 'm9-split.png') })

  // (5) the promote: a candidate becomes trusted by HUMAN judgment alone —
  //     the entry point the score-driven approval queue cannot provide.
  const candidateRow = page.locator('.clue-row', { hasText: '抽屉焦点管理' }).first()
  await candidateRow.click()
  await page.waitForTimeout(1000)
  const promoteReason = page.locator('input[placeholder*="为什么提升为可信"]').first()
  await promoteReason.waitFor({ state: 'visible', timeout: 10_000 })
  log('提升: 候选条目显示「提升为可信」人权入口')
  await promoteReason.fill('演示: 人已核对过这条焦点约定')
  await page.getByRole('button', { name: '提升为可信', exact: true }).first().click()
  await page.waitForTimeout(1500)
  if (await page.getByRole('button', { name: '提升为可信', exact: true }).count() !== 0) {
    throw new Error('提升后按钮仍在(说明状态没变成 trusted)')
  }
  const trustedPill = page.locator(`.clue-card ${PILL}`, { hasText: '可信' }).first()
  await trustedPill.waitFor({ state: 'visible', timeout: 10_000 })
  const dossier = (await page.locator('.clue-card').first().textContent()) ?? ''
  if (!dossier.includes('人工提升为可信(web)')) throw new Error('提升后履历里没有记下人操作的入口')
  log(`提升生效: 候选 →「${(await trustedPill.textContent())?.trim()}」,履历记下 web 入口与理由`)
  await page.screenshot({ path: path.join(assetsDir, 'm9-promote.png') })

  // (6) the approval workbench: 待复核 + 候选 buckets do their rows' work here
  const approvalsNav = page.getByText('知识库审批', { exact: true }).first()
  await approvalsNav.waitFor({ state: 'visible', timeout: 10_000 })
  await approvalsNav.click()
  await page.waitForTimeout(1800)
  const reviewTab = page.getByRole('button', { name: /待复核 \d+/ }).first()
  await reviewTab.waitFor({ state: 'visible', timeout: 15_000 })
  log(`工作台: 桶计数 —「${(await reviewTab.textContent())?.trim()}」/${(await page.getByRole('button', { name: /候选待提升 \d+/ }).first().textContent())?.trim()}`)

  // The workbench opens on 待批 (the queue); the buckets are tabs, so switch
  // to the one under test before looking for its rows.
  await reviewTab.click()
  await page.waitForTimeout(1200)
  const reviewRow = page.locator('.clue-card', { hasText: '绑定会漂移的一条' }).first()
  await reviewRow.waitFor({ state: 'visible', timeout: 10_000 })
  await reviewRow.getByRole('button', { name: '复核通过(重绑当前内容)' }).click()
  await page.waitForTimeout(1600)
  if (await page.locator('.clue-card', { hasText: '绑定会漂移的一条' }).count() !== 0) {
    throw new Error('复核通过后该条仍留在待复核桶里')
  }
  log('工作台 待复核: 复核通过(重绑当前内容)→ 该条离开 ⚑ 桶')

  const promoteTab = page.getByRole('button', { name: /候选待提升 \d+/ }).first()
  await promoteTab.click()
  await page.waitForTimeout(1200)
  const successorRow = page.locator('.clue-card', { hasText: '按钮要可 Tab(现行)' }).first()
  await successorRow.waitFor({ state: 'visible', timeout: 10_000 })
  await successorRow.getByRole('button', { name: '提升为可信' }).click()
  const confirm = page.getByRole('button', { name: '确认提升' }).first()
  await confirm.waitFor({ state: 'visible', timeout: 10_000 })
  // The verdict form needs its why only for retire; promote accepts an empty one.
  await page.locator('input[placeholder*="为什么提升为可信"]').first().fill('演示: 拆分出来的这条已核对')
  await confirm.click()
  await page.waitForTimeout(1600)
  if (await page.locator('.clue-card', { hasText: '按钮要可 Tab(现行)' }).count() !== 0) {
    throw new Error('提升后该条仍留在候选桶里')
  }
  log('工作台 候选: 提升为可信 → 该条离开候选桶(拆分后继在同一个界面里完成治理)')
  await page.screenshot({ path: path.join(assetsDir, 'm9-approval-workbench.png') })

  if (errors.length > 0) throw new Error(`浏览器报错: ${errors.slice(0, 3).join(' | ')}`)
  log('浏览器无 pageerror')
  log('M9-5 演示通过: 徽章 → 分片浏览器 → 划除(显示+检索双过滤) → 拆分(superseded) → 提升为可信 → 审批工作台(待复核/候选)')
  await browser.close()
} finally {
  // `runWeb` hands back { ctx, port, url, shutdown, done } — there is no
  // `close` (the M9 leftover this line used to call), so the old
  // `web.close?.().catch(...)` threw a TypeError in cleanup and masked the
  // real outcome while leaving the temp dir behind.
  if (web !== undefined) await web.shutdown()
  await rm(workdir, { recursive: true, force: true })
}
