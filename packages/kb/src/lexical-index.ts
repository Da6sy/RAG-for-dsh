/**
 * The inverted index (R1 of `docs/落地计划-剩余工程.md`).
 *
 * Why it exists, measured: every query used to materialize the corpus twice —
 * `buildLexicalStats` tokenized all of it to get df and the field averages, and
 * `scoreEntry` tokenized every entry AGAIN to score it. On nfcorpus (3.6k
 * entries) that is 1.7–3.8s per query, because the whole library was re-read and
 * re-tokenized for every single question. Textbook BM25 with an inverted index
 * answers the same batch in ~4ms/query, and the gap is not a constant factor:
 * it grows with the library.
 *
 * What this module owns:
 *
 * - **Build**: tokenize the corpus once, write `postings.json` + `meta.json`
 *   under `<store.dir>/lexical/`, and record enough metadata that a query never
 *   has to look at an entry it will not score.
 * - **Read/validate**: say honestly whether the stored index still describes
 *   the corpus (`current` / `stale` / `missing` / `corrupt` / `over-budget`).
 * - **Query helpers**: corpus statistics without a scan, the candidate id union
 *   for a query's tokens, and the per-field lengths a score needs.
 *
 * What it deliberately does NOT own: the scoring formula (that is `bm25.ts`,
 * one implementation for both paths) and any decision about what to do when the
 * index is unusable (the caller falls back to the scan and SAYS SO — a derived
 * layer's failure must never become a retrieval failure).
 *
 * Freshness, and the honest limit of it
 * -------------------------------------
 * Every entry file is written through an atomic rename, so its `mtimeMs` and
 * `size` change on ANY write, including a `touch` that only bumps a reference
 * counter. The index therefore stores per entry `{ m, s, h }` — mtime, size and
 * a hash of the PROJECTION it actually indexed (title, tags, redline-filtered
 * text, status, kind, tier, needsReview) — and validation is:
 *
 * 1. the `entries/` directory's own `mtimeMs` unchanged since the last check ⇒
 *    nothing was written at all ⇒ current (this is the steady state: ONE stat);
 * 2. otherwise stat each entry file; for the ones that changed, read that one
 *    file and compare its projection hash. A stats-only write keeps the index
 *    (no rebuild storm from ordinary retrievals), a text/status change rebuilds.
 *
 * So an edit made by a person with an editor — which also moves mtime — IS
 * caught. The residual gap is an edit that preserves both mtime and size
 * (`touch -r` plus an equal-length rewrite); `fingerprintLexicalIndex()` exists
 * for that, and the CLI's verify path uses it.
 *
 * @module @clue-harness/kb/lexical-index
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  bm25Fields,
  type Bm25FieldWeights,
  type LexicalStats,
  type PrecomputedFields,
} from './bm25.ts'
import { entryTextAfterRedlines } from './redline.ts'
import { tokenizeCounts } from './tokenize.ts'
import { lexicalIndexVersion, type KbEntry, type KbKind, type KbStatus, type KbTier } from './types.ts'

/** The directory name the derived index lives under (beside `entries/`, `docs/`). */
export const LEXICAL_INDEX_DIRNAME = 'lexical'

/** The postings file name inside that directory. */
export const LEXICAL_POSTINGS_FILE = 'postings.json'

/** The metadata file name inside that directory. */
export const LEXICAL_META_FILE = 'meta.json'

/** `<store.dir>/lexical`. */
export function lexicalIndexDir(storeDir: string): string {
  return path.join(storeDir, LEXICAL_INDEX_DIRNAME)
}

/** The three per-field numbers every posting carries. */
export type FieldTriple = [number, number, number]

/** One entry's indexed facts (the meta table's value type). */
export interface LexicalEntryFacts {
  /** mtimeMs of the entry file at build time. */
  m: number
  /** byte size of the entry file at build time. */
  s: number
  /** Hash of the indexed PROJECTION (see the module header). */
  h: string
  tier: KbTier
  kind: KbKind
  status: KbStatus
  needsReview: boolean
  /** Distinct-token counts per field — what BM25's length norm divides by today. */
  dl: FieldTriple
  /** Total token counts per field — what a real term frequency would need (F4②). */
  tl: FieldTriple
}

/** `meta.json`'s shape. */
export interface LexicalIndexMeta {
  indexVersion: string
  builtAt: string
  entryCount: number
  /** Mean DISTINCT token count per field (the lengths `dl` are normalized against). */
  avgDistinct: FieldTriple
  /** Mean TOTAL token count per field (for the F4② switch; unused while tf is presence). */
  avgTotal: FieldTriple
  /** entryId → facts (also the tier/status table the query path filters with). */
  entries: Record<string, LexicalEntryFacts>
  /** Hash over every entry's projection, for on-demand verification. */
  fingerprint: string
}

/** One posting: the entry plus its per-field term counts. */
export interface LexicalPosting {
  id: string
  /** term counts per field (title, tag, text) — presence is `> 0`. */
  tf: FieldTriple
}

/** A loaded index (meta + postings). */
export interface LexicalIndex {
  dir: string
  meta: LexicalIndexMeta
  /** token → postings. */
  postings: Record<string, LexicalPosting[]>
}

/** What a build did (the CLI and the panel print this verbatim). */
export interface LexicalIndexReport {
  dir: string
  entries: number
  tokens: number
  postings: number
  bytes: number
  seconds: number
  /** True when the budget stopped the build and the caller must scan instead. */
  overBudget: boolean
  reason: string
}

/** The build/read guards (落地计划 §2-1: 预算与降级). */
export interface LexicalIndexBudget {
  /** Entries beyond this refuse to build (fall back to the scan). */
  maxEntries?: number
  /** Milliseconds beyond which a build gives up (checked between entries). */
  maxMillis?: number
}

/** The shipped budget: generous for this project's scale, finite on purpose. */
export const DEFAULT_LEXICAL_BUDGET: Required<LexicalIndexBudget> = {
  maxEntries: 50_000,
  maxMillis: 20_000,
}

/** Hash of the projection the index is built FROM (not the whole entry record). */
export function entryProjectionHash(entry: KbEntry): string {
  const hash = createHash('sha256')
  hash.update(`${entry.title}\u0000${entry.tags.join('\u0000')}\u0000${entryTextAfterRedlines(entry)}\u0000`)
  hash.update(`${entry.tier}\u0000${entry.kind}\u0000${entry.status}\u0000${entry.needsReview ? 1 : 0}\u0000`)
  hash.update(`${entry.doc?.docId ?? ''}\u0000`)
  return hash.digest('hex').slice(0, 16)
}

/** The three field texts of one entry, exactly as scoring sees them. */
function fieldsOf(entry: KbEntry): { title: string; tag: string; text: string } {
  return {
    title: entry.title,
    tag: entry.tags.join(' '),
    text: entryTextAfterRedlines(entry),
  }
}

/** One entry's per-field token counts (the raw material of both the postings and the lengths). */
function countFields(entry: KbEntry): {
  maps: [Map<string, number>, Map<string, number>, Map<string, number>]
  distinct: FieldTriple
  total: FieldTriple
} {
  const fields = fieldsOf(entry)
  const maps: [Map<string, number>, Map<string, number>, Map<string, number>] = [
    tokenizeCounts(fields.title),
    tokenizeCounts(fields.tag),
    tokenizeCounts(fields.text),
  ]
  const distinct: FieldTriple = [0, 0, 0]
  const total: FieldTriple = [0, 0, 0]
  maps.forEach((map, index) => {
    // `tokenizeCounts` returns distinct tokens WITH counts, so the distinct
    // length is the map size and the total is the sum — the two notions the
    // length normalization and a real tf will each need.
    distinct[index] = map.size
    for (const count of map.values()) total[index] += count
  })
  return { maps, distinct, total }
}

/** The fingerprint over a corpus' projections (canonical order: by id). */
export function fingerprintLexicalEntries(entries: readonly KbEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`${entry.id}\u0000${entryProjectionHash(entry)}\u0000`)
  }
  return hash.digest('hex')
}

/** Everything a build needs. */
export interface BuildLexicalIndexInput {
  /** `<store.dir>` — the index goes into `<store.dir>/lexical/`. */
  storeDir: string
  /** The entries to index (already redline-filtered by the projection). */
  entries: readonly KbEntry[]
  /** Injectable clock. */
  now?: Date
  /** Budget guard. */
  budget?: LexicalIndexBudget
  /** Write the files (tests and the dry-run path pass `false`). */
  persist?: boolean
}

/**
 * Build the inverted index for a corpus.
 *
 * The postings carry real term COUNTS per field even though today's scoring
 * only asks "present or not": the counts cost nothing extra while the tokenizer
 * is running, and F4② (真词频) then needs no rebuild to switch on.
 * @param input - the corpus, the store directory and the guards.
 * @returns the index, a report, and (when `persist !== false`) the files written.
 */
export async function buildLexicalIndex(
  input: BuildLexicalIndexInput,
): Promise<{ index: LexicalIndex; report: LexicalIndexReport }> {
  const budget = { ...DEFAULT_LEXICAL_BUDGET, ...(input.budget ?? {}) }
  const started = Date.now()
  const dir = lexicalIndexDir(input.storeDir)
  if (input.entries.length > budget.maxEntries) {
    return {
      index: { dir, meta: emptyMeta(new Date(input.now ?? Date.now()).toISOString()), postings: {} },
      report: {
        dir, entries: input.entries.length, tokens: 0, postings: 0, bytes: 0, seconds: 0,
        overBudget: true,
        reason: `条目数 ${input.entries.length} 超过预算 ${budget.maxEntries},不建索引(退回扫描路径)`,
      },
    }
  }

  const postings = new Map<string, LexicalPosting[]>()
  const entries: Record<string, LexicalEntryFacts> = {}
  let titleSum = 0
  let tagSum = 0
  let textSum = 0
  let titleTotal = 0
  let tagTotal = 0
  let textTotal = 0
  let overBudget = false
  let reason = ''

  for (const entry of input.entries) {
    if (Date.now() - started > budget.maxMillis) {
      overBudget = true
      reason = `建索引超过时间预算 ${budget.maxMillis}ms,已停止(退回扫描路径)`
      break
    }
    const { maps, distinct, total } = countFields(entry)
    const dl: FieldTriple = distinct
    titleSum += dl[0]
    tagSum += dl[1]
    textSum += dl[2]
    titleTotal += total[0]
    tagTotal += total[1]
    textTotal += total[2]
    let mtimeMs = 0
    let size = 0
    try {
      const info = await stat(path.join(input.storeDir, 'entries', `${entry.id}.json`))
      mtimeMs = info.mtimeMs
      size = info.size
    } catch {
      // An in-memory corpus (tests, synthetic sets) has no file to stat: the
      // index is then valid for this process only, and `m`/`s` stay 0 — which
      // validation reads as "cannot be checked on disk", see `checkEntryFiles`.
    }
    entries[String(entry.id)] = {
      m: mtimeMs,
      s: size,
      h: entryProjectionHash(entry),
      tier: entry.tier,
      kind: entry.kind,
      status: entry.status,
      needsReview: entry.needsReview,
      dl,
      tl: total,
    }
    const id = String(entry.id)
    const touched = new Map<string, LexicalPosting>()
    for (let field = 0; field < 3; field += 1) {
      for (const [token, count] of maps[field] as Map<string, number>) {
        let posting = touched.get(token)
        if (posting === undefined) {
          posting = { id, tf: [0, 0, 0] }
          touched.set(token, posting)
        }
        // Real counts (from the counting tokenizer), even though today's
        // scoring only asks "present": F4② then needs no rebuild.
        posting.tf[field] = count
      }
    }
    for (const [token, posting] of touched) {
      const list = postings.get(token) ?? []
      list.push(posting)
      postings.set(token, list)
    }
  }

  const count = Object.keys(entries).length
  const indexed = input.entries.filter((entry) => entries[String(entry.id)] !== undefined)
  const meta: LexicalIndexMeta = {
    indexVersion: lexicalIndexVersion(),
    builtAt: new Date(input.now ?? Date.now()).toISOString(),
    entryCount: count,
    avgDistinct: [count === 0 ? 0 : titleSum / count, count === 0 ? 0 : tagSum / count, count === 0 ? 0 : textSum / count],
    avgTotal: [count === 0 ? 0 : titleTotal / count, count === 0 ? 0 : tagTotal / count, count === 0 ? 0 : textTotal / count],
    entries,
    fingerprint: overBudget ? '' : fingerprintLexicalEntries(indexed),
  }
  const flat: Record<string, LexicalPosting[]> = {}
  for (const [token, list] of postings) flat[token] = list.sort((a, b) => a.id.localeCompare(b.id))
  const index: LexicalIndex = { dir, meta, postings: flat }

  let bytes = 0
  if (input.persist !== false && !overBudget) {
    const postingsJson = JSON.stringify({ indexVersion: meta.indexVersion, postings: flat })
    const metaJson = JSON.stringify(meta, null, 0)
    bytes = postingsJson.length + metaJson.length
    await mkdir(dir, { recursive: true })
    // Atomic rename, like every other derived-layer file: a half-written index
    // must never be readable (it would look like a corrupt one forever).
    const postingsTmp = path.join(dir, `${LEXICAL_POSTINGS_FILE}.tmp`)
    const metaTmp = path.join(dir, `${LEXICAL_META_FILE}.tmp`)
    await writeFile(postingsTmp, postingsJson, 'utf8')
    await writeFile(metaTmp, metaJson, 'utf8')
    await rename(postingsTmp, path.join(dir, LEXICAL_POSTINGS_FILE))
    await rename(metaTmp, path.join(dir, LEXICAL_META_FILE))
  }

  return {
    index,
    report: {
      dir,
      entries: count,
      tokens: Object.keys(flat).length,
      postings: Object.values(flat).reduce((sum, list) => sum + list.length, 0),
      bytes,
      seconds: Math.round((Date.now() - started) / 10) / 100,
      overBudget,
      reason: overBudget ? reason : '已建立',
    },
  }
}

/** An empty meta (the over-budget and corrupt cases share it). */
function emptyMeta(builtAt: string): LexicalIndexMeta {
  return {
    indexVersion: lexicalIndexVersion(),
    builtAt,
    entryCount: 0,
    avgDistinct: [0, 0, 0],
    avgTotal: [0, 0, 0],
    entries: {},
    fingerprint: '',
  }
}

/** The outcome of reading an index off disk (never throws — degradation is data). */
export type LexicalIndexStatus = 'current' | 'stale' | 'missing' | 'corrupt' | 'over-budget' | 'unreadable'

/** A loaded index plus the honest answer about whether it can be trusted. */
export interface LexicalIndexLoad {
  index: LexicalIndex | null
  status: LexicalIndexStatus
  /** A sentence a surface can print verbatim (不变量 5: 降级要说出原因). */
  note: string
  /** The directory that was checked (for diagnostics). */
  dir: string
}

/** Read the two files without any validation. */
async function readFiles(dir: string): Promise<{ meta: LexicalIndexMeta; postings: Record<string, LexicalPosting[]> } | null> {
  try {
    const meta = JSON.parse(await readFile(path.join(dir, LEXICAL_META_FILE), 'utf8')) as LexicalIndexMeta
    const body = JSON.parse(await readFile(path.join(dir, LEXICAL_POSTINGS_FILE), 'utf8')) as {
      indexVersion?: string
      postings?: Record<string, LexicalPosting[]>
    }
    if (body.postings === undefined || body.postings === null || typeof body.postings !== 'object') return null
    return { meta, postings: body.postings }
  } catch {
    return null
  }
}

/**
 * Whether an entry file changed since the index was built, and whether that
 * change touches what the index actually indexed.
 * @param storeDir - the store the index belongs to.
 * @param id - the entry id.
 * @param facts - the recorded facts.
 * @returns `'same'`, `'irrelevant'` (stats-only write) or `'changed'`.
 */
async function entryFileDelta(
  storeDir: string,
  id: string,
  facts: LexicalEntryFacts,
): Promise<'same' | 'irrelevant' | 'changed'> {
  try {
    const info = await stat(path.join(storeDir, 'entries', `${id}.json`))
    if (facts.m === info.mtimeMs && facts.s === info.size) return 'same'
    const raw = JSON.parse(await readFile(path.join(storeDir, 'entries', `${id}.json`), 'utf8')) as KbEntry
    return entryProjectionHash(raw) === facts.h ? 'irrelevant' : 'changed'
  } catch {
    return 'changed'
  }
}

/** Per-directory cache: the parsed postings are the expensive part, not the check. */
interface CacheRow {
  /** `entries/` mtimeMs + file count at the moment of the last successful check. */
  stamp: string
  index: LexicalIndex
}
const CACHE = new Map<string, CacheRow>()

/** The cheap stamp of an `entries/` directory. */
async function entriesStamp(storeDir: string): Promise<{ stamp: string; count: number } | null> {
  try {
    const info = await stat(path.join(storeDir, 'entries'))
    const names = (await readdir(path.join(storeDir, 'entries'))).filter((name) => name.endsWith('.json'))
    return { stamp: `${info.mtimeMs}:${names.length}`, count: names.length }
  } catch {
    return { stamp: '0:0', count: 0 }
  }
}

/**
 * Load the index for a store and say whether it may be used.
 *
 * Cost in the steady state: ONE `dir/entries` stat (the directory's own mtime
 * moves on every add/remove/rename). Only when that moved does it look at the
 * individual files, and only the ones whose mtime/size changed get read.
 * @param storeDir - `<home>/kb/<workspace key>`.
 * @param options - budget and cache control.
 * @returns the index (or `null`) plus the status and a printable reason.
 */
export async function loadLexicalIndex(
  storeDir: string,
  options: { budget?: LexicalIndexBudget; useCache?: boolean; maxEntries?: number } = {},
): Promise<LexicalIndexLoad> {
  const dir = lexicalIndexDir(storeDir)
  // `maxEntries` is accepted at the top level as well as inside `budget`: the
  // size limit is the one guard a caller (the CLI, a settings page) wants to
  // pass alone, and silently ignoring it would be the "knob that does nothing"
  // this project has already been bitten by.
  const budget = {
    ...DEFAULT_LEXICAL_BUDGET,
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    ...(options.budget ?? {}),
  }
  const current = await entriesStamp(storeDir)
  if (current === null) return { index: null, status: 'missing', note: '条目目录不可读', dir }

  // The budget is checked BEFORE the files are read: a corpus this large is
  // supposed to fall back to the scan, and parsing a big index to discover that
  // would be the wrong order.
  if (current.count > budget.maxEntries) {
    return {
      index: null,
      status: 'over-budget',
      note: `条目数 ${current.count} 超过索引预算 ${budget.maxEntries} — 退回全库扫描(索引对规模不划算)`,
      dir,
    }
  }

  const cached = options.useCache === false ? undefined : CACHE.get(dir)
  if (cached !== undefined && cached.stamp === current.stamp) {
    return { index: cached.index, status: 'current', note: '索引可用(目录自上次检查以来未变动)', dir }
  }

  const files = await readFiles(dir)
  if (files === null) {
    // Distinguish "never built" from "there but unreadable": the first is a
    // normal cold start, the second is a defect worth naming.
    const exists = await stat(path.join(dir, LEXICAL_META_FILE)).then(() => true).catch(() => false)
    return {
      index: null,
      status: exists ? 'corrupt' : 'missing',
      note: exists
        ? '词法索引损坏(文件在读/解析时失败) — 本次退回全库扫描,查询路径会重建'
        : '词法索引尚未建立 — 本次退回全库扫描,查询路径会建立',
      dir,
    }
  }
  if (files.meta.indexVersion !== lexicalIndexVersion()) {
    return {
      index: null,
      status: 'stale',
      note: `词法索引版本不符(${files.meta.indexVersion} ≠ ${lexicalIndexVersion()}) — 本次退回全库扫描,查询路径会重建`,
      dir,
    }
  }
  const ids = Object.keys(files.meta.entries)
  if (ids.length !== current.count) {
    return {
      index: null,
      status: 'stale',
      note: `词法索引条目数不符(索引 ${ids.length} ≠ 磁盘 ${current.count}) — 本次退回全库扫描,查询路径会重建`,
      dir,
    }
  }
  // Per-file check: only the changed files are read, and a stats-only write
  // (`touch` bumps reference counts on every retrieval) keeps the index.
  for (const id of ids) {
    const facts = files.meta.entries[id] as LexicalEntryFacts
    const delta = await entryFileDelta(storeDir, id, facts)
    if (delta === 'changed') {
      return {
        index: null,
        status: 'stale',
        note: '词法索引与条目内容不一致(条目已改写) — 本次退回全库扫描,查询路径会重建',
        dir,
      }
    }
  }

  const index: LexicalIndex = { dir, meta: files.meta, postings: files.postings }
  CACHE.set(dir, { stamp: current.stamp, index })
  return { index, status: 'current', note: '索引可用', dir }
}

/** Drop the in-process cache (tests and explicit rebuilds). */
export function forgetLexicalIndex(storeDir?: string): void {
  if (storeDir === undefined) CACHE.clear()
  else CACHE.delete(lexicalIndexDir(storeDir))
}

/**
 * The corpus statistics, WITHOUT touching the corpus.
 *
 * `df` is the postings list length (a document is in the list iff it contains
 * the token in some field, which is exactly what the scan path counts), and the
 * averages come from the meta table. The scan path and this function therefore
 * describe the same corpus — a test pins that they agree entry for entry.
 * @param index - the loaded index.
 * @returns the statistics BM25 scores with.
 */
export function lexicalStatsFrom(index: LexicalIndex): LexicalStats {
  const df = new Map<string, number>()
  for (const [token, list] of Object.entries(index.postings)) df.set(token, list.length)
  return {
    total: index.meta.entryCount,
    df,
    avgTitle: index.meta.avgDistinct[0],
    avgTag: index.meta.avgDistinct[1],
    avgText: index.meta.avgDistinct[2],
  }
}

/** One candidate as the scoring path needs it. */
export interface LexicalCandidate {
  id: string
  facts: LexicalEntryFacts
  /** The query tokens present per field (from the postings). */
  fields: PrecomputedFields
}

/**
 * The candidates for a query: the union of the postings of its tokens.
 *
 * This is the whole point of the index — an entry that contains none of the
 * query's tokens cannot score above zero (BM25F is a sum over the query's
 * tokens), so it is never loaded and never scored.
 * @param index - the loaded index.
 * @param queryTokens - the query's tokens.
 * @returns the candidates, in ascending id order (deterministic).
 */
export function lexicalCandidates(index: LexicalIndex, queryTokens: readonly string[]): LexicalCandidate[] {
  const byId = new Map<string, { facts: LexicalEntryFacts; title: Set<string>; tag: Set<string>; text: Set<string> }>()
  for (const token of queryTokens) {
    for (const posting of index.postings[token] ?? []) {
      const facts = index.meta.entries[posting.id]
      if (facts === undefined) continue
      const row = byId.get(posting.id) ?? { facts, title: new Set<string>(), tag: new Set<string>(), text: new Set<string>() }
      if (posting.tf[0] > 0) row.title.add(token)
      if (posting.tf[1] > 0) row.tag.add(token)
      if (posting.tf[2] > 0) row.text.add(token)
      byId.set(posting.id, row)
    }
  }
  return [...byId.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, row]) => ({
      id,
      facts: row.facts,
      fields: {
        lengths: { title: row.facts.dl[0], tag: row.facts.dl[1], text: row.facts.dl[2] },
        title: row.title,
        tag: row.tag,
        text: row.text,
      },
    }))
}

/**
 * The field weights the index was built with — re-exported so a caller cannot
 * forget that the postings' `tf` triple is (title, tag, text) in THAT order.
 */
export const LEXICAL_FIELD_ORDER: readonly (keyof Bm25FieldWeights)[] = ['title', 'tag', 'text']

/** Full verification: recompute every projection hash from the entries on disk. */
export async function fingerprintLexicalIndex(storeDir: string): Promise<{ ok: boolean; note: string }> {
  const files = await readFiles(lexicalIndexDir(storeDir))
  if (files === null) return { ok: false, note: '词法索引缺失或损坏' }
  const names = (await readdir(path.join(storeDir, 'entries')).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  const hash = createHash('sha256')
  const rows: Array<[string, string]> = []
  for (const name of names) {
    const id = name.slice(0, -'.json'.length)
    try {
      const entry = JSON.parse(await readFile(path.join(storeDir, 'entries', name), 'utf8')) as KbEntry
      rows.push([id, entryProjectionHash(entry)])
    } catch {
      return { ok: false, note: `条目 ${id} 不可读,无法校验` }
    }
  }
  for (const [id, projection] of rows.sort((a, b) => a[0].localeCompare(b[0]))) hash.update(`${id}\u0000${projection}\u0000`)
  const digest = hash.digest('hex')
  if (digest !== files.meta.fingerprint) {
    return { ok: false, note: `指纹不符(索引 ${files.meta.fingerprint.slice(0, 12)} ≠ 现场 ${digest.slice(0, 12)}) — 需要重建` }
  }
  return { ok: true, note: `指纹一致(${digest.slice(0, 12)}),索引描述了现场的 ${rows.length} 条条目` }
}
