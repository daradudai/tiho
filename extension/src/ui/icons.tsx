// Tiny inline icon set (16px grid, 1.6 stroke, round joins). No icon font, no
// network: everything renders inside shadow DOM and extension pages alike.

import type { CSSProperties, JSX } from 'preact';
import type { Action, Category } from '../core/types';

const P = (d: string) => <path d={d} />;

const ICONS = {
  // categories
  toxic: (
    <path d="M8 1.9c.6 2.3 3.9 3.7 3.9 7.2a3.9 3.9 0 0 1-7.8 0c0-1.6.8-2.7 1.7-3.4.1 1.3.7 2.1 1.5 2.4C6.9 6.1 7.3 3.8 8 1.9z" />
  ),
  scam: (
    <>
      {P('M10.9 4.1v4.7a3.4 3.4 0 0 1-6.8 0V6.6')}
      {P('M4.1 6.6 2.6 8.1')}
      <circle cx="10.9" cy="2.9" r="1.2" />
    </>
  ),
  spam: (
    <>
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.8" />
      {P('M2.6 10.4V4.4c0-1 .8-1.8 1.8-1.8h6')}
    </>
  ),
  noise: <>{P('M2.8 7v2M5.4 5v6M8 3v10M10.6 5.6v4.8M13.2 7.2v1.6')}</>,
  negative: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      {P('M5.7 10.9c.6-.8 1.4-1.2 2.3-1.2s1.7.4 2.3 1.2')}
      {P('M6 6.5h.01M10 6.5h.01')}
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      {P('M6.3 6.3a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.6')}
      {P('M8 11.4h.01')}
    </>
  ),
  positive: <path d="M8 13.1S2.6 10 2.6 6.2A2.8 2.8 0 0 1 8 5.1a2.8 2.8 0 0 1 5.4 1.1C13.4 10 8 13.1 8 13.1z" />,
  clean: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      {P('M5.6 8.2l1.6 1.6 3.2-3.4')}
    </>
  ),

  // actions
  show: (
    <>
      {P('M1.8 8S4.1 3.6 8 3.6 14.2 8 14.2 8 11.9 12.4 8 12.4 1.8 8 1.8 8z')}
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  highlight: <path d="M8 2.2l1.5 3.6 3.7.4-2.8 2.5.8 3.7L8 10.5l-3.2 1.9.8-3.7-2.8-2.5 3.7-.4z" />,
  dim: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none" />
    </>
  ),
  collapse: (
    <>
      <rect x="2.4" y="6.2" width="11.2" height="3.6" rx="1.8" />
      {P('M5.6 3.2 8 4.6l2.4-1.4M5.6 12.8 8 11.4l2.4 1.4')}
    </>
  ),
  hide: (
    <>
      {P('M6.3 3.8A6.6 6.6 0 0 1 8 3.6c3.9 0 6.2 4.4 6.2 4.4a11 11 0 0 1-1.6 2.1M4.1 5.1A10.6 10.6 0 0 0 1.8 8s2.3 4.4 6.2 4.4c1 0 1.9-.3 2.7-.7')}
      {P('M2.4 2.4l11.2 11.2')}
    </>
  ),

  // ui
  chevronDown: P('M4.5 6.2 8 9.7l3.5-3.5'),
  chevronRight: P('M6.2 4.5 9.7 8l-3.5 3.5'),
  chevronUp: P('M4.5 9.8 8 6.3l3.5 3.5'),
  arrowUpRight: P('M5.2 10.8 10.8 5.2M6 5.2h4.8V10'),
  arrowRight: P('M3.2 8h9.6M8.8 4l4 4-4 4'),
  power: P('M8 2.2v5.2M4.6 4.4a5.2 5.2 0 1 0 6.8 0'),
  pause: P('M6 3.5v9M10 3.5v9'),
  play: <path d="M5 3.4v9.2L12.4 8z" />,
  x: P('M4 4l8 8M12 4l-8 8'),
  plus: P('M8 3.2v9.6M3.2 8h9.6'),
  check: P('M3.4 8.4l3 3 6.2-6.6'),
  trash: P('M2.8 4.4h10.4M6.4 4.4V3c0-.4.3-.8.8-.8h1.6c.4 0 .8.4.8.8v1.4M4.2 4.4l.6 8.4c0 .6.5 1 1 1h4.4c.6 0 1-.4 1-1l.6-8.4'),
  lock: (
    <>
      <rect x="3.2" y="7" width="9.6" height="6.6" rx="1.8" />
      {P('M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7')}
    </>
  ),
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.6" />
      {P('M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2')}
    </>
  ),
  zap: <path d="M8.8 1.8 3.4 9.2h4.2l-.6 5 5.4-7.4H8.2z" />,
  server: (
    <>
      <rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.4" />
      <rect x="2.4" y="9" width="11.2" height="4.4" rx="1.4" />
      {P('M4.8 4.8h.01M4.8 11.2h.01')}
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      {P('M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1')}
    </>
  ),
  sliders: P('M2.6 4.6h6.2M11.6 4.6h1.8M2.6 11.4h1.8M7.2 11.4h6.2M10.2 3v3.2M5.8 9.8V13'),
  inbox: (
    <>
      {P('M2.4 9.2l1.8-5.4c.2-.5.6-.8 1.1-.8h5.4c.5 0 .9.3 1.1.8l1.8 5.4V12c0 .6-.5 1-1 1H3.4c-.6 0-1-.4-1-1z')}
      {P('M2.4 9.2h3.2l.8 1.4h3.2l.8-1.4h3.2')}
    </>
  ),
  list: P('M5.6 4.4h7.6M5.6 8h7.6M5.6 11.6h7.6M2.8 4.4h.01M2.8 8h.01M2.8 11.6h.01'),
  activity: P('M1.8 8.4h2.6l1.8-4.6 3.4 8.6 1.8-4h2.8'),
  sparkles: (
    <>
      <path d="M6.6 2.6l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" />
      <path d="M11.8 9.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </>
  ),
  shield: P('M8 1.8l5 1.9v3.8c0 3.2-2.1 5.6-5 6.7-2.9-1.1-5-3.5-5-6.7V3.7z'),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      {P('M2.2 8h11.6M8 2.1c1.6 1.7 2.4 3.7 2.4 5.9S9.6 12.2 8 13.9C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.1z')}
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      {P('M8 7.4v3.4M8 5.2h.01')}
    </>
  ),
  keyboard: (
    <>
      <rect x="1.8" y="3.8" width="12.4" height="8.4" rx="1.6" />
      {P('M4.4 6.4h.01M6.8 6.4h.01M9.2 6.4h.01M11.6 6.4h.01M5.2 9.6h5.6')}
    </>
  ),
  mouse: (
    <>
      <rect x="4.2" y="1.8" width="7.6" height="12.4" rx="3.8" />
      {P('M8 4.4v2')}
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      {P('M2.8 13.6c.6-2.4 2.7-3.8 5.2-3.8s4.6 1.4 5.2 3.8')}
    </>
  ),
  type: P('M3.2 4V2.8h9.6V4M8 2.8v10.4M6 13.2h4'),
  regex: P('M10.8 2.4v5.2M8.6 3.7l4.4 2.6M8.6 6.3 13 3.7M3.6 11.4h2.4v2.4H3.6z'),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      {P('M10.4 10.4l3.2 3.2')}
    </>
  ),
  thumbUp: P('M5.2 7.2v6.2M5.2 7.2l2.4-5c.9 0 1.8.8 1.6 1.9l-.4 2.3h3.4c.8 0 1.4.8 1.2 1.6l-.9 4.2c-.1.6-.7 1.2-1.4 1.2H5.2M5.2 7.2H3.2c-.3 0-.6.3-.6.6v5c0 .3.3.6.6.6h2'),
  wave: P('M1.8 8c1.4-3 2.8-3 4.2 0s2.8 3 4.2 0c.9-1.8 1.8-2 3.8-.4'),
  eyeOff: P('M2.4 2.4l11.2 11.2M6.3 3.8A6.6 6.6 0 0 1 8 3.6c3.9 0 6.2 4.4 6.2 4.4a11 11 0 0 1-1.6 2.1M4.1 5.1A10.6 10.6 0 0 0 1.8 8s2.3 4.4 6.2 4.4c1 0 1.9-.3 2.7-.7'),
  more: P('M3.6 8h.01M8 8h.01M12.4 8h.01'),
  refresh: P('M13.2 4.4v3h-3M2.8 11.6v-3h3M12.7 7.4A5 5 0 0 0 3.6 5.6M3.3 8.6a5 5 0 0 0 9.1 1.8'),
  download: P('M8 2.4v8M4.8 7.6 8 10.8l3.2-3.2M2.8 13.6h10.4'),
  external: P('M9.6 2.8h3.6v3.6M13.2 2.8 7.6 8.4M11.6 9.6v2.8c0 .4-.4.8-.8.8H3.6c-.4 0-.8-.4-.8-.8V5.2c0-.4.4-.8.8-.8h2.8'),
  github: (
    <path d="M8 1.6a6.4 6.4 0 0 0-2 12.5c.3 0 .4-.1.4-.3v-1.2c-1.8.4-2.2-.8-2.2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.6 0 1 .7 1 .7.6 1 1.5.7 1.9.5 0-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.2-1.3.7-1.7-.1-.2-.3-.8.1-1.7 0 0 .5-.2 1.8.7a6.2 6.2 0 0 1 3.2 0c1.2-.8 1.8-.7 1.8-.7.3.9.1 1.5.1 1.7.4.4.7 1 .7 1.7 0 2.5-1.5 3-2.9 3.2.2.2.4.6.4 1.2v1.8c0 .2.1.4.5.3A6.4 6.4 0 0 0 8 1.6z" fill="currentColor" stroke="none" />
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName | Category | Action;
  size?: number;
  class?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  /** Filled glyph (category marks look softer filled at tiny sizes). */
  fill?: boolean;
  title?: string;
}

const FILLED_OK = new Set(['toxic', 'positive', 'highlight', 'play', 'zap']);

export function Icon({ name, size = 16, class: cls, strokeWidth = 1.6, style, fill, title }: IconProps) {
  const filled = fill && FILLED_OK.has(name);
  return (
    <svg
      class={cls ? `ico ${cls}` : 'ico'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      style={style}
    >
      {title && <title>{title}</title>}
      {ICONS[name as IconName]}
    </svg>
  );
}

/** Simplified platform glyphs (nominative use: which site a stat belongs to). */
export function PlatformGlyph({ platform, size = 16 }: { platform: string; size?: number }) {
  if (platform === 'youtube')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="3.2" width="14" height="9.6" rx="3" fill="#ff0033" />
        <path d="M6.6 5.7v4.6L10.6 8z" fill="#fff" />
      </svg>
    );
  if (platform === 'twitch')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 1.5 1.8 4.4v9h3.1V15h1.7l1.7-1.6h2.6l3.3-3.3V1.5z" fill="#9146ff" />
        <path d="M7 4.6v3.6M10.2 4.6v3.6" stroke="#fff" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    );
  if (platform === 'kick')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="3.2" fill="#53fc18" />
        <path d="M4.6 4v8M4.6 8h1.6l3-4M6.2 8l3 4" stroke="#0b0e0f" stroke-width="2" stroke-linecap="square" fill="none" />
      </svg>
    );
  return <Icon name="globe" size={size} />;
}
