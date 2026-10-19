/**
 * A minimal settings + credentials host for NON-Cordis surfaces (V1, 原规划 §9.8).
 *
 * The settings page gets `ctx.settings` and `ctx.credentials` from the running
 * host. The embedding worker (spawned by the host-side embedding entry) has
 * no Cordis context of its own — but it must read and write the SAME document,
 * or a configuration made in one place would not exist in the other.
 *
 * So the worker mounts dsh's own profile form stack — Config Editor and Settings —
 * beside `@deepseek-ai/dsh-credentials-local` on a Cordis Loader context, pointed at
 * the ClueHarness host home. Nothing here reimplements storage: the YAML
 * document, its writer lock, its comment-preserving leaf diff and the
 * credential store's owner-only file are all dsh's, which is exactly the
 * "不自造一套" the plan asks for (§9.1).
 *
 * `DSH_HOME` is passed EXPLICITLY rather than read from the environment: the
 * embedding worker never assigns it, and inheriting an ambient `DSH_HOME` would
 * silently read a co-installed dsh's settings instead of ClueHarness's own.
 *
 * @module @clue-harness/kb-face/embedding-host
 */
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { boot, initProfile, loadOptionalPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { clueHostHome } from '@clue-harness/util'
import { registerEmbeddingSettings } from './embedding-config.ts'

/** One opened host: the context plus an honest teardown. */
export interface EmbeddingHost {
  ctx: Context
  /** The harness home the document lives in (for diagnostics). */
  dshHome: string
  /** The settings document path (never the credentials path — that one stays private). */
  documentPath: string | undefined
  /** Stop the providers and release the file watchers/locks. */
  close(): Promise<void>
}

/**
 * Wait until a service appears on the context.
 *
 * Providers register their service during `init`, which settles asynchronously;
 * polling a predicate is deterministic where a fixed sleep is a guess (and the
 * guess is wrong exactly when a machine is slow).
 * @param ctx - the context to poll.
 * @param name - the service name.
 * @param timeoutMs - how long to wait before giving up.
 * @returns true when the service appeared.
 */
async function waitForService(ctx: Context, name: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ctx.get(name) !== undefined) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Open the settings + credentials providers for the ClueHarness host home.
 * @param options - an explicit `dshHome` override (tests) and the document path.
 * @returns the host, or throws when a provider never came up (fail loud: a
 *   configuration CLI that silently writes nowhere is worse than one that fails).
 */
export async function openEmbeddingHost(options: { dshHome?: string } = {}): Promise<EmbeddingHost> {
  const dshHome = options.dshHome ?? clueHostHome()
  const profileDir = join(dshHome, 'profiles', 'clue-kb')
  const configPath = join(profileDir, 'cordis.yml')
  initProfile(profileDir, [])
  const installAnchor = fileURLToPath(new URL('../../package.json', import.meta.url))
  const require = createRequire(import.meta.url)
  const initialEntries = [
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    { id: 'clue-kb-embedding', name: '@clue-harness/kb-face/embedding-entry' },
    { id: 'clue-kb-retrieval', name: '@clue-harness/kb-face/retrieval-entry' },
  ]
  await writeFile(configPath, '[]\n')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patch = loadOptionalPatches('clue', patchPath) ?? []
  const presentIds = new Set(patch.flatMap(operation => operation.insert?.map(entry => entry.id) ?? []))
  const missingEntries = initialEntries.filter(entry => !presentIds.has(entry.id))
  if (missingEntries.length > 0) patch.push({ insert: missingEntries })
  await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`)
  const initialProfile = loadProfileDirectory('clue', profileDir, installAnchor)
  const ctx = await boot(
    'clue',
    configPath,
    initialProfile.patches,
    async (hostContext) => {
      hostContext.provide('profileContext', {
        name: 'clue-kb',
        dir: profileDir,
        patchPath,
        installAnchor,
        startedBundles: [],
        cwd: process.cwd(),
        home: dshHome,
        overlays: [],
      })
      await hostContext.plugin(ConfigEditor)
      await hostContext.plugin(SettingsForms)
      await hostContext.plugin(CredentialsLocal as never, { dshHome, watch: false } as never)
    },
    pathToFileURL(dirname(require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))).href,
  )
  const [settingsReady, credentialsReady] = await Promise.all([
    waitForService(ctx, 'settings'),
    waitForService(ctx, 'credentials'),
  ])
  if (!settingsReady || !credentialsReady) {
    throw new Error(`embedding host: cannot open the settings/credentials services (${dshHome}): settings=${settingsReady} credentials=${credentialsReady}`)
  }
  await registerEmbeddingSettings(ctx)
  await ctx.loader.await()
  const settings = ctx.get('settings') as unknown as { documentPath?: string } | undefined
  return {
    ctx,
    dshHome,
    documentPath: settings?.documentPath,
    close: () => ctx.fiber.dispose(),
  }
}
