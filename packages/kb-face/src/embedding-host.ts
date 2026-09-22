/**
 * A minimal settings + credentials host for NON-Cordis surfaces (V1, 原规划 §9.8).
 *
 * The settings page gets `ctx.settings` and `ctx.credentials` from the running
 * host. The CLI (`clue kb embed-config …`, `clue kb embed`, `clue kb doctor`)
 * has no host — but it must read and write the SAME document, or a
 * configuration made in one place would not exist in the other.
 *
 * So the CLI mounts dsh's own providers — `@deepseek-ai/dsh-settings-file` and
 * `@deepseek-ai/dsh-credentials-local` — on a bare Cordis context, pointed at
 * the ClueHarness host home. Nothing here reimplements storage: the YAML
 * document, its writer lock, its comment-preserving leaf diff and the
 * credential store's owner-only file are all dsh's, which is exactly the
 * "不自造一套" the plan asks for (§9.1).
 *
 * `DSH_HOME` is passed EXPLICITLY rather than read from the environment: the
 * `clue kb` path never assigns it, and inheriting an ambient `DSH_HOME` would
 * silently read a co-installed dsh's settings instead of ClueHarness's own.
 *
 * @module @clue-harness/kb-face/embedding-host
 */
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { apply as applyPiAi } from '@deepseek-ai/dsh-llm-pi-ai'
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
  const ctx = new Context()
  const fibers = [
    ctx.plugin(FileSettingsProvider as never, { dshHome, watch: false } as never),
    ctx.plugin(CredentialsLocal as never, { dshHome, watch: false } as never),
  ] as unknown as Array<{ dispose?: () => Promise<void> | void }>
  // The pi-ai row is what REGISTERS the `llm-pi-ai` settings namespace — the
  // section that names the user's configured providers and their key
  // references. Without it a minimal host can read neither, which is exactly
  // how the embedder picker ended up offering only the built-in catalog in the
  // CLI while the web page saw the real providers. Mounting it (dormant: it
  // creates no route until the section supplies profiles) makes both surfaces
  // answer the same question the same way.
  fibers.push(ctx.plugin(LlmRuntime as never, {} as never) as unknown as { dispose?: () => Promise<void> | void })
  const [settingsReady, credentialsReady] = await Promise.all([
    waitForService(ctx, 'settings'),
    waitForService(ctx, 'credentials'),
  ])
  if (!settingsReady || !credentialsReady) {
    throw new Error(`embedding host: cannot open the settings/credentials services (${dshHome}): settings=${settingsReady} credentials=${credentialsReady}`)
  }
  if (await waitForService(ctx, 'llm')) {
    try {
      applyPiAi(ctx, {} as never)
    } catch {
      // A composition without pi-ai (or a version that changed its shape) must
      // not break embedding configuration: the picker then falls back to the
      // built-in catalog, which still works.
    }
  }
  registerEmbeddingSettings(ctx)
  const settings = ctx.get('settings') as unknown as { documentPath?: string } | undefined
  return {
    ctx,
    dshHome,
    documentPath: settings?.documentPath,
    close: async () => {
      // Disposing the provider fibers drains queued writes and closes the file
      // watchers, which is what makes a write performed a millisecond earlier
      // durable and lets the process exit without a lingering handle.
      for (const fiber of fibers) await fiber.dispose?.()
    },
  }
}
