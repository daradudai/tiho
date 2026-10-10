// The in-chat bar. Compact row (~36 px): mark + calm ring, preset switch,
// category chips with live counters, model status; expands into a mini
// dashboard overlay. Reads only the frame-throttled View, never the raw store.

import { useComputed, type ReadonlySignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BarActions } from '../../core/bar-actions';
import type { PresetId } from '../../core/settings';
import type { Action, Category, ModelStatus } from '../../core/types';
import { modelSummary } from '../model-status';
import { CATEGORIES } from '../../core/types';
import { Mark } from '../brand';
import { Diverging, Ring, Sparkline } from '../charts';
import { ago, compact, grouped, pct, rate, vibeWord } from '../format';
import { Icon } from '../icons';
import { ACTION_META, CATEGORY_META, CHIP_CATEGORIES, PRESET_META, PRESET_ORDER, PLATFORM_SURFACE, nextAction } from '../tokens';
import type { View } from './view';

const SHORT: Record<Category, string> = {
  toxic: 'Toxic',
  scam: 'Scam',
  spam: 'Spam',
  noise: 'Noise',
  negative: 'Negative',
  question: 'Questions',
  positive: 'Positive',
  clean: 'Other',
};

const MENU_ACTIONS: Action[] = ['show', 'highlight', 'dim', 'collapse', 'hide'];

type Tip = { title: string; sub?: string; x: number; y: number; below: boolean };
type Menu = { kind: 'chip'; cat: Category; x: number; y: number } | { kind: 'preset'; x: number; y: number };

export interface BarProps {
  v: View;
  actions: BarActions;
  waveRef: (el: SVGPathElement | null) => void;
}

export function Bar({ v, actions, waveRef }: BarProps) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipWarm = useRef(0);

  const settings = v.settings.value;
  const theme = v.theme.value;
  const platform = v.platform.value || 'default';
  const surf = (PLATFORM_SURFACE[platform] ?? PLATFORM_SURFACE.default)[theme];

  // Close popovers on outside pointerdown / Escape. Events inside the bar are
  // stopped at the wrapper, so anything reaching the document is "outside".
  useEffect(() => {
    if (!open && !menu) return;
    const host = (root.current?.getRootNode() as ShadowRoot | Document | null as any)?.host as Element | undefined;
    const onDown = (e: Event) => {
      // Inside the bar the event target is retargeted to our host element.
      if ((host && e.target === host) || e.composedPath().includes(root.current!)) return;
      setMenu(null);
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) setMenu(null);
        else setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, menu]);

  const place = (el: Element, below = true) => {
    const r = root.current!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - r.left + b.width / 2, y: below ? b.bottom - r.top + 6 : b.top - r.top - 6, w: r.width };
  };

  // Tooltips: delegated, short delay, instant when moving between items.
  const onOver = (e: PointerEvent) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (!t || menu || open) return;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    const show = () => {
      const p = place(t);
      setTip({ title: t.dataset.tip!, sub: t.dataset.tipSub, x: p.x, y: p.y, below: true });
      tipWarm.current = performance.now();
    };
    if (performance.now() - tipWarm.current < 600) show();
    else tipTimer.current = setTimeout(show, 280);
  };
  const onOut = (e: PointerEvent) => {
    const t = (e.target as Element).closest?.('[data-tip]');
    const to = (e.relatedTarget as Element | null)?.closest?.('[data-tip]');
    if (t && t === to) return;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (tip) tipWarm.current = performance.now();
    setTip(null);
  };

  const openChipMenu = (cat: Category, el: Element) => {
    const p = place(el);
    setTip(null);
    setMenu({ kind: 'chip', cat, x: p.x, y: p.y });
  };

  const openPresetMenu = (el: Element) => {
    const p = place(el);
    setTip(null);
    setMenu(menu?.kind === 'preset' ? null : { kind: 'preset', x: p.x, y: p.y });
  };

  const stop = (e: Event) => e.stopPropagation();
  const toggleOpen = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(null);
    setMenu(null);
    if (!open && root.current) {
      // One layout read on user action: fit the panel inside the viewport.
      const b = root.current.getBoundingClientRect().bottom;
      root.current.style.setProperty('--avail', `${Math.max(220, window.innerHeight - b - 72)}px`);
    }
    setOpen(!open);
  };

  return (
    <div
      ref={root}
      class="hb"
      data-theme={theme}
      data-platform={platform}
      data-open={open ? '' : undefined}
      data-off={settings.enabled ? undefined : ''}
      style={{ '--hb-bg': surf.bg, '--hb-raised': surf.raised, '--hb-line': surf.line, '--hb-font': surf.font } as any}
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={stop}
      onWheel={stop}
      onContextMenu={stop}
      onPointerOver={onOver}
      onPointerOut={onOut}
    >
      <div class="hb-row" role="toolbar" aria-label="Hush chat filter">
        <MarkButton v={v} open={open} onToggle={toggleOpen} waveRef={waveRef} />
        {settings.enabled ? (
          <>
            <CalmText v={v} />
            <PresetSwitch
              preset={settings.preset}
              menuOpen={menu?.kind === 'preset'}
              onPick={(p) => actions.setPreset(p)}
              onOpenMenu={openPresetMenu}
            />
            <Chips v={v} actions={actions} onMenu={openChipMenu} />
          </>
        ) : (
          <div class="hb-paused">
            <span>Hush is paused</span>
            <button class="hb-btn hb-btn-accent" onClick={() => actions.toggleEnabled()}>
              <Icon name="play" size={11} fill /> Resume
            </button>
          </div>
        )}
        <ModelDot model={v.model} perf={v.perf} />
        <button
          class="hb-iconbtn hb-expand"
          aria-label={open ? 'Close dashboard' : 'Open dashboard'}
          aria-expanded={open}
          data-tip={open ? 'Close' : 'Live stats'}
          onClick={toggleOpen}
        >
          <Icon name="chevronDown" size={14} strokeWidth={1.8} />
        </button>
      </div>

      {open && <Panel v={v} actions={actions} onChipMenu={openChipMenu} onClose={() => setOpen(false)} />}

      {menu?.kind === 'chip' && (
        <ChipMenu
          cat={menu.cat}
          current={settings.actions[menu.cat]}
          count={v.counts.value[menu.cat]}
          x={menu.x}
          y={menu.y}
          onPick={(a) => {
            actions.setAction(menu.cat, a);
            setMenu(null);
          }}
        />
      )}
      {menu?.kind === 'preset' && (
        <PresetMenu
          current={settings.preset}
          x={menu.x}
          y={menu.y}
          onPick={(p) => {
            actions.setPreset(p);
            setMenu(null);
          }}
        />
      )}
      {tip && !menu && (
        <div class="hb-tip" role="tooltip" style={{ '--x': `${tip.x}px`, top: `${tip.y}px` } as any}>
          <b>{tip.title}</b>
          {tip.sub && <span>{tip.sub}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Mark + calm ring ─────────────────────────────────────────────── */

const RING_R = 13;
const RING_C = 2 * Math.PI * RING_R;

function MarkButton({ v, open, onToggle, waveRef }: { v: View; open: boolean; onToggle: () => void; waveRef: (el: SVGPathElement | null) => void }) {
  const offset = useComputed(() => {
    const t = v.totals.value;
    const r = t.seen > 0 ? t.filtered / t.seen : 0;
    return String(RING_C * (1 - Math.min(1, r)));
  });
  const label = useComputed(() => {
    const t = v.totals.value;
    return t.seen ? `${pct(t.filtered / t.seen)} of chat hushed` : 'Waiting for chat';
  });
  const sub = useComputed(() => {
    const t = v.totals.value;
    return t.seen ? `${grouped(t.filtered)} of ${grouped(t.seen)} messages` : 'Hush will start counting soon';
  });
  return (
    <button
      class="hb-mark"
      aria-label="Hush — open live stats"
      aria-expanded={open}
      onClick={onToggle}
      data-tip={label}
      data-tip-sub={sub}
    >
      <svg class="hb-ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r={RING_R} class="hb-ring-track" />
        <circle cx="15" cy="15" r={RING_R} class="hb-ring-fill" stroke-dasharray={`${RING_C} ${RING_C}`} stroke-dashoffset={offset} />
      </svg>
      <Mark size={18} waveRef={waveRef} />
    </button>
  );
}

function CalmText({ v }: { v: View }) {
  const value = useComputed(() => {
    const t = v.totals.value;
    return t.seen ? pct(t.filtered / t.seen) : '—';
  });
  return (
    <div class="hb-calm" aria-hidden="true">
      <b>{value}</b>
      <span>hushed</span>
    </div>
  );
}

/* ── Preset switch ────────────────────────────────────────────────── */

function PresetSwitch({ preset, menuOpen, onPick, onOpenMenu }: { preset: PresetId; menuOpen: boolean; onPick: (p: PresetId) => void; onOpenMenu: (el: Element) => void }) {
  const idx = PRESET_ORDER.indexOf(preset as (typeof PRESET_ORDER)[number]);
  const label = preset === 'custom' ? 'Custom' : PRESET_META[preset].label;
  return (
    <>
      <button
        class="hb-preset-pill"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tip="Vibe preset"
        data-tip-sub={preset === 'custom' ? 'You tweaked categories' : PRESET_META[preset as Exclude<PresetId, 'custom'>].desc}
        onClick={(e) => onOpenMenu(e.currentTarget)}
      >
        <span>{label}</span>
        <Icon name="chevronDown" size={11} strokeWidth={2} />
      </button>
      <div class="hb-seg" role="radiogroup" aria-label="Vibe preset" style={{ '--i': idx, '--n': PRESET_ORDER.length } as any} data-none={idx < 0 ? '' : undefined}>
        <span class="hb-seg-thumb" aria-hidden="true" />
        {PRESET_ORDER.map((p) => (
          <button
            role="radio"
            aria-checked={p === preset}
            class="hb-seg-btn"
            data-tip={PRESET_META[p].label}
            data-tip-sub={PRESET_META[p].desc}
            onClick={() => onPick(p)}
          >
            {PRESET_META[p].short}
          </button>
        ))}
      </div>
    </>
  );
}

function PresetMenu({ current, x, y, onPick }: { current: PresetId; x: number; y: number; onPick: (p: PresetId) => void }) {
  return (
    <div class="hb-menu hb-menu-preset" role="menu" style={{ '--x': `${x}px`, top: `${y}px` } as any}>
      <div class="hb-menu-head">Vibe preset</div>
      {PRESET_ORDER.map((p) => (
        <button role="menuitemradio" aria-checked={p === current} class="hb-menu-item" onClick={() => onPick(p)}>
          <span class="hb-menu-check">{p === current && <Icon name="check" size={12} strokeWidth={2} />}</span>
          <span class="hb-menu-text">
            <b>{PRESET_META[p].label}</b>
            <span>{PRESET_META[p].desc}</span>
          </span>
        </button>
      ))}
      {current === 'custom' && <div class="hb-menu-note">Custom — you changed individual categories.</div>}
    </div>
  );
}

/* ── Category chips ───────────────────────────────────────────────── */

function Chips({ v, actions, onMenu }: { v: View; actions: BarActions; onMenu: (c: Category, el: Element) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const onWheel = (e: WheelEvent) => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  };
  return (
    <div class="hb-chips" ref={scroller} onWheel={onWheel}>
      {CHIP_CATEGORIES.map((c) => (
        <Chip key={c} cat={c} v={v} action={v.settings.value.actions[c]} actions={actions} onMenu={onMenu} />
      ))}
    </div>
  );
}

function useLongPress(cb: (el: Element) => void) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (e.button !== 0) return;
      const el = e.currentTarget as Element;
      t.current = setTimeout(() => {
        fired.current = true;
        cb(el);
      }, 480);
    },
    onPointerUp: () => t.current && clearTimeout(t.current),
    onPointerLeave: () => t.current && clearTimeout(t.current),
    consumed: () => fired.current,
  };
}

function Chip({ cat, v, action, actions, onMenu }: { cat: Category; v: View; action: Action; actions: BarActions; onMenu: (c: Category, el: Element) => void }) {
  const n = useComputed(() => compact(v.counts.value[cat]));
  const zero = useComputed(() => (v.counts.value[cat] ? undefined : ''));
  const lp = useLongPress((el) => onMenu(cat, el));
  const meta = CATEGORY_META[cat];
  const next = nextAction(action);
  return (
    <button
      class="hb-chip"
      data-a={action}
      data-c={cat}
      data-zero={zero}
      aria-label={`${meta.label}: ${ACTION_META[action].verb}. Click to ${ACTION_META[next].label.toLowerCase()}.`}
      data-tip={`${SHORT[cat]} · ${ACTION_META[action].verb.toLowerCase()}`}
      data-tip-sub={`Click to ${ACTION_META[next].label.toLowerCase()} · right-click for all`}
      onPointerDown={lp.onPointerDown}
      onPointerUp={lp.onPointerUp}
      onPointerLeave={lp.onPointerLeave}
      onClick={() => {
        if (lp.consumed()) return;
        actions.setAction(cat, next);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(cat, e.currentTarget);
      }}
    >
      <span class="hb-chip-ico">
        <Icon name={cat} size={13} fill strokeWidth={1.7} />
      </span>
      <span class="hb-chip-n">{n}</span>
    </button>
  );
}

function ChipMenu({ cat, current, count, x, y, onPick }: { cat: Category; current: Action; count: number; x: number; y: number; onPick: (a: Action) => void }) {
  const meta = CATEGORY_META[cat];
  return (
    <div class="hb-menu" role="menu" style={{ '--x': `${x}px`, top: `${y}px`, '--c': `var(--c-${cat})` } as any}>
      <div class="hb-menu-cat">
        <span class="hb-menu-cat-ico">
          <Icon name={cat} size={14} fill />
        </span>
        <span class="hb-menu-text">
          <b>
            {meta.label} <em>{grouped(count)}</em>
          </b>
          <span>{meta.desc}</span>
        </span>
      </div>
      {MENU_ACTIONS.map((a) => (
        <button role="menuitemradio" aria-checked={a === current} class="hb-menu-item" data-a={a} onClick={() => onPick(a)}>
          <span class="hb-menu-aico">
            <Icon name={a} size={13} fill={a === 'highlight'} />
          </span>
          <span class="hb-menu-text">
            <b>{ACTION_META[a].label}</b>
          </span>
          <span class="hb-menu-check">{a === current && <Icon name="check" size={12} strokeWidth={2} />}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Model status ─────────────────────────────────────────────────── */

function ModelDot({ model, perf }: { model: ReadonlySignal<ModelStatus>; perf: ReadonlySignal<{ p50ms: number }> }) {
  const m = model.value;
  const s = modelSummary(m);
  const p50 = perf.value.p50ms;
  const sub = m.state === 'ready' && p50 > 0 ? `${s.sub} · ${p50.toFixed(0)} ms` : s.sub;
  return (
    <span class="hb-status" data-tone={s.tone} data-tip={s.title} data-tip-sub={sub} role="status" aria-label={s.title} tabIndex={0}>
      {s.tone === 'load' ? (
        m.progress != null ? (
          <Ring value={m.progress} size={14} stroke={2} />
        ) : (
          <span class="hb-spin" />
        )
      ) : (
        <span class="hb-dot" />
      )}
    </span>
  );
}

/* ── Expanded mini dashboard ──────────────────────────────────────── */

function Panel({ v, actions, onChipMenu, onClose }: { v: View; actions: BarActions; onChipMenu: (c: Category, el: Element) => void; onClose: () => void }) {
  const settings = v.settings.value;
  const ratio = useComputed(() => {
    const t = v.totals.value;
    return t.seen ? pct(t.filtered / t.seen) : '—';
  });
  const sub = useComputed(() => {
    const t = v.totals.value;
    return `${grouped(t.filtered)} of ${grouped(t.seen)} messages`;
  });
  const now = useComputed(() => {
    const r = v.rate.value;
    return rate(r[r.length - 1] ?? 0);
  });
  const vibeNow = useComputed(() => {
    const x = v.vibe.value;
    // average the last 3 buckets (15 s) for a steadier word
    const tail = x.slice(-3);
    return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  });
  return (
    <div class="hb-panel" role="dialog" aria-label="Hush live stats">
      <div class="hp-body">
      <div class="hp-head">
        <div class="hp-calm">
          <b>{ratio}</b>
          <span>
            hushed <em>·</em> {sub}
          </span>
        </div>
        <button class="hb-btn" onClick={() => actions.toggleEnabled()} aria-label={settings.enabled ? 'Pause Hush' : 'Resume Hush'}>
          <Icon name={settings.enabled ? 'pause' : 'play'} size={11} strokeWidth={2} fill={!settings.enabled} />
          {settings.enabled ? 'Pause' : 'Resume'}
        </button>
      </div>

      <div class="hp-tiles">
        <div class="hp-tile">
          <div class="hp-tile-top">
            <span class="hp-label">Messages / s</span>
            <b class="hp-num">{now}</b>
          </div>
          <Sparkline values={v.rate} height={34} color="var(--accent)" />
        </div>
        <div class="hp-tile">
          <div class="hp-tile-top">
            <span class="hp-label">Vibe</span>
            <b class="hp-num" data-vibe={vibeNow.value > 0.05 ? 'pos' : vibeNow.value < -0.05 ? 'neg' : 'mid'}>
              {vibeWord(vibeNow.value)}
            </b>
          </div>
          <Diverging values={v.vibe} height={34} />
        </div>
      </div>

      <section class="hp-sec">
        <div class="hp-sec-head">
          <span class="hp-label">Categories</span>
          <span class="hp-hint">click to cycle</span>
        </div>
        <div class="hp-cats">
          {CATEGORIES.map((c) => (
            <CatRow cat={c} v={v} action={settings.actions[c]} actions={actions} onMenu={onChipMenu} />
          ))}
        </div>
      </section>

      <Waves v={v} />
      <Questions v={v} actions={actions} />
      </div>

      <div class="hp-foot">
        <FootModel v={v} />
        <button
          class="hb-link"
          onClick={() => {
            actions.openSidePanel();
            onClose();
          }}
        >
          Open dashboard <Icon name="arrowUpRight" size={12} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function CatRow({ cat, v, action, actions, onMenu }: { cat: Category; v: View; action: Action; actions: BarActions; onMenu: (c: Category, el: Element) => void }) {
  const n = useComputed(() => compact(v.counts.value[cat]));
  return (
    <button
      class="hp-cat"
      data-a={action}
      data-c={cat}
      onClick={() => actions.setAction(cat, nextAction(action))}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(cat, e.currentTarget);
      }}
      aria-label={`${CATEGORY_META[cat].label}: ${ACTION_META[action].verb}`}
    >
      <span class="hp-cat-ico">
        <Icon name={cat} size={13} fill />
      </span>
      <span class="hp-cat-text">
        <span class="hp-cat-name">{SHORT[cat]}</span>
        <span class="hp-cat-a" data-a={action}>
          {ACTION_META[action].verb}
        </span>
      </span>
      <span class="hp-cat-n">{n}</span>
    </button>
  );
}

function Waves({ v }: { v: View }) {
  const waves = v.waves.value.slice(0, 4);
  if (!waves.length) return null;
  const now = Date.now();
  return (
    <section class="hp-sec">
      <div class="hp-sec-head">
        <span class="hp-label">Waves</span>
        <span class="hp-hint">same message, many people</span>
      </div>
      <div class="hp-waves">
        {waves.map((w) => (
          <span class="hp-wave" data-live={now - w.lastAt < 10_000 ? '' : undefined} title={`${w.users} people · ${ago(w.startedAt)} ago`}>
            <span class="hp-wave-t">{w.text}</span>
            <em>×{compact(w.count)}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function Questions({ v, actions }: { v: View; actions: BarActions }) {
  const qs = v.questions.value.slice(0, 3);
  return (
    <section class="hp-sec">
      <div class="hp-sec-head">
        <span class="hp-label">Latest questions</span>
        <span class="hp-hint">{v.questions.value.length ? `${v.questions.value.length} so far` : ''}</span>
      </div>
      {qs.length ? (
        <div class="hp-qs">
          {qs.map((q) => (
            <button class="hp-q" onClick={() => actions.revealMessage(q.msg.key)} title="Show in chat">
              <span class="hp-q-ico">
                <Icon name="question" size={12} />
              </span>
              <span class="hp-q-body">
                <b>{q.msg.author}</b> {q.msg.text}
              </span>
              <span class="hp-q-t">{ago(q.msg.ts)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div class="hp-empty">No questions yet — they'll gather here.</div>
      )}
    </section>
  );
}

function FootModel({ v }: { v: View }) {
  const m = v.model.value;
  const s = modelSummary(m);
  const p = v.perf.value;
  return (
    <span class="hp-model" data-tone={s.tone}>
      <span class="hb-dot" />
      <span>
        {s.title}
        {m.state === 'ready' && p.p50ms > 0 && <em> · {p.p50ms.toFixed(0)} ms</em>}
      </span>
    </span>
  );
}

