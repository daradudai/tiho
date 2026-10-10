// The Hush mark: a speech bubble whose sound wave settles into a flat line.
// Same geometry as src/assets/logo.svg and the generated toolbar icons.

import type { CSSProperties } from 'preact';

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
  /** Ref to the wave path, for activity pulses. */
  waveRef?: (el: SVGPathElement | null) => void;
  title?: string;
  style?: CSSProperties;
}

export function Mark({ size = 20, variant = 'gradient', class: cls, waveRef, title, style }: MarkProps) {
  const id = `hush-g${++gradSeq}`;
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
        ref={waveRef}
        class="hush-wave"
        d={WAVE_CALM}
        stroke={variant === 'gradient' ? '#fff' : 'var(--mark-wave, #fff)'}
        stroke-width="2.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Wordmark: mark + "Hush" set in the UI face. */
export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span class="hush-wordmark" style={{ display: 'inline-flex', alignItems: 'center', gap: `${Math.round(size * 0.4)}px` }}>
      <Mark size={size} />
      <span style={{ fontWeight: 650, fontSize: `${Math.round(size * 0.8)}px`, letterSpacing: '-0.02em' }}>Hush</span>
    </span>
  );
}

/** Pulse the wave of a mark once (activity). Cheap: one tiny SVG path, ≤ 420 ms. */
export function pulseWave(el: SVGPathElement | null, strength = 1): void {
  if (!el || typeof el.animate !== 'function') return;
  if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const peak = strength > 0.6 ? WAVE_EXCITED : WAVE_CALM;
  try {
    el.animate(
      [
        { d: `path("${WAVE_CALM}")`, transform: 'scaleY(1)' },
        { d: `path("${peak}")`, transform: `scaleY(${1 + 0.18 * strength})`, offset: 0.35 },
        { d: `path("${WAVE_CALM}")`, transform: 'scaleY(1)' },
      ] as Keyframe[],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  } catch {
    /* `d` not animatable here: ignore */
  }
}
