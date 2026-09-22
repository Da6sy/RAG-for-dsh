/**
 * The workspace registry (M9: 集中式存储 + 自建工作区名单).
 *
 * Layout it describes — everything ClueHarness keeps, all of it under the
 * clue home, nothing inside the workspace:
 *
 *   <home>/workspaces.json          this registry (the 名单)
 *   <home>/kb/<key>/                one workspace's project tier
 *   <home>/baselines/<key>/         one workspace's render baselines
 *   <home>/kb/_global/              the global tier
 *   <home>/sessions/{cli,web}/      session logs of each surface
 *   <home>/host/                    the dsh host home `clue` boots into
 *
 * Why a registry at all, now that the key is derivable from the path: the
 * USER's list. Retrieval and the gate resolve a store from whatever cwd a
 * session carries, but the settings panel must show "the workspaces that
 * exist" — including ones that were renamed to a friendlier label, added by
 * hand, or whose directory is currently unmounted. So the registry is the
 * roster + labels + per-workspace settings; the path→key derivation stays the
 * single source of truth for WHICH directory a root's data lives in (the two
 * never disagree because `key` here is exactly that derivation's result).
 *
 * ClueHarness owns this list: it is NOT read from dsh's workspace service.
 * A path is the only input taken from the outside (a session cwd, a CLI
 * argument, a typed directory) — the label, the key, the settings and the
 * lifetime are all clue's own.
 *
 * @module @clue-harness/kb/workspaces
 */
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { atomicWriteJson, canonicalRoot, clueHome, readJsonOrNull, workspaceKey } from '@clue-harness/util'

/** Registry document version; refuse-on-mismatch, never migrate (house style). */
export const WORKSPACES_REGISTRY_VERSION = 1

/**
 * How a workspace entered the side table. M9.1: `registry` is the only origin
 * the settings panel shows — it means "the host has this workspace right now".
 * `auto`/`migrate` come from a CLI touching a path, `manual` from `clue kb
 * workspace add`. Those rows are real data but NOT panel rows: the host's
 * workspace registry owns visibility (see `workspace-sync.ts`).
 */
export type WorkspaceSource = 'registry' | 'auto' | 'manual' | 'migrate'

/**
 * Orphan lifecycle (M9.1): `live` = in the registry; `orphaned` = the registry
 * dropped it and the panel must ask whether to delete its knowledge base;
 * `kept` = answered "keep" (hidden, data intact) — also the state a purged row
 * lands in, distinguished by `purgedAt`. Absent reads as `live` (rows written
 * before this field existed were all live).
 */
export type WorkspaceState = 'live' | 'orphaned' | 'kept'

/**
 * The per-workspace render-surface override (M9: the old
 * `<root>/.clue/render-surface.json` file moved INTO the record, so a
 * workspace directory stays free of ClueHarness state). Arrays REPLACE the
 * defaults — explicit over implicit, unchanged from M3a.
 */
export interface RenderSurfaceSettings {
  /** Absent = keep the shipped extension defaults. */
  extensions?: string[]
  /** Absent = keep the shipped prefix defaults. */
  pathPrefixes?: string[]
}

/** One registered workspace. */
export interface WorkspaceRecord {
  /** The central key (`encodeSegment(root)`, `-N` on anchor collision). */
  key: string
  /** Canonical (realpath'd) absolute root — the anchor the key was derived from. */
  root: string
  /** Human label shown in the panel; defaults to the directory's basename. */
  label: string
  /** Which clue surface first saw it: the host registry, a CLI open, or a hand add. */
  source: WorkspaceSource
  /** The origin of the CURRENT row (source only records the first sighting). */
  origin?: WorkspaceSource
  /** Orphan lifecycle; absent = live. */
  state?: WorkspaceState
  addedAt: string
  lastSeenAt: string
  /** The host's workspace id (registry rows only). */
  hostId?: string
  /** The host's display title — the sidebar's name, mirrored, never invented. */
  hostTitle?: string
  /** When the registry dropped this workspace (the question's age). */
  orphanedAt?: string
  /** Audit text for the orphan/keep/purge decision. */
  orphanReason?: string
  /** Set when the orphan question was answered with a purge (bytes in trash). */
  purgedAt?: string
  /** Absent = use the shipped defaults. */
  renderSurface?: RenderSurfaceSettings
}

/** Whether a row is a live panel row (absent state/origin read as live/registry-neutral). */
export function isLiveRow(row: WorkspaceRecord): boolean {
  return (row.state ?? 'live') === 'live'
}

/** The registry document. */
export interface WorkspaceRegistry {
  version: typeof WORKSPACES_REGISTRY_VERSION
  workspaces: WorkspaceRecord[]
}

/** The M8-era central file that only existed for generalization discovery. */
interface LegacyProjectsFile {
  version?: number
  projects?: Array<{ projectRoot?: unknown }>
}

/** `<home>/workspaces.json`. */
export function workspacesRegistryFile(home: string = clueHome()): string {
  return path.join(home, 'workspaces.json')
}

/** Deterministic ordering: by root (labels are user-editable, paths are not). */
function sortRecords(records: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records].sort((a, b) => a.root.localeCompare(b.root) || a.key.localeCompare(b.key))
}

/**
 * Read the roster. A foreign version fails loud; a missing file is empty —
 * except that an M8 `<home>/projects.json` is ADOPTED on the fly. Reading
 * never writes (a dry-run and a status print must have no side effects);
 * the adopted rows land on disk the first time anything actually mutates the
 * roster, because every writer starts from this same read. Roots whose
 * directory vanished stay listed (their data lives in the home and stays
 * browsable) — `listActiveWorkspaces` is what tells the two apart.
 * @param home - ClueHarness home override.
 * @returns records sorted by root.
 */
export async function readWorkspaces(home: string = clueHome()): Promise<WorkspaceRecord[]> {
  const file = workspacesRegistryFile(home)
  const doc = await readJsonOrNull<Partial<WorkspaceRegistry>>(file)
  if (doc === null) {
    const legacy = await readJsonOrNull<LegacyProjectsFile>(path.join(home, 'projects.json'))
    const adopted = (legacy?.projects ?? [])
      .map((row) => (typeof row.projectRoot === 'string' ? row.projectRoot : null))
      .filter((root): root is string => root !== null)
    if (adopted.length === 0) return []
    const now = new Date().toISOString()
    const records: WorkspaceRecord[] = []
    for (const root of sortStringsUnique(adopted)) {
      records.push(await buildRecord(root, { source: 'auto', now, home }))
    }
    return sortRecords(records)
  }
  if (doc.version !== undefined && doc.version !== WORKSPACES_REGISTRY_VERSION) {
    throw new Error(`workspace registry version mismatch: v${String(doc.version)} ≠ v${WORKSPACES_REGISTRY_VERSION} — refused (no auto-migration)`)
  }
  return sortRecords((doc.workspaces ?? []) as WorkspaceRecord[])
}

async function writeRegistry(doc: WorkspaceRegistry, home: string): Promise<void> {
  await atomicWriteJson(workspacesRegistryFile(home), doc)
}

function sortStringsUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/** True when the canonical root's directory is present on disk right now. */
async function rootExists(root: string): Promise<boolean> {
  const info = await stat(root).catch(() => null)
  return info !== null && info.isDirectory()
}

/**
 * A workspace's own data actually lives in the home: opening a tier writes
 * its meta.json anchor immediately (`entries/` only appears with the first
 * knowledge, so the anchor — not the entries dir — is the honest "was opened"
 * marker).
 */
async function tierExists(key: string, home: string): Promise<boolean> {
  return (await stat(path.join(home, 'kb', key, 'meta.json')).catch(() => null)) !== null
}

/** Derive a fresh record for one root (key from the path, label from the basename). */
async function buildRecord(
  root: string,
  options: { source: WorkspaceSource; now: string; home: string; label?: string; renderSurface?: RenderSurfaceSettings },
): Promise<WorkspaceRecord> {
  const key = await workspaceKey(root, options.home)
  const record: WorkspaceRecord = {
    key,
    root,
    label: options.label ?? path.basename(root),
    source: options.source,
    addedAt: options.now,
    lastSeenAt: options.now,
  }
  if (options.renderSurface !== undefined) record.renderSurface = options.renderSurface
  return record
}

/** Upsert one record; an existing label/source/addedAt are PRESERVED (touch only). */
async function upsert(record: WorkspaceRecord, home: string): Promise<WorkspaceRecord> {
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === record.key)
  if (index === -1) {
    records.push(record)
  } else {
    const stored = records[index]
    // A registry sync refreshes identity/state itself; an auto/manual
    // registration must never downgrade those fields.
    if (record.origin === 'registry') {
      records[index] = { ...stored, ...record, addedAt: stored.addedAt }
      await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
      return (await readWorkspaces(home)).find((row) => row.key === record.key) ?? record
    }
    const incomingIsJustTheDefault = record.label === path.basename(record.root)
    const storedIsCustom = stored.label !== path.basename(stored.root)
    records[index] = {
      ...stored,
      root: record.root,
      // An automatic registration carries no opinion about the name: the
      // derived label is the basename, and a basename arriving from an
      // open() must never overwrite a label a human typed in the panel.
      label: incomingIsJustTheDefault && storedIsCustom ? stored.label : record.label,
      lastSeenAt: record.lastSeenAt,
    }
  }
  await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
  return (await readWorkspaces(home)).find((row) => row.key === record.key) ?? record
}

/**
 * Register (or just re-seen) the workspace one root belongs to. Called by
 * every store open, so "a project joins the roster by being USED" holds —
 * and an existing custom label survives the touch.
 * @param projectRoot - any path spelling of the workspace.
 * @param options - home override, source label, timestamp.
 * @returns the effective record after the upsert.
 */
export async function registerWorkspace(
  projectRoot: string,
  options: { home?: string; source?: WorkspaceSource; at?: string; hostId?: string; title?: string } = {},
): Promise<WorkspaceRecord> {
  const home = options.home ?? clueHome()
  const now = options.at ?? new Date().toISOString()
  const root = canonicalRoot(projectRoot)
  const record = await buildRecord(root, { source: options.source ?? 'auto', now, home })
  if (options.source === 'registry') {
    record.origin = 'registry'
    record.state = 'live'
    record.label = options.title ?? path.basename(root)
    record.hostTitle = options.title ?? path.basename(root)
    if (options.hostId !== undefined) record.hostId = options.hostId
  }
  return upsert(record, home)
}

/**
 * Persist the side table verbatim (the sync owns the reconciliation, so it
 * writes the whole document in one atomic pass rather than racing upserts).
 * @param records - the complete new roster.
 * @param home - ClueHarness home override.
 */
export async function writeWorkspaces(records: readonly WorkspaceRecord[], home: string = clueHome()): Promise<void> {
  await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
}

/**
 * Add a workspace BY HAND (the settings panel's 添加 / `clue kb workspace add`).
 * @param projectRoot - the directory to register.
 * @param label - optional display name (default: directory basename).
 * @param home - ClueHarness home override.
 * @returns the created or refreshed record.
 * @throws when the directory does not exist (fail loud, never a phantom row).
 */
export async function addWorkspace(projectRoot: string, label?: string, home: string = clueHome()): Promise<WorkspaceRecord> {
  const root = canonicalRoot(projectRoot)
  if (!(await rootExists(root))) throw new Error(`workspace directory does not exist: ${projectRoot}`)
  const now = new Date().toISOString()
  const records = await readWorkspaces(home)
  const existing = records.find((row) => row.root === root)
  const record: WorkspaceRecord = await buildRecord(root, {
    source: 'manual',
    now,
    home,
    ...(label !== undefined && label !== '' ? { label } : existing !== undefined ? { label: existing.label } : {}),
    ...(existing?.renderSurface !== undefined ? { renderSurface: existing.renderSurface } : {}),
  })
  return upsert(record, home)
}

/**
 * Rename a workspace's display label (data and key untouched).
 * @param key - the workspace key.
 * @param label - the new label (non-blank).
 * @param home - ClueHarness home override.
 * @returns the updated record.
 * @throws when the key is unknown or the label is blank.
 */
export async function renameWorkspace(key: string, label: string, home: string = clueHome()): Promise<WorkspaceRecord> {
  if (label.trim() === '') throw new Error('workspace label must not be empty')
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === key)
  if (index === -1) throw new Error(`workspace not registered: ${key}`)
  records[index] = { ...records[index], label: label.trim(), lastSeenAt: new Date().toISOString() }
  await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
  return records[index]
}

/**
 * Unregister a workspace. This deletes the ROSTER ROW ONLY — the tier and the
 * baselines stay in the home, and the root re-registers itself the moment any
 * session works in it again (the 移除 button must never destroy knowledge).
 * @param key - the workspace key.
 * @param home - ClueHarness home override.
 * @returns what was unregistered plus where its data still lives.
 * @throws when the key is unknown.
 */
export async function removeWorkspace(
  key: string,
  home: string = clueHome(),
): Promise<{ record: WorkspaceRecord; kbDir: string; baselinesDir: string }> {
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === key)
  if (index === -1) throw new Error(`workspace not registered: ${key}`)
  const [record] = records.splice(index, 1)
  await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
  return {
    record,
    kbDir: path.join(home, 'kb', record.key),
    baselinesDir: path.join(home, 'baselines', record.key),
  }
}

/**
 * Look one workspace up by key, root, or any path spelling of it.
 * @param identity - key, absolute path, or relative directory.
 * @param home - ClueHarness home override.
 * @returns the record and the resolved root, or null when unknown.
 */
export async function findWorkspace(
  identity: string,
  home: string = clueHome(),
): Promise<{ record: WorkspaceRecord; root: string } | null> {
  const records = await readWorkspaces(home)
  const byKey = records.find((row) => row.key === identity)
  if (byKey !== undefined) return { record: byKey, root: byKey.root }
  const root = canonicalRoot(identity)
  const byRoot = records.find((row) => row.root === root)
  return byRoot === undefined ? null : { record: byRoot, root }
}

/**
 * The live roster: registered AND both the directory and the tier are present.
 * This is what cross-project machinery (M5 generalization) scans, so it never
 * trips over an unmounted drive or a row registered before its first store open.
 * @param home - ClueHarness home override.
 * @returns the usable records, sorted by root.
 */
export async function listActiveWorkspaces(home: string = clueHome()): Promise<WorkspaceRecord[]> {
  const out: WorkspaceRecord[] = []
  for (const record of await readWorkspaces(home)) {
    if (record.root === '') continue
    if (!(await rootExists(record.root))) continue
    if (!(await tierExists(record.key, home))) continue
    out.push(record)
  }
  return out
}

/**
 * Set (or clear, with null) one workspace's render-surface override.
 * @param key - the workspace key.
 * @param settings - the new surface, or null to fall back to the defaults.
 * @param home - ClueHarness home override.
 * @returns the updated record.
 * @throws when the key is unknown.
 */
export async function setRenderSurface(
  key: string,
  settings: RenderSurfaceSettings | null,
  home: string = clueHome(),
): Promise<WorkspaceRecord> {
  const records = await readWorkspaces(home)
  const index = records.findIndex((row) => row.key === key)
  if (index === -1) throw new Error(`workspace not registered: ${key}`)
  const next = { ...records[index], lastSeenAt: new Date().toISOString() }
  if (settings === null) delete next.renderSurface
  else next.renderSurface = settings
  records[index] = next
  await writeRegistry({ version: WORKSPACES_REGISTRY_VERSION, workspaces: sortRecords(records) }, home)
  return next
}

/**
 * The per-workspace surface settings (undefined = ship the defaults).
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override.
 * @returns the stored override or undefined.
 */
export async function getRenderSurface(
  projectRoot: string,
  home: string = clueHome(),
): Promise<RenderSurfaceSettings | undefined> {
  const root = canonicalRoot(projectRoot)
  const key = await workspaceKey(root, home)
  const records = await readWorkspaces(home)
  return records.find((row) => row.key === key)?.renderSurface
}
