/**
 * The channel-profile table (V3, 原规划 §7.3) — configuration, never branching code.
 *
 * §1.1 established the fact this file exists for: the three retrieval channels
 * have **two different query authors**. The `kb_search` tool's query is written
 * by the model (short, intentional, ideal for an embedding); the `pre-step`
 * injection's query is the human's whole message (long, multi-intent, full of
 * code fences) and the gate's query is a mechanical failure signature
 * (assertions, error text, file paths). Feeding all three through one
 * configuration would make the first ablation unattributable — and would embed
 * a wall of prose whose only real signal is the paths inside it.
 *
 * So each channel gets a row: fusion weights, whether binding recall
 * participates, and a NORMALIZATION spec. Per 拍板 4 the first three milestones
 * shipped only `tool`; V3 lights up the other two.
 *
 * Normalization is where the profile stops being a number table and starts
 * doing work. Two rules matter:
 *
 * - **Identifiers and paths belong to the lexical channel only.** A path is a
 *   token, not a meaning: embedding `packages/kb/src/query.ts:141` dilutes the
 *   vector with noise and can even make two unrelated files look similar (they
 *   share `packages/`). The gate profile therefore SPLITS them out: lexical
 *   sees everything, the embedder sees only the prose.
 * - **A long query must be bounded before it is embedded.** A 4000-character
 *   pasted message is truncated at `maxChars` and loses its code fences, which
 *   are boilerplate for retrieval purposes.
 *
 * @module @clue-harness/rag/profiles
 */

/** How a profile turns a raw query into the two channel texts. */
export interface ProfileNormalization {
  /** Truncate to this many characters (0 = no limit). */
  maxChars: number
  /** Drop fenced code blocks and inline code before use. */
  stripCodeFences: boolean
  /** Remove path/identifier-like tokens from the SEMANTIC text (lexical keeps them). */
  splitIdentifiers: boolean
}

/** One retrieval channel's behavior. */
export interface ChannelProfile {
  /** Profile name (`tool` | `pre-step` | `gate`). */
  name: string
  /** Fusion weight of the lexical channel. */
  lexicalWeight: number
  /** Fusion weight of the vector channel. */
  semanticWeight: number
  /** Whether binding recall participates (the caller must supply changed files). */
  bindingRecall: boolean
  /** How the raw query is prepared for each channel. */
  normalization: ProfileNormalization
}

/** The shipped profiles (原规划 §7.3's table, verbatim). */
export const CHANNEL_PROFILES: Record<string, ChannelProfile> = {
  // The model writes this one: short, intentional, already a sentence.
  tool: {
    name: 'tool',
    lexicalWeight: 1,
    semanticWeight: 1,
    bindingRecall: false,
    normalization: { maxChars: 0, stripCodeFences: false, splitIdentifiers: false },
  },
  // The human's whole turn: long, multi-intent, code-heavy. The vector channel
  // gets less weight (a whole message is a weak single embedding) and the text
  // is bounded.
  'pre-step': {
    name: 'pre-step',
    lexicalWeight: 1,
    semanticWeight: 0.6,
    bindingRecall: false,
    normalization: { maxChars: 1200, stripCodeFences: true, splitIdentifiers: false },
  },
  // A mechanical failure signature: assertions + error text + file paths.
  // Lexical is up-weighted (paths and identifiers are the gold here) and the
  // semantic channel gets almost nothing — and only from the prose.
  gate: {
    name: 'gate',
    lexicalWeight: 1.3,
    semanticWeight: 0.3,
    bindingRecall: true,
    normalization: { maxChars: 0, stripCodeFences: false, splitIdentifiers: true },
  },
}

/** Resolve one profile by name (unknown names fall back to `tool`). */
export function resolveProfile(name: string | undefined): ChannelProfile {
  return CHANNEL_PROFILES[name ?? 'tool'] ?? (CHANNEL_PROFILES.tool as ChannelProfile)
}

/** One query, split into what each channel should see. */
export interface NormalizedQuery {
  /** What the lexical channel scores (always the whole query). */
  lexical: string
  /** What the vector channel embeds (identifiers already removed when asked). */
  semantic: string
  /** The identifier/path-like tokens that were kept out of the embedding. */
  identifiers: string[]
  /** True when the query was truncated by the profile. */
  truncated: boolean
}

/** Whether one whitespace-delimited token looks like an identifier or a path. */
export function isIdentifierToken(token: string): boolean {
  const bare = token.replace(/^[`'"[({<]+/, '').replace(/[`'"[)\]}>.,;:!?]+$/, '')
  if (bare.length < 2) return false
  // A path separator is decisive: `src/a.ts`, `packages/kb`.
  if (bare.includes('/') || bare.includes('\\')) return true
  // A filename extension or a dotted handler: `query.ts`, `kb.ingest`.
  if (/^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(bare)) return true
  // A hyphen/underscore-joined symbol: `focus-trap`, `windowScore_map`.
  if (/^[A-Za-z][\w]*(?:[-_][\w]+)+$/.test(bare)) return true
  // A SCREAMING constant: `API_KEY`, `KB_FORMAT_VERSION`.
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(bare)) return true
  // A version or a numeric code: `v2.1`, `4.5.2`, `E401`.
  if (/^v?\d+(?:\.\d+)+$/.test(bare)) return true
  if (/^[A-Z]?\d{3,}$/.test(bare)) return true
  // camelCase with an interior capital: `updateEntryText`.
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(bare)) return true
  return false
}

/** Remove fenced code blocks and inline code (boilerplate for retrieval). */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/**
 * Prepare one raw query for the two channels, per the profile's spec.
 *
 * The lexical text is ALWAYS the (possibly truncated) whole query: the first
 * level's tokenizer is what makes paths and identifiers findable, and taking
 * them away from it would undo the very case that motivates the gate profile.
 * Only the semantic text loses them.
 * @param profile - the profile in effect.
 * @param text - the raw query.
 * @returns the per-channel texts plus what was removed.
 */
export function normalizeQuery(profile: ChannelProfile, text: string): NormalizedQuery {
  const spec = profile.normalization
  let working = text.trim()
  if (spec.stripCodeFences) working = stripCode(working)
  working = working.replace(/\s+/g, ' ').trim()
  const truncated = spec.maxChars > 0 && working.length > spec.maxChars
  if (truncated) working = working.slice(0, spec.maxChars)

  const identifiers: string[] = []
  let semantic = working
  if (spec.splitIdentifiers) {
    const kept: string[] = []
    for (const token of working.split(' ')) {
      if (token === '') continue
      if (isIdentifierToken(token)) identifiers.push(token)
      else kept.push(token)
    }
    semantic = kept.join(' ')
  }
  return { lexical: working, semantic, identifiers, truncated }
}
