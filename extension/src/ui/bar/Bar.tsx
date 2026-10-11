// The in-chat bar, in two modes (docs/ux-modes.md).
//
// Basic (the default, for someone who sees chat for the first time): the
// mark, one choice (Off · Clean · Quiet) and Show hidden; the mark opens a
// sheet that says the same in words. It shows no numbers and reads no chat
// data, so it never re-renders while chat flows (only on settings, model
// status, the tab's views or the open state).
//
// Advanced (streamers, mods): presets, category chips with what is in chat
// now (click: show only that category, right-click: change what happens to
// it; as many as fit, "+N" for the rest), Show hidden, model status; expands
// into a live view.
//
// Reads only the frame-throttled View, never the raw store.

import { computed, useComputed, type ReadonlySignal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BarActions } from '../../core/bar-actions';
import { advancedExtras, basicLevel, type BasicLevel, type PresetId, type Settings } from '../../core/settings';
import type { Action, Category, ModelStatus, Platform } from '../../core/types';
import { modelSummary, plainModelStatus, retryModel } from '../model-status';
import { SEVERITY } from '../../core/policy';
import { CATEGORIES } from '../../core/types';
import { LiveMark } from '../brand';
import { Diverging, Ring, Sparkline } from '../charts';
import { ago, compact, grouped, rate, scoreDetail, vibeTone, vibeWord } from '../format';
import { Icon } from '../icons';
import { iconImage } from './glyphs';
import {
  ACTION_META,
  CATEGORY_META,
  CHIP_CATEGORIES,
  LEVEL_META,
  LEVEL_ORDER,
  PLAIN,
  PRESET_META,
  PRESET_ORDER,
  PLATFORM_SURFACE,
  SITE_NAME,
  type Theme,
} from '../tokens';
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

/**
 * A tooltip. A sub with "{n}" names a category count (data-tip-n): it is
 * filled in while the tip shows, so numbers stay live without rewriting
 * attributes while chat flows.
 */
type Tip = { title: string; sub?: string; n?: Category; x: number; y: number };
/** An open menu; `from` is the chip or button that opened it (focus returns there). */
type Menu = ({ kind: 'chip'; cat: Category } | { kind: 'preset' }) & { x: number; y: number; from: HTMLElement };

export interface BarProps {
  v: View;
  actions: BarActions;
  /** The live mark (activity pulses, see mountBar). */
  markRef: (el: HTMLElement | null) => void;
}

export function Bar({ v, actions, markRef }: BarProps) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipWarm = useRef(0);
  /** The tip on screen came from keyboard focus (focusout hides it). */
  const tipFocus = useRef(false);

  const settings = v.settings.value;
  const theme = v.theme.value;
  const platform = v.platform.value || 'default';
  const site = SITE_NAME[platform] ? (platform as Platform) : undefined;
  const peek = v.peek.value;
  const solo = v.solo.value;
  const advanced = settings.uiMode === 'advanced';
  const level = basicLevel(settings, site);
  /** Hush runs on this site: on, and not turned off here. */
  const on = level !== 'off';
  const surf = (PLATFORM_SURFACE[platform] ?? PLATFORM_SURFACE.default)[theme];

  /** Close the menu and give focus back to the chip or button that opened it. */
  const closeMenu = () => {
    menu?.from.focus({ preventScroll: true });
    setMenu(null);
  };

  // Popovers close on an outside pointerdown. Escape closes a menu, then the
  // panel, then ends Solo, then Show hidden; the listener is there only while
  // one of them is. Events inside the bar are stopped at the wrapper, so
  // anything reaching the document is "outside".
  useEffect(() => {
    if (!open && !menu && !peek && !solo) return;
    const doc = root.current?.ownerDocument ?? document;
    const host = (root.current?.getRootNode() as ShadowRoot | Document | null as any)?.host as Element | undefined;
    const onDown = (e: Event) => {
      // Inside the bar the event target is retargeted to our host element.
      if ((host && e.target === host) || e.composedPath().includes(root.current!)) return;
      setMenu(null);
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || typing(e)) return;
      if (menu) closeMenu();
      else if (open) setOpen(false);
      else if (solo) actions.setSolo(null);
      else if (peek) actions.setPeek(false);
    };
    const popover = open || !!menu;
    if (popover) doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    return () => {
      if (popover) doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
    };
  }, [open, menu, peek, solo]);

  const place = (el: Element, below = true) => {
    const r = root.current!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - r.left + b.width / 2, y: below ? b.bottom - r.top + 6 : b.top - r.top - 6, w: r.width };
  };

  // Tooltips: delegated, short delay, instant when moving between items; also
  // on keyboard focus.
  const showTip = (t: HTMLElement) => {
    const p = place(t);
    setTip({ title: t.dataset.tip!, sub: t.dataset.tipSub, n: t.dataset.tipN as Category | undefined, x: p.x, y: p.y });
    tipWarm.current = performance.now();
  };
  const hideTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (tip) tipWarm.current = performance.now();
    setTip(null);
  };
  const onOver = (e: PointerEvent) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (!t || menu || open) return;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (performance.now() - tipWarm.current < 600) showTip(t);
    else tipTimer.current = setTimeout(() => showTip(t), 280);
  };
  const onOut = (e: PointerEvent) => {
    const t = (e.target as Element).closest?.('[data-tip]');
    const to = (e.relatedTarget as Element | null)?.closest?.('[data-tip]');
    if (t && t === to) return;
    hideTip();
  };
  const onFocusIn = (e: FocusEvent) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (!t || menu || open || !focusVisible(t)) return;
    showTip(t);
    tipFocus.current = true;
  };
  const onFocusOut = () => {
    if (!tipFocus.current) return;
    tipFocus.current = false;
    hideTip();
  };

  const openChipMenu = (cat: Category, el: Element) => {
    const p = place(el);
    setTip(null);
    setMenu({ kind: 'chip', cat, x: p.x, y: p.y, from: el as HTMLElement });
  };

  const openPresetMenu = (el: Element) => {
    const p = place(el);
    setTip(null);
    setMenu(menu?.kind === 'preset' ? null : { kind: 'preset', x: p.x, y: p.y, from: el as HTMLElement });
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
  const togglePeek = () => actions.setPeek(!peek);
  /** What the off row says: Hush is off everywhere, or only here. */
  const offText = settings.enabled && site ? `Off on ${SITE_NAME[site]}` : 'Hush is off';

  return (
    <div
      ref={root}
      class="hb"
      data-theme={theme}
      data-platform={platform}
      data-mode={advanced ? 'advanced' : 'basic'}
      data-open={open ? '' : undefined}
      data-off={on ? undefined : ''}
      data-peek={peek ? '' : undefined}
      data-solo={solo ?? undefined}
      style={{ '--hb-bg': surf.bg, '--hb-raised': surf.raised, '--hb-line': surf.line, '--hb-font': surf.font } as any}
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={stop}
      onWheel={stop}
      onContextMenu={stop}
      onPointerOver={onOver}
      onPointerOut={onOut}
      onFocusIn={onFocusIn}
      onFocusOut={onFocusOut}
    >
      {advanced ? (
        <div class="hb-row" role="toolbar" aria-label="Hush chat filter">
          <MarkButton v={v} label="Hush: open live view" title={() => 'Hush'} sub="Open live view" open={open} onToggle={toggleOpen} markRef={markRef} />
          {on ? (
            <>
              {solo ? (
                <SoloPill key={solo} v={v} cat={solo} onEnd={() => actions.setSolo(null)} />
              ) : (
                <PresetSwitch preset={settings.preset} menuOpen={menu?.kind === 'preset'} onPick={(p) => actions.setPreset(p)} onOpenMenu={openPresetMenu} />
              )}
              <Chips v={v} theme={theme} solo={solo} open={open} onSolo={(c) => actions.setSolo(c)} onMenu={openChipMenu} onMore={toggleOpen} />
              {!solo && <PeekButton peek={peek} onToggle={togglePeek} />}
            </>
          ) : (
            <div class="hb-paused">
              <span>{offText}</span>
              {!settings.enabled && (
                <button class="hb-btn hb-btn-accent" onClick={() => actions.toggleEnabled()}>
                  <Icon name="power" size={11} strokeWidth={2} /> Turn on
                </button>
              )}
            </div>
          )}
          <ModelDot model={v.model} perf={v.perf} />
          <button
            class="hb-iconbtn hb-expand"
            aria-label={open ? 'Hide live view' : 'Show live view'}
            aria-expanded={open}
            data-tip={open ? 'Close' : 'Live view'}
            onClick={toggleOpen}
          >
            <Icon name="chevronDown" size={14} strokeWidth={1.8} />
          </button>
        </div>
      ) : (
        <div class="hb-row" role="toolbar" aria-label="Hush chat filter">
          <MarkButton
            v={v}
            label="Hush options"
            title={(m) => statusOf(settings, site, m).text}
            sub="Click for options"
            open={open}
            onToggle={toggleOpen}
            markRef={markRef}
          />
          <LevelSwitch level={level} onPick={(l) => actions.setLevel(l)} />
          {on ? (
            <PeekButton peek={peek} words onToggle={togglePeek} />
          ) : (
            <span class="hb-offnote">{offText}</span>
          )}
        </div>
      )}

      {open &&
        (advanced ? (
          <Panel v={v} actions={actions} on={on} site={site} solo={solo} peek={peek} onChipMenu={openChipMenu} onClose={() => setOpen(false)} />
        ) : (
          <Sheet v={v} settings={settings} site={site} level={level} actions={actions} />
        ))}

      {menu?.kind === 'chip' && (
        <ChipMenu
          key={menu.cat} // another chip's menu is a new menu: it takes focus again
          v={v}
          cat={menu.cat}
          current={settings.actions[menu.cat]}
          soloed={solo === menu.cat}
          x={menu.x}
          y={menu.y}
          onSolo={() => {
            actions.setSolo(solo === menu.cat ? null : menu.cat);
            closeMenu();
          }}
          onPick={(a) => {
            actions.setAction(menu.cat, a);
            closeMenu();
          }}
          onClose={closeMenu}
        />
      )}
      {menu?.kind === 'preset' && (
        <PresetMenu
          current={settings.preset}
          x={menu.x}
          y={menu.y}
          onPick={(p) => {
            actions.setPreset(p);
            closeMenu();
          }}
          onClose={closeMenu}
        />
      )}
      {tip && !menu && <TipView tip={tip} v={v} />}
    </div>
  );
}

function TipView({ tip, v }: { tip: Tip; v: View }) {
  // Only a tip with a count reads the chat (Basic's tips have none).
  const sub = tip.n ? tip.sub?.replace('{n}', grouped(v.inChat.value.byCat[tip.n])) : tip.sub;
  return (
    <div class="hb-tip" role="tooltip" style={{ '--x': `${tip.x}px`, top: `${tip.y}px` } as any}>
      <b>{tip.title}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

/** Escape belongs to whatever the viewer is typing in (Twitch's chat box is contenteditable). */
function typing(e: Event): boolean {
  const el = e.composedPath()[0] as Element | undefined;
  return !!el?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])');
}

/** :focus-visible, read when focus lands (false where the selector is unknown). */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * A computed that is built again when `deps` change. (useComputed keeps
 * reading the props its first closure saw until one of its signals changes:
 * for a label that also says a prop, that can be never while chat is quiet.)
 */
function useLive<T>(fn: () => T, deps: unknown[]): ReadonlySignal<T> {
  return useMemo(() => computed(fn), deps);
}

/* ── Status, in plain words ───────────────────────────────────────── */

type Tone = 'ok' | 'off' | 'load' | 'err';

/** What Hush is doing here, in words: no numbers and no model jargon (Basic's sheet and mark). */
function statusOf(s: Settings, site: Platform | undefined, m: ModelStatus): { text: string; tone: Tone } {
  if (!s.enabled) return { text: PLAIN.off, tone: 'off' };
  if (site && s.sites[site] === false) return { text: PLAIN.siteOff(SITE_NAME[site]!), tone: 'off' };
  return plainModelStatus(m) ?? { text: PLAIN.on, tone: 'ok' };
}

/* ── Mark ─────────────────────────────────────────────────────────── */

const RING_R = 13;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The mark opens the sheet (Basic) or the live view (Advanced). Its ring is
 * model progress only: a download's share, or a slow turn (a transform, on
 * the compositor) while the model loads; an amber dot when it failed. It
 * reads the model status itself, so a download re-renders the mark alone.
 */
function MarkButton({
  v,
  label,
  title,
  sub,
  open,
  onToggle,
  markRef,
}: {
  v: View;
  label: string;
  /** Tooltip title (Basic's says what Hush is doing, which depends on the model). */
  title: (m: ModelStatus) => string;
  sub: string;
  open: boolean;
  onToggle: () => void;
  markRef: (el: HTMLElement | null) => void;
}) {
  const m = v.model.value;
  return (
    <button class="hb-mark" aria-label={label} aria-expanded={open} onClick={onToggle} data-tip={title(m)} data-tip-sub={sub}>
      {m.state === 'downloading' && m.progress != null ? (
        <svg class="hb-ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r={RING_R} class="hb-ring-track" />
          <circle cx="15" cy="15" r={RING_R} class="hb-ring-fill" stroke-dasharray={`${RING_C} ${RING_C}`} stroke-dashoffset={(RING_C * (1 - Math.min(1, m.progress))).toFixed(2)} />
        </svg>
      ) : (
        (m.state === 'downloading' || m.state === 'loading') && <span class="hb-ring-spin" aria-hidden="true" />
      )}
      <LiveMark size={18} liveRef={markRef} />
      {m.state === 'error' && <span class="hb-mark-err" aria-hidden="true" />}
    </button>
  );
}

/* ── Show hidden ──────────────────────────────────────────────────── */

/** Show hidden (this tab only): Basic says it in words (the eye alone in a narrow column), Advanced shows the eye. */
function PeekButton({ peek, words, onToggle }: { peek: boolean; words?: boolean; onToggle: () => void }) {
  const label = peek ? 'Hide again' : 'Show hidden';
  return (
    <button
      class={words ? 'hb-peek' : 'hb-iconbtn hb-peek-ico'}
      aria-pressed={peek}
      aria-label={label}
      data-tip={label}
      data-tip-sub={peek ? 'Esc also works.' : 'Brings back what Hush hid in this tab, faded.'}
      onClick={onToggle}
    >
      <Icon name={peek ? 'eyeOff' : 'show'} size={14} strokeWidth={1.7} />
      {words && <span class="hb-peek-t">{label}</span>}
    </button>
  );
}

/* ── Basic: level ─────────────────────────────────────────────────── */

/**
 * Arrow keys in a radio group move to the next radio and pick it, like
 * native radios; only the checked one (or the first, when none is) is a Tab stop.
 */
function radioKeys<T>(values: readonly T[], current: T | null, pick: (v: T) => void) {
  return (e: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
    const i = Math.max(0, radios.indexOf(e.target as HTMLElement));
    const to = (i + step + values.length) % values.length;
    radios[to]?.focus({ preventScroll: true });
    if (values[to] !== current) pick(values[to]!);
  };
}

const tabStop = <T,>(value: T, current: T | null, first: T) => (value === current || (current === null && value === first) ? 0 : -1);

function LevelSwitch({ level, onPick }: { level: BasicLevel | null; onPick: (l: BasicLevel) => void }) {
  const idx = level ? LEVEL_ORDER.indexOf(level) : -1;
  return (
    <div
      class="hb-seg hb-level"
      role="radiogroup"
      aria-label={PLAIN.levelQuestion}
      style={{ '--i': Math.max(0, idx), '--n': LEVEL_ORDER.length } as any}
      data-none={idx < 0 ? '' : undefined}
      onKeyDown={radioKeys(LEVEL_ORDER, level, onPick)}
    >
      <span class="hb-seg-thumb" aria-hidden="true" />
      {LEVEL_ORDER.map((l) => (
        <button
          role="radio"
          aria-checked={l === level}
          tabIndex={tabStop(l, level, LEVEL_ORDER[0])}
          class="hb-seg-btn"
          data-tip={LEVEL_META[l].label}
          data-tip-sub={LEVEL_META[l].desc}
          onClick={() => onPick(l)}
        >
          {LEVEL_META[l].label}
        </button>
      ))}
    </div>
  );
}

/* ── Basic: sheet ─────────────────────────────────────────────────── */

function Sheet({ v, settings, site, level, actions }: { v: View; settings: Settings; site?: Platform; level: BasicLevel | null; actions: BarActions }) {
  const custom = settings.preset !== 'chill' && settings.preset !== 'focus';
  const note = level === null ? PLAIN.custom : level === 'off' && custom ? PLAIN.customOff : null;
  const extras = advancedExtras(settings);
  return (
    <div class="hb-panel hb-sheet" role="dialog" aria-label="Hush options">
      <div class="hp-body">
        <SheetStatus v={v} settings={settings} site={site} />

        <div class="hs-q" id="hs-q">
          {PLAIN.levelQuestion}
        </div>
        <div class="hs-levels" role="radiogroup" aria-labelledby="hs-q" onKeyDown={radioKeys(LEVEL_ORDER, level, (l) => actions.setLevel(l))}>
          {LEVEL_ORDER.map((l) => (
            <button role="radio" aria-checked={l === level} tabIndex={tabStop(l, level, LEVEL_ORDER[0])} class="hs-level" onClick={() => actions.setLevel(l)}>
              <span class="hs-radio" aria-hidden="true" />
              <span class="hs-level-text">
                <b>
                  {LEVEL_META[l].label}
                  {LEVEL_META[l].recommended && <em class="hs-badge">Recommended</em>}
                </b>
                <span>{LEVEL_META[l].desc}</span>
              </span>
            </button>
          ))}
        </div>
        {note && <p class="hs-note">{note}</p>}
        {extras.length > 0 && <p class="hs-note">{PLAIN.extras(extras)}</p>}
        <p class="hs-hint">
          <Icon name="show" size={13} strokeWidth={1.7} />
          <span>"Show hidden" brings back anything Hush hid.</span>
        </p>

        <button class="hs-mode" role="switch" aria-checked={false} onClick={() => actions.setMode('advanced')}>
          <span class="hs-mode-text">
            <b>{PLAIN.advanced}</b>
            <span>{PLAIN.advancedHint}</span>
          </span>
          <span class="hb-switch" aria-hidden="true" />
        </button>
      </div>
      <div class="hp-foot hs-foot">
        <Icon name="lock" size={13} strokeWidth={1.7} />
        <span>{PLAIN.privacy}</span>
      </div>
    </div>
  );
}

function SheetStatus({ v, settings, site }: { v: View; settings: Settings; site?: Platform }) {
  const s = statusOf(settings, site, v.model.value);
  return (
    <div class="hs-status" data-tone={s.tone} role="status">
      {s.tone === 'load' ? <span class="hb-spin" /> : <span class="hb-dot" />}
      <span class="hs-status-t">{s.text}</span>
      {s.tone === 'err' && (
        <button class="hb-btn" onClick={retryModel}>
          <Icon name="refresh" size={11} strokeWidth={2} /> Retry
        </button>
      )}
    </div>
  );
}

/* ── Advanced: preset switch ──────────────────────────────────────── */

function PresetSwitch({ preset, menuOpen, onPick, onOpenMenu }: { preset: PresetId; menuOpen: boolean; onPick: (p: PresetId) => void; onOpenMenu: (el: Element) => void }) {
  const idx = PRESET_ORDER.indexOf(preset as (typeof PRESET_ORDER)[number]);
  const label = preset === 'custom' ? 'Custom' : PRESET_META[preset].label;
  return (
    <>
      <button
        class="hb-preset-pill"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tip="Preset"
        data-tip-sub={preset === 'custom' ? 'You changed individual categories.' : PRESET_META[preset].desc}
        onClick={(e) => onOpenMenu(e.currentTarget)}
      >
        <span>{label}</span>
        <Icon name="chevronDown" size={11} strokeWidth={2} />
      </button>
      <div
        class="hb-seg hb-preset-seg"
        role="radiogroup"
        aria-label="Preset"
        style={{ '--i': Math.max(0, idx), '--n': PRESET_ORDER.length } as any}
        data-none={idx < 0 ? '' : undefined}
        onKeyDown={radioKeys(PRESET_ORDER, idx < 0 ? null : PRESET_ORDER[idx]!, onPick)}
      >
        <span class="hb-seg-thumb" aria-hidden="true" />
        {PRESET_ORDER.map((p) => (
          <button
            role="radio"
            aria-checked={p === preset}
            tabIndex={tabStop(p, idx < 0 ? null : preset, PRESET_ORDER[0])}
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

/**
 * Keyboard behaviour of a menu: focus its checked item when it opens; arrows,
 * Home and End move between items; Tab closes it (Escape is handled by the bar).
 */
function useMenuKeys(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const item = el?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role^="menuitem"]');
    item?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const i = items.indexOf(e.target as HTMLElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    } else if (to !== undefined && items.length) {
      e.preventDefault();
      items[(to + items.length) % items.length]!.focus({ preventScroll: true });
    }
  };
  return { ref, onKeyDown };
}

function PresetMenu({ current, x, y, onPick, onClose }: { current: PresetId; x: number; y: number; onPick: (p: PresetId) => void; onClose: () => void }) {
  const keys = useMenuKeys(onClose);
  return (
    <div class="hb-menu hb-menu-preset" role="menu" aria-label="Preset" ref={keys.ref} onKeyDown={keys.onKeyDown} style={{ '--x': `${x}px`, top: `${y}px` } as any}>
      <div class="hb-menu-head">Preset</div>
      {PRESET_ORDER.map((p) => (
        <button role="menuitemradio" aria-checked={p === current} class="hb-menu-item" onClick={() => onPick(p)}>
          <span class="hb-menu-check">{p === current && <Icon name="check" size={12} strokeWidth={2} />}</span>
          <span class="hb-menu-text">
            <b>{PRESET_META[p].label}</b>
            <span>{PRESET_META[p].desc}</span>
          </span>
        </button>
      ))}
      {current === 'custom' && <div class="hb-menu-note">Custom: you changed individual categories.</div>}
    </div>
  );
}

/* ── Advanced: Solo pill ──────────────────────────────────────────── */

/** Takes the preset's place while one category shows alone: "Only Spam · 8 ×"; a click shows everything. */
function SoloPill({ v, cat, onEnd }: { v: View; cat: Category; onEnd: () => void }) {
  const name = SHORT[cat];
  const n = useComputed(() => v.inChat.value.byCat[cat]);
  const text = useComputed(() => `Only ${name} · ${n.value ? compact(n.value) : 'none yet'}`);
  const label = useComputed(() => `Showing only ${name.toLowerCase()}, ${n.value} in chat now. Show all messages.`);
  return (
    <button
      class="hb-solo"
      data-c={cat}
      aria-label={label}
      data-tip={`Showing only ${name.toLowerCase()}`}
      data-tip-sub="{n} in chat now · Esc or × shows everything"
      data-tip-n={cat}
      onClick={onEnd}
    >
      <span class="hb-chip-ico" style={{ backgroundImage: iconImage({ name: cat, fill: true, strokeWidth: 1.7 }, '#ffffff') }} />
      <span class="hb-solo-t">{text}</span>
      <span class="hb-solo-x" aria-hidden="true">
        <Icon name="x" size={10} strokeWidth={2.2} />
      </span>
    </button>
  );
}

/* ── Advanced: category chips ─────────────────────────────────────── */

/**
 * Where a chip stands in a narrow bar (lower first): the one shown alone, then
 * the categories Hush changes (hidden first, then folded, dimmed,
 * highlighted), then the ones it shows as they are, those with messages in
 * chat now first. Ties keep CHIP_CATEGORIES order.
 */
function chipRank(c: Category, actions: Record<Category, Action>, solo: Category | null, byCat: Record<Category, number>): number {
  return c === solo ? 0 : actions[c] !== 'show' ? 5 - SEVERITY[actions[c]] : byCat[c] ? 5 : 6;
}

/**
 * As many chips as fit, by chipRank; the others wrap onto a line the row
 * clips, and "+N" (they are all in the live view) stands in for them. An
 * IntersectionObserver says which ones wrapped, so nothing here reads layout.
 * The rank is a CSS order, so a chip that moves keeps keyboard focus; it
 * changes with settings and Solo, and while chat flows only when a category
 * shown as is gets its first message in chat or loses its last.
 */
function Chips({
  v,
  theme,
  solo,
  open,
  onSolo,
  onMenu,
  onMore,
}: {
  v: View;
  theme: Theme;
  solo: Category | null;
  open: boolean;
  onSolo: (c: Category | null) => void;
  onMenu: (c: Category, el: Element) => void;
  onMore: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<Category[]>([]);
  const actions = v.settings.value.actions;
  const ranks = useLive(() => CHIP_CATEGORIES.map((c) => chipRank(c, actions, solo, v.inChat.value.byCat)).join(), [actions, solo]).value.split(',');

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const out = new Set<Category>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const c = (e.target as HTMLElement).dataset.c as Category;
          if (e.intersectionRatio < 0.9) out.add(c);
          else out.delete(c);
        }
        setOver(CHIP_CATEGORIES.filter((c) => out.has(c)));
      },
      { root: el, threshold: 0.9 },
    );
    for (const chip of el.querySelectorAll('.hb-chip')) io.observe(chip);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div class="hb-chips" ref={box}>
        <div class="hb-chips-in">
          {CHIP_CATEGORIES.map((c, i) => (
            <Chip key={c} cat={c} v={v} theme={theme} action={actions[c]} solo={solo} rank={Number(ranks[i])} over={over.includes(c)} onSolo={onSolo} onMenu={onMenu} />
          ))}
        </div>
      </div>
      {over.length > 0 && (
        <button
          class="hb-more"
          aria-expanded={open}
          aria-label={`${over.length} more ${over.length === 1 ? 'category' : 'categories'}: ${over.map((c) => SHORT[c]).join(', ')}. ${open ? 'Hide' : 'Show'} live view`}
          data-tip={over.map((c) => SHORT[c]).join(' · ')}
          data-tip-sub="Click: open the live view, with every category"
          onClick={onMore}
        >
          +{over.length}
        </button>
      )}
    </>
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

/**
 * A category and how many of its messages are in chat now. Click: show only
 * these (again: show everything). Right-click, long-press or the context-menu
 * key: change what happens to them.
 */
function Chip({
  cat,
  v,
  theme,
  action,
  solo,
  rank,
  over,
  onSolo,
  onMenu,
}: {
  cat: Category;
  v: View;
  theme: Theme;
  action: Action;
  solo: Category | null;
  /** Its place in a narrow bar (chipRank). */
  rank: number;
  /** It did not fit in the bar ("+N" stands in for it). */
  over: boolean;
  onSolo: (c: Category | null) => void;
  onMenu: (c: Category, el: Element) => void;
}) {
  const verb = ACTION_META[action].verb.toLowerCase();
  const count = useComputed(() => v.inChat.value.byCat[cat]);
  const n = useComputed(() => compact(count.value));
  const zero = useComputed(() => (count.value ? undefined : ''));
  const label = useLive(() => `${SHORT[cat]}, ${verb}, ${count.value} in chat now. Show only ${SHORT[cat].toLowerCase()}.`, [verb]);
  const lp = useLongPress((el) => onMenu(cat, el));
  const soloed = solo === cat;
  return (
    <button
      class="hb-chip"
      data-a={action}
      data-c={cat}
      data-zero={zero}
      data-faded={solo && !soloed ? '' : undefined}
      data-over={over ? '' : undefined}
      style={{ order: rank }}
      aria-pressed={soloed}
      aria-label={label}
      data-tip={`${SHORT[cat]} · ${verb}`}
      data-tip-sub={soloed ? 'Showing only these · Click: show everything' : '{n} in chat now · Click: show only these · Right-click: change'}
      data-tip-n={soloed ? undefined : cat}
      onPointerDown={lp.onPointerDown}
      onPointerUp={lp.onPointerUp}
      onPointerLeave={lp.onPointerLeave}
      onClick={() => {
        if (lp.consumed()) return;
        onSolo(soloed ? null : cat);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(cat, e.currentTarget);
      }}
    >
      {/* an image, not an inline <svg>: see glyphs.ts */}
      <span class="hb-chip-ico" style={{ backgroundImage: iconImage({ name: cat, fill: true, strokeWidth: 1.7 }, CATEGORY_META[cat].color[theme], action === 'dim' ? 0.45 : 1) }} />
      <span class="hb-chip-n">{n}</span>
    </button>
  );
}

function ChipMenu({
  v,
  cat,
  current,
  soloed,
  x,
  y,
  onSolo,
  onPick,
  onClose,
}: {
  v: View;
  cat: Category;
  current: Action;
  soloed: boolean;
  x: number;
  y: number;
  onSolo: () => void;
  onPick: (a: Action) => void;
  onClose: () => void;
}) {
  const meta = CATEGORY_META[cat];
  const keys = useMenuKeys(onClose);
  const now = useComputed(() => `${grouped(v.inChat.value.byCat[cat])} in chat now`);
  return (
    <div
      class="hb-menu"
      role="menu"
      aria-label={`${SHORT[cat]}: what to do`}
      ref={keys.ref}
      onKeyDown={keys.onKeyDown}
      style={{ '--x': `${x}px`, top: `${y}px`, '--c': `var(--c-${cat})` } as any}
    >
      <div class="hb-menu-cat">
        <span class="hb-menu-cat-ico">
          <Icon name={cat} size={14} fill />
        </span>
        <span class="hb-menu-text">
          <b>
            {SHORT[cat]}
            <em>{now}</em>
          </b>
          <span>{meta.desc}</span>
        </span>
      </div>
      <button role="menuitem" class="hb-menu-item hb-menu-solo" aria-pressed={soloed} onClick={onSolo}>
        <span class="hb-menu-aico">
          <Icon name={soloed ? 'eyeOff' : 'show'} size={13} />
        </span>
        <span class="hb-menu-text">
          <b>{soloed ? 'Show everything' : `Show only ${SHORT[cat]}`}</b>
        </span>
      </button>
      <div class="hb-menu-sep" role="separator" />
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

/* ── Advanced: model status ───────────────────────────────────────── */

function ModelDot({ model, perf }: { model: ReadonlySignal<ModelStatus>; perf: ReadonlySignal<{ p50ms: number }> }) {
  const m = model.value;
  const s = modelSummary(m);
  const p50 = perf.value.p50ms;
  const sub = m.state === 'ready' && p50 > 0 ? `${s.sub} · ${p50.toFixed(0)} ms` : s.sub;
  return (
    <span class="hb-status" data-tone={s.tone} data-tip={s.title} data-tip-sub={sub} role="status" aria-label={s.title} tabIndex={0}>
      {s.tone === 'load' ? m.progress != null ? <Ring value={m.progress} size={14} stroke={2} /> : <span class="hb-spin" /> : <span class="hb-dot" />}
    </span>
  );
}

/* ── Advanced: live view ──────────────────────────────────────────── */

function Panel({
  v,
  actions,
  on,
  site,
  solo,
  peek,
  onChipMenu,
  onClose,
}: {
  v: View;
  actions: BarActions;
  on: boolean;
  site?: Platform;
  solo: Category | null;
  peek: boolean;
  onChipMenu: (c: Category, el: Element) => void;
  onClose: () => void;
}) {
  const settings = v.settings.value;
  const now = useComputed(() => {
    const r = v.rate.value;
    return rate(r[r.length - 1] ?? 0);
  });
  const mood = useComputed(() => {
    const x = v.vibe.value;
    // average the last 3 buckets (15 s) for a steadier word
    const tail = x.slice(-3);
    return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  });
  return (
    <div class="hb-panel" role="dialog" aria-label="Hush live view">
      <div class="hp-body">
        <InChatHead v={v} actions={actions} on={on} enabled={settings.enabled} site={site} solo={solo} peek={peek} />

        <div class="hp-tiles">
          <div class="hp-tile">
            <div class="hp-tile-top">
              <span class="hp-label">Messages / s</span>
              <b class="hp-num">{now}</b>
            </div>
            <div class="hp-win">last 60 s</div>
            <Sparkline values={v.rate} height={30} color="var(--accent)" />
          </div>
          <div class="hp-tile">
            <div class="hp-tile-top">
              <span class="hp-label">Mood</span>
              <b class="hp-num" data-vibe={vibeTone(mood.value)}>
                {vibeWord(mood.value)}
              </b>
            </div>
            <div class="hp-win">last 5 min</div>
            <Diverging values={v.vibe} height={30} />
          </div>
        </div>

        <section class="hp-sec">
          <div class="hp-sec-head">
            <span class="hp-label">
              Categories <span class="hp-win">· in chat now</span>
            </span>
            <span class="hp-hint">click: show only · ▾: change</span>
          </div>
          <div class="hp-cats">
            {CATEGORIES.map((c) => (
              <CatRow cat={c} v={v} action={settings.actions[c]} solo={solo} onSolo={(x) => actions.setSolo(x)} onMenu={onChipMenu} />
            ))}
          </div>
        </section>

        <Waves v={v} />
        <Questions v={v} actions={actions} />
      </div>

      <div class="hp-foot">
        <FootModel v={v} />
        <span class="hp-foot-links">
          <button class="hb-link hb-link-quiet" onClick={() => actions.setMode('basic')}>
            {PLAIN.basic}
          </button>
          <button
            class="hb-link"
            onClick={() => {
              actions.openSidePanel();
              onClose();
            }}
          >
            Side panel <Icon name="arrowUpRight" size={12} strokeWidth={1.8} />
          </button>
        </span>
      </div>
    </div>
  );
}

/** "In chat now": what the chat list holds right now, recounted as verdicts change. */
function InChatHead({
  v,
  actions,
  on,
  enabled,
  site,
  solo,
  peek,
}: {
  v: View;
  actions: BarActions;
  on: boolean;
  enabled: boolean;
  site?: Platform;
  solo: Category | null;
  peek: boolean;
}) {
  const rows = useComputed(() => grouped(v.inChat.value.rows));
  const msgs = useComputed(() => (v.inChat.value.rows === 1 ? 'message' : 'messages'));
  const hidden = useComputed(() => grouped(v.inChat.value.hidden));
  const folded = useComputed(() => grouped(v.inChat.value.folded));
  const only = useLive(() => (solo ? grouped(v.inChat.value.byCat[solo]) : ''), [solo]);
  if (!on)
    return (
      <div class="hp-head">
        <div class="hp-head-top">
          <span class="hp-label">In chat now</span>
          {!enabled && (
            <button class="hb-btn hb-btn-accent" onClick={() => actions.toggleEnabled()}>
              <Icon name="power" size={11} strokeWidth={2} /> Turn on
            </button>
          )}
        </div>
        <div class="hp-now">{enabled && site ? PLAIN.siteOff(SITE_NAME[site]!) : PLAIN.off}</div>
      </div>
    );
  return (
    <div class="hp-head">
      <div class="hp-head-top">
        <span class="hp-label">In chat now</span>
        <span class="hp-head-btns">
          {solo ? (
            <button class="hb-btn" onClick={() => actions.setSolo(null)}>
              Show everything
            </button>
          ) : (
            <>
              <button class="hb-btn" aria-pressed={peek} onClick={() => actions.setPeek(!peek)}>
                <Icon name={peek ? 'eyeOff' : 'show'} size={12} strokeWidth={1.8} /> {peek ? 'Hide again' : 'Show hidden'}
              </button>
              <button class="hb-btn" onClick={() => actions.toggleEnabled()}>
                <Icon name="power" size={11} strokeWidth={2} /> Turn off
              </button>
            </>
          )}
        </span>
      </div>
      {solo ? (
        <div class="hp-now">
          Only {SHORT[solo]}: <b>{only}</b> of <b>{rows}</b> {msgs}
        </div>
      ) : (
        <div class="hp-now">
          <b>{rows}</b> {msgs} <i>·</i> <b>{hidden}</b> hidden <i>·</i> <b>{folded}</b> folded
        </div>
      )}
    </div>
  );
}

/** A category row: a click shows only it (again: everything); ▾ changes what happens to it. */
function CatRow({
  cat,
  v,
  action,
  solo,
  onSolo,
  onMenu,
}: {
  cat: Category;
  v: View;
  action: Action;
  solo: Category | null;
  onSolo: (c: Category | null) => void;
  onMenu: (c: Category, el: Element) => void;
}) {
  const n = useComputed(() => compact(v.inChat.value.byCat[cat]));
  const soloed = solo === cat;
  const name = SHORT[cat];
  return (
    <div class="hp-cat" data-a={action} data-c={cat} data-soloed={soloed ? '' : undefined} data-faded={solo && !soloed ? '' : undefined}>
      <button
        class="hp-cat-main"
        aria-pressed={soloed}
        aria-label={`${name}: ${ACTION_META[action].verb.toLowerCase()}. Show only ${name.toLowerCase()}.`}
        onClick={() => onSolo(soloed ? null : cat)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(cat, e.currentTarget.nextElementSibling ?? e.currentTarget);
        }}
      >
        <span class="hp-cat-ico">
          <Icon name={cat} size={13} fill />
        </span>
        <span class="hp-cat-text">
          <span class="hp-cat-name">{name}</span>
          <span class="hp-cat-a" data-a={action}>
            {ACTION_META[action].verb}
          </span>
        </span>
        <span class="hp-cat-n">{n}</span>
      </button>
      <button class="hp-cat-more" aria-haspopup="menu" aria-label={`Change what happens to ${name.toLowerCase()}`} onClick={(e) => onMenu(cat, e.currentTarget)}>
        <Icon name="chevronDown" size={11} strokeWidth={2} />
      </button>
    </div>
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
            <span class="hp-wave-t" dir="auto">
              {w.text}
            </span>
            <em>×{compact(w.count)}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function Questions({ v, actions }: { v: View; actions: BarActions }) {
  const qs = v.questions.value.slice(0, 3);
  const thresholds = v.model.value.thresholds;
  return (
    <section class="hp-sec">
      <div class="hp-sec-head">
        <span class="hp-label">Latest questions</span>
        {qs.length > 0 && <span class="hp-hint">newest first</span>}
      </div>
      {qs.length ? (
        <div class="hp-qs">
          {qs.map((q) => (
            <button
              class="hp-q"
              onClick={() => actions.revealMessage(q.msg.key)}
              title={['Show in chat', q.verdict.reason, scoreDetail(q.verdict, thresholds)].filter(Boolean).join('\n')}
            >
              <span class="hp-q-ico">
                <Icon name="question" size={12} />
              </span>
              <span class="hp-q-body">
                <b>
                  <bdi>{q.msg.author}</bdi>
                </b>{' '}
                <span dir="auto">{q.msg.text}</span>
              </span>
              <span class="hp-q-t">{ago(q.msg.ts)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div class="hp-empty">No questions yet. They'll gather here.</div>
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
