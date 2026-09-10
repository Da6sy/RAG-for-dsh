/**
 * Generalization proposals (M5, design §3.6 source ③).
 *
 * "同一条知识在 ≥2 个不同项目里都验证过 → 系统提议泛化成全局知识(你审一眼)。"
 *
 * Mechanism, all deterministic (no model in the loop — the design's "由大模型
 * 改写" is deferred polish; the DRAFT below is honest about being a copy):
 *
 * 1. discover the project tiers via the central registry (workspace-bound
 *    KBs, M8 binding revision) — a project joins by its store having been
 *    opened at least once — plus the global tier;
 * 2. an entry counts as VERIFIED when it is trusted OR its ledger carries at
 *    least one evidence-pass (objective verification vouched for it);
 * 3. similar verified entries from DIFFERENT projects cluster (token overlap
 *    coefficient ≥ threshold over title+text — the same tokenizer retrieval
 *    uses, so "similar" means exactly what search can already see);
 * 4. a cluster is skipped when the global tier already holds a similar
 *    candidate/trusted entry (that IS the dedupe: repeated scans never stack
 *    proposals, and a rejected generalization stays rejected until its
 *    candidate is discarded);
 * 5. otherwise: create the global CANDIDATE (draft = the strongest member's
 *    title/text, merged tags, NO bindings — a global entry binds no one
 *    project's files; freshness travels via failure propagation instead) and
 *    queue a promote approval on it. Zero new approval vocabulary: a
 *    generalization IS "a candidate global entry awaiting human promotion"
 *    (决策 #21 — 提升必经人批 — applies with its existing machinery).
 *
 * @module @clue-harness/kb-loop/generalize
 */
import path from 'node:path'
import {
  listKnownProjects,
  openGlobalStore,
  openProjectStore,
  readSignals,
  tokenize,
  windowScore,
  KbStore,
  type ApprovalRequest,
  type KbEntry,
} from '@clue-harness/kb'
import { clueHome } from '@clue-harness/util'

/** One verified entry with its project anchor. */
interface VerifiedEntry {
  projectRoot: string
  entry: KbEntry
  score: number
}

/** One proposed generalization (created or dry-run). */
export interface GeneralizationProposal {
  /** The draft's content (what the global candidate carries). */
  draft: {
    kind: KbEntry['kind']
    title: string
    text: string
    tags: string[]
  }
  /** The verified sources behind the proposal (≥2 distinct projects). */
  sources: Array<{ projectRoot: string; entryId: string; title: string }>
  /** The created global entry + queued approval (absent in dryRun). */
  created?: { entry: KbEntry; request: ApprovalRequest }
}

/** Scan result: proposals plus every skip reason (transparency). */
export interface GeneralizationScan {
  proposals: GeneralizationProposal[]
  skipped: string[]
  /** Project tiers examined (live anchors only). */
  projectsScanned: number
}

export interface GeneralizationOptions {
  /** ClueHarness home override (tests/demos). */
  home?: string
  /** Token overlap coefficient bound for "same knowledge". Default 0.5. */
  threshold?: number
  /** Compute proposals without writing (CLI --dry-run). */
  dryRun?: boolean
  now?: Date
}

const DEFAULT_THRESHOLD = 0.5

/**
 * Overlap coefficient of two token sets: |A∩B| / min(|A|,|B|). Deliberately
 * NOT Jaccard — a short global-rule phrasing ("按钮别掉出 Tab 顺序") fully
 * contained in a longer project-specific one ("本项目 ds-button 组件的按钮别
 * 掉出 Tab 顺序,评审时踩过三次") IS the same knowledge; Jaccard would
 * penalize the extra project detail exactly where containment is the point.
 * @param a - first token set.
 * @param b - second token set.
 * @returns the coefficient in [0,1] (0 when either side is empty).
 */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / small.size
}

/** The similarity key of one entry (title weighted into the text tokens). */
function entryTokens(entry: KbEntry): Set<string> {
  return new Set(tokenize(`${entry.title} ${entry.text}`))
}

/**
 * Similarity of two entries: the MAX of title-only and full-text overlap.
 * The title is a knowledge's IDENTITY; project-specific detail in the text
 * dilutes raw token overlap (measured: identical titles with differently
 * worded bodies score 0.41 full-text — under any sane threshold). Either
 * strong containment means "same knowledge": a shared title directly, or a
 * title-less paraphrase through the full text.
 * @param a - first entry.
 * @param b - second entry.
 * @returns the similarity in [0,1].
 */
export function entrySimilarity(a: KbEntry, b: KbEntry): number {
  const titleOverlap = overlapCoefficient(new Set(tokenize(a.title)), new Set(tokenize(b.title)))
  return Math.max(titleOverlap, overlapCoefficient(entryTokens(a), entryTokens(b)))
}

/**
 * Scan every live project tier for cross-project verified similarity and
 * turn each fresh cluster into a global candidate + promote approval.
 * @param options - home, threshold, dry-run.
 * @returns proposals created (or computed) and every skip reason.
 */
export async function suggestGeneralizations(options: GeneralizationOptions = {}): Promise<GeneralizationScan> {
  const now = options.now ?? new Date()
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const skipped: string[] = []

  // ── discover workspace-bound project tiers via the central registry ─────
  // (M8 binding revision: project KBs live at <root>/.clue/kb — no central
  // directory to list anymore; the registry <home>/projects.json is written
  // on every store open, so a project joins the loop by being USED. A
  // vanished workspace drops out inside listKnownProjects.)
  const home = options.home ?? clueHome()
  const global = await openGlobalStore(home)
  const projects: KbStore[] = []
  for (const root of await listKnownProjects(home)) {
    projects.push(await openProjectStore(root, home))
  }

  // ── collect verified entries per project ───────────────────────────────
  const verified: VerifiedEntry[] = []
  for (const store of projects) {
    const ledger = await readSignals(path.join(store.dir, 'signals.jsonl'))
    for (const entry of await store.list()) {
      if (entry.status !== 'candidate' && entry.status !== 'trusted') continue
      const passed = ledger.some((record) => record.entryId === entry.id && record.source === 'evidence' && record.polarity === 'positive')
      if (entry.status !== 'trusted' && !passed) continue
      const { score } = windowScore(ledger, entry.id, now, store.config.windowDays)
      verified.push({ projectRoot: store.projectRoot ?? '', entry, score })
    }
  }

  // ── cluster across DIFFERENT projects (greedy connected components) ────
  const keyOf = (item: VerifiedEntry): string => `${item.projectRoot}\u0000${item.entry.id}`
  const clusters: VerifiedEntry[][] = []
  const assigned = new Set<string>()
  for (const seed of verified) {
    const seedKey = keyOf(seed)
    if (assigned.has(seedKey)) continue
    const cluster: VerifiedEntry[] = [seed]
    assigned.add(seedKey)
    // Fixed-point growth: a cluster absorbs anything similar to ANY member
    // from a project not yet in it (transitive chain stays one proposal).
    let grew = true
    while (grew) {
      grew = false
      for (const candidate of verified) {
        const candidateKey = keyOf(candidate)
        if (assigned.has(candidateKey)) continue
        if (cluster.some((member) => member.projectRoot === candidate.projectRoot)) continue
        const similar = cluster.some((member) => entrySimilarity(member.entry, candidate.entry) >= threshold)
        if (similar) {
          cluster.push(candidate)
          assigned.add(candidateKey)
          grew = true
        }
      }
    }
    if (cluster.length >= 2) clusters.push(cluster)
  }

  // ── dedupe against the global tier, then draft + queue ─────────────────
  const globalEntries = (await global.list()).filter((entry) => entry.status === 'candidate' || entry.status === 'trusted')
  const proposals: GeneralizationProposal[] = []
  for (const cluster of clusters) {
    const strongest = [...cluster].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))[0]
    const existing = globalEntries.find((entry) => entrySimilarity(entry, strongest.entry) >= threshold)
    if (existing !== undefined) {
      skipped.push(`「${strongest.entry.title}」的全局版已存在(${existing.id},${existing.status}),不重复提案`)
      continue
    }
    const tags = [...new Set(cluster.flatMap((member) => member.entry.tags))].sort()
    const proposal: GeneralizationProposal = {
      draft: { kind: strongest.entry.kind, title: strongest.entry.title, text: strongest.entry.text, tags },
      sources: cluster.map((member) => ({
        projectRoot: member.projectRoot,
        entryId: String(member.entry.id),
        title: member.entry.title,
      })),
    }
    if (options.dryRun !== true) {
      const entry = await global.add({
        kind: proposal.draft.kind,
        title: proposal.draft.title,
        text: proposal.draft.text,
        tags: proposal.draft.tags,
        createdBy: 'generalization',
        note: `泛化自 ${cluster.length} 个项目的已验证知识: ${proposal.sources.map((s) => `${s.entryId}@${path.basename(s.projectRoot)}`).join(', ')}(草稿为最强成员原文,人批时可改写)`,
      })
      const request = await global.requestApproval(
        entry.id,
        'promote',
        `泛化提议: 同类知识在 ${cluster.length} 个项目各自验证过(${proposal.sources.map((s) => path.basename(s.projectRoot)).join(', ')}),建议收编为全局知识`,
        strongest.score,
        now.toISOString(),
      )
      proposal.created = { entry, request }
      // The new candidate joins the dedupe set so one scan never proposes
      // the same cluster twice through overlapping members.
      globalEntries.push(entry)
    }
    proposals.push(proposal)
  }

  return { proposals, skipped, projectsScanned: projects.length }
}
