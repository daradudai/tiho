// Cheap SVG charts: one <path> per series, recomputed only when the input
// signal changes (≤ 1/s for rate/vibe). Width-agnostic (viewBox +
// non-scaling strokes), so no layout reads are ever needed.

import { useComputed, type ReadonlySignal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import { seriesPath, smooth } from './format';

let uid = 0;
const nextId = (p: string) => `${p}${++uid}`;

const VW = 300; // virtual width; stretched by CSS

export interface SparklineProps {
  values: ReadonlySignal<number[]>;
  height?: number;
  /** CSS color (var() ok). */
  color?: string;
  /** Fixed max (else auto). */
  max?: number;
  class?: string;
  /** Moving-average radius. */
  smoothing?: number;
  /** Show hover crosshair with value tooltip (pages only). */
  hover?: (v: number, i: number, n: number) => string;
  fill?: boolean;
}

export function Sparkline({ values, height = 32, color = 'var(--accent)', max, class: cls, smoothing = 1, hover, fill = true }: SparklineProps) {
  const [gid] = useState(() => nextId('hsg'));
  const paths = useComputed(() => {
    const v = smooth(values.value, smoothing);
    let m = max ?? 0;
    if (max === undefined) for (const x of v) if (x > m) m = x;
    return seriesPath(v, VW, height, { min: 0, max: Math.max(m * 1.15, 1) });
  });
  const line = useComputed(() => paths.value[0]);
  const area = useComputed(() => paths.value[1]);
  const lastY = useComputed(() => {
    const v = smooth(values.value, smoothing);
    let m = max ?? 0;
    if (max === undefined) for (const x of v) if (x > m) m = x;
    m = Math.max(m * 1.15, 1);
    const last = v[v.length - 1] ?? 0;
    const pad = 1.5;
    return `${((height - pad - (last / m) * (height - pad * 2)) / height) * 100}%`;
  });
  const [hov, setHov] = useState<{ x: number; i: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const onMove = hover
    ? (e: PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const n = values.peek().length;
        const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const i = Math.round(fx * (n - 1));
        setHov({ x: (i / Math.max(1, n - 1)) * 100, i });
      }
    : undefined;
  return (
    <div
      ref={ref}
      class={`spark ${cls ?? ''}`}
      style={{ height: `${height}px`, '--spark-c': color } as any}
      onPointerMove={onMove}
      onPointerLeave={hover ? () => setHov(null) : undefined}
    >
      <svg viewBox={`0 0 ${VW} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color={color} stop-opacity="0.28" />
            <stop offset="1" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        {fill && <path d={area} fill={`url(#${gid})`} />}
        <path d={line} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
      <span class="spark-dot" style={{ top: lastY.value }} />
      {hover && hov && (
        <>
          <span class="spark-x" style={{ left: `${hov.x}%` }} />
          <span class="spark-tip" style={{ left: `${Math.min(88, Math.max(12, hov.x))}%` }}>
            {hover(values.peek()[hov.i] ?? 0, hov.i, values.peek().length)}
          </span>
        </>
      )}
    </div>
  );
}

export interface DivergingProps {
  /** Values in [-1, 1]. */
  values: ReadonlySignal<number[]>;
  height?: number;
  pos?: string;
  neg?: string;
  class?: string;
  hover?: (v: number, i: number, n: number) => string;
}

/** Diverging area around a zero line: above = positive color, below = negative. */
export function Diverging({ values, height = 32, pos = 'var(--c-positive)', neg = 'var(--c-negative)', class: cls, hover }: DivergingProps) {
  const [ids] = useState(() => ({ top: nextId('hdt'), bot: nextId('hdb'), gp: nextId('hdgp'), gn: nextId('hdgn') }));
  const mid = height / 2;
  const line = useComputed(() => {
    const v = smooth(values.value, 1);
    return seriesPath(v, VW, height, { min: -1, max: 1, pad: 1.5 })[0];
  });
  const area = useComputed(() => (line.value ? `${line.value}L${VW} ${mid}L0 ${mid}Z` : ''));
  const [hov, setHov] = useState<{ x: number; i: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const onMove = hover
    ? (e: PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const n = values.peek().length;
        const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const i = Math.round(fx * (n - 1));
        setHov({ x: (i / Math.max(1, n - 1)) * 100, i });
      }
    : undefined;
  return (
    <div
      ref={ref}
      class={`spark diverging ${cls ?? ''}`}
      style={{ height: `${height}px` }}
      onPointerMove={onMove}
      onPointerLeave={hover ? () => setHov(null) : undefined}
    >
      <svg viewBox={`0 0 ${VW} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
        <defs>
          <clipPath id={ids.top}>
            <rect x="0" y="0" width={VW} height={mid} />
          </clipPath>
          <clipPath id={ids.bot}>
            <rect x="0" y={mid} width={VW} height={mid} />
          </clipPath>
          <linearGradient id={ids.gp} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color={pos} stop-opacity="0.38" />
            <stop offset="0.5" stop-color={pos} stop-opacity="0.04" />
          </linearGradient>
          <linearGradient id={ids.gn} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.5" stop-color={neg} stop-opacity="0.04" />
            <stop offset="1" stop-color={neg} stop-opacity="0.38" />
          </linearGradient>
        </defs>
        <line x1="0" x2={VW} y1={mid} y2={mid} stroke="var(--track)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="2 3" />
        <g clip-path={`url(#${ids.top})`}>
          <path d={area} fill={`url(#${ids.gp})`} />
          <path d={line} fill="none" stroke={pos} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        </g>
        <g clip-path={`url(#${ids.bot})`}>
          <path d={area} fill={`url(#${ids.gn})`} />
          <path d={line} fill="none" stroke={neg} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        </g>
      </svg>
      {hover && hov && (
        <>
          <span class="spark-x" style={{ left: `${hov.x}%` }} />
          <span class="spark-tip" style={{ left: `${Math.min(88, Math.max(12, hov.x))}%` }}>
            {hover(values.peek()[hov.i] ?? 0, hov.i, values.peek().length)}
          </span>
        </>
      )}
    </div>
  );
}

/** Progress ring (model download etc.). */
export function Ring({ value, size = 16, stroke = 2, color = 'var(--accent)', track = 'var(--track)', class: cls }: { value: number; size?: number; stroke?: number; color?: string; track?: string; class?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg class={cls} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} stroke-width={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        stroke-width={stroke}
        stroke-linecap="round"
        stroke-dasharray={`${c} ${c}`}
        stroke-dashoffset={c * (1 - v)}
        style={{ transition: 'stroke-dashoffset var(--dur) var(--ease)' }}
      />
    </svg>
  );
}
