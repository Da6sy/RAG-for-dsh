# ClueHarness for dsh

**English** | [中文](README.zh.md)

A self-contained **dsh plugin set** for a governed, cited knowledge base, plus a liquid-glass appearance plugin.
It runs inside a dsh web profile. It is not a separate CLI or application.

## The four plugins

| Plugin | Face | What it adds |
| --- | --- | --- |
| `@clue-harness/kb-face` | host | `ctx.kb`, the four model tools (`kb_search`, `kb_detail`, `kb_propose`, `kb_cite`), retrieval-first pre-step injection, source-drift tracking, and the end-of-turn evidence gate. |
| `@clue-harness/kb-web` | host (HTTP) | Same-origin `/api/clue-kb/*` routes: settings, approvals, entry governance, source documents/原文 and chunks, embeddings, search, and import. |
| `@clue-harness/ui-kb` | browser | Settings sections (approval center + knowledge panel), citation cards, the session-header knowledge drawer, and the ClueHarness brand/theme layer. |
| `@clue-harness/ui-skin` | host + browser | Full-window wallpaper, adjustable scrim, panel frost, liquid-glass bubbles, terminal/file-viewer glass, and the "Appearance & Background" settings page (`ui-clue-skin`). |

The four plugins share seven engine packages: `util`, `compat`, `kb`, `rag`, `kb-loop`, `evidence-render`, `eval`.
The engines are usable on their own; `compat` is the small layer that wraps the dsh APIs the knowledge base relies on.

## What it does

- **Retrieval** — BM25F over an inverted index, an optional vector channel, RRF fusion, and deterministic feature
  reranking. With no embedder it falls back to lexical-only and says so; a lexical hit is never passed off as a
  semantic one.
- **Four tools for the model** — `kb_search` retrieves, `kb_detail` drills into the source document, `kb_propose`
  suggests new knowledge (models can only propose; approval is human), and `kb_cite` declares which entries a turn
  actually relied on.
- **Automatic retrieval and verification** — a retrieval pass before the first step injects relevant knowledge under
  a budget; the end-of-turn evidence gate pulls in precedents by failure signature when verification fails.
- **Governance** — a five-state lifecycle (candidate / trusted / expired / discarded / superseded), an approval queue,
  a signal ledger, immutable source snapshots with drift detection, and manual redaction and splitting. Governance
  happens on entries; source documents stay immutable evidence.
- **Browser surfaces** — two sections in the dsh settings page, the session-header knowledge drawer, and citation
  cards, all built from dsh's own components and design tokens.
- **Appearance** — wallpaper presets or a local image, an adjustable read-through mask, frosted panels, liquid-glass
  bubbles, and glass terminal/file-viewer panes. The skin's settings live in the `ui-clue-skin` namespace; the
  background image stays in the browser's IndexedDB.
- **Embedding endpoint** — any OpenAI-compatible endpoint; the key travels as a reference or through the credential
  store and is never echoed back.

## Install into a dsh profile

```sh
dsh plugin --profile web add \
  /path/to/clue-harness/plugins/kb-face \
  /path/to/clue-harness/plugins/kb-web \
  /path/to/clue-harness/plugins/ui-kb \
  /path/to/clue-harness/plugins/ui-skin
```

Each package ships its own `cordis.patch.yml`, so adding the four to the profile's `dsh.profile.bundles` is enough:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@clue-harness/kb-face",
        "@clue-harness/kb-web",
        "@clue-harness/ui-kb",
        "@clue-harness/ui-skin"
      ]
    }
  }
}
```

Build the two browser halves once:

```sh
npm run build:ui   # plugins/ui-kb/lib/client.js + plugins/ui-skin/lib/client.js
```

**Local TypeScript plugins must be linked, not copied into `node_modules`.** Node's type stripping refuses files under
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The reference profile uses `link:` for `ui-skin` and
symlinked plugin directories for the other three. Shipping compiled artifacts is the other supported route.

The reference profile may use an **unbranded staging copy** of `ui-kb`/`kb-web`; this repository carries the
ClueHarness-branded source. Keep that in mind when comparing the running UI with this source.

## Configuration

- **Knowledge base** — dsh settings → "Knowledge Retrieval & Embeddings". Pick an embedder, test the connection, tune
  fusion/recall depth/candidate count/reranking, build or rebuild the vector layer, and read its health.
  `kb-face`'s `config.cwd` is the default workspace anchor; the session's validated cwd decides the project tier.
- **Knowledge location** — `~/.clue/kb/<workspace key>` for the project tier and `~/.clue/kb/_global` for the shared
  tier, outside your workspace and outside git.
- **Appearance** — dsh settings → "Appearance & Background". Presets are clear / balanced / frosted; "clear" means
  strength 100% + blur 0. Transparency and blur are independent. The terminal and file viewer follow the same glass
  controls. The session header keeps its glass tint but drops the blur, because the knowledge drawer is fixed inside
  it and a filtered ancestor would clip the drawer to the header's height.

## Layout

```
plugins/   ui-skin, ui-kb, kb-web, kb-face
packages/  util, compat, kb, rag, kb-loop, evidence-render, eval
```

## Development

```sh
npm install
npm run build:ui
npm run typecheck
npm test
```

`npm test` runs the 386 unit and contract tests in `packages/` and `plugins/` (about 7.5 seconds on the reference
machine). The browser halves are built with esbuild. `ui-skin`'s contract tests read the installed dsh client bundles,
so the dsh client packages are declared as devDependencies of that plugin.

## Tech stack

- Node.js 22.19+ (TypeScript source, type stripping)
- TypeScript 6, Cordis, React 18, esbuild
- dsh 0.2.0-rc.2 release packages (pinned)
- Node file system only: atomic JSON writes and JSONL ledgers — no database, no vector store
- Playwright / Chromium only for the engine-level evidence-render tests

## License

MIT
