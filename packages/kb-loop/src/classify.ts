/**
 * Change classification — the first-class trigger rule (design doc §4.3).
 *
 * "渲染提取不是常规动作,是条件动作": render verification runs ONLY when the
 * changed files intersect the project's render surface. Pure-backend turns
 * never open a browser and are never blocked by the evidence gate.
 *
 * The render surface is per-workspace configurable (M9: it lives in the
 * workspace's record inside `<home>/workspaces.json` — the old
 * `<root>/.clue/render-surface.json` file was imported by `clue kb migrate`,
 * so no ClueHarness state stays inside the project directory). Arrays REPLACE
 * the defaults — explicit over implicit — with sane defaults for the M1 scope
 * (plain HTML/CSS projects).
 *
 * @module @clue-harness/kb-loop/classify
 */
import { getRenderSurface, type RenderSurfaceSettings } from '@clue-harness/kb'

/** What counts as "renderable" in this project. */
export interface RenderSurfaceConfig {
  /** File extensions (lowercase, with dot) that are renderable. */
  extensions: string[]
  /** Project-relative directory prefixes whose files are renderable. */
  pathPrefixes: string[]
}

export const DEFAULT_RENDER_SURFACE: RenderSurfaceConfig = {
  extensions: ['.html', '.htm', '.css'],
  pathPrefixes: ['styles/', 'assets/styles/'],
}

/**
 * Load one workspace's render surface: its stored override when it has one,
 * else the shipped defaults. A stored array REPLACES that array's defaults (no
 * merge surprises). A malformed roster fails loud inside the registry read,
 * so a misconfiguration can never silently widen or narrow what triggers.
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override (default CLUE_HOME/~/.clue).
 * @returns the effective config.
 */
export async function loadRenderSurfaceConfig(projectRoot: string, home?: string): Promise<RenderSurfaceConfig> {
  const stored: RenderSurfaceSettings | undefined = await getRenderSurface(projectRoot, home)
  const extensions = stored?.extensions ?? DEFAULT_RENDER_SURFACE.extensions
  const pathPrefixes = stored?.pathPrefixes ?? DEFAULT_RENDER_SURFACE.pathPrefixes
  if (!Array.isArray(extensions) || !Array.isArray(pathPrefixes)) {
    throw new Error(`渲染面配置格式错误: ${projectRoot} 的 renderSurface.extensions/pathPrefixes 必须是数组`)
  }
  return {
    extensions: extensions.map((e) => e.toLowerCase().startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`),
    pathPrefixes: pathPrefixes.map((p) => p.replace(/\\/g, '/').replace(/^\/+/, '')),
  }
}

/** Normalize any platform's path to a project-relative posix string. */
export function normalizeRelative(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.?\//, '')
}

/**
 * Split a changed-file list by the render surface.
 * @param files - changed paths (relative or absolute-under-root; normalized here).
 * @param config - effective render-surface config.
 * @returns renderable vs everything else, both deterministic (input order).
 */
export function classifyChanges(
  files: readonly string[],
  config: RenderSurfaceConfig = DEFAULT_RENDER_SURFACE,
): { renderable: string[]; other: string[] } {
  const renderable: string[] = []
  const other: string[] = []
  for (const raw of files) {
    const file = normalizeRelative(raw)
    const lower = file.toLowerCase()
    const byExtension = config.extensions.some((ext) => lower.endsWith(ext))
    const byPrefix = config.pathPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
    if (byExtension || byPrefix) renderable.push(file)
    else other.push(file)
  }
  return { renderable, other }
}
