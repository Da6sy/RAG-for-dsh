#!/usr/bin/env node
/**
 * `clue` — ClueHarness command entry.
 *
 * M0 shipped one mode (chat). M1 adds `render` — and with it the dispatch
 * shape dsh's own bin uses: parse the mode first, dynamically import only
 * that mode's machinery, so unrelated modes never load (chat does not pay
 * for Playwright; render does not boot the agent tree at all).
 *
 *   clue                     interactive chat (boots the composition)
 *   clue web                 web surface (dsh web shell + clue patch stack)
 *   clue render <page.html>  render inspection (no agent tree involved)
 *   clue kb <命令>            knowledge base (see `clue kb help`)
 *   clue recall               retrieval-recall harness (synthetic set, seconds)
 *   clue --help | --version
 *
 * @module @clue-harness/cli/bin
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const USAGE = `clue — ClueHarness(M0/M1/M2/M3)

Usage:
  clue                      interactive chat (boots the full agent composition)
  clue web [--port N]       web surface (dsh web shell + ClueHarness knowledge base panel, default port 3090)
  clue render <page.html>   render verification (structure tree / baseline comparison; see clue render --help)
  clue kb <command>         knowledge base (add/remove/query, state machine, approval queue; see clue kb help)
  clue recall [--chunks n]  retrieval recall / ablation harness (synthetic corpus + six query classes + hard guardrails; see clue recall --help)
  clue bench <command>      artifact management for public benchmark runs (index/compare/cleanup; see clue bench help)
  clue --help               this help

Vector and rerank configuration lives on the clue kb side: clue kb embed-config / embed / doctor / query --explain (see clue kb help)
  clue --version            version number`

function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const [, , command, ...rest] = process.argv

if (command === '--help' || command === '-h') {
  console.log(USAGE)
} else if (command === '--version') {
  console.log(readVersion())
} else if (command === 'render') {
  const { renderMain } = await import('./render-cli.ts')
  process.exitCode = await renderMain(rest)
} else if (command === 'web') {
  const { webMain } = await import('./web.ts')
  process.exitCode = await webMain(rest)
} else if (command === 'kb') {
  const { kbMain } = await import('./kb-cli.ts')
  process.exitCode = await kbMain(rest)
} else if (command === 'bench') {
  const { benchMain } = await import('./bench-cli.ts')
  process.exitCode = await benchMain(rest)
} else if (command === 'recall') {
  const { recallMain } = await import('./recall-cli.ts')
  process.exitCode = await recallMain(rest)
} else if (command === undefined) {
  const { clueHostHome, clueSessionsDir } = await import('@clue-harness/util')
  // Same host-home rule as `clue web`: DSH_HOME is ASSIGNED to the clue host
  // home (CLUE_HOST_HOME overrides), never inherited — an exported DSH_HOME
  // from a surrounding dsh is exactly the sharing this decouples.
  process.env.DSH_HOME = process.env.CLUE_HOST_HOME ?? clueHostHome()
  // M9: the session log is central too (`<home>/sessions/cli`), so running
  // `clue` in somebody's repository leaves nothing behind in it. The
  // composition reads this through CLUE_SESSIONS_ROOT.
  process.env.CLUE_SESSIONS_ROOT = process.env.CLUE_SESSIONS_DIR ?? clueSessionsDir('cli')
  const { loadLayeredEnv, installFailLoud, boot } = await import('@deepseek-ai/dsh-app-boot')
  const { runChat } = await import('./chat.ts')
  // .env layering (DEEPSEEK_API_KEY usually lands here), then the fail-loud
  // net, then boot the fixed composition and hand the settled tree to chat.
  loadLayeredEnv('clue')
  installFailLoud('clue')
  const configPath = fileURLToPath(new URL('./clue.cordis.yml', import.meta.url))
  try {
    const ctx = await boot('clue', configPath)
    await runChat(ctx)
  } catch (error) {
    console.error(`clue: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
} else {
  console.error(`clue: unknown command "${command}"\n\n${USAGE}`)
  process.exitCode = 2
}
