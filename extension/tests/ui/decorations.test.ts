import { describe, expect, it } from 'vitest';
import { decorationCss, pillRuns, type DecorationOptions } from '../../src/ui/decorations';
import { buildCss } from '../../src/runtime/styles';

/** Every selector of every style rule (keyframes skipped). */
function selectors(css: string): string[] {
  return [...css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^@media[^{]*\{/, '').trim())
    .filter((s) => s && !s.startsWith(':where(')) // the variables
    .flatMap((s) => s.split(','))
    .map((s) => s.trim());
}

describe('pillRuns', () => {
  it('marks the last collapsed row of each run with its length; hidden rows do not break a run', () => {
    const u = undefined;
    expect(pillRuns(['show', 'collapse', 'hide', 'collapse', 'show', 'collapse'])).toEqual([u, u, u, '2', u, '1']);
    expect(pillRuns(['collapse', 'highlight', 'dim', 'hide'])).toEqual(['1', u, u, u]);
    expect(pillRuns(['show', 'hide'])).toEqual([u, u]);
  });
});

/** Every mode and view the runtime can ask for. */
const VARIANTS: DecorationOptions[] = [
  {},
  { mode: 'basic' },
  { decorate: false },
  { peek: true },
  { peek: true, mode: 'basic' },
  { solo: 'spam' },
  { solo: 'clean', decorate: false },
];

/** The selectors of the rules that set display:none. */
const hiding = (css: string) =>
  [...css.matchAll(/([^{}]+)\{[^{}]*display:none[^{}]*\}/g)]
    .flatMap((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(','))
    .map((s) => s.trim())
    .filter((s) => !s.endsWith('::after')); // a view's tag, until its row is pointed at

describe('decorationCss', () => {
  it('uses only plain attribute selectors on the row (no scoping, combinators or counters), in every mode and view', () => {
    const run = '[data-tiho-run][data-tiho-a="collapse"]:not([data-tiho-open])';
    for (const p of ['twitch', 'youtube', 'kick'])
      for (const t of ['dark', 'light'] as const)
        for (const o of VARIANTS) {
          const css = decorationCss(p, t, o);
          expect(css).not.toContain(':is(');
          expect(css).not.toContain(':has(');
          expect(css).not.toContain('counter');
          const sels = selectors(css);
          expect(sels.length).toBeGreaterThan(20);
          // the one exception: the pill row's own content, hidden so that the row can stay visible and take focus (the views draw no pills)
          expect(sels.filter((s) => s.includes('>'))).toEqual(o.peek || o.solo ? [] : [`${run}>*`]);
          for (const s of sels.filter((s) => !s.includes('>'))) {
            // one compound selector: attributes (Solo also matches the end of a reason), :not(attribute), :hover, :focus-visible, :focus-within, :dir(rtl), ::before / ::after
            expect(s, s).toMatch(/^(\[data-tiho-[a-z]+(\$?="[a-z ]+")?\]|:not\(\[data-tiho-[a-z]+(="[a-z]+")?\]\)|:hover|:focus-visible|:focus-within|:dir\(rtl\)|::before|::after)+$/);
          }
        }
  });

  it('Basic: no category edges and no reason chips; the glow, the opened edge, pills, ×N, dim and highlight stay', () => {
    const basic = decorationCss('twitch', 'dark', { mode: 'basic' });
    expect(basic).not.toContain('var(--tiho-edge)!important');
    expect(basic).not.toContain('content:attr(data-tiho-r)');
    for (const kept of ['linear-gradient(90deg', '[data-tiho-open]{', 'content:attr(data-tiho-run) " hidden"', 'content:"×" attr(data-tiho-wh)', '[data-tiho-a="dim"]{opacity'])
      expect(basic, kept).toContain(kept);
    expect(hiding(basic)).toEqual(hiding(decorationCss('twitch', 'dark')));
  });

  it('Show hidden brings hidden and folded rows back in place, faded and tagged; wave members stay folded', () => {
    const css = decorationCss('twitch', 'dark', { peek: true });
    expect(hiding(css)).toEqual(['[data-tiho-wm]:not([data-tiho-open])']);
    expect(css).not.toContain('data-tiho-run'); // no pills: a pill row reads as a plain row
    expect(css).toContain('[data-tiho-a="hide"],[data-tiho-a="collapse"]:not([data-tiho-open]){opacity:.6!important}');
    expect(css).toContain('[data-tiho-a="hide"]:hover,[data-tiho-a="collapse"]:not([data-tiho-open]):hover{opacity:1!important}');
    expect(css).toContain('[data-tiho-a="hide"]::after{content:"hidden · " attr(data-tiho-r)}');
    expect(css).toContain('[data-tiho-a="collapse"]:not([data-tiho-open]):not([data-tiho-r])::after{content:"folded · " attr(data-tiho-c)}');
    expect(css).toContain('[data-tiho-c="clean"][data-tiho-a="hide"]:not([data-tiho-r])::after{content:"hidden · other"}');
    // the tag never reflows the row: no float, only an out-of-flow chip while the row is pointed at (mirrored for RTL chats)
    expect(css).not.toMatch(/data-tiho-a="hide"\][^{]*\{[^}]*float:right/);
    expect(css).toContain('[data-tiho-a="hide"]::after,[data-tiho-a="collapse"]:not([data-tiho-open])::after{display:none}');
    expect(css).toMatch(/\[data-tiho-a="hide"\]:hover::after,\[data-tiho-a="hide"\]:focus-within::after,[^{]*\{\s*display:block;position:absolute;top:auto;right:44px;bottom:calc\(100% - 8px\)/);
    expect(css).toContain('[data-tiho-a="hide"]:hover,[data-tiho-a="hide"]:focus-within,');
    expect(css).toMatch(/\[data-tiho-a="hide"\]:hover:dir\(rtl\)::after,[^{]*\{\s*right:auto;left:44px;/);
    expect(decorationCss('kick', 'dark', { peek: true })).not.toContain('position:relative'); // Kick's rows are positioned already
    // Basic says it in plain words
    const basic = decorationCss('twitch', 'dark', { peek: true, mode: 'basic' });
    expect(basic).toContain('[data-tiho-a="hide"]::after,[data-tiho-a="collapse"]:not([data-tiho-open])::after{content:"Hidden"}');
    expect(basic).toContain('[data-tiho-c="toxic"][data-tiho-a="hide"]::after,[data-tiho-c="toxic"][data-tiho-a="collapse"]:not([data-tiho-open])::after{content:"Hidden · insult"}');
    expect(basic).toContain('{content:"Hidden · one-word reply"}');
    expect(basic).not.toContain('attr(data-tiho-r)');
  });

  it('Solo hides every other category and shows its own in full, each row tagged with its reason and normal action', () => {
    const css = decorationCss('twitch', 'dark', { solo: 'spam' });
    expect(hiding(css)).toEqual(['[data-tiho-wm]:not([data-tiho-open])', '[data-tiho-c]:not([data-tiho-c="spam"])']);
    expect(css).not.toContain('[data-tiho-a="dim"]{opacity'); // in full, even when dimmed
    expect(css).not.toContain('data-tiho-run');
    expect(css).not.toContain('var(--tiho-edge)!important'); // the tag replaces edges and chips
    expect(css).not.toContain('content:attr(data-tiho-r);');
    expect(css).toContain('[data-tiho-c="spam"][data-tiho-a="collapse"]{--tiho-did:" · folded"}');
    expect(css).toContain('[data-tiho-c="spam"][data-tiho-open]{--tiho-did:" · opened"}');
    expect(css).toContain('[data-tiho-c="spam"][data-tiho-r$="always shown"]{--tiho-did:""}');
    expect(css).toContain('[data-tiho-c="spam"]::after{content:attr(data-tiho-r) var(--tiho-did,"")}');
    // the marker: a solid edge in the category color (no text on the row); the wave head keeps its ×N badge
    expect(css).toContain('[data-tiho-c="spam"]{box-shadow:inset var(--tiho-edge-w) 0 0 var(--tiho-accent,var(--tiho-pill-fg))!important}');
    expect(css).toContain('content:"×" attr(data-tiho-wh)');
    // normally not shown: the dashed edge
    expect(css).toMatch(/\[data-tiho-c="spam"\]\[data-tiho-a="hide"\],\[data-tiho-c="spam"\]\[data-tiho-a="collapse"\]:not\(\[data-tiho-open\]\)\{\s*box-shadow:none!important;\s*background-image:linear-gradient/);
    // Kick's virtual list too: its rows wait for a verdict taking no space, so hiding most of them is stable (see below)
    const kick = decorationCss('kick', 'dark', { solo: 'spam' });
    expect(hiding(kick)).toEqual(hiding(css));
    expect(kick).not.toContain('[data-tiho-c]:not([data-tiho-c="spam"]){visibility');
    // clean rows have no reason: "other · shown"
    expect(decorationCss('kick', 'light', { solo: 'clean' })).toContain('[data-tiho-c="clean"]:not([data-tiho-r])::after{content:"other" var(--tiho-did,"")}');
  });

  it('lets the pill row take keyboard focus: visible itself, its content hidden, a ring on the pill', () => {
    const css = decorationCss('kick', 'light');
    const run = '[data-tiho-run][data-tiho-a="collapse"]:not([data-tiho-open])';
    expect(css).toContain('overflow:hidden!important;visibility:visible!important;opacity:1!important;color:transparent!important;');
    expect(css).toContain(`${run}>*{visibility:hidden!important}`);
    expect(css).toContain(`${run}:focus-visible::before{box-shadow:inset 2px 0 0 var(--tiho-link),`);
    expect(css).toContain(`${run}:focus-visible:dir(rtl)::before{box-shadow:inset -2px 0 0 var(--tiho-link),`);
  });

  it('mirrors everything that has a side for right-to-left chats, labels kept left-to-right', () => {
    const css = decorationCss('twitch', 'dark');
    const run = '[data-tiho-run][data-tiho-a="collapse"]:not([data-tiho-open])';
    // the pill: indent on the right, "3 hidden" half rounded and dotted on its right edge, readable
    expect(css).toContain(`${run}:dir(rtl){padding:3px var(--tiho-indent) 3px 8px!important}`);
    expect(css).toMatch(/:dir\(rtl\)::before\{\s*direction:ltr;padding:0 18px 0 5px;border-radius:0 999px 999px 0;\s*background-image:radial-gradient\(circle at calc\(100% - 9\.5px\) 50%/);
    expect(css).toMatch(/:dir\(rtl\)::after\{\s*padding:0 0 0 10px;border-radius:999px 0 0 999px;\s*box-shadow:inset 1px 0 0/);
    // wave badge in the top-left corner (margin mirrored), highlight and edges from the right
    expect(css).toContain('[data-tiho-wh][data-tiho-a="highlight"]:dir(rtl)::before{float:left;margin:6px 6px 0 10px;direction:ltr}');
    expect(css).toContain('[data-tiho-a="highlight"]:dir(rtl){box-shadow:inset -3px 0 0');
    expect(css).toContain('box-shadow:inset calc(-1 * var(--tiho-edge-w)) 0 0 var(--tiho-edge)!important');
    expect(css).toContain('linear-gradient(270deg,');
    expect(css).toContain('[data-tiho-open]:dir(rtl){box-shadow:none!important;background-position:100% 0!important}');
    expect(css).toMatch(/:hover:dir\(rtl\)::after\{\s*right:auto;left:44px;padding:0 15px 0 7px;direction:ltr;/);
    // decorate off: the pill and highlight still mirror, edges and chips are gone
    const off = decorationCss('youtube', 'light', { decorate: false });
    expect(off).toContain(`${run}:dir(rtl)::before`);
    expect(off).toContain('[data-tiho-wh][data-tiho-a="highlight"]:dir(rtl)::before{float:left;margin:3px 8px 0 0;direction:ltr}');
    expect(off).not.toContain('left:44px');
  });

  it('draws one pill per run from data-tiho-run; the run’s other rows take no space', () => {
    const css = decorationCss('twitch', 'dark');
    expect(css).toContain('[data-tiho-a="collapse"]:not([data-tiho-open]):not([data-tiho-run]){display:none!important}');
    expect(css).toContain('content:attr(data-tiho-run) " hidden"');
    expect(css).toContain('content:"·  show"');
  });

  it('drops edges and reason chips when decorate is off, keeps hide / dim / collapse / highlight', () => {
    const on = decorationCss('youtube', 'light');
    const off = decorationCss('youtube', 'light', { decorate: false });
    expect(on).toContain('content:attr(data-tiho-r)');
    expect(off).not.toContain('content:attr(data-tiho-r)');
    expect(on).toContain('var(--tiho-edge)');
    expect(off).not.toContain('var(--tiho-edge)');
    for (const kept of ['[data-tiho-a="hide"]', '[data-tiho-a="dim"]', '" hidden"', '[data-tiho-a="highlight"]']) expect(off).toContain(kept);
  });

  it('puts the reason chip above the row, out of flow, and never repositions absolute (Kick) rows', () => {
    const tw = decorationCss('twitch', 'dark');
    expect(tw).toMatch(/content:attr\(data-tiho-r\);\s*display:block;position:absolute;top:auto;right:44px;bottom:calc\(100% - 8px\)/);
    expect(tw).toContain('[data-tiho-r][data-tiho-open]:hover{position:relative}'); // the hovered row anchors it
    expect(decorationCss('kick', 'dark')).not.toContain('position:relative');
  });

  it('themes colors for light and dark', () => {
    expect(decorationCss('twitch', 'dark')).toContain('--tiho-c-toxic:#ff6470;--tiho-e-toxic:#ff64709e');
    expect(decorationCss('twitch', 'light')).toContain('--tiho-c-toxic:#d42f42;--tiho-e-toxic:#d42f42b3');
  });

  it('on a virtual list (Kick) a row waiting for its verdict takes no space; elsewhere it keeps its place, invisible', () => {
    // Kick measures a row as it mounts: one born at full height and hidden a frame later pulls more rows in, in a loop (Quiet)
    const birth = (css: string) => css.match(/\[data-tiho-list\]>:not\(\[data-tiho-a\]\)\{([^}]*)\}/)?.[1];
    for (const o of VARIANTS) {
      expect(birth(buildCss({ platform: 'kick', theme: 'dark', decorate: true, ...o }))).toBe('display:none!important');
      for (const p of ['twitch', 'youtube'] as const)
        expect(birth(buildCss({ platform: p, theme: 'light', decorate: true, ...o }))).toBe('visibility:hidden!important');
    }
  });

  it('is valid CSS for every platform, theme, mode and view (parses in the DOM)', () => {
    for (const p of ['twitch', 'youtube', 'kick'] as const)
      for (const t of ['dark', 'light'] as const)
        for (const o of VARIANTS) {
          const style = document.createElement('style');
          style.textContent = buildCss({ platform: p, theme: t, decorate: true, ...o });
          document.head.appendChild(style);
          expect(style.sheet?.cssRules.length ?? 0).toBeGreaterThan(15);
          style.remove();
        }
  });
});
