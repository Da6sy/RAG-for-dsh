/**
 * KbStore — the knowledge base over the filesystem (design doc §3.1/§3.3/§3.5).
 *
 * Layout (decision #6 RE-Revised M9: storage is CENTRAL, one tier per
 * WORKSPACE — the 集中式 layout; the M8 experiment of writing into the
 * workspace is retired together with its `.git/info/exclude` bookkeeping):
 *   <home>/kb/<workspace-key>/     one workspace's project tier
 *     meta.json                    format stamp + the ROOT anchor it belongs to
 *     entries/<id>.json            FACTS: one file per entry (source of truth)
 *     signals.jsonl                APPEND-ONLY weighted signal ledger
 *     approvals.json               the batched human-decision queue
 *     doubt.jsonl                  M6 doubt ledgers (evidence loop sidecar)
 *   <home>/kb/_global/             the global tier (cross-project by definition)
 *   <home>/workspaces.json         the roster: key ↔ root ↔ label + per-workspace
 *                                  settings (M9; ClueHarness's own list, never
 *                                  read from dsh's workspace service)
 *
 * The key is a pure function of the canonical root (`encodeSegment(root)`,
 * `-N` when two roots encode alike — decided by the meta.json anchor), so the
 * panel, the CLI and a session's gate all land on the same tier FROM A PATH
 * alone: the M8 accident this file used to prevent (对话与审批各读一本库) is
 * prevented by the derivation, not by where the bytes sit. What centralizing
 * buys: a workspace directory carries zero ClueHarness state, and no git
 * bookkeeping of ours ever touches it. What it costs: copying a project folder
 * no longer copies its memory — the knowledge lives in the home.
 * `clue kb migrate` imports the old in-workspace layout (it never overwrites).
 *
 * Concurrency (decision #13: same-process only for now): every operation is
 * read-compute-atomic-write; no in-memory cache, so two stores over the same
 * directory in one process stay coherent, and the write-behind/lock machinery
 * for cross-process (B2/B3) is a later, additive concern.
 *
 * The store OWENS persistence and orchestration; the state machine owns
 * legality; signals owns scoring. Three files, three jobs.
 *
 * @module @clue-harness/kb/store
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { atomicWriteJson, canonicalRoot, clueHome, readJsonOrNull, sha256File, workspaceKey } from '@clue-harness/util'
import {
  readWorkspaces,
  registerWorkspace,
  setRenderSurface,
  type RenderSurfaceSettings,
} from './workspaces.ts'
import {
  DEFAULT_KB_CONFIG,
  KB_FORMAT_VERSION,
  KbEntryId,
  type ApprovalAction,
  type ApprovalRequest,
  type KbConfig,
  type KbEntry,
  type KbKind,
  type KbMeta,
  type KbStatus,
  type KbTier,
  type SourceBinding,
} from './types.ts'
import {
  applyTransition,
  clearNeedsReview,
  raiseNeedsReview,
  type TransitionTrigger,
} from './state-machine.ts'
import {
  appendSignal,
  buildSignal,
  discardThreshold,
  readSignals,
  windowScore,
  type SignalInput,
} from './signals.ts'
import type { SignalRecord } from './types.ts'

export interface KbStoreOptions {
  tier: KbTier
  /** Absolute or resolvable workspace root (required for tier 'project'). */
  projectRoot?: string
  /**
   * ClueHarness home — CENTRAL for everything: the global tier, the roster,
   * and (M9) the per-workspace project tiers. Default CLUE_HOME or ~/.clue;
   * tests/demos pass an isolated home.
   */
  home?: string
  config?: Partial<KbConfig>
}

/** What `add` accepts; the store stamps identity/status/provenance. */
export interface AddEntryInput {
  kind: KbKind
  title: string
  text: string
  tags?: string[]
  /** Project-relative paths to bind; hashed at add time. */
  bindings?: string[]
  note?: string
  createdBy?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One opened KB tier. */
export class KbStore {
  readonly dir: string
  readonly tier: KbTier
  readonly projectRoot: string | null
  /** The central workspace key this tier lives under (null for the global tier). */
  readonly key: string | null
  readonly config: KbConfig

  private constructor(
    dir: string,
    tier: KbTier,
    projectRoot: string | null,
    key: string | null,
    config: KbConfig,
  ) {
    this.dir = dir
    this.tier = tier
    this.projectRoot = projectRoot
    this.key = key
    this.config = config
  }

  /**
   * Open (creating on first use) one KB tier.
   *
   * Project tier: `<home>/kb/<workspace-key>` where the key derives from the
   * canonical root (see {@link workspaceKey}) — same path in, same tier out,
   * for a session gate, the CLI, or the settings panel. Two side effects keep
   * the roster honest: the meta.json anchor is written for a fresh tier (it is
   * what makes the key collision-safe), and the root is registered in
   * `<home>/workspaces.json` so "a project joins the list by being used"
   * holds. Nothing is ever written INTO the workspace.
   */
  static async open(options: KbStoreOptions): Promise<KbStore> {
    const home = options.home ?? clueHome()
    const config: KbConfig = { ...DEFAULT_KB_CONFIG, ...options.config, weights: { ...DEFAULT_KB_CONFIG.weights, ...(options.config?.weights ?? {}) } }
    let tierRoot: string | null = null
    let key: string | null = null
    let dir: string
    if (options.tier === 'global') {
      dir = path.join(home, 'kb', '_global')
    } else {
      if (options.projectRoot === undefined) throw new Error('KbStore.open: tier=project 需要 projectRoot')
      tierRoot = canonicalRoot(options.projectRoot)
      key = await workspaceKey(tierRoot, home)
      dir = path.join(home, 'kb', key)
    }
    const metaFile = path.join(dir, 'meta.json')
    if ((await readJsonOrNull<KbMeta>(metaFile)) === null) {
      const meta: KbMeta = {
        version: KB_FORMAT_VERSION,
        tier: options.tier,
        projectRoot: tierRoot ?? '',
        createdAt: new Date().toISOString(),
      }
      await atomicWriteJson(metaFile, meta)
    }
    if (tierRoot !== null && key !== null) await registerWorkspace(tierRoot, { home })
    return new KbStore(dir, options.tier, tierRoot, key, config)
  }

  // ---- paths ----
  private get entriesDir(): string { return path.join(this.dir, 'entries') }
  private entryFile(id: KbEntryId): string { return path.join(this.entriesDir, `${id}.json`) }
  private get signalsFile(): string { return path.join(this.dir, 'signals.jsonl') }
  private get approvalsFile(): string { return path.join(this.dir, 'approvals.json') }

  /** Resolve a binding's relative path against the project anchor. */
  bindingPath(binding: SourceBinding): string {
    if (this.projectRoot === null) throw new Error('全局库条目不支持文件绑定解析(没有项目锚点)')
    return path.resolve(this.projectRoot, binding.path)
  }

  // ---- facts CRUD ----

  /**
   * Add a new entry. It ALWAYS starts as candidate (the user's original
   * rule: 首次添加=候选), no exceptions — nothing enters trusted directly.
   */
  async add(input: AddEntryInput, at: string = new Date().toISOString()): Promise<KbEntry> {
    if (input.title.trim() === '' || input.text.trim() === '') {
      throw new Error('kb add: title 和 text 都不能为空')
    }
    const id = KbEntryId(`k-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`)
    const bindings: SourceBinding[] = []
    for (const rel of input.bindings ?? []) {
      const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
      const abs = this.projectRoot === null
        ? (() => { throw new Error('全局库条目不能绑定项目文件') })()
        : path.resolve(this.projectRoot, normalized)
      bindings.push({ path: normalized, contentHash: await sha256File(abs) })
    }
    const entry: KbEntry = {
      version: KB_FORMAT_VERSION,
      id,
      tier: this.tier,
      kind: input.kind,
      title: input.title.trim(),
      text: input.text,
      tags: [...new Set(input.tags ?? [])].sort(),
      bindings,
      provenance: {
        createdBy: input.createdBy ?? 'cli',
        createdAt: at,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      status: 'candidate',
      needsReview: false,
      reviewReason: null,
      stats: { lastReferencedAt: null, referenceCount: 0 },
      history: [{ at, change: 'status', from: null, to: 'candidate', reason: 'created: 新知识一律从候选开始' }],
      discardedAt: null,
    }
    await atomicWriteJson(this.entryFile(id), entry)
    return entry
  }

  /** Load one entry; refuses foreign format versions (house style). */
  async get(id: KbEntryId): Promise<KbEntry | null> {
    const entry = await readJsonOrNull<KbEntry>(this.entryFile(id))
    if (entry === null) return null
    if (entry.version !== KB_FORMAT_VERSION) {
      throw new Error(`kb 条目版本不匹配: ${id} 是 v${String(entry.version)}, 当前 v${KB_FORMAT_VERSION} — 拒绝读取(不自动迁移)`)
    }
    return entry
  }

  /** List entries (deterministic order: createdAt desc, then id). */
  async list(filter: { status?: KbStatus; kind?: KbKind; needsReview?: boolean } = {}): Promise<KbEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.entriesDir)
    } catch {
      return []
    }
    const entries: KbEntry[] = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const entry = await this.get(KbEntryId(name.slice(0, -'.json'.length)))
      if (entry === null) continue
      if (filter.status !== undefined && entry.status !== filter.status) continue
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue
      if (filter.needsReview !== undefined && entry.needsReview !== filter.needsReview) continue
      entries.push(entry)
    }
    entries.sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt) || a.id.localeCompare(b.id))
    return entries
  }

  private async save(entry: KbEntry): Promise<KbEntry> {
    await atomicWriteJson(this.entryFile(entry.id), entry)
    return entry
  }

  // ---- lifecycle ----

  /** Guarded status transition (legality lives in state-machine.ts). */
  async transition(id: KbEntryId, to: KbStatus, trigger: TransitionTrigger, reason: string, at?: string): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    return this.save(applyTransition(entry, to, trigger, reason, at))
  }

  /**
   * Re-hash the entry's bindings against the project anchor.
   * - drift or missing file → raise the orthogonal needs-review flag;
   * - all match and the flag was hash-caused → auto-clear (自动重验通过).
   * Global-tier entries and unbound entries are no-ops.
   */
  async checkBindings(id: KbEntryId, at: string = new Date().toISOString()): Promise<KbEntry> {
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    if (entry.tier === 'global' || entry.bindings.length === 0) return entry
    for (const binding of entry.bindings) {
      const abs = this.bindingPath(binding)
      let currentHash: string
      try {
        currentHash = await sha256File(abs)
      } catch {
        entry = raiseNeedsReview(entry, `源文件不存在: ${binding.path}`, at)
        continue
      }
      if (currentHash !== binding.contentHash) {
        entry = raiseNeedsReview(entry, `源文件内容已变: ${binding.path}`, at)
      }
    }
    const hashCaused = entry.reviewReason !== null && entry.reviewReason.startsWith('源文件')
    const allMatch = await this.bindingsAllMatch(entry)
    if (entry.needsReview && hashCaused && allMatch) {
      entry = clearNeedsReview(entry, '自动重验通过: 绑定文件哈希与记录一致', at)
    }
    return this.save(entry)
  }

  private async bindingsAllMatch(entry: KbEntry): Promise<boolean> {
    for (const binding of entry.bindings) {
      try {
        if ((await sha256File(this.bindingPath(binding))) !== binding.contentHash) return false
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Manually raise the orthogonal needs-review flag (M5 failure propagation:
   * a GLOBAL entry that keeps failing attributed verification in projects
   * gets flagged here — binding-drift is not the only way knowledge goes
   * stale). Idempotent through raiseNeedsReview: the same reason twice is a
   * no-op, a different reason re-flags with fresh history.
   * @param id - the entry to flag.
   * @param reason - why review is needed (audit trail text).
   * @param at - ISO timestamp.
   * @returns the flagged entry.
   * @throws when the entry does not exist (fail loud, never guess).
   */
  async flagNeedsReview(id: KbEntryId, reason: string, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    return this.save(raiseNeedsReview(entry, reason, at))
  }

  /**
   * Human re-verification. `accept` rebinds: recorded hashes are updated to
   * the current content (the change is acknowledged as correct) and the flag
   * clears; without it, this is just a manual check that clears on match.
   */
  async reverify(id: KbEntryId, accept: boolean, at: string = new Date().toISOString()): Promise<KbEntry> {
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    if (accept && entry.tier !== 'global') {
      const rebound: SourceBinding[] = []
      const previous = entry.bindings
      for (const binding of previous) {
        const abs = this.bindingPath(binding)
        try {
          rebound.push({ path: binding.path, contentHash: await sha256File(abs) })
        } catch {
          throw new Error(`kb reverify --accept: 绑定文件不存在 ${binding.path}(不能接受一个消失的文件为新基准)`)
        }
      }
      const changed = rebound.some((b, i) => b.contentHash !== previous[i].contentHash)
      entry = {
        ...entry,
        bindings: rebound,
        history: changed
          ? [...entry.history, { at, change: 'rebind' as const, from: entry.status, to: null, reason: '人工复核接受新内容: 绑定哈希已更新' }]
          : entry.history,
      }
    }
    entry = clearNeedsReview(entry, accept ? '人工复核通过(--accept)' : '人工重验: 绑定哈希一致', at)
    return this.save(entry)
  }

  /**
   * Replace an entry's text with an audited history event (M6: the approval
   * center's "AI 润色" adoption path — a human adopts a rewritten draft and
   * the ledger records that the body changed and why). Title/tags/status/
   * bindings are NOT this method's business; it changes exactly one field.
   * @param id - the entry to edit.
   * @param text - the new body text (non-blank).
   * @param reason - audit trail text (e.g. who/what produced the rewrite).
   * @param at - ISO timestamp.
   * @returns the updated entry.
   * @throws when the entry does not exist or the text is blank (fail loud).
   */
  async updateEntryText(id: KbEntryId, text: string, reason: string, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    if (text.trim() === '') throw new Error('kb: 正文不能为空白')
    if (text === entry.text) return entry // no-op edit: no history spam
    return this.save({
      ...entry,
      text,
      history: [...entry.history, { at, change: 'textUpdated' as const, from: entry.status, to: null, reason }],
    })
  }

  // ---- signals & scoring ----

  /** Append one weighted signal to the ledger. */
  async recordSignal(id: KbEntryId, input: SignalInput, note = '', at?: string): Promise<SignalRecord> {
    if ((await this.get(id)) === null) throw new Error(`kb: 条目不存在 ${id}`)
    const record = buildSignal(id, input, note, this.config, at)
    await appendSignal(this.signalsFile, record)
    return record
  }

  /** Current sliding-window score for one entry. */
  async score(id: KbEntryId, now: Date = new Date()): Promise<ReturnType<typeof windowScore>> {
    return windowScore(await readSignals(this.signalsFile), id, now, this.config.windowDays)
  }

  /** Mark the entry as referenced (drives the expire timer; NOT a signal — see query.ts doctrine). */
  async touch(id: KbEntryId, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: 条目不存在 ${id}`)
    return this.save({
      ...entry,
      stats: { lastReferencedAt: at, referenceCount: entry.stats.referenceCount + 1 },
    })
  }

  // ---- maintenance: expire / discard / purge / promotion suggestions ----

  /**
   * The periodic maintenance pass (M2: manual `clue kb sweep`; M3: a Cordis
   * job). Order matters: score-driven edges first, then idle expiry, then
   * the retention purge — so a purge never races a fresh transition.
   */
  async sweep(now: Date = new Date()): Promise<{ expired: KbEntryId[]; discarded: KbEntryId[]; purged: KbEntryId[]; promotions: ApprovalRequest[] }> {
    const signals = await readSignals(this.signalsFile)
    const expired: KbEntryId[] = []
    const discarded: KbEntryId[] = []
    const purged: KbEntryId[] = []
    const at = now.toISOString()

    for (const entry of await this.list()) {
      // 1) strong-negative: user rejection / attributed evidence failure
      //    crossed the bound → discard WITHOUT a queue (entering discard is
      //    machine-driven; LEAVING it needs the human — the user's rule).
      if (entry.status === 'candidate' || entry.status === 'trusted' || entry.status === 'expired') {
        const { score } = windowScore(signals, entry.id, now, this.config.windowDays)
        if (score <= discardThreshold(this.config)) {
          await this.save(applyTransition(entry, 'discarded', 'strong-negative', `窗口分数 ${score} ≤ ${discardThreshold(this.config)}`, at))
          discarded.push(entry.id)
          continue
        }
      }
      // 2) idle expiry (both candidate and trusted have this exit — patch #1).
      if (entry.status === 'candidate' || entry.status === 'trusted') {
        const anchor = Date.parse(entry.stats.lastReferencedAt ?? entry.provenance.createdAt)
        if (!Number.isNaN(anchor) && now.getTime() - anchor > this.config.expireAfterDays * DAY_MS) {
          await this.save(applyTransition(entry, 'expired', 'expire-idle', `超过 ${this.config.expireAfterDays} 天未被引用`, at))
          expired.push(entry.id)
          continue
        }
      }
      // 3) retention purge (decision #11: 60 days, then gone; signals stay).
      if (entry.status === 'discarded' && entry.discardedAt !== null) {
        const discardedAt = Date.parse(entry.discardedAt)
        if (!Number.isNaN(discardedAt) && now.getTime() - discardedAt > this.config.discardRetentionDays * DAY_MS) {
          await rm(this.entryFile(entry.id), { force: true })
          purged.push(entry.id)
        }
      }
    }
    const promotions = await this.suggestPromotions(now, signals)
    return { expired, discarded, purged, promotions }
  }

  /**
   * Turn score-eligible candidates into queued promote REQUESTS (never a
   * direct promotion). Suppressed while an equal pending request exists, or
   * a promotion was rejected inside the window ( ignored twice → quieter).
   */
  async suggestPromotions(now: Date = new Date(), signals?: SignalRecord[]): Promise<ApprovalRequest[]> {
    const ledger = signals ?? await readSignals(this.signalsFile)
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const created: ApprovalRequest[] = []
    for (const entry of await this.list({ status: 'candidate' })) {
      const { score } = windowScore(ledger, entry.id, now, this.config.windowDays)
      if (score < this.config.trustThreshold) continue
      const pending = approvals.some((a) => a.entryId === entry.id && a.action === 'promote' && a.resolvedAt === null)
      if (pending) continue
      const rejectedRecently = approvals.some((a) => {
        if (a.entryId !== entry.id || a.action !== 'promote' || a.resolution !== 'rejected' || a.resolvedAt === null) return false
        return now.getTime() - Date.parse(a.resolvedAt) < this.config.windowDays * DAY_MS
      })
      if (rejectedRecently) continue
      const request = await this.requestApproval(entry.id, 'promote', `窗口分数 ${score} ≥ ${this.config.trustThreshold}(多次成功引用)`, score, now.toISOString())
      created.push(request)
    }
    return created
  }

  // ---- the batched approval queue (decision #12) ----

  /** Queue one human decision; dedupes against an equal pending request. */
  async requestApproval(entryId: KbEntryId, action: ApprovalAction, reason: string, score: number, at: string = new Date().toISOString()): Promise<ApprovalRequest> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const existing = approvals.find((a) => a.entryId === entryId && a.action === action && a.resolvedAt === null)
    if (existing !== undefined) return existing
    const request: ApprovalRequest = {
      id: `a-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      entryId,
      action,
      reason,
      scoreAtRequest: score,
      createdAt: at,
      resolvedAt: null,
      resolution: null,
    }
    await atomicWriteJson(this.approvalsFile, [...approvals, request])
    return request
  }

  /** List the queue (pending first, oldest first — the batch-review order). */
  async listApprovals(pendingOnly = true): Promise<ApprovalRequest[]> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    return approvals
      .filter((a) => !pendingOnly || a.resolvedAt === null)
      .sort((a, b) => (a.resolvedAt === null ? 0 : 1) - (b.resolvedAt === null ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Resolve one queued request. Approved promote/rescue/reactivate/discard
   * apply their transition; approving a promote ALSO records the human-confirm
   * signal (the approval IS the strongest positive). A rejected promote
   * records NO negative signal — declining to trust is not saying "wrong".
   */
  async resolveApproval(requestId: string, approved: boolean, at: string = new Date().toISOString()): Promise<{ request: ApprovalRequest; entry: KbEntry | null }> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const index = approvals.findIndex((a) => a.id === requestId)
    if (index === -1) throw new Error(`kb: 审批请求不存在 ${requestId}`)
    const request = approvals[index]
    if (request.resolvedAt !== null) throw new Error(`kb: 请求 ${requestId} 已被处理(${request.resolution})`)
    let entry: KbEntry | null = null
    if (approved) {
      if (request.action === 'promote') {
        entry = await this.transition(request.entryId, 'trusted', 'approve-promote', `人工批准提升(请求 ${requestId})`, at)
        await this.recordSignal(request.entryId, 'human-confirm', `批准提升为可信(${request.reason})`, at)
      } else if (request.action === 'discard') {
        entry = await this.transition(request.entryId, 'discarded', 'strong-negative', `人工批准遗弃(请求 ${requestId})`, at)
      } else if (request.action === 'rescue') {
        entry = await this.transition(request.entryId, 'candidate', 'rescue', `人工捞回(请求 ${requestId})`, at)
      } else {
        entry = await this.transition(request.entryId, 'candidate', 'reactivate', `人工复核重新激活(请求 ${requestId})`, at)
      }
    }
    approvals[index] = { ...request, resolvedAt: at, resolution: approved ? 'approved' : 'rejected' }
    await atomicWriteJson(this.approvalsFile, approvals)
    return { request: approvals[index], entry }
  }
}

/**
 * Convenience: open the global tier (stays central — cross-project by
 * definition).
 *
 * Discard bound (user decision, M5 review): the global tier uses the SAME
 * derived bound as projects (-trustThreshold = -20) — knowledge is not
 * killed faster for being global. Design §3.6's "全局更敏感" is realized
 * through FAILURE PROPAGATION instead (consecutive attributed failures flag
 * the entry 待复核 for every project to see — sensitivity as a review flag,
 * not as a faster execution). `config.discardThreshold` remains available
 * for a deployment that wants an explicit different bound.
 */
export function openGlobalStore(home?: string, config?: Partial<KbConfig>): Promise<KbStore> {
  return KbStore.open({ tier: 'global', home, config })
}

/** Convenience: open the PROJECT tier of one workspace (`<home>/kb/<key>`). */
export function openProjectStore(projectRoot: string, home?: string, config?: Partial<KbConfig>): Promise<KbStore> {
  return KbStore.open({ tier: 'project', projectRoot, home, config })
}

// ── central paths & the M9 import (from the M8 in-workspace layout) ─────────

/** The workspace-internal directory the M8 layout wrote into: `<root>/.clue`. */
export function legacyWorkspaceClueDir(projectRoot: string): string {
  return path.join(projectRoot, '.clue')
}

/** One migration outcome (the CLI prints this verbatim — it is the user's evidence). */
export interface MigrationEntry {
  /** The canonical workspace root the piece belongs to. */
  root: string
  /** Which kind of state moved. */
  kind: 'kb' | 'baselines' | 'surface' | 'leftover'
  from: string
  /** Absent when the piece was skipped. */
  to?: string
  moved: boolean
  reason: string
}

export interface MigrateOptions {
  /** ClueHarness home to migrate INTO (default CLUE_HOME/~/.clue). */
  home?: string
  /** Explicit roots to examine; the legacy roster file is always added. */
  roots?: readonly string[]
  /** Report only, move nothing. */
  dryRun?: boolean
}

/**
 * Import the M8 workspace-bound layout into central storage (decision #6
 * re-revision): for every known workspace, move `<root>/.clue/kb` to
 * `<home>/kb/<key>` and `<root>/.clue/render-baselines` to
 * `<home>/baselines/<key>`, and fold `<root>/.clue/render-surface.json` into
 * the workspace's roster record. Afterwards a workspace directory carries no
 * ClueHarness state at all.
 *
 * Discovery: explicit `roots` + the adopted roster + the legacy
 * `<home>/projects.json`. A non-empty destination is NEVER overwritten (skip +
 * reason — two machines migrated independently keep their own copy); an absent
 * workspace is simply nothing to do. The meta.json anchor travels with the
 * tier, which is what keeps the key walk honest.
 * @param options - home, explicit roots, dry run.
 * @returns per-workspace, per-piece outcomes.
 */
export async function migrateWorkspaceKbsToCentral(options: MigrateOptions = {}): Promise<MigrationEntry[]> {
  const home = options.home ?? clueHome()
  const report: MigrationEntry[] = []

  const candidates = new Set<string>()
  for (const root of options.roots ?? []) candidates.add(canonicalRoot(root))
  const legacy = await readJsonOrNull<{ projects?: Array<{ projectRoot?: unknown }> }>(path.join(home, 'projects.json'))
  for (const row of legacy?.projects ?? []) {
    if (typeof row.projectRoot === 'string' && row.projectRoot !== '') candidates.add(canonicalRoot(row.projectRoot))
  }
  for (const row of await readWorkspaces(home)) candidates.add(canonicalRoot(row.root))

  for (const root of [...candidates].sort()) {
    const clueDir = legacyWorkspaceClueDir(root)
    const key = await workspaceKey(root, home)
    const kbFrom = path.join(clueDir, 'kb')
    const kbTo = path.join(home, 'kb', key)
    const baselinesFrom = path.join(clueDir, 'render-baselines')
    const baselinesTo = path.join(home, 'baselines', key)
    const surfaceFrom = path.join(clueDir, 'render-surface.json')

    const hasKb = (await stat(path.join(kbFrom, 'entries')).catch(() => null)) !== null
    const hasBaselines = (await stat(baselinesFrom).catch(() => null)) !== null
    const hasSurface = (await stat(surfaceFrom).catch(() => null)) !== null
    if (!hasKb && !hasBaselines && !hasSurface) continue

    if (hasKb) {
      const occupied = (await readdir(kbTo).catch(() => null)) !== null
      if (occupied) {
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: false, reason: '中心库已存在，不覆盖（请手动合并）' })
      } else if (options.dryRun === true) {
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: false, reason: 'dry-run：将迁入中心库' })
      } else {
        await moveDir(kbFrom, kbTo)
        await registerWorkspace(root, { home, source: 'migrate' })
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: true, reason: '已收回到中心库' })
      }
    }
    if (hasBaselines) {
      const occupied = (await readdir(baselinesTo).catch(() => null)) !== null
      if (occupied) {
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: false, reason: '中心基准目录已存在，不覆盖' })
      } else if (options.dryRun === true) {
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: false, reason: 'dry-run：将迁入中心基准目录' })
      } else {
        await moveDir(baselinesFrom, baselinesTo)
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: true, reason: '渲染基准已收回中心' })
      }
    }
    if (hasSurface) {
      const target = `${key} @ workspaces.json`
      if (options.dryRun === true) {
        report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: false, reason: 'dry-run：将写入注册表' })
      } else {
        const custom = await readJsonOrNull<Partial<RenderSurfaceSettings>>(surfaceFrom)
        const settings: RenderSurfaceSettings = {
          ...(Array.isArray(custom?.extensions) ? { extensions: custom.extensions.map(String) } : {}),
          ...(Array.isArray(custom?.pathPrefixes) ? { pathPrefixes: custom.pathPrefixes.map(String) } : {}),
        }
        if (settings.extensions === undefined && settings.pathPrefixes === undefined) {
          report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: false, reason: '文件里没有有效数组，保留原位待人工处理' })
        } else {
          await setRenderSurface(key, settings, home)
          await rm(surfaceFrom, { force: true })
          report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: true, reason: '渲染面配置已并入工作区记录' })
        }
      }
    }
    if (options.dryRun !== true) {
      const leftovers = await readdir(clueDir).catch(() => null)
      if (leftovers !== null && leftovers.length === 0) {
        await rm(clueDir, { recursive: true, force: true })
      } else if (leftovers !== null) {
        report.push({ root, kind: 'leftover', from: clueDir, moved: false, reason: `.clue/ 仍有其他内容(${leftovers.join(', ')})，未删除` })
      }
    }
  }
  return report
}

/** Move a directory, falling back to copy+delete across devices. */
async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}
