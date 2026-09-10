/**
 * `@clue-harness/rag` — retrieval augmentation (M4).
 *
 * Business-package discipline (design §2.1): zero dsh imports; the only
 * sibling dependency is the kb engine (stores, queryKb, QueryHit). The
 * Cordis-facing consumption happens in kb-face (the gate's second stage) —
 * engines first, faces on demand (the M1/M2/M3a precedent).
 *
 * Three capabilities:
 * 1. `failureSignature` — the deterministic retrieval query derived from a
 *    FAILED verification (assertions + diff errors + changed files);
 * 2. `RagRetriever` + `createFulltextRetriever` — the retrieval seam
 *    (full-text now; embedding/index-epoch later per 讲解框 C) with the
 *    binding boost: entries bound to files this work unit changed re-rank
 *    up, ANNOUNCED in annotations (explainable retrieval stays a rule);
 * 3. `renderRetrievalAssist` — the gate assist block injected alongside the
 *    correction report (complaint + precedent in one message).
 *
 * @module @clue-harness/rag
 */
export { failureSignature, type SignatureOptions, type SignatureSource } from './signature.ts'
export {
  createFulltextRetriever,
  normalizePath,
  type RagRetriever,
  type RetrieveOptions,
  type RetrieverConfig,
} from './retrieve.ts'
export { renderRetrievalAssist } from './assist.ts'
