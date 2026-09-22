/**
 * `clue render` — the M1 human entry to render verification.
 *
 *   clue render <page.html> [--project <dir>] [--home <dir>] [--viewport 1440x900] [--dpr 1]
 *                  [--record | --confirm | --show]   (default: compare)
 *                  [--mask <selector>]... [--json <out>]
 *
 * Exit codes: 0 clean · 1 error-severity evidence (diff errors or failed
 * error-severity assertions — scriptable gate) · 2 usage/environment failure.
 *
 * Hand-rolled arg parsing on purpose: M1 has no commander dependency, and a
 * ten-flag surface does not earn one yet.
 *
 * @module @clue-harness/cli/render
 */
import { inspectPage, type InspectMode } from '@clue-harness/evidence-render'

const USAGE = `Usage: clue render <page.html> [options]
  --project <dir>     project root directory (default: current directory)
  --home <dir>        central home (baselines live in <home>/baselines/<workspace key>; default: $CLUE_HOME or ~/.clue)
  --viewport <WxH>    viewport (default: 1440x900)
  --dpr <n>           device pixel ratio (default: 1)
  --record            save this capture as the baseline (pending human confirmation)
  --confirm           human-confirm the existing baseline (does not launch a browser)
  --show              print the one-off structure tree + checks only (no comparison)
  --mask <selector>   mask text in volatile regions (repeatable)
  --json <file>       also write the snapshot JSON to a file
Default mode is compare: with a baseline it compares; without one it degrades to show and suggests --record.`

interface ParsedArgs {
  page: string
  project: string
  viewport: { width: number; height: number }
  dpr: number
  mode: InspectMode
  masks: string[]
  jsonOut: string | undefined
  home: string | undefined
}

function parseArgs(argv: string[]): ParsedArgs {
  let page: string | null = null
  let project = process.cwd()
  let viewport = { width: 1440, height: 900 }
  let dpr = 1
  let mode: InspectMode = 'compare'
  const masks: string[] = []
  let jsonOut: string | undefined
  let home: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`render: option ${arg} requires an argument\n\n${USAGE}`)
      return value
    }
    switch (arg) {
      case '--project': project = next(); break
      case '--viewport': {
        const match = next().match(/^(\d+)x(\d+)$/)
        if (match === null) throw new Error(`render: --viewport requires WxH format\n\n${USAGE}`)
        viewport = { width: Number(match[1]), height: Number(match[2]) }
        break
      }
      case '--dpr': dpr = Number(next()); break
      case '--record': mode = 'record'; break
      case '--confirm': mode = 'confirm'; break
      case '--show': mode = 'show'; break
      case '--mask': masks.push(next()); break
      case '--json': jsonOut = next(); break
      case '--home': home = next(); break
      case '--help': case '-h': throw new HelpRequested()
      default:
        if (arg.startsWith('-')) throw new Error(`render: unknown option ${arg}\n\n${USAGE}`)
        if (page !== null) throw new Error(`render: only one page argument is accepted (got ${page}, then ${arg})\n\n${USAGE}`)
        page = arg
    }
  }
  if (page === null) throw new Error(`render: missing page argument\n\n${USAGE}`)
  return { page, project, viewport, dpr, mode, masks, jsonOut, home }
}

class HelpRequested extends Error {}

/**
 * CLI entry.
 * @param argv - args after `clue render`.
 * @returns process exit code.
 */
export async function renderMain(argv: string[]): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(USAGE)
      return 0
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  try {
    const result = await inspectPage({
      projectRoot: parsed.project,
      page: parsed.page,
      mode: parsed.mode,
      viewport: parsed.viewport,
      dpr: parsed.dpr,
      maskSelectors: parsed.masks,
      jsonOut: parsed.jsonOut,
      // M9: baselines are addressed through the central home, keyed by the
      // workspace path — the page's own directory stays free of clue state.
      ...(parsed.home !== undefined ? { home: parsed.home } : {}),
    })
    process.stdout.write(result.report)
    return result.exitOk ? 0 : 1
  } catch (error) {
    console.error(`clue render: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
