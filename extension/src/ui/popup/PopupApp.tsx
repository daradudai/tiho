// Toolbar popup (360 px): master switch, this site, live stats, preset,
// strictness, model (and Hush Engine) status, open dashboard.

import { signal, useComputed } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { EngineStatus } from '../../core/protocol';
import type { PresetId } from '../../core/settings';
import { PRESETS } from '../../core/settings';
import type { Action, Category } from '../../core/types';
import { Mark } from '../brand';
import { engineSummary, getActiveTab, getEngineStatus, getPerf, getSnapshot, onEngineStatus, type ActiveTab, type LiveSnapshot } from '../bridge';
import { Sparkline } from '../charts';
import { compact, pct, rate, strictWord, vibeWord } from '../format';
import { Icon, PlatformGlyph } from '../icons';
import { Button, Slider, Toggle, initModelStatus, initSettings, initTheme, modelStatus, settings, updateSettings } from '../kit/kit';
import { modelSummary } from '../model-status';
import { CATEGORY_META, CHIP_CATEGORIES, PRESET_META, PRESET_ORDER } from '../tokens';
import './popup.css';

const tab = signal<ActiveTab | null>(null);
const snap = signal<LiveSnapshot | null>(null);
const perfOnly = signal<{ msgsPerSec: number } | null>(null);
const rateSig = signal<number[]>([]);
const engine = signal<EngineStatus | null>(null);

export const SITE_NAME: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };


async function refresh() {
  const t = tab.value ?? (tab.value = await getActiveTab());
  if (!t?.platform) return;
  const s = await getSnapshot(t.id);
  snap.value = s;
  if (s) rateSig.value = s.rate;
  else {
    const p = await getPerf();
    perfOnly.value = p ? { msgsPerSec: p.stats.msgsPerSec } : null;
  }
}

async function refreshEngine() {
  const e = settings.value.engine;
  if (e.enabled) engine.value = await getEngineStatus(e.url);
}

async function openDashboard() {
  try {
    const id = tab.value?.id;
    if (id != null) await chrome.sidePanel.open({ tabId: id });
    else {
      const w = await chrome.windows?.getCurrent?.();
      if (w?.id != null) await chrome.sidePanel.open({ windowId: w.id });
    }
  } catch {
    /* side panel unavailable */
  }
  window.close?.();
}

export function PopupApp() {
  useEffect(() => {
    initTheme();
    initSettings();
    initModelStatus(1500);
    void refresh();
    const id = setInterval(refresh, 1000);
    const off = onEngineStatus((s) => (engine.value = s));
    const eid = setInterval(refreshEngine, 3000);
    return () => {
      clearInterval(id);
      clearInterval(eid);
      off();
    };
  }, []);

  const s = settings.value;
  useEffect(() => void refreshEngine(), [s.engine.enabled, s.engine.url]);
  const t = tab.value;
  const onSite = !!t?.platform;
  const siteOn = onSite ? s.sites[t!.platform!] : false;

  return (
    <div class="pp" data-off={s.enabled ? undefined : ''}>
      <header class="pp-head">
        <div class="pp-brand">
          <Mark size={30} />
          <div>
            <h1>Hush</h1>
            <p class="pp-sub">
              {s.enabled
                ? onSite
                  ? siteOn
                    ? `Filtering ${SITE_NAME[t!.platform!]} chat`
                    : `Off on ${SITE_NAME[t!.platform!]}`
                  : 'Ready for your next stream'
                : 'Paused everywhere'}
            </p>
          </div>
        </div>
        <Toggle size="lg" checked={s.enabled} label="Hush on/off" onChange={(v) => updateSettings({ enabled: v })} />
      </header>

      <main class="pp-main">
        <SiteCard />

        <section class="pp-sec">
          <div class="pp-sec-head">
            <h2 class="k-label">Vibe</h2>
            {s.preset === 'custom' && <span class="pp-custom">Custom mix</span>}
          </div>
          <Presets current={s.preset} />
        </section>

        <section class="pp-sec">
          <div class="pp-sec-head">
            <h2 class="k-label">Strictness</h2>
            <span class="pp-strict">{strictWord(s.strictness)}</span>
          </div>
          <Slider value={s.strictness} label="Strictness" left="Lenient" right="Strict" onChange={(v) => updateSettings({ strictness: v })} />
        </section>
      </main>

      <footer class="pp-foot">
        <div class="pp-status">
          <ModelLine />
          {s.engine.enabled && <EngineLine />}
        </div>
        <Button variant="primary" size="md" iconRight="arrowRight" onClick={openDashboard}>
          Dashboard
        </Button>
      </footer>
      <div class="pp-privacy">
        <Icon name="lock" size={11} strokeWidth={1.8} />
        Runs on your device · no message ever leaves it
      </div>
    </div>
  );
}

function SiteCard() {
  const t = tab.value;
  const s = settings.value;
  const sn = snap.value;
  const vibe = useComputed(() => {
    const v = snap.value?.vibe ?? [];
    const tail = v.slice(-3);
    return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  });

  if (!t?.platform) {
    return (
      <div class="pp-site pp-site-empty">
        <div class="pp-empty-title">Open a live stream</div>
        <p>Hush quietly filters live chat on</p>
        <div class="pp-sites">
          {(['youtube', 'twitch', 'kick'] as const).map((p) => (
            <a
              class="pp-sitechip"
              href={p === 'youtube' ? 'https://www.youtube.com/live' : p === 'twitch' ? 'https://www.twitch.tv/directory' : 'https://kick.com/browse'}
              target="_blank"
              rel="noreferrer"
            >
              <PlatformGlyph platform={p} size={14} />
              {SITE_NAME[p]}
            </a>
          ))}
        </div>
      </div>
    );
  }

  const p = t.platform;
  const on = s.sites[p];
  const channel = sn?.channel || t.url.split('/').filter(Boolean).pop() || t.host;
  const seen = sn?.totals.seen ?? 0;
  const live = !!sn;
  return (
    <div class="pp-site" data-live={live ? '' : undefined}>
      <div class="pp-site-top">
        <span class="pp-site-ico">
          <PlatformGlyph platform={p} size={16} />
        </span>
        <div class="pp-site-text">
          <div class="pp-site-name">{channel}</div>
          <div class="pp-site-desc">
            {live ? (
              <>
                <span class="pp-live" />
                Live chat on {SITE_NAME[p]}
              </>
            ) : on ? (
              `${SITE_NAME[p]} · waiting for chat`
            ) : (
              `Hush is off on ${SITE_NAME[p]}`
            )}
          </div>
        </div>
        <Toggle size="sm" checked={on} label={`Hush on ${SITE_NAME[p]}`} onChange={(v) => updateSettings({ sites: { ...s.sites, [p]: v } })} />
      </div>
      {live && on && (
        <>
          <div class="pp-kpis">
            <div class="pp-kpi">
              <b class="pp-kpi-grad">{seen ? pct(sn!.totals.filtered / seen) : '—'}</b>
              <span>hushed</span>
            </div>
            <div class="pp-kpi">
              <b>{rate(sn!.rate[sn!.rate.length - 1] ?? sn!.perf.msgsPerSec)}</b>
              <span>msgs / s</span>
            </div>
            <div class="pp-kpi">
              <b data-vibe={vibe.value > 0.05 ? 'pos' : vibe.value < -0.05 ? 'neg' : 'mid'}>{vibeWord(vibe.value)}</b>
              <span>vibe</span>
            </div>
          </div>
          <Sparkline values={rateSig} height={30} color="var(--accent)" class="pp-spark" />
          <CategoryStrip counts={sn!.counts} actions={s.actions} />
        </>
      )}
      {!live && on && perfOnly.value && (
        <div class="pp-kpis">
          <div class="pp-kpi">
            <b>{rate(perfOnly.value.msgsPerSec)}</b>
            <span>msgs / s</span>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryStrip({ counts, actions }: { counts: Record<Category, number>; actions: Record<Category, Action> }) {
  const all = [...CHIP_CATEGORIES, 'clean' as Category];
  const total = all.reduce((a, c) => a + counts[c], 0) || 1;
  const filtered = CHIP_CATEGORIES.filter((c) => actions[c] === 'hide' || actions[c] === 'collapse');
  return (
    <div class="pp-strip" aria-label="Chat composition">
      <div class="pp-strip-bar">
        {all.map((c) => {
          const w = (counts[c] / total) * 100;
          return w > 0.4 ? <span data-c={c} data-a={actions[c]} style={{ flexGrow: w }} title={`${CATEGORY_META[c].label}: ${compact(counts[c])}`} /> : null;
        })}
      </div>
      {filtered.length > 0 && (
        <div class="pp-strip-legend">
          {filtered.map((c) => (
            <span data-c={c}>
              <Icon name={c} size={11} fill />
              <b>{compact(counts[c])}</b> {CATEGORY_META[c].label.toLowerCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Presets({ current }: { current: PresetId }) {
  const [hover, setHover] = useState<Exclude<PresetId, 'custom'> | null>(null);
  const shown = hover ?? (current === 'custom' ? null : current);
  return (
    <>
      <div class="pp-presets" role="radiogroup" aria-label="Vibe preset" onPointerLeave={() => setHover(null)}>
        {PRESET_ORDER.map((p) => (
          <button
            type="button"
            role="radio"
            aria-checked={current === p}
            class="pp-preset"
            onPointerEnter={() => setHover(p)}
            onFocus={() => setHover(p)}
            onClick={() => updateSettings({ preset: p, actions: { ...PRESETS[p] } })}
          >
            <b>{PRESET_META[p].label}</b>
            <span class="pp-dots" aria-hidden="true">
              {CHIP_CATEGORIES.map((c) => (
                <i data-c={c} data-a={PRESETS[p][c]} />
              ))}
            </span>
          </button>
        ))}
      </div>
      <p class="pp-preset-desc">{shown ? PRESET_META[shown].desc : 'Your own mix — tune it in the dashboard'}</p>
    </>
  );
}

function EngineLine() {
  const sum = engineSummary(engine.value);
  return (
    <span class="pp-model pp-engine" data-tone={sum.tone}>
      <span class="pp-model-dot" />
      <span>
        <b>Hush Engine · {sum.title}</b>
        {sum.sub && <em>{sum.sub}</em>}
      </span>
    </span>
  );
}

function ModelLine() {
  const m = modelStatus.value;
  if (!m)
    return (
      <span class="pp-model" data-tone="idle">
        <span class="pp-model-dot" />
        <span>
          <b>Hush Lite</b>
          <em>Connecting…</em>
        </span>
      </span>
    );
  const s = modelSummary(m);
  return (
    <span class="pp-model" data-tone={s.tone}>
      {s.tone === 'load' && m.progress != null ? (
        <span class="pp-model-prog" style={{ '--p': `${Math.round(m.progress * 100)}%` } as any} />
      ) : (
        <span class="pp-model-dot" />
      )}
      <span>
        <b>{s.title}</b>
        <em>{s.sub}</em>
      </span>
    </span>
  );
}
