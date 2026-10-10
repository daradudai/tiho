// tokens.css and tokens.ts must agree on category colors (CSS for components,
// TS for decorations injected into the host page).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES } from '../../src/core/types';
import { CATEGORY_META } from '../../src/ui/tokens';

const css = fs.readFileSync(path.resolve(__dirname, '../../src/ui/tokens.css'), 'utf8');

function block(theme: 'dark' | 'light'): string {
  const start = css.indexOf(`[data-theme="${theme}"] {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}', start));
}

describe('design tokens', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`category colors match (${theme})`, () => {
      const b = block(theme);
      for (const c of CATEGORIES) {
        const m = b.match(new RegExp(`--c-${c}:[ ]*(#[0-9a-f]{6})`, 'i'));
        expect(m?.[1]?.toLowerCase(), `--c-${c}`).toBe(CATEGORY_META[c].color[theme].toLowerCase());
      }
    });
  }
});
