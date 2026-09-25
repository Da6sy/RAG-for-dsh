/**
 * The clue browser identity (tab title + favicon), injected through the
 * webserver's index-injection table — the same sanctioned channel
 * dsh's own client-modules uses for the boot manifest and preloads.
 *
 * Why injection (not a rebuilt frontend): `dsh-web-frontend`'s dist bakes
 * its product title at BUILD time (`process.env.DSH_CLIENT_TITLE` is a
 * build define in ui-renderer's DocumentTitle), and clue consumes published
 * packages — the static `<title>` and `/favicon.svg` in the dist are dsh's.
 * A head-placed classic script (the webserver renders rows after the opening
 * head tag) therefore rewrites both at the earliest possible moment and
 * KEEPS them rewritten: the shell's DocumentTitle component re-projects the
 * session title on changes, and a MutationObserver on document.head re-applies
 * the clue identity after every such write. The favicon link is swapped in
 * place (dsh's whale stops being requested) and added if absent.
 *
 * @module @clue-harness/kb-web/identity
 */

/** The tab title ClueHarness owns (user decision: two words, no brand glue). */
export const IDENTITY_TITLE = 'Clue Harness'

/**
 * The network mark — the same art as the ui-kb sidebar brand, as a
 * standalone document (URL-encoded into a data URI, so no route, no file,
 * no dependency on the frontend dist's statics).
 */
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">'
  + '<rect x="2" y="2" width="44" height="44" rx="14" fill="#102D2B"/>'
  + '<path d="M34 13L22 10L12 19L14 32L27 38L37 29M12 19L25 24L34 13M14 32L25 24L37 29M25 24L27 38"'
  + ' stroke="#5DD4BA" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<circle cx="22" cy="10" r="2.5" fill="#D6F5EA"/><circle cx="12" cy="19" r="3" fill="#D6F5EA"/>'
  + '<circle cx="14" cy="32" r="2.5" fill="#5DD4BA"/><circle cx="27" cy="38" r="2.5" fill="#5DD4BA"/>'
  + '<circle cx="37" cy="29" r="3" fill="#D6F5EA"/><circle cx="34" cy="13" r="3" fill="#E7B566"/>'
  + '<circle cx="25" cy="24" r="6" fill="#102D2B"/><circle cx="25" cy="24" r="3.5" fill="#E7B566"/>'
  + '</svg>'

/**
 * The favicon as a data URI (no fetch, no cache, no server route).
 * @returns the `data:image/svg+xml,…` reference.
 */
export function faviconDataUri(): string {
  return `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
}

/**
 * Build the injected head script: claim title + favicon now, at
 * DOMContentLoaded, and on every later head mutation (the shell re-projects
 * session titles on selection changes). Guarded writes (compare before set)
 * keep the observer loop-free.
 * @returns classic-script text (contains no closing-script sequence).
 */
export function identityScript(): string {
  const title = JSON.stringify(IDENTITY_TITLE)
  const icon = JSON.stringify(faviconDataUri())
  return '(function(){var T=' + title + ';var F=' + icon + ';'
    + 'function fix(){'
    + 'try{if(document.title!==T){document.title=T;}}catch(e){}'
    + 'try{var links=document.querySelectorAll(\'link[rel~="icon"]\');'
    + 'if(links.length===0){var l=document.createElement(\'link\');l.rel=\'icon\';l.type=\'image/svg+xml\';l.href=F;document.head.appendChild(l);}'
    + 'for(var i=0;i<links.length;i++){var k=links[i];k.type=\'image/svg+xml\';if(k.href!==F){k.href=F;}}'
    + '}catch(e){}}'
    + 'fix();'
    + 'if(document.readyState===\'loading\'){document.addEventListener(\'DOMContentLoaded\',fix);}'
    + 'try{new MutationObserver(fix).observe(document.head,{childList:true,subtree:true,characterData:true});}catch(e){}'
    + '})();'
}
