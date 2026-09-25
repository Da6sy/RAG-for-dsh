/**
 * Scheduling the cross-project generalization scan (§9 of
 * `docs/落地计划-剩余工程.md`).
 *
 * The scan used to run with `await` inside the turn-stopping hook, i.e. a PASS
 * could not end until every other workspace's KB had been walked and compared.
 * That cost grows with the number of projects on the machine, while the work
 * itself is speculative (it only QUEUES a proposal for a human). So it moves to
 * a dsh background job when a job registry is available, and keeps the exact
 * old behavior when it is not.
 *
 * Three properties are the point, and each one has a test:
 *
 * 1. **Never fails the turn.** A scan that throws becomes a `failed` job (or a
 *    logged warning on the fallback path) — the turn's own outcome is decided by
 *    the evidence gate, not by a speculative scan.
 * 2. **Owner-attached.** The job carries the turn's `Agent`, so disposal cancels
 *    it with the session that asked for it (dsh's registry contract).
 * 3. **Cancellation is honest.** `suggestGeneralizations` is not interruptible
 *    mid-walk, so `cancel()` records the intent, the job still settles through
 *    `done`, and the outcome says what happened. Pretending to abort work that
 *    keeps running would be the worse lie.
 *
 * @module @clue-harness/kb-face/generalize-schedule
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobKind } from '@deepseek-ai/dsh-jobs'

/**
 * Our job kind.
 *
 * `JobKindMap` is documented as declaration-mergeable, but the interface lives
 * in `@deepseek-ai/dsh-jobs/types`, which the package's `exports` map does not
 * expose (and merging through the re-exporting entry would declare a DIFFERENT
 * interface, not extend that one). The registry treats kinds as opaque id
 * namespaces, so a checked cast is the honest way to add one — with the reason
 * written down instead of a silent `as never`.
 */
export const GENERALIZE_JOB_KIND = 'kb-generalize' as JobKind

/** The slice of dsh's job registry this module uses (kept structural for tests). */
export interface JobStarter {
  start(spec: {
    kind: JobKind
    label: string
    owner?: Agent
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
      readOutput?(): string
    }
  }): string
}

/** What one scheduling attempt did. */
export interface GeneralizeScheduleResult {
  /** `job` when a background job took it, `sync` on the fallback path. */
  via: 'job' | 'sync'
  /** The registry-issued id (job path only). */
  jobId?: string
  /** Whether the scan itself succeeded (sync path only — a job reports through its own record). */
  ok?: boolean
  /** The failure message when something went wrong (never thrown). */
  error?: string
}

/**
 * Run the scan in the background when a registry exists, else inline.
 *
 * @param options - the scan, the registry (if any) and the logging seam.
 * @returns what happened (never throws — see property 1).
 */
export async function scheduleGeneralizationScan(options: {
  /** The scan itself (injected: the real one walks every workspace). */
  scan: () => Promise<void>
  /** The job registry, when the composition has one. */
  jobs?: JobStarter | undefined
  /** The live agent the scan belongs to (owner fencing + disposal cancellation). */
  owner?: Agent
  /** One-line job label. */
  label?: string
  /** Where a failure is reported. */
  warn?: (message: string) => void
}): Promise<GeneralizeScheduleResult> {
  const warn = options.warn ?? ((): void => {})
  if (options.jobs === undefined) {
    try {
      await options.scan()
      return { via: 'sync', ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`generalization scan failed (ignored; this turn is unaffected): ${message}`)
      return { via: 'sync', ok: false, error: message }
    }
  }

  try {
    const jobId = options.jobs.start({
      kind: GENERALIZE_JOB_KIND,
      label: options.label ?? 'cross-project generalization scan',
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
      run: () => {
        let cancelled = false
        let note = ''
        const done = options.scan().then(
          () => ({ status: cancelled ? ('killed' as const) : ('completed' as const), ...(cancelled ? { detail: 'cancellation recorded (the scan is not interruptible; it ran to completion)' } : {}) }),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            warn(`generalization scan failed (ignored; this turn is unaffected): ${message}`)
            return { status: 'failed' as const, detail: message }
          },
        )
        return {
          cancel: (reason?: string) => {
            cancelled = true
            note = reason ?? ''
          },
          done,
          readOutput: () => (cancelled ? `cancellation requested${note === '' ? '' : `: ${note}`}\n` : ''),
        }
      },
    })
    return { via: 'job', jobId }
  } catch (error) {
    // A registry that refuses (no attached controller for this owner, a
    // duplicate registration) must not lose the scan: fall back to inline.
    const message = error instanceof Error ? error.message : String(error)
    warn(`generalization scan could not move to the background (${message}); running it synchronously in this turn instead`)
    try {
      await options.scan()
      return { via: 'sync', ok: true, error: message }
    } catch (inner) {
      const innerMessage = inner instanceof Error ? inner.message : String(inner)
      warn(`generalization scan failed (ignored; this turn is unaffected): ${innerMessage}`)
      return { via: 'sync', ok: false, error: innerMessage }
    }
  }
}
