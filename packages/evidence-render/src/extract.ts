/**
 * The in-page L1 extractor (design doc §4.2–§4.4).
 *
 * HARD CONSTRAINT: {@link extractInPage} is serialized by `page.evaluate` and
 * executed INSIDE the browser — it must be fully self-contained: no imports,
 * no closures over module scope, no Node APIs. Only `import type` is allowed
 * in this file (types vanish at compile time). Every helper lives inside the
 * function body.
 *
 * Determinism contract (feeds the "three runs byte-identical" gate):
 * - no timestamps, no randomness, no iteration order other than DOM order;
 * - coordinates rounded to integers, percentages to one decimal;
 * - attribute maps built with sorted keys;
 * - volatile regions arrive pre-masked by normalize.ts (data-clue-masked).
 *
 * @module @clue-harness/evidence-render/extract
 */
import type { Box, InteractiveState, ModuleKind, ModuleNode, RepeatInfo, VisibilityInfo } from './types.ts'

/** Knobs handed to the in-page extractor (all deterministic, all defaulted). */
export interface ExtractConfig {
  /** Row band height (px) for the coarse grid ("r2 c4-9"). */
  gridRowPx: number
  /** Own-text preview cap (characters). */
  textCap: number
  /** Max module tree depth below the root candidates. */
  depthCap: number
  /** Consecutive same-signature siblings at/above this count fold into a group. */
  siblingCollapseMin: number
  /** How many folded items stay expanded in the output. */
  expandItems: number
  /** Smallest w/h (px) for an unmarked container to count as a visual module. */
  visualMinW: number
  visualMinH: number
  /** Attribute set on masked volatile elements by normalize.ts. */
  maskAttr: string
  /** Marker-hint thresholds: min area and min descendant elements. */
  hintMinW: number
  hintMinH: number
  hintMinChildren: number
  /** Attribute value truncation cap. */
  attrValueCap: number
}

export const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
  gridRowPx: 60,
  textCap: 40,
  depthCap: 5,
  siblingCollapseMin: 6,
  expandItems: 2,
  visualMinW: 120,
  visualMinH: 40,
  maskAttr: 'data-clue-masked',
  hintMinW: 400,
  hintMinH: 240,
  hintMinChildren: 4,
  attrValueCap: 60,
}

/** Wire shape produced inside the page (mirrors LayoutSnapshot minus host facts). */
export interface RawLayout {
  page: { width: number; height: number }
  modules: ModuleNode[]
  markerHints: string[]
}

/**
 * Extract the semantic scene tree from the CURRENT page state.
 * Runs inside the browser via page.evaluate — see the module header for the
 * self-containment contract.
 * @param cfg - extractor knobs (plain JSON, passed by value).
 * @returns the raw layout wire object.
 */
export function extractInPage(cfg: ExtractConfig): RawLayout {
  // ---- tiny in-page helpers (all local; nothing leaks from module scope) --
  const round = (n: number): number => Math.round(n)
  const round1 = (n: number): number => Math.round(n * 10) / 10
  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
  const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

  const LANDMARK_WORDS: Record<string, string> = {
    header: '顶部栏', nav: '导航', main: '主区域', aside: '侧栏',
    footer: '页脚', section: '区块', form: '表单',
  }
  const ROLE_WORDS: Record<string, string> = {
    banner: '顶部栏', navigation: '导航', main: '主区域', complementary: '侧栏',
    contentinfo: '页脚', search: '搜索区', form: '表单',
  }
  const TAG_WORDS: Record<string, string> = {
    button: '按钮', input: '输入框', select: '下拉选择', textarea: '文本域', a: '链接',
  }

  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return true
    if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden'
    if (tag === 'a') return el.hasAttribute('href')
    const role = el.getAttribute('role')
    return role === 'button' || role === 'textbox' || role === 'checkbox' || role === 'link'
  }

  const isLandmark = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase()
    if (tag in LANDMARK_WORDS) return true
    const role = el.getAttribute('role')
    return role !== null && role in ROLE_WORDS
  }

  const hasOwnBackground = (el: Element): boolean => {
    const cs = getComputedStyle(el)
    const notNone = (v: string): boolean => v !== 'none' && v !== '0px' && v !== ''
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') return true
    if (notNone(cs.borderTopWidth) && cs.borderTopStyle !== 'none') return true
    if (notNone(cs.borderRadius) && cs.borderRadius !== '0px') return true
    return notNone(cs.boxShadow)
  }

  const ownText = (el: Element): string => {
    let out = ''
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? ''
    }
    return out.replace(/\s+/g, ' ').trim()
  }

  const parseColor = (value: string): { r: number; g: number; b: number; a: number } | null => {
    const m = value.match(/rgba?\(([^)]+)\)/)
    if (m === null) return null
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }

  const luminance = (c: { r: number; g: number; b: number }): number => {
    const channel = (v: number): number => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  }

  const contrastOf = (el: Element): number | null => {
    const text = ownText(el)
    if (text === '') return null
    const fg = parseColor(getComputedStyle(el).color)
    if (fg === null) return null
    let bg: { r: number; g: number; b: number } | null = null
    let walker: Element | null = el
    while (walker !== null && bg === null) {
      const parsed = parseColor(getComputedStyle(walker).backgroundColor)
      if (parsed !== null && parsed.a > 0.01) bg = parsed
      walker = walker.parentElement
    }
    if (bg === null) bg = { r: 255, g: 255, b: 255 }
    const l1 = luminance({ r: fg.r, g: fg.g, b: fg.b })
    const l2 = luminance(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    return round1(ratio)
  }

  const structuralId = (el: Element): string => {
    const parts: string[] = []
    let walker: Element | null = el
    while (walker !== null && walker.tagName.toLowerCase() !== 'body') {
      const parent: Element | null = walker.parentElement
      if (parent === null) break
      const tag = walker.tagName.toLowerCase()
      let nth = 1
      let sib = walker.previousElementSibling
      while (sib !== null) {
        if (sib.tagName === walker.tagName) nth += 1
        sib = sib.previousElementSibling
      }
      parts.unshift(`${tag}:nth(${nth})`)
      walker = parent
    }
    return `page>${parts.join('>')}`
  }

  const shortSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    const id = el.id !== '' ? `#${el.id}` : ''
    const cls = el.classList.length > 0 ? `.${el.classList[0]}` : ''
    return `${tag}${id}${cls}`
  }

  // ---- pass 1: candidate discovery (document order) ----------------------
  const all = Array.from(document.body.querySelectorAll('*'))
  const candidates: Element[] = []
  const kindOf = new Map<Element, ModuleKind>()
  const moduleNameSeen = new Map<string, number>()
  for (const el of all) {
    const marker = el.getAttribute('data-module')
    if (marker !== null && marker !== '') {
      const seen = (moduleNameSeen.get(marker) ?? 0) + 1
      moduleNameSeen.set(marker, seen)
      candidates.push(el)
      kindOf.set(el, 'marker')
      continue
    }
    if (isInteractive(el)) { candidates.push(el); kindOf.set(el, 'interactive'); continue }
    if (isLandmark(el)) { candidates.push(el); kindOf.set(el, 'landmark'); continue }
    const rect = el.getBoundingClientRect()
    if (rect.width >= cfg.visualMinW && rect.height >= cfg.visualMinH && hasOwnBackground(el)) {
      candidates.push(el)
      kindOf.set(el, 'visual')
    }
  }
  const candidateSet = new Set(candidates)

  // ---- pass 2: hierarchy (nearest candidate ancestor) ---------------------
  const parentOf = new Map<Element, Element | null>()
  const childrenOf = new Map<Element | null, Element[]>()
  for (const el of candidates) {
    let walker = el.parentElement
    while (walker !== null && !candidateSet.has(walker)) walker = walker.parentElement
    parentOf.set(el, walker)
    const list = childrenOf.get(walker) ?? []
    list.push(el)
    childrenOf.set(walker, list)
  }

  // ---- pass 3: identity + per-element facts -------------------------------
  const markerCount = new Map<string, number>()
  const nodeOf = new Map<Element, ModuleNode>()
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const gridCols = 12

  const buildNode = (el: Element): ModuleNode => {
    const kind = kindOf.get(el) ?? 'visual'
    const marker = el.getAttribute('data-module')
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const tag = el.tagName.toLowerCase()

    // Stable id: marker name (deduped) wins; else the structural path.
    let id: string
    if (kind === 'marker' && marker !== null) {
      const seen = (markerCount.get(marker) ?? 0) + 1
      markerCount.set(marker, seen)
      id = seen === 1 ? marker : `${marker}#${seen}`
    } else {
      id = structuralId(el)
    }

    // Label: marker name > aria-label > landmark word > interactive naming > visual fallback.
    let label: string
    const aria = el.getAttribute('aria-label')
    if (kind === 'marker' && marker !== null) label = marker
    else if (aria !== null && aria !== '') label = cap(aria, 24)
    else if (kind === 'landmark') {
      const role = el.getAttribute('role')
      label = (role !== null && role in ROLE_WORDS ? ROLE_WORDS[role] : LANDMARK_WORDS[tag]) ?? tag
    } else if (kind === 'interactive') {
      const placeholder = el.getAttribute('placeholder')
      const text = cap(ownText(el), 12)
      const word = TAG_WORDS[tag] ?? '控件'
      label = placeholder !== null && placeholder !== '' ? `${cap(placeholder, 12)}${word}`
        : text !== '' ? `${text}${word === '按钮' ? '按钮' : ''}`
        : tag === 'input' ? `${word}[${(el as HTMLInputElement).type}]`
        : word
    } else {
      label = el.id !== '' ? `#${el.id}` : el.classList.length > 0 ? `.${el.classList[0]}` : '区块'
    }

    const box: Box = {
      x: round(rect.left + scrollX),
      y: round(rect.top + scrollY),
      w: round(rect.width),
      h: round(rect.height),
    }
    const boxPct: Box = {
      x: round1((box.x / Math.max(1, document.documentElement.scrollWidth)) * 100),
      y: round1((box.y / Math.max(1, document.documentElement.scrollHeight)) * 100),
      w: round1((box.w / Math.max(1, viewportW)) * 100),
      h: round1((box.h / Math.max(1, viewportH)) * 100),
    }
    const colW = viewportW / gridCols
    const c1 = clamp(Math.floor(box.x / colW) + 1, 1, gridCols)
    const c2 = clamp(Math.ceil((box.x + box.w) / colW), 1, gridCols)
    const r1 = Math.floor(box.y / cfg.gridRowPx) + 1
    const r2 = Math.floor(Math.max(box.y, box.y + box.h - 1) / cfg.gridRowPx) + 1
    const grid = `r${r1}${r2 > r1 ? `-${r2}` : ''} c${c1}${c2 > c1 ? `-${c2}` : ''}`

    const displayed = box.w > 0 && box.h > 0
      && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01
    const inViewport = box.y < scrollY + viewportH && box.y + box.h > scrollY
      && box.x < scrollX + viewportW && box.x + box.w > scrollX

    // Overflow clipping: self scroll overflow, or an ancestor with clipping
    // overflow whose rect does not (almost) fully contain this box.
    let clipped = false
    if (displayed) {
      const overflowClips = (v: string): boolean => v === 'hidden' || v === 'auto' || v === 'scroll'
      if ((el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        && (overflowClips(cs.overflowX) || overflowClips(cs.overflowY))) {
        clipped = true
      }
      if (!clipped) {
        let walker = el.parentElement
        while (walker !== null && walker.tagName.toLowerCase() !== 'body') {
          const wcs = getComputedStyle(walker)
          if (overflowClips(wcs.overflowX) || overflowClips(wcs.overflowY)) {
            const wr = walker.getBoundingClientRect()
            const contained = rect.left >= wr.left - 1 && rect.top >= wr.top - 1
              && rect.right <= wr.right + 1 && rect.bottom <= wr.bottom + 1
            if (!contained) { clipped = true; break }
          }
          walker = walker.parentElement
        }
      }
    }

    let interactive: InteractiveState | null = null
    // Interactive facts belong to the ELEMENT, not to its classification
    // branch: a control carrying data-module is kind 'marker', but it is
    // still a button — extracting only under kind==='interactive' silently
    // dropped the flagship tab-order assertion for marked controls (found
    // by the dogfood harness: a marked button with tabindex=-1 sailed past
    // the gate). Identity stays marker-first; facts follow the element.
    if (isInteractive(el)) {
      const htmlEl = el as HTMLInputElement
      const focusableTag = tag === 'button' || tag === 'select' || tag === 'textarea'
        || (tag === 'input' && htmlEl.type !== 'hidden') || (tag === 'a' && el.hasAttribute('href'))
        || el.getAttribute('role') === 'button'
      const disabled = htmlEl.disabled === true || el.getAttribute('aria-disabled') === 'true'
      const tabindexAttr = el.getAttribute('tabindex')
      const tabIndex = tabindexAttr !== null ? parseInt(tabindexAttr, 10) : null
      const tabbable = displayed && !disabled
        && (tabIndex !== null ? tabIndex >= 0 : focusableTag)
      interactive = {
        tag,
        type: tag === 'input' ? htmlEl.type : tag === 'button' ? (htmlEl.getAttribute('type') ?? 'submit') : null,
        disabled,
        tabbable,
        tabIndex: tabindexAttr !== null ? tabIndex : null,
        focused: document.activeElement === el,
      }
    }

    // Whitelisted attributes only, sorted keys, capped values.
    const attrs: Record<string, string> = {}
    const put = (key: string, value: string | null): void => {
      if (value !== null && value !== '') attrs[key] = cap(value, cfg.attrValueCap)
    }
    put('id', el.id)
    put('name', el.getAttribute('name'))
    put('role', el.getAttribute('role'))
    put('aria-label', el.getAttribute('aria-label'))
    put('placeholder', el.getAttribute('placeholder'))
    put('alt', el.getAttribute('alt'))
    if (tag === 'input' || tag === 'button') put('type', el.getAttribute('type'))
    if (tag === 'a') put('href', el.getAttribute('href'))
    if (el.hasAttribute('required')) attrs['required'] = 'true'
    if (el.hasAttribute('readonly')) attrs['readonly'] = 'true'
    const sortedAttrs: Record<string, string> = {}
    for (const key of Object.keys(attrs).sort()) sortedAttrs[key] = attrs[key]

    const masked = el.hasAttribute(cfg.maskAttr)
    const rawText = masked ? '▮(已屏蔽)' : ownText(el)
    const text = rawText === '' ? null : cap(rawText, cfg.textCap)
    const textLength = rawText === '' ? null : rawText.length
    const contrastRatio = masked || text === null ? null : contrastOf(el)

    const violations: string[] = []
    if (interactive !== null && !interactive.disabled && !interactive.tabbable && displayed) {
      violations.push('不在 Tab 顺序中')
    }
    if (contrastRatio !== null && contrastRatio < 4.5) violations.push(`对比度不足(${contrastRatio.toFixed(1)})`)

    const visibility: VisibilityInfo = {
      displayed, inViewport, occluded: false, occludedBy: null, clipped,
    }

    return {
      id, label, kind,
      moduleName: marker !== null && marker !== '' ? marker : null,
      box, boxPct, grid,
      relations: [],
      text, textLength,
      attrs: sortedAttrs,
      style: {
        position: cs.position,
        zIndex: cs.zIndex === 'auto' ? null : cs.zIndex,
        contrastRatio,
      },
      visibility,
      interactive,
      repeat: null,
      violations,
      children: [],
    }
  }

  for (const el of candidates) nodeOf.set(el, buildNode(el))

  // ---- pass 4: occlusion (needs the element→label map complete) -----------
  const ownerOf = (target: Element | null): string | null => {
    let walker = target
    while (walker !== null) {
      const node = nodeOf.get(walker)
      if (node !== undefined) return node.label
      walker = walker.parentElement
    }
    return target === null ? null : shortSelector(target)
  }
  for (const el of candidates) {
    const node = nodeOf.get(el)
    if (node === undefined || !node.visibility.displayed) continue
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    if (cx < 0 || cy < 0 || cx > viewportW || cy > viewportH) continue // below the fold: undecidable
    const hit = document.elementFromPoint(cx, cy)
    if (hit === null) continue
    if (hit === el || el.contains(hit) || hit.contains(el)) continue
    node.visibility.occluded = true
    node.visibility.occludedBy = ownerOf(hit)
    node.violations.push(node.interactive !== null ? '交互元素被遮挡' : '被遮挡')
  }

  // ---- pass 5: sibling collapse into repeat groups ------------------------
  const signatureOf = (el: Element): string => {
    const childTags = Array.from(el.children).map((c) => c.tagName).join(',')
    return `${el.tagName}|${el.className}|${childTags}`
  }
  const collapsedParents = new Set<Element | null>()
  const groupReplace = new Map<Element | null, Array<Element | { group: true; run: Element[] }>>()
  for (const [parentEl, kids] of childrenOf) {
    if (kids.length < cfg.siblingCollapseMin) continue
    const runs: Element[][] = []
    let current: Element[] = []
    let currentSig: string | null = null
    for (const kid of kids) {
      const sig = signatureOf(kid)
      if (sig === currentSig) current.push(kid)
      else {
        if (current.length >= cfg.siblingCollapseMin) runs.push(current)
        current = [kid]
        currentSig = sig
      }
    }
    if (current.length >= cfg.siblingCollapseMin) runs.push(current)
    if (runs.length === 0) continue
    collapsedParents.add(parentEl)
    const mixed: Array<Element | { group: true; run: Element[] }> = []
    for (const kid of kids) {
      const run = runs.find((r) => r[0] === kid)
      if (run !== undefined) {
        mixed.push({ group: true, run })
      } else if (!runs.some((r) => r.includes(kid))) {
        mixed.push(kid)
      }
    }
    groupReplace.set(parentEl, mixed)
  }

  const buildRepeat = (run: Element[], parentId: string, tagWord: string): { node: ModuleNode; expanded: ModuleNode[] } => {
    const first = nodeOf.get(run[0])
    const firstEl = run[0]
    const rects = run.map((el) => el.getBoundingClientRect())
    const vertical = Math.max(...rects.map((r) => r.top)) - Math.min(...rects.map((r) => r.top))
      >= Math.max(...rects.map((r) => r.left)) - Math.min(...rects.map((r) => r.left))
    const gaps: number[] = []
    for (let i = 1; i < rects.length; i += 1) {
      gaps.push(round(vertical ? rects[i].top - rects[i - 1].bottom : rects[i].left - rects[i - 1].right))
    }
    const uniform = gaps.length > 0 && Math.max(...gaps) - Math.min(...gaps) <= 2
    const gap = uniform ? gaps[Math.floor(gaps.length / 2)] : null
    const sigs = new Set(run.map(signatureOf))
    const expanded = run.slice(0, cfg.expandItems).map((el) => nodeOf.get(el)).filter((n): n is ModuleNode => n !== undefined)
    const groupNode: ModuleNode = {
      id: `group:${parentId}:${firstEl.tagName.toLowerCase()}`,
      label: `${first?.label ?? tagWord}等`,
      kind: 'group',
      moduleName: null,
      box: {
        x: round(Math.min(...rects.map((r) => r.left + scrollX))),
        y: round(Math.min(...rects.map((r) => r.top + scrollY))),
        w: round(Math.max(...rects.map((r) => r.right + scrollX)) - Math.min(...rects.map((r) => r.left + scrollX))),
        h: round(Math.max(...rects.map((r) => r.bottom + scrollY)) - Math.min(...rects.map((r) => r.top + scrollY))),
      },
      boxPct: { x: 0, y: 0, w: 0, h: 0 }, // filled below
      grid: first?.grid ?? 'r1 c1-12',
      relations: [],
      text: null, textLength: null, attrs: {},
      style: { position: 'static', zIndex: null, contrastRatio: null },
      visibility: { displayed: true, inViewport: true, occluded: false, occludedBy: null, clipped: false },
      interactive: null,
      repeat: {
        count: run.length,
        firstBox: { x: round(rects[0].left + scrollX), y: round(rects[0].top + scrollY), w: round(rects[0].width), h: round(rects[0].height) },
        gap,
        structureSame: sigs.size === 1,
        expanded,
      },
      violations: [],
      children: [],
    }
    const docW = Math.max(1, document.documentElement.scrollWidth)
    const docH = Math.max(1, document.documentElement.scrollHeight)
    groupNode.boxPct = {
      x: round1((groupNode.box.x / docW) * 100),
      y: round1((groupNode.box.y / docH) * 100),
      w: round1((groupNode.box.w / viewportW) * 100),
      h: round1((groupNode.box.h / viewportH) * 100),
    }
    return { node: groupNode, expanded }
  }

  // ---- pass 6: assemble the tree (depth-capped) ---------------------------
  const assemble = (parentEl: Element | null, depth: number, parentId: string): ModuleNode[] => {
    if (depth > cfg.depthCap) return []
    const kids = groupReplace.has(parentEl)
      ? (groupReplace.get(parentEl) ?? [])
      : (childrenOf.get(parentEl) ?? [])
    const out: ModuleNode[] = []
    for (const item of kids) {
      if (item instanceof Element) {
        const node = nodeOf.get(item)
        if (node === undefined) continue
        node.children = assemble(item, depth + 1, node.id)
        out.push(node)
      } else {
        // Collapsed-run marker: one group node stands in for the whole run.
        const built = buildRepeat(item.run, parentId, '列表项')
        out.push(built.node)
      }
    }
    return out
  }

  const modules = assemble(null, 1, 'page')

  // ---- pass 7: relations (nearest module links only, capped) --------------
  const byId = new Map<string, ModuleNode>()
  const indexTree = (nodes: ModuleNode[]): void => {
    for (const node of nodes) {
      byId.set(node.id, node)
      if (node.repeat !== null) indexTree(node.repeat.expanded)
      indexTree(node.children)
    }
  }
  indexTree(modules)

  const relate = (nodes: ModuleNode[], parentId: string): void => {
    nodes.forEach((node, index) => {
      node.relations = [`inside:${parentId}`]
      if (index > 0) {
        const prev = nodes[index - 1]
        const overlap = Math.min(node.box.y + node.box.h, prev.box.y + prev.box.h)
          - Math.max(node.box.y, prev.box.y)
        const minHeight = Math.max(1, Math.min(node.box.h, prev.box.h))
        if (overlap / minHeight >= 0.5 && prev.box.x < node.box.x) {
          node.relations.push(`beside:${prev.id}`)
        } else if (prev.box.y + prev.box.h <= node.box.y) {
          node.relations.push(`below:${prev.id}`)
        } else {
          node.relations.push(`sibling-after:${prev.id}`)
        }
      }
      if (node.repeat !== null) relate(node.repeat.expanded, node.id)
      relate(node.children, node.id)
    })
  }
  relate(modules, 'page')

  // ---- pass 8: marker hints (large complex unmarked blocks) ---------------
  const markerHints: string[] = []
  for (const el of all) {
    if (markerHints.length >= 3) break
    if (candidateSet.has(el)) continue
    if (el.getAttribute('data-module') !== null) continue
    // Only consider elements whose subtree contains candidates but which are
    // not themselves inside a marker (hints target unnamed ORGANIZER blocks).
    let walker = el.parentElement
    let insideMarker = false
    while (walker !== null) {
      if (walker.getAttribute('data-module') !== null) { insideMarker = true; break }
      walker = walker.parentElement
    }
    if (insideMarker) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < cfg.hintMinW || rect.height < cfg.hintMinH) continue
    if (el.querySelectorAll('*').length < cfg.hintMinChildren) continue
    markerHints.push(`${shortSelector(el)} (${round(rect.width)}×${round(rect.height)}) 面积大且结构复杂但没有 data-module 标记,建议添加`)
  }

  return {
    page: {
      width: Math.max(document.documentElement.scrollWidth, viewportW),
      height: Math.max(document.documentElement.scrollHeight, viewportH),
    },
    modules,
    markerHints,
  }
}
