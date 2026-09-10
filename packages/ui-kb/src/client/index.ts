/**
 * `@clue-harness/ui-kb` browser half — the ClueHarness surfaces assembly.
 *
 * Five contributions, all through the slot system's single API (dsh client
 * discipline: `slots.inject` waits on each declaration, withdraws with it,
 * and rolls back atomically — the generator form for multi-registrations):
 *
 * 1. `settings.section` ×2 — the approval center (design §6.1, priority one)
 *    and the KB panel (§6.2), each a full page in the settings nav;
 * 2. `tool.call.toolview` keyed `kb_search` / `kb_propose` — the citation
 *    cards (§6.4): a registered key REPLACES the generic tool row, so the
 *    knowledge the model consulted renders as first-class product UI;
 * 3. `sidebar.brand.mark` / `sidebar.brand.name` /
 *    `conversation.hero.brand.mark` — the ClueHarness brand takeover (the
 *    patch layer disables ui-brand-official; single slots take exactly one
 *    occupant, so this is composed, never raced);
 * 4. the theme sheet — the deepseek-blue static ramp redefined to clue teal
 *    on `body` (later sheet, equal specificity: the whole shell re-accents
 *    in light AND dark because both alias blocks reference the statics);
 * 5. nothing else: no locale dictionaries yet (copy is product-Chinese per
 *    house convention), no stores (all state is component-local), no Remote
 *    plane (data rides the kb-web same-origin JSON routes).
 *
 * Bundle purity: every value import is a baseline module-table row (react,
 * primitives icons) or this package's own files; cross-plugin contracts
 * (SlotMap merges, ToolCallBlock, ClientContext) are TYPE-ONLY imports and
 * erase before bundling.
 *
 * @module @clue-harness/ui-kb/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only SlotMap/context merges — each pulls one slot contract into this
// program (settings.section; brand marks; tool.call.toolview). Cross-plugin
// collaboration goes through the slot system, never a value import.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { installClueStyles } from './styles.ts'
import { ApprovalsSection } from './ApprovalsSection.tsx'
import { KbSection } from './KbSection.tsx'
import { KbCiteCard, KbProposeCard, KbSearchCard } from './CitationCards.tsx'
import { ClueBrandMark, ClueBrandName } from './Brand.tsx'

/** Services required before the surfaces mount (the slot registry only). */
export const inject = ['slots']

/**
 * Register every ClueHarness surface.
 * @param ctx - the browser-side cordis context (slots guaranteed by inject).
 */
export function apply(ctx: ClientContext): void {
  // The stylesheet rides the fiber: uninstalling this plugin removes the
  // accent override and every clue class with it.
  ctx.effect(() => installClueStyles(), 'ui-kb: clue stylesheet')

  // The two KB pages in the settings nav, one atomic pair (both or neither).
  ctx.slots.inject('settings.section', function* registerSections() {
    yield ctx.slots.register({
      name: 'settings.section',
      id: 'clue-kb-approvals',
      order: 90,
      label: () => '知识库审批',
    }, ApprovalsSection)
    yield ctx.slots.register({
      name: 'settings.section',
      id: 'clue-kb',
      order: 91,
      label: () => '知识库',
    }, KbSection)
  })

  // Citation cards: keyed toolviews replacing the generic rows for the three
  // kb tools (additive for our own keys — no shipped view claims them).
  ctx.slots.inject('tool.call.toolview', function* registerCitations() {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'kb_search' }, KbSearchCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'kb_propose' }, KbProposeCard)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'kb_cite' }, KbCiteCard)
  })

  // Brand takeover, atomically across all three seats (the ui-brand-official
  // precedent: nested injects wait each declaration, one generator installs
  // the set so a partial brand never renders).
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* registerBrand() {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ClueBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, ClueBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ClueBrandMark)
      })))
}
