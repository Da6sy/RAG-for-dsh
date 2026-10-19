/**
 * `@clue-harness/ui-skin` browser half.
 *
 * Three contributions, one of them the actual product:
 *
 * 1. the stylesheet (`installSkinStyles`) — the whole visual language;
 * 2. the controller — wallpaper resolution, the contrast guard and the
 *    settings write queue (it mounts one fixed background stack on body);
 * 3. the `settings.section` page — registered only while the Host serves the
 *    `ui-clue-skin` namespace, so a deployment without our Host half shows no
 *    dead page (the same gate ui-settings-web-search uses).
 *
 * No other plugin is imported at runtime; every cross-plugin contract here is
 * type-only, and the bundle externals stay the dsh client baseline.
 *
 * @module @clue-harness/ui-skin/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the SlotMap merge (`settings.section`) and the ctx.configForms
// Context merge. Cross-plugin collaboration goes through services, never a
// value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SETTINGS_NS } from '../skin-config.ts'
import { installSkinStyles } from './styles.ts'
import { SkinController } from './controller.ts'
import { SkinSection } from './Section.tsx'

/** Services required before the page and layer mount. */
export const inject = ['slots', 'configForms']

/** Register every skin surface. */
export function apply(ctx: ClientContext): void {
  // The sheet rides the fiber: uninstalling this plugin restores the shell.
  ctx.effect(() => installSkinStyles(), 'ui-skin: stylesheet')

  const controller = new SkinController(ctx)
  ctx.effect(() => {
    const boot = (): void => { void controller.start() }
    if (typeof document === 'undefined') return () => {}
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
      return () => {
        document.removeEventListener('DOMContentLoaded', boot)
        controller.dispose()
      }
    }
    boot()
    return () => { controller.dispose() }
  }, 'ui-skin: wallpaper + settings adoption')

  // The page exists exactly while the Host row that owns the namespace is
  // active. `order: 5` sits between General (0) and Models (10).
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'clue-ui-skin',
    order: 5,
    label: () => '外观与背景',
    inject: () => ({ skin: controller }),
  }, SkinSection))), 'ui-skin: settings page')
}
