import { describe, expect, it } from 'vitest';
import { decorationCss, pillRuns } from '../../src/ui/decorations';
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

describe('decorationCss', () => {
  it('uses only plain attribute selectors on the row (no scoping, combinators or counters)', () => {
    for (const p of ['twitch', 'youtube', 'kick'])
      for (const t of ['dark', 'light'] as const) {
        const css = decorationCss(p, t);
        expect(css).not.toContain(':is(');
        expect(css).not.toContain(':has(');
        expect(css).not.toContain('counter');
        const sels = selectors(css);
        expect(sels.length).toBeGreaterThan(30);
        for (const s of sels) {
          // one compound selector: attributes, :not(attribute), :hover, :dir(rtl), ::before / ::after
          expect(s, s).toMatch(/^(\[data-hush-[a-z]+(="[a-z]+")?\]|:not\(\[data-hush-[a-z]+(="[a-z]+")?\]\)|:hover|:dir\(rtl\)|::before|::after)+$/);
        }
      }
  });

  it('mirrors everything that has a side for right-to-left chats, labels kept left-to-right', () => {
    const css = decorationCss('twitch', 'dark');
    const run = '[data-hush-run][data-hush-a="collapse"]:not([data-hush-open])';
    // the pill: indent on the right, "3 hidden" half rounded and dotted on its right edge, readable
    expect(css).toContain(`${run}:dir(rtl){padding:3px var(--hush-indent) 3px 8px!important}`);
    expect(css).toMatch(/:dir\(rtl\)::before\{\s*direction:ltr;padding:0 18px 0 5px;border-radius:0 999px 999px 0;\s*background-image:radial-gradient\(circle at calc\(100% - 9\.5px\) 50%/);
    expect(css).toMatch(/:dir\(rtl\)::after\{\s*padding:0 0 0 10px;border-radius:999px 0 0 999px;\s*box-shadow:inset 1px 0 0/);
    // wave badge in the top-left corner (margin mirrored), highlight and edges from the right
    expect(css).toContain('[data-hush-wh][data-hush-a="highlight"]:dir(rtl)::before{float:left;margin:6px 6px 0 10px;direction:ltr}');
    expect(css).toContain('[data-hush-a="highlight"]:dir(rtl){box-shadow:inset -3px 0 0');
    expect(css).toContain('box-shadow:inset calc(-1 * var(--hush-edge-w)) 0 0 var(--hush-edge)!important');
    expect(css).toContain('linear-gradient(270deg,');
    expect(css).toContain('[data-hush-open]:dir(rtl){box-shadow:none!important;background-position:100% 0!important}');
    expect(css).toMatch(/:hover:dir\(rtl\)::after\{\s*right:auto;left:44px;padding:0 15px 0 7px;direction:ltr;/);
    // decorate off: the pill and highlight still mirror, edges and chips are gone
    const off = decorationCss('youtube', 'light', { decorate: false });
    expect(off).toContain(`${run}:dir(rtl)::before`);
    expect(off).toContain('[data-hush-wh][data-hush-a="highlight"]:dir(rtl)::before{float:left;margin:3px 8px 0 0;direction:ltr}');
    expect(off).not.toContain('left:44px');
  });

  it('draws one pill per run from data-hush-run; the run’s other rows take no space', () => {
    const css = decorationCss('twitch', 'dark');
    expect(css).toContain('[data-hush-a="collapse"]:not([data-hush-open]):not([data-hush-run]){display:none!important}');
    expect(css).toContain('content:attr(data-hush-run) " hidden"');
    expect(css).toContain('content:"·  show"');
  });

  it('drops edges and reason chips when decorate is off, keeps hide / dim / collapse / highlight', () => {
    const on = decorationCss('youtube', 'light');
    const off = decorationCss('youtube', 'light', { decorate: false });
    expect(on).toContain('content:attr(data-hush-r)');
    expect(off).not.toContain('content:attr(data-hush-r)');
    expect(on).toContain('var(--hush-edge)');
    expect(off).not.toContain('var(--hush-edge)');
    for (const kept of ['[data-hush-a="hide"]', '[data-hush-a="dim"]', '" hidden"', '[data-hush-a="highlight"]']) expect(off).toContain(kept);
  });

  it('puts the reason chip above the row, out of flow, and never repositions absolute (Kick) rows', () => {
    const tw = decorationCss('twitch', 'dark');
    expect(tw).toMatch(/content:attr\(data-hush-r\);\s*position:absolute;top:auto;right:44px;bottom:calc\(100% - 8px\)/);
    expect(tw).toContain('[data-hush-r][data-hush-open]:hover{position:relative}'); // the hovered row anchors it
    expect(decorationCss('kick', 'dark')).not.toContain('position:relative');
  });

  it('themes colors for light and dark', () => {
    expect(decorationCss('twitch', 'dark')).toContain('--hush-c-toxic:#ff6470;--hush-e-toxic:#ff64709e');
    expect(decorationCss('twitch', 'light')).toContain('--hush-c-toxic:#d42f42;--hush-e-toxic:#d42f42b3');
  });

  it('is valid CSS for every platform and theme (parses in the DOM)', () => {
    for (const p of ['twitch', 'youtube', 'kick'] as const)
      for (const t of ['dark', 'light'] as const) {
        const style = document.createElement('style');
        style.textContent = buildCss({ platform: p, theme: t, decorate: true });
        document.head.appendChild(style);
        expect(style.sheet?.cssRules.length ?? 0).toBeGreaterThan(20);
        style.remove();
      }
  });
});
