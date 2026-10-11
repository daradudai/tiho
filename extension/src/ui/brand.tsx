// The Tiho mark: a speech bubble whose sound wave settles into a flat line.
// Same geometry as src/assets/logo.svg and the generated toolbar icons.

import type { CSSProperties } from 'preact';
import { BRAND } from './tokens';

export const BUBBLE_PATH =
  'M16 3.5C22.9 3.5 28.5 8.2 28.5 14C28.5 19.8 22.9 24.5 16 24.5C14.5 24.5 13.1 24.3 11.8 23.9C10.2 25.4 7.9 26.6 5.2 27C6.4 25.6 7.1 24 7.3 22.4C4.9 20.5 3.5 17.4 3.5 14C3.5 8.2 9.1 3.5 16 3.5Z';

/** Settled wave (the logo). All wave variants share the same command list so CSS can interpolate `d`. */
export const WAVE_CALM =
  'M9 14 C9.75 9.47 11.25 9.47 12 14 C12.75 17.07 14.25 17.07 15 14 C15.75 12.53 17.25 12.53 18 14 C18.63 14.47 19.88 14.47 20.5 14 C21.13 14 22.38 14 23 14';
export const WAVE_EXCITED =
  'M9 14 C9.75 8.4 11.25 8.4 12 14 C12.75 18.53 14.25 18.53 15 14 C15.75 11.07 17.25 11.07 18 14 C18.63 15.6 19.88 15.6 20.5 14 C21.13 13.33 22.38 13.33 23 14';
export const WAVE_TURBULENT =
  'M9 14 C9.75 8.93 11.25 8.93 12 14 C12.75 19.07 14.25 19.07 15 14 C15.75 9.2 17.25 9.2 18 14 C18.63 18.27 19.88 18.27 20.5 14 C21.13 10.27 22.38 10.27 23 14';
export const WAVE_FLAT =
  'M9 14 C9.75 14 11.25 14 12 14 C12.75 14 14.25 14 15 14 C15.75 14 17.25 14 18 14 C18.63 14 19.88 14 20.5 14 C21.13 14 22.38 14 23 14';

let gradSeq = 0;

export interface MarkProps {
  size?: number;
  /** 'gradient' (default, brand), 'mono' (currentColor bubble, background-colored wave) */
  variant?: 'gradient' | 'mono';
  class?: string;
  title?: string;
  style?: CSSProperties;
}

export function Mark({ size = 20, variant = 'gradient', class: cls, title, style }: MarkProps) {
  const id = `tiho-g${++gradSeq}`;
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      style={style}
    >
      {title && <title>{title}</title>}
      {variant === 'gradient' && (
        <defs>
          <linearGradient id={id} x1="4" y1="3" x2="29" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#7c83ff" />
            <stop offset="0.55" stop-color="#a78bfa" />
            <stop offset="1" stop-color="#5ab2ff" />
          </linearGradient>
        </defs>
      )}
      <path d={BUBBLE_PATH} fill={variant === 'gradient' ? `url(#${id})` : 'currentColor'} />
      <path
        class="tiho-wave"
        d={WAVE_CALM}
        stroke={variant === 'gradient' ? '#fff' : 'var(--mark-wave, #fff)'}
        stroke-width="2.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Wordmark: mark + "Tiho" set in the UI face. */
export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span class="tiho-wordmark" style={{ display: 'inline-flex', alignItems: 'center', gap: `${Math.round(size * 0.4)}px` }}>
      <Mark size={size} />
      <span style={{ fontWeight: 650, fontSize: `${Math.round(size * 0.8)}px`, letterSpacing: '-0.02em' }}>Tiho</span>
    </span>
  );
}

/** The gradient mark as a standalone SVG document (for images / data URLs), with the given wave. */
export function markSvg(wave: string = WAVE_CALM): string {
  const [a, b, c] = BRAND.gradient;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">' +
    `<defs><linearGradient id="g" x1="4" y1="3" x2="29" y2="27" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>` +
    `<path d="${BUBBLE_PATH}" fill="url(#g)"/>` +
    `<path d="${wave}" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

/** CSS url() of an SVG document (parentheses escaped too: some CSS parsers end url() at them). */
export function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replaceAll('(', '%28').replaceAll(')', '%29')}")`;
}

let liveUrls: [string, string] | null = null;

/**
 * The mark for live surfaces (the in-chat bar): two stacked background
 * images, calm and excited. In a page that paints chat all the time this is
 * one display item each instead of an SVG subtree (own viewBox transform and
 * clip, re-walked every frame), and an activity pulse (pulseMark) is a
 * cross-fade of the top image: opacity only, run by the compositor (on an
 * HTML box: Chrome does not composite animations of SVG elements).
 * Sizing + layer hints live with the host's CSS (.tiho-live, bar.css).
 */
export function LiveMark({ size = 18, liveRef }: { size?: number; liveRef?: (el: HTMLElement | null) => void }) {
  liveUrls ??= [svgUrl(markSvg(WAVE_CALM)), svgUrl(markSvg(WAVE_EXCITED))];
  return (
    <span class="tiho-live" ref={liveRef} aria-hidden="true" style={{ width: `${size}px`, height: `${size}px`, backgroundImage: liveUrls[0] }}>
      <span class="tiho-live-busy" style={{ backgroundImage: liveUrls[1] }} />
    </span>
  );
}

/** One activity pulse of a LiveMark: the wave swells and settles (≤ 700 ms, opacity only). */
export function pulseMark(root: Element | null, strength = 1): void {
  const busy = root?.querySelector<HTMLElement>('.tiho-live-busy');
  if (!busy || typeof busy.animate !== 'function') return;
  if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const peak = 0.55 + 0.45 * Math.max(0, Math.min(1, strength));
  busy.animate([{ opacity: 0 }, { opacity: peak, offset: 0.3 }, { opacity: 0 }], { duration: 640, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
