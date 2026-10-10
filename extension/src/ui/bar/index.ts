// mountBar: inserts the Hush bar into the platform's chat column, inside a
// shadow root so the page's CSS and ours never meet.
//
// Cost model (tests/stress, bar A/B): the bar must stay invisible in the
// page's main-thread profile while chat flows. Counters update ≤ 2×/s, in
// frames the page renders anyway (see view.ts), inside a size/layout/paint-
// contained row; motion is opacity / transform on its own layer (compositor).
// Nothing animates per frame on the main thread.

import { h, render } from 'preact';
import { effect } from '@preact/signals';
import type { BarActions } from '../../core/bar-actions';
import type { Store } from '../../core/store';
import { pulseMark } from '../brand';
import tokensCss from '../tokens.css?inline';
import barCss from './bar.css?inline';
import { Bar } from './Bar';
import { createView } from './view';

export type BarAnchor = { el: HTMLElement; where: 'before' | 'prepend' };

export interface MountOptions {
  /**
   * Shadow root mode. Default 'closed': page scripts cannot reach the bar's
   * buttons (pause, presets) and press them. Tests pass 'open'.
   */
  shadow?: ShadowRootMode;
  /** Act on script-generated events too (tests drive the bar with el.click()). Default: only the viewer's own input. */
  synthetic?: boolean;
}

export const BAR_TAG = 'hush-bar';

/** Events the bar acts on; untrusted ones (dispatched by a script) are dropped before they reach it. */
const INPUT_EVENTS = ['click', 'contextmenu', 'pointerdown', 'keydown'] as const;

function dropSynthetic(e: Event): void {
  if (e.isTrusted) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}

/** "www.twitch.tv" → "twitch.tv" (enough for the three chat sites). */
const siteOf = (host: string) => host.split('.').slice(-2).join('.');

/**
 * True when another site frames this chat (a Twitch or Kick embed on someone's
 * page, YouTube chat embedded elsewhere). The bar changes settings on every
 * site and tab, so it is not shown where the framing page could cover it and
 * steer the viewer's clicks (clickjacking). Filtering still runs there.
 */
export function framedByOtherSite(win: Window): boolean {
  if (win.top === win) return false;
  const own = siteOf(win.location.hostname);
  const ancestors = win.location.ancestorOrigins;
  if (ancestors) {
    for (let i = 0; i < ancestors.length; i++) {
      try {
        if (siteOf(new URL(ancestors[i]!).hostname) !== own) return true;
      } catch {
        return true; // opaque origin ("null"): a sandboxed frame
      }
    }
    return false;
  }
  try {
    return siteOf(win.top!.location.hostname) !== own;
  } catch {
    return true; // reading a cross-origin top throws
  }
}

/**
 * Minimum ms between activity pulses of the mark. Even on the compositor a
 * running animation costs the page a little style work per frame: keep it rare.
 */
const PULSE_MS = 6000;

export function mountBar(anchor: BarAnchor, store: Store, actions: BarActions, opts: MountOptions = {}): () => void {
  if (framedByOtherSite(window)) return () => {};
  const host = document.createElement(BAR_TAG);
  host.setAttribute('data-hush-ui', '');
  const shadow = host.attachShadow({ mode: opts.shadow ?? 'closed' });

  const style = document.createElement('style');
  style.textContent = `${tokensCss}\n${barCss}`;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  if (!opts.synthetic) for (const t of INPUT_EVENTS) mount.addEventListener(t, dropSynthetic, true);

  if (anchor.where === 'prepend') anchor.el.prepend(host);
  else anchor.el.before(host);

  const { view, dispose: disposeView } = createView(store);

  // Hide entirely when the user turned the bar off.
  const disposeVisible = effect(() => {
    host.style.setProperty('display', store.settings.value.showBar ? 'block' : 'none', 'important');
  });

  // Activity pulse while chat flows: the mark's wave swells now and then,
  // strength follows msgs/s. Compositor-only (see LiveMark), and sparse.
  let mark: HTMLElement | null = null;
  let lastPulse = -Infinity;
  let lastSeen = -1;
  const disposePulse = effect(() => {
    const seen = view.totals.value.seen;
    const t = performance.now();
    const moved = seen !== lastSeen;
    lastSeen = seen;
    if (!moved || t - lastPulse < PULSE_MS || document.hidden || !mark) return;
    lastPulse = t;
    const r = view.rate.peek();
    pulseMark(mark, Math.min(1, (r[r.length - 1] ?? 0) / 60));
  });

  render(
    h(Bar, {
      v: view,
      actions,
      markRef: (el: HTMLElement | null) => {
        mark = el;
      },
    }),
    mount,
  );

  return () => {
    disposePulse();
    disposeVisible();
    disposeView();
    render(null, mount);
    host.remove();
  };
}
