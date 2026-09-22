/**
 * `clue web` — the ClueHarness web surface (M3c).
 *
 * Composition route (design revision, verified against sources):
 * the web plane boots the OFFICIAL dsh bundle stack — `@deepseek-ai/dsh-base`
 * + `@deepseek-ai/dsh-web-app` patch layers — with a clue overlay patch on
 * top. The web roster's host-service dependency closure IS dsh-base
 * (workspace/storage/projection/gateway/...); rebuilding it by hand would be
 * reinventing the base bundle, and the profile mechanism (empty root config
 * + patch stack + healed module fallback) is exactly the sanctioned way an
 * app composes bundles. This is the "dsh 生态超集宿主" posture of design
 * §1.4 made executable: dsh's own web shell underneath, clue's differences
 * (kb-face, kb-web routes, ui-kb surfaces, persona, brand, port) as one
 * patch layer a user can read in a single file.
 *
 * The spine deliberately does NOT mount here: base provides the same dsh
 * services (llm/session/tools/agents/agent-loop) the spine would, and two
 * providers for one service is a composition conflict. The spine remains the
 * CLI/headless composition layer (clue.cordis.yml); the web surface inherits
 * dsh's. kb-face works unchanged because it binds to SERVICE NAMES
 * (tools/systemPrompt/agents), not to the spine.
 *
 * Faithful copies of dsh apps/cli/profile-boot.ts mechanics (same reasons):
 * - the root config is rewritten empty on every boot (Loader tree write-back
 *   would otherwise bake composed rows in and duplicate inserts next boot);
 * - the shipped agent-preset root is a launcher-resolved overlay (only the
 *   app can resolve its own installation's config);
 * - fresh patch clones per boot (include pushes insert rows BY REFERENCE and
 *   later id-targeted patches mutate them in place);
 * - SIGTERM exits 0 (a supervisor's ordinary stop), SIGINT exits 130.
 *
 * @module @clue-harness/cli/web
 */
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { clueHostHome, clueSessionsDir } from '@clue-harness/util'

/** This installation's anchor: apps/cli's own package.json. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The profile this surface owns under the host home (`$DSH_HOME/profiles/`, default `~/.clue/host`). */
const PROFILE_NAME = 'clue-web'

/** Bundle layers in application order (base first, web-app over it). */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** The clue overlay patch beside this module. */
const CLUE_PATCH_PATH = fileURLToPath(new URL('./clue.web.patch.yml', import.meta.url))

/** Default listen port — 3090 keeps `clue web` beside a running `dsh web` (3080). */
const DEFAULT_PORT = 3090

/** The session-telemetry row the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** Options for {@link runWeb}. */
export interface RunWebOptions {
  /** The frozen launch-environment snapshot (from `loadLayeredEnv('clue')`). */
  environment: LaunchEnvironmentSnapshot
  /** Inner arguments after `clue web` (minus the flags parsed here). */
  args?: readonly string[]
  /** Listen port; 0 asks the OS (tests). Default 3090. */
  port?: number
  /** Listen host. Default loopback. */
  host?: '127.0.0.1' | '0.0.0.0'
  /** Wire SIGINT/SIGTERM to shutdown (bin default; tests drive shutdown directly). */
  manageSignals?: boolean
}

/** The booted web surface handle. */
export interface WebHandle {
  /** The settled root context. */
  ctx: Context
  /** The canonical URL to open. */
  url: string
  /** The bound port (the OS-assigned value when requested 0). */
  port: number
  /** Bounded shutdown: dispose the tree once, resolve {@link done}. */
  shutdown: (code?: number) => Promise<void>
  /** Resolves with the exit code once shutdown completes. */
  done: Promise<number>
}

/**
 * Resolve a package's root directory from this installation without the
 * package exporting `./package.json` (Node's own node_modules lookup order —
 * the dsh profile-boot `packageDirFromAnchor` posture).
 * @param packageName - the package to locate.
 * @returns its absolute directory, or undefined when not installed.
 */
function packageDir(packageName: string): string | undefined {
  for (const searchPath of createRequire(INSTALL_ANCHOR).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Parse the launcher-owned flags out of the inner arguments.
 * @param args - raw inner arguments (`clue web` tail).
 * @returns the flags plus the remaining app arguments.
 */
export function parseWebArgs(args: readonly string[]): { port?: number; host?: string; rest: string[] } {
  let port: number | undefined
  let host: string | undefined
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--port' && i + 1 < args.length) {
      const parsed = Number(args[++i])
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`clue web: --port requires an integer in 0-65535, got "${args[i]}"`)
      }
      port = parsed
    } else if (arg === '--host' && i + 1 < args.length) {
      host = args[++i]
    } else {
      rest.push(arg)
    }
  }
  if (host !== undefined && host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error(`clue web: --host only supports 127.0.0.1 or 0.0.0.0, got "${host}"`)
  }
  return { port, host, rest }
}

/**
 * Boot the ClueHarness web surface and hand back its handle. The process
 * stays alive on the webserver's listening socket; {@link WebHandle.done}
 * settles when shutdown runs (signal, `appExit`, or a direct call).
 * @param options - environment snapshot, arguments, and bind overrides.
 * @returns the settled handle.
 * @throws a labelled error when host preparation or the plugin tree fails.
 */
export async function runWeb(options: RunWebOptions): Promise<WebHandle> {
  // ClueHarness owns its host home (~/.clue/host): profiles, settings,
  // credentials, storages, sessions — NEVER shared with a co-installed dsh
  // (user decision). This ASSIGNS DSH_HOME rather than defaulting it: a
  // parent process (dsh itself, or a shell inheriting one) commonly exports
  // DSH_HOME, and honoring that would silently re-share everything the
  // independence exists to prevent. The supported override is clue's own
  // variable — CLUE_HOST_HOME (tests isolate with it; point it at ~/.dsh to
  // deliberately share). `resolveDshHome` reads the env per call, so this
  // lands before the first consumer.
  process.env.DSH_HOME = process.env.CLUE_HOST_HOME ?? clueHostHome()
  // M9 parity with the chat bin: clue's session log is central too, so a web
  // surface launched inside a repository writes nothing into it. The bundle's
  // session-persistence row takes an absolute root from here (launcher-owned
  // overlay below), never a project-relative one.
  const sessionsRoot = process.env.CLUE_SESSIONS_DIR ?? clueSessionsDir('web')
  const flags = { port: options.port, host: options.host, rest: [...(options.args ?? [])] }
  const {
    boot, composeEntries, healProfilesModuleFallback, initProfile, loadProfile,
    loadOptionalPatches, resolveProfileDir,
  } = await import('@deepseek-ai/dsh-app-boot')
  const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline')

  // Host preparation: the healed flat module fallback (every roster row
  // resolves from the profile tree through it) and the profile skeleton.
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profileDir = resolveProfileDir(PROFILE_NAME)
  initProfile(profileDir, PROFILE_BUNDLES)
  const profile = loadProfile('clue', PROFILE_NAME, INSTALL_ANCHOR)
  // Always rewritten: the whole composition is patch layers, and the Loader's
  // tree write-back would bake composed rows into this file (dsh's reason).
  writeFileSync(join(profile.dir, 'cordis.yml'), '# clue web profile root — an empty entry list; the tree is patches.\n[]\n')

  // The patch stack, in application order.
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const cluePatches = loadOptionalPatches('clue', CLUE_PATCH_PATH) ?? []
  const overlays: PatchOptions[] = []

  // Row index over the pre-overlay composition, for launcher-owned rows.
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, cluePatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }

  // The shipped agent-preset root: a roster fact only an app installation can
  // resolve — clue ships none, so the dsh installation's presets ARE the
  // shipped roster (session agents get the standard dsh toolset; the kb tools
  // reach them through the host-layer tools registry).
  const dshDir = packageDir('@deepseek-ai/dsh')
  const shippedPresetRoot = dshDir === undefined ? undefined : join(dshDir, 'config', 'agent-presets')
  if (rows.has('agent-presets') && shippedPresetRoot !== undefined && existsSync(shippedPresetRoot)) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: `${shippedPresetRoot}/`, trust: 'system' }],
      },
    })
  }

  // The bind: an explicit flag wins; the default pins 3090 (beside dsh web's
  // 3080) and restates host/port literally, replacing the bundle's
  // webStartup-derived config. The row keeps its inject edge (harmless).
  overlays.push({
    id: 'webserver',
    config: { host: flags.host ?? '127.0.0.1', port: flags.port ?? DEFAULT_PORT },
  })

  // The session log's home: an absolute central directory (M9). Restating the
  // row's whole config is the patch contract, and `root` is its only key.
  if (rows.has('session-persistence-jsonl')) {
    overlays.push({ id: 'session-persistence-jsonl', config: { root: sessionsRoot } })
  }

  // Privacy switch parity with dsh: ANY non-empty value disables telemetry
  // (off-by-mistake beats on-by-mistake).
  if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }

  // Shutdown plumbing BEFORE boot: prepare's exit callback and the signal
  // handlers reference the controller, and an inserted provider can publish
  // before sibling rows finish mounting (dsh's reason for early wiring).
  let exitCode = 0
  let settleDone: (code: number) => void = () => {}
  const done = new Promise<number>((resolve) => { settleDone = resolve })
  const app: { current?: Context } = {}
  let shuttingDown: Promise<void> | undefined
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown
    shuttingDown = (async () => {
      exitCode = code
      await app.current?.fiber.dispose()
      settleDone(code)
    })()
    return shuttingDown
  }

  const patches = structuredClone([...bundlePatches, ...profile.patches, ...cluePatches, ...overlays])
  const ctx = await boot('clue', join(profile.dir, 'cordis.yml'), patches, (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts: the frozen launch-environment
    // snapshot and the launcher facts (inner args + bounded exit request).
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    provideCmdline(hostCtx, { args: flags.rest, exit: code => void shutdown(code) })
  })
  app.current = ctx

  if (options.manageSignals !== false) {
    // SIGTERM is a supervisor's ordinary stop (exit 0); SIGINT is a user
    // interrupt (exit 130) — dsh's launcher semantics.
    process.on('SIGTERM', () => { void shutdown(0) })
    process.on('SIGINT', () => { void shutdown(130) })
  }

  // The bound port (OS-assigned when 0 was requested) — the webserver service
  // exposes it after listen; boot settled, so it is live.
  const webServer = ctx.get('webServer') as { port: number } | undefined
  if (webServer === undefined) throw new Error('clue web: webserver service missing (composition broken?)')
  const host = flags.host ?? '127.0.0.1'
  // Origin form, NO trailing slash — the format dsh's own `dsh web: <url>`
  // print uses. Launcher tools (ClueHarnessApp's parseUrl) capture this line
  // verbatim and probe `url + '/'`; a slashed base makes that request the
  // path `//`, which the host webserver cannot parse and answers with a
  // blanket 400 (new URL("//", base) throws Invalid URL, and every handler
  // rejection funnels into 400). Keep this print machine-readable.
  return { ctx, port: webServer.port, url: `http://${host}:${webServer.port}`, shutdown, done }
}

/**
 * The `clue web` bin mode: env + fail-loud, boot, and wait for shutdown.
 * @param args - inner arguments after `clue web`.
 * @returns the process exit code.
 */
export async function webMain(args: readonly string[]): Promise<number> {
  const { loadLayeredEnv, installFailLoud } = await import('@deepseek-ai/dsh-app-boot')
  const environment = loadLayeredEnv('clue')
  const handle: { current?: WebHandle } = {}
  installFailLoud('clue', process, async () => { await handle.current?.shutdown(1) })
  try {
    const parsed = parseWebArgs(args)
    const web = await runWeb({
      environment,
      args: parsed.rest,
      ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      ...(parsed.host !== undefined ? { host: parsed.host as '127.0.0.1' | '0.0.0.0' } : {}),
    })
    handle.current = web
    // The web-runtime row prints dsh's own URL line; this is the clue one
    // (the approval center's home), printed once the tree has settled.
    // One line, no decoration: the bundle's own URL print is switched off in
    // clue.web.patch.yml, so this is the only startup output.
    console.log(`clue web: ${web.url}`)
    return await web.done
  } catch (error) {
    console.error(`clue web: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
