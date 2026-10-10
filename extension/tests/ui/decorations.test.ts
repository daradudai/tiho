import { describe, expect, it } from 'vitest';
import { decorationCss } from '../../src/ui/decorations';

describe('decorationCss', () => {
  it('scopes to the row selector and bumps specificity', () => {
    const css = decorationCss('twitch', 'dark', { rowSelector: '.chat-line__message' });
    expect(css).toContain(':is(.chat-line__message)[data-hush-c="toxic"]');
    expect(css).toContain('html :is(.chat-line__message)[data-hush-a="hide"]');
    expect(css).toContain('counter(hush-run) " hidden"');
  });

  it('drops edges/tooltips when decorate is off but keeps collapse/dim/hide', () => {
    const on = decorationCss('youtube', 'light');
    const off = decorationCss('youtube', 'light', { decorate: false });
    expect(on).toContain('content:attr(data-hush-r)');
    expect(off).not.toContain('content:attr(data-hush-r)');
    expect(off).toContain('[data-hush-a="dim"]');
    expect(off).toContain('" hidden"');
  });

  it('is valid CSS for every platform/theme (parses in the DOM)', () => {
    for (const p of ['twitch', 'youtube', 'kick'])
      for (const t of ['dark', 'light'] as const) {
        const style = document.createElement('style');
        style.textContent = decorationCss(p, t, { rowSelector: '.row' });
        document.head.appendChild(style);
        expect(style.sheet?.cssRules.length ?? 1).toBeGreaterThan(0);
        style.remove();
      }
  });
});
