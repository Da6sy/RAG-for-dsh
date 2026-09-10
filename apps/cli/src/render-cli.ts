/**
 * `clue render` — the M1 human entry to render verification.
 *
 *   clue render <page.html> [--project <dir>] [--viewport 1440x900] [--dpr 1]
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

const USAGE = `用法: clue render <page.html> [选项]
  --project <dir>     项目根目录(默认当前目录)
  --viewport <WxH>    视口(默认 1440x900)
  --dpr <n>           设备像素比(默认 1)
  --record            把本次采集存为基准(待人工确认)
  --confirm           人工确认现有基准(不启动浏览器)
  --show              仅输出单次结构树+检查(不比对)
  --mask <selector>   屏蔽易变区域文本(可重复)
  --json <file>       同时把快照 JSON 写到文件
默认模式为 compare:有基准就比对,没有基准退化为 show 并提示 --record。`

interface ParsedArgs {
  page: string
  project: string
  viewport: { width: number; height: number }
  dpr: number
  mode: InspectMode
  masks: string[]
  jsonOut: string | undefined
}

function parseArgs(argv: string[]): ParsedArgs {
  let page: string | null = null
  let project = process.cwd()
  let viewport = { width: 1440, height: 900 }
  let dpr = 1
  let mode: InspectMode = 'compare'
  const masks: string[] = []
  let jsonOut: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`选项 ${arg} 缺少参数\n\n${USAGE}`)
      return value
    }
    switch (arg) {
      case '--project': project = next(); break
      case '--viewport': {
        const match = next().match(/^(\d+)x(\d+)$/)
        if (match === null) throw new Error(`--viewport 需要 WxH 格式\n\n${USAGE}`)
        viewport = { width: Number(match[1]), height: Number(match[2]) }
        break
      }
      case '--dpr': dpr = Number(next()); break
      case '--record': mode = 'record'; break
      case '--confirm': mode = 'confirm'; break
      case '--show': mode = 'show'; break
      case '--mask': masks.push(next()); break
      case '--json': jsonOut = next(); break
      case '--help': case '-h': throw new HelpRequested()
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}\n\n${USAGE}`)
        if (page !== null) throw new Error(`只接受一个页面参数(已有 ${page},又见 ${arg})\n\n${USAGE}`)
        page = arg
    }
  }
  if (page === null) throw new Error(`缺少页面参数\n\n${USAGE}`)
  return { page, project, viewport, dpr, mode, masks, jsonOut }
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
    })
    process.stdout.write(result.report)
    return result.exitOk ? 0 : 1
  } catch (error) {
    console.error(`clue render: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
