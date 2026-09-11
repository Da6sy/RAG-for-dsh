/**
 * The workspace SYNC (M9.1): the host's workspace registry is the roster.
 *
 * Why this file exists — the real accident it fixes: ClueHarness kept its own
 * list of "workspaces", seeded from every directory the CLI had ever opened.
 * The settings panel therefore showed a workspace the user's sidebar never
 * had, and a workspace they had deleted in dsh/ClueHarness's own web surface
 * kept a row forever. Two lists, two truths — the exact shape of the M8
 * panel-vs-session bug, one level up.
 *
 * The rule now: **the host `workspaceRegistry` is the only thing that decides
 * which workspaces the panel shows.** `<home>/workspaces.json` is demoted to a
 * per-workspace SIDE TABLE (the KB key, the display title mirrored from the
 * registry, the render-surface setting, the orphan state). Rows that exist
 * only because a CLI touched the path are still there (their knowledge is
 * real) but the panel hides them, and the CLI reports them.
 *
 * Deletion is where the product has to earn trust. The registry deletes a
 * workspace registration while keeping the directory and every session log —
 * and it emits NO event, so the observation is a diff over `list()` (which is
 * synchronous and performs no IO, so the diff is near-free). A disappeared
 * workspace becomes an ORPHAN question, never an automatic action:
 *
 *   live      → in the registry, panel shows it
 *   orphaned  → registry dropped it; the panel asks "delete its KB too?"
 *   purged    → answered yes: `<home>/trash/<ts>/<key>/` holds everything
 *               (the tier, the baselines, the settings) — reversible by hand
 *   kept      → answered no: hidden from the panel, data untouched, and the
 *               question is NOT asked again (until the path returns, which
 *               re-activates the row automatically)
 *
 * The kb package owns the side table; the registry rows are PUSHED IN as
 * plain data, which is what keeps this engine dsh-free.
 *
 * @module @clue-harness/kb/workspace-sync
 */
import path from 'node:path'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { atomicWriteJson, canonicalRoot, clueHome, readJsonOrNull, workspaceKey } from '@clue-harness/util'
import {
  WORKSPACES_REGISTRY_VERSION,
  readWorkspaces,
  registerWorkspace,
  writeWorkspaces,
  type WorkspaceRecord,
} from './workspaces.ts'

/** The addressed key is not in the side table at all (a 404-shaped fact). */
export class WorkspaceUnknownError extends Error {
  /** @param key - the addressed workspace key. */
  constructor(key: string) {
    super(`工作区未登记: ${key}`)
    this.name = 'WorkspaceUnknownError'
  }
}

/** The row exists but is not awaiting an answer (a 400-shaped fact). */
export class WorkspaceNotPurgeableError extends Error {
  /**
   * @param key - the addressed workspace key.
   * @param state - the state it is actually in.
   */
  constructor(key: string, state: string) {
    super(`只能清退已从工作区列表移除的知识库(${key} 当前 ${state})`)
    this.name = 'WorkspaceNotPurgeableError'
  }
}

/** One row of the host's workspace registry, as plain data. */
export interface HostWorkspaceRow {
  /** The host's stable workspace id. */
  id: string
  /** The workspace directory (any spelling; canonicalized here). */
  path: string
  /** The host's display title (the sidebar's name). */
  title: string
}

/** The outcome of one sync pass — the caller's report and the UI's cue. */
export interface WorkspaceSyncReport {
  /** Rows created or refreshed from the registry. */
  live: WorkspaceRecord[]
  /** Rows that just became orphans (the panel must ask about them). */
  newlyOrphaned: Array<{ key: string; root: string; title: string }>
  /** Rows that came back (a re-created workspace re-activates its history). */
  revived: string[]
  /** Rows kept solely by CLI use — present in the home, hidden from the panel. */
  cliOnly: number
}

/**
 * Reconcile the side table with the host registry. Called on every host-plane
 * read of the roster (cheap: `list()` is in-memory, the table is one file), so
 * "added a workspace but never opened a session in it" is visible immediately
 * — the row is created at sync time, with an empty central tier.
 * @param rows - the registry's current workspaces, in display order.
 * @param home - ClueHarness home override.
 * @returns what the panel needs to render (including any new orphan question).
 */
export async function syncWorkspaces(
  rows: readonly HostWorkspaceRow[],
  home: string = clueHome(),
): Promise<WorkspaceSyncReport> {
  const now = new Date().toISOString()
  const records = await readWorkspaces(home)
  const byRoot = new Map(records.map((row) => [row.root, row]))
  const newlyOrphaned: WorkspaceSyncReport['newlyOrphaned'] = []
  const revived: string[] = []
  const live: WorkspaceRecord[] = []
  const seen = new Set<string>()

  for (const host of rows) {
    const root = canonicalRoot(host.path)
    if (seen.has(root)) continue
    seen.add(root)
    let record = byRoot.get(root)
    if (record === undefined) {
      record = await registerWorkspace(root, { home, source: 'registry', at: now, hostId: host.id, title: host.title })
    } else {
      const changed = record.hostTitle !== host.title || record.hostId !== host.id
        || record.state !== 'live' || record.origin !== 'registry'
      if (changed) {
        if (record.state !== 'live' && record.state !== undefined) revived.push(record.key)
        record = {
          ...record,
          origin: 'registry',
          state: 'live',
          hostId: host.id,
          hostTitle: host.title,
          label: host.title,
          lastSeenAt: now,
        }
      } else {
        record = { ...record, lastSeenAt: now }
      }
    }
    live.push(record)
  }

  // Registry-dropped rows: only REGISTRY-origin rows become orphans (a CLI-only
  // path was never in the registry, so its absence proves nothing).
  //
  // The new rows start the list — building `next` from the OLD records alone
  // silently dropped every workspace registered in this pass (the bug this
  // comment exists to keep impossible).
  const next: WorkspaceRecord[] = [...live]
  for (const record of records) {
    if (live.some((row) => row.key === record.key)) continue
    if (record.origin === 'registry' && record.state !== 'orphaned' && record.state !== 'kept') {
      next.push({
        ...record,
        state: 'orphaned',
        orphanedAt: now,
        orphanReason: `工作区「${record.hostTitle ?? record.label}」已从工作区列表移除`,
      })
      newlyOrphaned.push({ key: record.key, root: record.root, title: record.hostTitle ?? record.label })
      continue
    }
    next.push(record)
  }

  await writeWorkspaces(next, home)
  return {
    live,
    newlyOrphaned,
    revived,
    cliOnly: next.filter((row) => row.origin !== 'registry' || row.state === 'kept').length,
  }
}

/**
 * The rows the settings panel may show: live registry workspaces plus orphans
 * awaiting an answer. CLI-only and "kept" rows stay out of this list (they are
 * still real data, still on disk, still reported by the CLI).
 * @param home - ClueHarness home override.
 * @returns records in registry order, orphans last.
 */
export async function panelWorkspaces(home: string = clueHome()): Promise<WorkspaceRecord[]> {
  const records = await readWorkspaces(home)
  const live = records.filter((row) => row.origin === 'registry' && row.state === 'live')
  const orphans = records.filter((row) => row.state === 'orphaned')
  return [...live, ...orphans]
}

/** Where one purged workspace's bytes land: `<home>/trash/<stamp>/<key>`. */
export function trashDirFor(key: string, stamp: string, home: string = clueHome()): string {
  return path.join(home, 'trash', stamp.replace(/[:.]/g, '-'), key)
}

/** One purged piece (the report the user reads before approving again). */
export interface PurgedPiece {
  kind: 'kb' | 'baselines'
  from: string
  to: string
}

/**
 * Answer the orphan question with "delete it": move the workspace's ENTIRE
 * central state — the knowledge tier and the render baselines — into
 * `<home>/trash/<timestamp>/<key>/`, then mark the row purged-and-hidden.
 *
 * Trash, not rm: this is the one destructive verb in the product, and the
 * design's own rule ("a misclick cannot kill knowledge") has to hold here too.
 * The stamp keeps parallel purges from colliding, and the directory is plain
 * enough to move back by hand.
 * @param key - the workspace key.
 * @param home - ClueHarness home override.
 * @returns where the bytes went (absent kinds were never created).
 * @throws when the row is unknown or is not an orphan awaiting an answer.
 */
export async function purgeWorkspace(
  key: string,
  home: string = clueHome(),
): Promise<{ moved: PurgedPiece[]; trashRoot: string }> {
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === key)
  if (index === -1) throw new WorkspaceUnknownError(key)
  const record = records[index]
  if (record.state !== 'orphaned') throw new WorkspaceNotPurgeableError(key, record.state ?? 'live')
  const stamp = new Date().toISOString()
  const target = trashDirFor(key, stamp, home)
  const moved: PurgedPiece[] = []

  const kbFrom = path.join(home, 'kb', key)
  const baselinesFrom = path.join(home, 'baselines', key)
  for (const [kind, from] of [['kb', kbFrom], ['baselines', baselinesFrom]] as const) {
    if ((await readdir(from).catch(() => null)) === null) continue
    const to = path.join(target, kind)
    await mkdir(path.dirname(to), { recursive: true })
    await rename(from, to)
    moved.push({ kind, from, to })
  }
  if (moved.length === 0) await mkdir(target, { recursive: true })

  records[index] = {
    ...record,
    state: 'kept',
    purgedAt: stamp,
    orphanReason: `已清退至回收目录: ${target}`,
  }
  await writeWorkspaces(records, home)
  return { moved, trashRoot: target }
}

/**
 * Answer the orphan question with "keep it": the row stops asking and leaves
 * the panel; nothing on disk changes. Re-opening that directory as a workspace
 * revives the row (see {@link syncWorkspaces}).
 * @param key - the workspace key.
 * @param home - ClueHarness home override.
 * @returns the updated record.
 * @throws when the row is unknown.
 */
export async function keepWorkspace(key: string, home: string = clueHome()): Promise<WorkspaceRecord> {
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === key)
  if (index === -1) throw new WorkspaceUnknownError(key)
  records[index] = { ...records[index], state: 'kept' }
  await writeWorkspaces(records, home)
  return records[index]
}

/**
 * Purge every orphan row in one go (the panel's "全清退"): same trash discipline,
 * one timestamp shared so a batch is restorable as a unit.
 * @param home - ClueHarness home override.
 * @returns what moved.
 */
export async function purgeAllOrphans(
  home: string = clueHome(),
): Promise<{ trashRoot: string; keys: string[]; moved: PurgedPiece[] }> {
  const stamp = new Date().toISOString()
  const records = await readWorkspaces(home)
  const orphans = records.filter((row) => row.state === 'orphaned')
  const moved: PurgedPiece[] = []
  const keys: string[] = []
  let trashRoot = path.join(home, 'trash', stamp.replace(/[:.]/g, '-'))
  for (const record of orphans) {
    const target = trashDirFor(record.key, stamp, home)
    trashRoot = path.dirname(target)
    for (const [kind, from] of [['kb', path.join(home, 'kb', record.key)], ['baselines', path.join(home, 'baselines', record.key)]] as const) {
      if ((await readdir(from).catch(() => null)) === null) continue
      const to = path.join(target, kind)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
      moved.push({ kind, from, to })
    }
    keys.push(record.key)
  }
  if (keys.length === 0) return { trashRoot, keys, moved }
  await writeWorkspaces(records.map((row) => keys.includes(row.key)
    ? { ...row, state: 'kept' as const, purgedAt: stamp, orphanReason: `已清退至回收目录: ${trashDirFor(row.key, stamp, home)}` }
    : row), home)
  return { trashRoot, keys, moved }
}

/**
 * List the trash: what a purge kept recoverable, and from where.
 * @param home - ClueHarness home override.
 * @returns one entry per purged workspace (path + size in files).
 */
export async function listTrash(
  home: string = clueHome(),
): Promise<Array<{ stamp: string; key: string; dir: string; kinds: string[] }>> {
  const root = path.join(home, 'trash')
  const stamps = await readdir(root).catch(() => [] as string[])
  const out: Array<{ stamp: string; key: string; dir: string; kinds: string[] }> = []
  for (const stamp of stamps.sort()) {
    const keys = await readdir(path.join(root, stamp)).catch(() => [] as string[])
    for (const key of keys.sort()) {
      const dir = path.join(root, stamp, key)
      out.push({ stamp, key, dir, kinds: await readdir(dir).catch(() => [] as string[]) })
    }
  }
  return out
}

/** The side-table document shape the CLI prints when asked for the truth. */
export async function readSideTable(home: string = clueHome()): Promise<WorkspaceRecord[]> {
  return readWorkspaces(home)
}

/** Where the side table lives (exported for the CLI's footer). */
export function sideTableFile(home: string = clueHome()): string {
  return path.join(home, 'workspaces.json')
}

/** Drop the file when a test wants the pre-state (internal helper, unused at runtime). */
export async function resetSideTable(home: string = clueHome()): Promise<void> {
  await rm(sideTableFile(home), { force: true })
}

export { WORKSPACES_REGISTRY_VERSION, atomicWriteJson, readJsonOrNull, workspaceKey }
