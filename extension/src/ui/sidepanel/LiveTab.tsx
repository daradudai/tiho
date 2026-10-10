import { PRESETS } from '../../core/settings';
import type { Action, Category } from '../../core/types';
import { CATEGORIES } from '../../core/types';
import { Mark } from '../brand';
import { Diverging, Sparkline } from '../charts';
import { ago, compact, grouped, pct, rate as fmtRate, signed, vibeWord } from '../format';
import { Icon } from '../icons';
import { Card, Segmented, settings, updateSettings } from '../kit/kit';
import { modelSummary } from '../model-status';
import { ACTION_META, CATEGORY_META, PRESET_META, PRESET_ORDER } from '../tokens';
import { NoChat } from './SidePanelApp';
import { live, rate, vibe } from './state';

const ACTIONS: Action[] = ['show', 'highlight', 'dim', 'collapse', 'hide'];

export function LiveTab() {
  const s = live.value;
  if (!s) return <NoChat />;
  const seen = s.totals.seen;
  const ratio = seen ? s.totals.filtered / seen : 0;
  const now = s.rate[s.rate.length - 1] ?? 0;
  const peak = Math.max(0, ...s.rate);
  const avg = s.rate.length ? s.rate.reduce((a, b) => a + b, 0) / s.rate.length : 0;
  const v3 = s.vibe.slice(-3);
  const vibeNow = v3.length ? v3.reduce((a, b) => a + b, 0) / v3.length : 0;
  const ms = modelSummary(s.model);

  return (
    <div class="sp-stack">
      <section class="sp-hero">
        <div class="sp-hero-main">
          <span class="k-label">Hushed</span>
          <b class="sp-hero-num">{seen ? pct(ratio) : '—'}</b>
          <span class="sp-hero-sub">
            {grouped(s.totals.filtered)} of {grouped(seen)} messages
          </span>
        </div>
        <div class="sp-ring-wrap">
          <HushRing ratio={ratio} />
          <Mark size={26} />
        </div>
      </section>

      <Card
        title="Messages per second"
        action={
          <span class="sp-metric">
            <b>{fmtRate(now)}</b> now · avg {fmtRate(avg)} · peak {fmtRate(peak)}
          </span>
        }
      >
        <Sparkline values={rate} height={76} color="var(--accent)" smoothing={1} hover={(v, i, n) => `${fmtRate(v)} msg/s · ${n - 1 - i}s ago`} />
        <div class="sp-axis">
          <span>60s ago</span>
          <span>now</span>
        </div>
      </Card>

      <Card
        title="Vibe"
        action={
          <span class="sp-metric" data-vibe={vibeNow > 0.05 ? 'pos' : vibeNow < -0.05 ? 'neg' : 'mid'}>
            <b>{vibeWord(vibeNow)}</b> {signed(vibeNow)}
          </span>
        }
      >
        <Diverging values={vibe} height={64} hover={(v, i, n) => `${vibeWord(v)} ${signed(v)} · ${Math.round(((n - 1 - i) * 5) / 60 * 10) / 10} min ago`} />
        <div class="sp-axis">
          <span>5 min ago</span>
          <span class="sp-axis-legend">
            <i data-c="positive" /> positive <i data-c="negative" /> negative
          </span>
          <span>now</span>
        </div>
      </Card>

      <Card title="Categories" action={<PresetPicker />} pad={false}>
        <div class="sp-cats">
          {CATEGORIES.map((c) => (
            <CatRow cat={c} count={s.counts[c]} total={seen} action={settings.value.actions[c]} />
          ))}
        </div>
      </Card>

      {s.waves.length > 0 && (
        <Card title="Waves" action={<span class="sp-metric">same message, many people</span>}>
          <div class="sp-waves">
            {s.waves.map((w) => (
              <div class="sp-wave" data-live={Date.now() - w.lastAt < 10_000 ? '' : undefined}>
                <span class="sp-wave-t">{w.text}</span>
                <span class="sp-wave-n">×{compact(w.count)}</span>
                <span class="sp-wave-meta">
                  {w.users} people · {ago(w.lastAt)} ago
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Engine room" action={<span class={`sp-tone sp-tone-${ms.tone}`}>{ms.title}</span>}>
        <div class="sp-perf">
          <Perf label="Latency p50" value={`${s.perf.p50ms.toFixed(0)} ms`} />
          <Perf label="Latency p95" value={`${s.perf.p95ms.toFixed(0)} ms`} />
          <Perf label="Inferences / s" value={fmtRate(s.perf.inferPerSec)} />
          <Perf label="Cache hits" value={pct(s.perf.cacheHitRate)} />
        </div>
      </Card>
    </div>
  );
}

function Perf({ label, value }: { label: string; value: string }) {
  return (
    <div class="sp-perf-cell">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function HushRing({ ratio }: { ratio: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg class="sp-ring" width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
      <defs>
        <linearGradient id="sp-ring-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7c83ff" />
          <stop offset="0.55" stop-color="#a78bfa" />
          <stop offset="1" stop-color="#5ab2ff" />
        </linearGradient>
      </defs>
      <circle cx="38" cy="38" r={r} fill="none" stroke="var(--track)" stroke-width="7" />
      <circle
        cx="38"
        cy="38"
        r={r}
        fill="none"
        stroke="url(#sp-ring-g)"
        stroke-width="7"
        stroke-linecap="round"
        stroke-dasharray={`${c} ${c}`}
        stroke-dashoffset={c * (1 - Math.min(1, Math.max(0.005, ratio)))}
        transform="rotate(-90 38 38)"
        style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }}
      />
    </svg>
  );
}

function PresetPicker() {
  const p = settings.value.preset;
  return (
    <Segmented
      size="sm"
      label="Preset"
      value={p}
      options={PRESET_ORDER.map((id) => ({ value: id, label: PRESET_META[id].short, title: PRESET_META[id].desc }))}
      onChange={(id) => updateSettings({ preset: id, actions: { ...PRESETS[id as keyof typeof PRESETS] } })}
    />
  );
}

function CatRow({ cat, count, total, action }: { cat: Category; count: number; total: number; action: Action }) {
  const share = total ? count / total : 0;
  const meta = CATEGORY_META[cat];
  const set = (a: Action) => updateSettings({ preset: 'custom', actions: { ...settings.value.actions, [cat]: a } });
  return (
    <div class="sp-cat" data-c={cat} data-a={action}>
      <span class="sp-cat-ico">
        <Icon name={cat} size={14} fill />
      </span>
      <div class="sp-cat-body">
        <div class="sp-cat-top">
          <span class="sp-cat-name" title={meta.desc}>
            {meta.label}
          </span>
          <span class="sp-cat-n">
            {compact(count)} <em>{pct(share, share < 0.1 && share > 0 ? 1 : 0)}</em>
          </span>
        </div>
        <div class="sp-cat-bar">
          <span style={{ width: `${Math.max(share * 100, count ? 1.5 : 0)}%` }} />
        </div>
      </div>
      <div class="sp-acts" role="radiogroup" aria-label={`${meta.label} action`}>
        {ACTIONS.map((a) => (
          <button role="radio" aria-checked={a === action} class="sp-act" data-a={a} title={`${ACTION_META[a].label} — ${ACTION_META[a].desc}`} onClick={() => set(a)}>
            <Icon name={a} size={13} fill={a === 'highlight'} strokeWidth={1.7} />
          </button>
        ))}
      </div>
    </div>
  );
}

