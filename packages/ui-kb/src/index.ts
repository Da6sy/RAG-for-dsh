/**
 * `@clue-harness/ui-kb` node half — deliberately empty.
 *
 * This package is a `dsh.client` dual-face plugin: the host Loader mounts
 * this entry (a no-op apply), while the client-modules node half scans the
 * package's `dsh.client` manifest declaration and serves the built browser
 * bundle (`lib/client.js`) into the boot graph. All behavior lives in the
 * browser half (`./src/client/index.ts`).
 *
 * @module @clue-harness/ui-kb
 */

/** Cordis plugin name (stable id in fibers and diagnostics). */
export const name = 'clue-ui-kb'

/**
 * The empty node half (browser surfaces own everything).
 */
export function apply(): void {
  // Nothing to mount host-side; see the module doc.
}
