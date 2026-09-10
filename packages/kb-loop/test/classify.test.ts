/**
 * Change-classification tests: the §4.3 trigger rule in pure logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_RENDER_SURFACE,
  classifyChanges,
  loadRenderSurfaceConfig,
  normalizeRelative,
} from '../src/classify.ts'

test('default surface: html/css extensions and styles/ prefix are renderable', () => {
  const { renderable, other } = classifyChanges([
    'index.html',
    'pages/search.htm',
    'styles/app.css',
    'src/main.ts',
    'package.json',
    'README.md',
  ])
  assert.deepEqual(renderable, ['index.html', 'pages/search.htm', 'styles/app.css'])
  assert.deepEqual(other, ['src/main.ts', 'package.json', 'README.md'])
})

test('THE trigger rule: a pure-backend changeset yields zero renderable files', () => {
  const { renderable } = classifyChanges(['src/api/users.ts', 'src/db/schema.sql', 'tests/api.test.ts'])
  assert.equal(renderable.length, 0, '纯后端改动绝不能触发渲染验证')
})

test('windows separators and ./ prefixes normalize away', () => {
  assert.equal(normalizeRelative('.\\styles\\app.css'), 'styles/app.css')
  assert.equal(normalizeRelative('./index.html'), 'index.html')
  const { renderable } = classifyChanges(['.\\pages\\a.HTML'])
  assert.deepEqual(renderable, ['pages/a.HTML'], '扩展名匹配大小写不敏感')
})

test('project config REPLACES defaults (explicit over implicit) and fails loud when malformed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-surface-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.clue'), { recursive: true })

  // No config → defaults.
  assert.deepEqual(await loadRenderSurfaceConfig(root), DEFAULT_RENDER_SURFACE)

  // Config replaces: .jsx becomes renderable, .html no longer is.
  await writeFile(path.join(root, '.clue/render-surface.json'), JSON.stringify({ extensions: ['.jsx'], pathPrefixes: ['ui/'] }), 'utf8')
  const custom = await loadRenderSurfaceConfig(root)
  assert.deepEqual(custom.extensions, ['.jsx'])
  const { renderable } = classifyChanges(['index.html', 'ui/app.jsx'], custom)
  assert.deepEqual(renderable, ['ui/app.jsx'])

  // Dot-less extensions get dotted; malformed shapes throw.
  await writeFile(path.join(root, '.clue/render-surface.json'), JSON.stringify({ extensions: ['tsx'] }), 'utf8')
  assert.deepEqual((await loadRenderSurfaceConfig(root)).extensions, ['.tsx'])
  await writeFile(path.join(root, '.clue/render-surface.json'), '{"extensions":"nope"}', 'utf8')
  await assert.rejects(() => loadRenderSurfaceConfig(root), /格式错误/)
})
