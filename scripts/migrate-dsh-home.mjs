/**
 * One-shot migration: dsh's shared host home → the ClueHarness host home.
 *
 * ClueHarness web/CLI now default `DSH_HOME` to `~/.clue/host` (the host
 * half of the clue home): profiles, settings, credentials, storages, and
 * future sessions all live there, independent of a co-installed dsh.
 * This script copies what the user's existing `~/.dsh` holds INTO the new
 * home — everything EXCEPT `sessions/` (the user's decision: old dsh
 * conversations stay with dsh; clue web starts its own session history) —
 * so settings and credentials carry over without sharing the directory.
 *
 * Skipped by design:
 * - `sessions/`            — explicitly excluded (user decision);
 * - any `node_modules/`    — the healed profile farm is regenerated at every
 *   boot by healProfilesModuleFallback from THIS installation's closure;
 *   copying dsh-installed symlinks would carry stale/global targets.
 *
 * ~/.dsh is never modified or deleted — the running dsh keeps working.
 * Re-running is safe (overwrite copy). Usage: node scripts/migrate-dsh-home.mjs [--dry-run]
 *
 * @module @clue-harness/scripts/migrate-dsh-home
 */
import { chmod, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const { clueHostHome } = await import('../packages/util/src/index.ts')

const source = path.join(homedir(), '.dsh')
const target = clueHostHome()
const dryRun = process.argv.includes('--dry-run')
const skipNames = new Set(['sessions'])

const log = (...parts) => console.log('[migrate]', ...parts)

/**
 * Whether a path (relative to the source home) survives the filter.
 * @param {string} relative - POSIX-relative path inside the source home.
 * @returns {boolean} true when the entry should be copied.
 */
function keep(relative) {
  const segments = relative.split('/')
  if (segments.some((s) => s === 'node_modules')) return false
  if (segments.some((s) => skipNames.has(s))) return false
  return true
}

/**
 * One-level audit of the source home for the summary.
 * @param {string} dir - absolute directory.
 * @param {string} [prefix] - relative label prefix.
 * @returns {Promise<Map<string,string>>} leaf path → kind for everything kept.
 */
async function audit(dir, prefix = '') {
  const out = new Map()
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (!keep(rel)) continue
    if (entry.isDirectory()) {
      for (const [k, v] of await audit(path.join(dir, entry.name), rel)) out.set(k, v)
    } else if (entry.isFile()) {
      out.set(rel, 'file')
    } else if (entry.isSymbolicLink()) {
      out.set(rel, 'link')
    }
  }
  return out
}

log(`源: ${source}`)
log(`目标: ${target}${dryRun ? '  [--dry-run]' : ''}`)
if ((await stat(source).catch(() => null)) === null) {
  log('源目录不存在 — 无需迁移')
  process.exit(0)
}

const plan = await audit(source)
const files = [...plan].filter(([, kind]) => kind === 'file')
const skipped = (await readdir(source).catch(() => [])).filter((name) => !keep(name))
log(`迁移 ${files.length} 个文件(跳过顶层: ${skipped.join(', ') || '无'})`)
for (const [rel] of files.slice(0, 40)) log(`  · ${rel}`)
if (files.length > 40) log(`  … 其余 ${files.length - 40} 个`)

if (dryRun) {
  log('dry-run 结束,未写入')
  process.exit(0)
}

await mkdir(target, { recursive: true, mode: 0o700 })
// cp with a filter sees ABSOLUTE src paths; translate back to relative so the
// keep() rules apply uniformly, and never follow links.
const srcPrefix = source + path.sep
await cp(source, target, {
  recursive: true,
  force: true,
  errorOnExist: false,
  verbatimSymlinks: true,
  filter: (src) => {
    const rel = path.relative(srcPrefix, src)
    return rel === '' || keep(rel.split(path.sep).join('/'))
  },
})

// Credential hygiene like dsh's own store: owner-only files.
await chmod(path.join(target, '.credentials.yaml'), 0o600).catch(() => {})
await chmod(path.join(target, 'settings.yaml'), 0o600).catch(() => {})
await chmod(target, 0o700).catch(() => {})

log('完成。新宿主目录:', target)
log('注意: sessions/ 未迁移 — clue web 将拥有全新的会话历史(旧 dsh 会话留在', path.join(source, 'sessions'), ')')
process.exit(0)
