// Small component kit for extension pages (popup, side panel, onboarding).

import { signal, type Signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../../core/settings';
import type { ModelStatus } from '../../core/types';
import { getModelStatus, onModelStatus } from '../bridge';
import { Icon, type IconName } from '../icons';

/* ── theme ─────────────────────────────────────────────────────────── */

/** Follows the OS theme unless ?theme=dark|light (showcase) or a stored override. */
export function initTheme(): void {
  const forced = new URLSearchParams(location.search).get('theme');
  const root = document.documentElement;
  if (forced === 'dark' || forced === 'light') {
    root.dataset.theme = forced;
    return;
  }
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => (root.dataset.theme = mq.matches ? 'dark' : 'light');
  apply();
  mq.addEventListener?.('change', apply);
}

/* ── settings (shared, optimistic) ─────────────────────────────────── */

export const settings: Signal<Settings> = signal(DEFAULT_SETTINGS);
export const settingsReady = signal(false);
let settingsInit = false;

export function initSettings(): void {
  if (settingsInit) return;
  settingsInit = true;
  loadSettings()
    .then((s) => {
      settings.value = s;
      settingsReady.value = true;
    })
    .catch(() => (settingsReady.value = true));
  try {
    onSettingsChanged((s) => (settings.value = s));
  } catch {
    /* no chrome.storage (tests) */
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings.value = { ...settings.value, ...patch };
  try {
    settings.value = await saveSettings(patch);
  } catch {
    /* keep optimistic value */
  }
}

/* ── model status ──────────────────────────────────────────────────── */

export const modelStatus = signal<ModelStatus | null>(null);
let modelInit = false;
export function initModelStatus(pollMs = 0): void {
  if (modelInit) return;
  modelInit = true;
  const pull = () => getModelStatus().then((s) => s && (modelStatus.value = s));
  void pull();
  onModelStatus((s) => (modelStatus.value = s));
  if (pollMs) setInterval(pull, pollMs);
}

/* ── components ────────────────────────────────────────────────────── */

export function Toggle({ checked, onChange, label, size = 'md', disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; size?: 'md' | 'lg' | 'sm'; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      class={`k-toggle k-toggle-${size}`}
      onClick={() => onChange(!checked)}
    >
      <span class="k-toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ComponentChildren; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const i = options.findIndex((o) => o.value === value);
  return (
    <div class={`k-seg k-seg-${size}`} role="radiogroup" aria-label={label} style={{ '--i': i, '--n': options.length } as any} data-none={i < 0 ? '' : undefined}>
      <span class="k-seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} class="k-seg-btn" title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  label,
  left,
  right,
  format,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  left?: string;
  right?: string;
  format?: (v: number) => string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const p = ((v - min) / (max - min)) * 100;
  return (
    <div class="k-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={label}
        aria-valuetext={format ? format(v) : undefined}
        style={{ '--p': `${p}%` } as any}
        onInput={(e) => setV(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
      {(left || right || format) && (
        <div class="k-slider-scale">
          <span>{left}</span>
          {format && <b>{format(v)}</b>}
          <span>{right}</span>
        </div>
      )}
    </div>
  );
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  icon,
  iconRight,
  onClick,
  disabled,
  title,
  type = 'button',
  class: cls,
}: {
  children?: ComponentChildren;
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  class?: string;
}) {
  return (
    <button type={type} class={`k-btn k-btn-${variant} k-btn-${size} ${cls ?? ''}`} onClick={onClick} disabled={disabled} title={title} aria-label={!children ? title : undefined}>
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} strokeWidth={1.8} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 12 : 14} strokeWidth={1.8} />}
    </button>
  );
}

export function Card({ children, class: cls, title, action, pad = true }: { children: ComponentChildren; class?: string; title?: ComponentChildren; action?: ComponentChildren; pad?: boolean }) {
  return (
    <section class={`k-card ${pad ? 'k-card-pad' : ''} ${cls ?? ''}`}>
      {(title || action) && (
        <header class="k-card-head">
          {title && <h3 class="k-label">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Row({ title, desc, children, icon }: { title: ComponentChildren; desc?: ComponentChildren; children?: ComponentChildren; icon?: JSX.Element }) {
  return (
    <div class="k-row">
      {icon && <span class="k-row-ico">{icon}</span>}
      <div class="k-row-text">
        <div class="k-row-title">{title}</div>
        {desc && <div class="k-row-desc">{desc}</div>}
      </div>
      {children && <div class="k-row-ctl">{children}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', dot }: { children: ComponentChildren; tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'accent' | 'info'; dot?: boolean }) {
  return (
    <span class={`k-badge k-badge-${tone}`}>
      {dot && <span class="k-badge-dot" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="k-kbd">{children}</kbd>;
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ComponentChildren }) {
  return (
    <div class="k-empty">
      <span class="k-empty-ico">
        <Icon name={icon} size={18} />
      </span>
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Re-render every `ms` (relative timestamps). */
export function useTick(ms = 5000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}
