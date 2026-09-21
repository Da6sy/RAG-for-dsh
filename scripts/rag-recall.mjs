/**
 * Thin wrapper: `node scripts/rag-recall.mjs …` == `clue recall …`.
 *
 * The implementation lives in `apps/cli/src/recall-cli.ts` so the command ships
 * with the globally linked `clue` bin and works from any cwd. This shim keeps
 * the historical script path working for anyone who bookmarked it.
 *
 * @module @clue-harness/scripts/rag-recall
 */
import { recallMain } from '../apps/cli/src/recall-cli.ts'

process.exitCode = await recallMain(process.argv.slice(2))
