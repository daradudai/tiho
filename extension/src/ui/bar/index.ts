// mountBar: inserts the Hush bar into the platform's chat column, inside a
// shadow root so the page's CSS and ours never meet.

import { h, render } from 'preact';
import { effect } from '@preact/signals';
import type { BarActions } from '../../core/bar-actions';
import type { Store } from '../../core/store';
import { pulseWave } from '../brand';
import tokensCss from '../tokens.css?inline';
import barCss from './bar.css?inline';
import { Bar } from './Bar';
import { createView } from './view';

export type BarAnchor = { el: HTMLElement; where: 'before' | 'prepend' };

export interface MountOptions {
  /** Shadow root mode (default 'open' so tests can reach in; styles are isolated either way). */
  shadow?: ShadowRootMode;
}

export const BAR_TAG = 'hush-bar';

export function mountBar(anchor: BarAnchor, store: Store, actions: BarActions, opts: MountOptions = {}): () => void {
  const host = document.createElement(BAR_TAG);
  host.setAttribute('data-hush-ui', '');
  const shadow = host.attachShadow({ mode: opts.shadow ?? 'open' });

  const style = document.createElement('style');
  style.textContent = `${tokensCss}\n${barCss}`;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);

  if (anchor.where === 'prepend') anchor.el.prepend(host);
  else anchor.el.before(host);

  const { view, dispose: disposeView } = createView(store);

  // Hide entirely when the user turned the bar off.
  const disposeVisible = effect(() => {
    host.style.setProperty('display', store.settings.value.showBar ? 'block' : 'none', 'important');
  });

  // Activity pulse: at most every 700 ms, strength follows msgs/s.
  let wave: SVGPathElement | null = null;
  let lastPulse = 0;
  const disposePulse = effect(() => {
    void store.totals.value;
    const t = performance.now();
    if (t - lastPulse < 700 || document.hidden || !wave) return;
    lastPulse = t;
    const r = store.rate.peek();
    const now = r[r.length - 1] ?? 0;
    pulseWave(wave, Math.min(1, now / 60));
  });

  render(
    h(Bar, {
      v: view,
      actions,
      waveRef: (el: SVGPathElement | null) => {
        wave = el;
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
