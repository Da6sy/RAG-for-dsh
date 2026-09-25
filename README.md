# RAG-for-dsh

**English** | [中文](README.zh.md)

A knowledge base and retrieval plugin set for **dsh**. It turns what a project has learned — conventions, pitfalls,
hard-won decisions — into knowledge that can be **searched, cited and governed**: retrieved automatically during a
conversation, and checked again when a turn ends.

## What it does

- **Retrieval.** BM25F over an inverted index (≈67 ms per query on a 3.6k-entry library), an optional vector channel,
  RRF fusion, then deterministic feature reranking. When no embedder is available it falls back to lexical-only and
  says so in the result — a lexical hit is never passed off as a semantic one.
- **Four tools for the model.** `kb_search` to retrieve, `kb_detail` to drill into the source document, `kb_propose`
  to suggest new knowledge (it can only propose; approval is always a human act), `kb_cite` to declare which entries a
  turn actually relied on.
- **Automatic retrieval and verification.** A retrieval pass before the first step injects relevant knowledge under a
  budget; the evidence gate at the end of a turn uses the failure signature to pull in precedents when verification fails.
- **Governance.** A five-state lifecycle (candidate / trusted / expired / discarded / superseded), an approval queue, a
  signal ledger, immutable source snapshots with drift detection, and manual redaction and splitting. Governance
  happens on entries; source documents stay immutable evidence.
- **User interface.** Two sections in the dsh settings page (approval center and knowledge panel), a knowledge drawer
  in the session header, and citation cards for tool calls — all built from dsh's own components and design tokens.
- **Embedding endpoint.** Any OpenAI-compatible endpoint; the key travels as a reference or through the credential
  store and is never echoed back.

## Install

```sh
dsh plugin --profile web add /path/to/RAG-for-dsh/plugins/spine /path/to/RAG-for-dsh/plugins/kb-face /path/to/RAG-for-dsh/plugins/kb-web /path/to/RAG-for-dsh/plugins/ui-kb
```

Each plugin package ships its own `cordis.patch.yml`, so the profile picks the rows up once the packages are listed in
its `dsh.profile.bundles`. The browser half needs one build: `node plugins/ui-kb/build.mjs`.

## Usage

The tools are ordinary dsh tools — the model calls them on its own, and injection plus the evidence gate apply to
every session without further wiring.

In the dsh settings page (**Knowledge Retrieval & Embeddings**) you can pick an embedder and test the connection, tune
fusion / recall depth / candidate count / reranking stages and quotas, build or rebuild the vector layer, and read the
vector-layer health and ranklog summary.

Optionally, `clue kb` manages the same data from a terminal: approvals, governance (`redline` / `split` / `retire` /
`rebind`), document ingestion, retrieval forensics (`query --explain`), cross-project generalization and layout
migration. `clue web` boots a local instance with the same plugin set.

Knowledge lives outside your workspace and never touches your git bookkeeping: `~/.clue/kb/<workspace key>` for the
project tier, `~/.clue/kb/_global` for the shared tier, `~/.clue/baselines/<workspace key>` for render baselines.

## Tech stack

- Node.js 22+ (runs TypeScript directly)
- TypeScript 6
- Cordis (plugin tree, `ctx` services, tool and slot registration, patch layers)
- `@deepseek-ai/dsh-*` (pinned release packages)
- React 18 with `@deepseek-ai/dsh-client-ui-primitives` and `ui-slots`
- esbuild (browser bundle)
- Playwright / Chromium (evidence layer)
- Node file system only: atomic JSON writes and JSONL ledgers — no database, no vector store

## Layout

```
plugins/     four dsh plugin packages: spine, kb-face, kb-web, ui-kb (each with its own cordis.patch.yml)
packages/    engine libraries: util, kb, rag, kb-loop, evidence-render, eval, compat
apps/cli/    the clue command line (knowledge management, local web instance, benchmark harness)
scripts/     benchmark and demo scripts (BEIR runs, end-to-end demos, diagnostics)
```

## Development

```sh
npm install
npm test          # 393 tests, including real-browser gates
npm run typecheck
npm run build:ui
```
