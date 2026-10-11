// The one stylesheet that turns verdict attributes into visuals.
//
// Rows carry at most these attributes (written by the runtime):
//   data-tiho-a   show | highlight | dim | collapse | hide | pending
//   data-tiho-c   toxic | scam | spam | noise | negative | question | positive | clean
//   data-tiho-r   short reason ("toxic · 94%", "!command") → hover chip
//   data-tiho-wh  wave head: live count ("37")              → "×37" badge
//   data-tiho-wm  wave member (collapses into its head, takes no space)
//   data-tiho-run last collapsed row of a run: run length    → "3 hidden · show" pill
//                 (the run's other collapsed rows take no space; the pill row is
//                 also a button: tabindex, role and aria-label, see markRun)
//   data-tiho-open  user expanded a collapsed row
// and the chat list itself may carry
//   data-tiho-list  rows without data-tiho-a yet are invisible (hidden from
//                   birth until their first verdict — no flash of unfiltered text);
//                   in a virtual list (Kick) they take no space either
//
// The row rules and all visuals live in src/ui/decorations.ts (themed per
// platform and light/dark, Basic or Advanced); this module adds the list-level
// rule and owns the <style> element. Show hidden and Solo are variants of the
// whole sheet: turning one on or off is one text swap (one style recalc, like
// a theme change), with no write on any row. Performance: selectors are plain attribute selectors (Blink
// buckets them by attribute, so only rows carrying data-tiho-* are ever
// matched), never scoped with the platform row selector — only the runtime
// writes these attributes, and only on rows. Measured in tests/stress:
// :is(<row selector list>) scoping and "+" / "> *" combinators on every row
// tripled style-recalc cost; pill runs are marked by the runtime instead.
// (The one child rule left, scoped to pill rows, measured within noise.)
// No inline styles are ever written on rows.

import type { UiMode } from '../core/settings';
import type { Category, Platform } from '../core/types';
import { decorationCss, virtualList } from '../ui/decorations';

export const ATTR = {
  action: 'data-tiho-a',
  category: 'data-tiho-c',
  reason: 'data-tiho-r',
  waveHead: 'data-tiho-wh',
  waveMember: 'data-tiho-wm',
  run: 'data-tiho-run',
  open: 'data-tiho-open',
  list: 'data-tiho-list',
} as const;

export const STYLE_ID = 'tiho-row-style';

export interface StyleOptions {
  decorate: boolean;
  theme: 'dark' | 'light';
  /** Platform skin of the decorations (pill indent, badge placement). */
  platform?: Platform;
  /** Basic draws no category edges and no reason chips (default 'advanced'). */
  mode?: UiMode;
  /** Show hidden: hidden and folded rows come back in place, faded and tagged. */
  peek?: boolean;
  /** Solo: only this category's rows, each tagged with its reason and normal action. */
  solo?: Category | null;
  /** Accepted for compatibility; ignored — selectors are attribute-only (see header). */
  rowSelector?: string;
}

export function buildCss(o: StyleOptions): string {
  const platform = o.platform ?? 'twitch';
  // in a virtual list (Kick) a row waiting for its verdict takes no space either: see PlatformDeco.virtual
  const unseen = virtualList(platform) ? 'display:none' : 'visibility:hidden';
  return (
    `[data-tiho-list]>:not([data-tiho-a]){${unseen}!important}` +
    decorationCss(platform, o.theme, { decorate: o.decorate, mode: o.mode, peek: o.peek, solo: o.solo })
  );
}

/** Owns the injected <style> element (in the document head or the list's shadow root). */
export class RowStyles {
  private el: HTMLStyleElement | null = null;
  private css = '';

  mount(root: Document | ShadowRoot, o: StyleOptions): void {
    // nodeType checks instead of instanceof: content scripts / iframes / test DOMs have distinct globals
    const isDoc = root.nodeType === 9;
    const doc = isDoc ? (root as Document) : (root.ownerDocument ?? document);
    const parent: Node = isDoc ? ((root as Document).head ?? (root as Document).documentElement) : root;
    if (!this.el || this.el.parentNode !== parent) {
      this.el?.remove();
      const existing = isDoc ? (root as Document).getElementById(STYLE_ID) : null;
      this.el = (existing as HTMLStyleElement | null) ?? doc.createElement('style');
      this.el.id = STYLE_ID;
      parent.appendChild(this.el);
      this.css = '';
    }
    this.update(o);
  }

  update(o: StyleOptions): void {
    if (!this.el) return;
    const css = buildCss(o);
    if (css !== this.css) {
      this.el.textContent = css;
      this.css = css;
    }
  }

  remove(): void {
    this.el?.remove();
    this.el = null;
    this.css = '';
  }
}
