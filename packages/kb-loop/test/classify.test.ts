/**
 * Change-classification tests: the §4.3 trigger rule in pure logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_RENDER_SURFACE,
  classifyChanges,
  loadRenderSurfaceConfig,
  normalizeRelative,
} from '../src/classify.ts'
import { openProjectStore, registerWorkspace } from '@clue-harness/kb'

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

test('the workspace record REPLACES defaults (explicit over implicit) and fails loud when malformed', async (t) => {
  // M9: the surface is per-workspace SETTINGS inside the roster, not a file
  // written into the user's project directory.
  const { setRenderSurface } = await import('@clue-harness/kb')
  const root = await mkdtemp(path.join(tmpdir(), 'clue-surface-'))
  const home = path.join(root, 'home')
  const proj = path.join(root, 'proj')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(proj, { recursive: true })
  await openProjectStore(proj, home) // registers the workspace

  // No config → defaults.
  assert.deepEqual(await loadRenderSurfaceConfig(proj, home), DEFAULT_RENDER_SURFACE)

  // Config replaces: .jsx becomes renderable, .html no longer is.
  const record = await registerWorkspace(proj, { home })
  await setRenderSurface(record.key, { extensions: ['.jsx'], pathPrefixes: ['ui/'] }, home)
  const custom = await loadRenderSurfaceConfig(proj, home)
  assert.deepEqual(custom.extensions, ['.jsx'])
  const { renderable } = classifyChanges(['index.html', 'ui/app.jsx'], custom)
  assert.deepEqual(renderable, ['ui/app.jsx'])

  // Dot-less extensions get dotted; malformed shapes throw.
  await setRenderSurface(record.key, { extensions: ['tsx'] }, home)
  assert.deepEqual((await loadRenderSurfaceConfig(proj, home)).extensions, ['.tsx'])
  const doc = JSON.parse(await readFile(path.join(home, 'workspaces.json'), 'utf8'))
  doc.workspaces[0].renderSurface = { extensions: 'nope' }
  await writeFile(path.join(home, 'workspaces.json'), JSON.stringify(doc), 'utf8')
  await assert.rejects(() => loadRenderSurfaceConfig(proj, home), /render surface config malformed/)

  // Clearing the override falls back to the shipped defaults.
  await setRenderSurface(record.key, null, home)
  assert.deepEqual(await loadRenderSurfaceConfig(proj, home), DEFAULT_RENDER_SURFACE)
})
