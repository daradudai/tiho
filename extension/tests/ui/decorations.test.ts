import { describe, expect, it } from 'vitest';
import { decorationCss } from '../../src/ui/decorations';
import { buildCss } from '../../src/runtime/styles';

/** Every selector of every style rule (keyframes skipped). */
function selectors(css: string): string[] {
  return [...css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^@media[^{]*\{/, '').trim())
    .filter((s) => s && !s.startsWith(':where(')) // the variables
    .flatMap((s) => s.split(','))
    .map((s) => s.trim());
}

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
          // one compound selector: attributes, :not(attribute), :hover, ::before / ::after
          expect(s, s).toMatch(/^(\[data-hush-[a-z]+(="[a-z]+")?\]|:not\(\[data-hush-[a-z]+(="[a-z]+")?\]\)|:hover|::before|::after)+$/);
        }
      }
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
