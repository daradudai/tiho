import type { ComponentChildren } from 'preact';
import { PRESETS } from '../../core/settings';
import type { InChat } from '../../core/store';
import type { Action, Category } from '../../core/types';
import { CATEGORIES } from '../../core/types';
import { Diverging, Sparkline } from '../charts';
import { ago, compact, grouped, pct, rate as fmtRate, signed, vibeTone, vibeWord } from '../format';
import { Icon } from '../icons';
import { Card, Segmented, settings, updateSettings } from '../kit/kit';
import { modelSummary } from '../model-status';
import { ACTION_META, CATEGORY_META, PRESET_META, PRESET_ORDER } from '../tokens';
import { NoChat } from './SidePanelApp';
import { canView, live, rate, setPeek, setSolo, vibe, views } from './state';

const ACTIONS: Action[] = ['show', 'highlight', 'dim', 'collapse', 'hide'];

/** A card title with the window its numbers cover ("last 60 s", "in chat now"). */
function Titled({ title, window: w }: { title: ComponentChildren; window: string }) {
  return (
    <>
      {title}
      <em class="sp-win">{w}</em>
    </>
  );
}

export function LiveTab() {
  const s = live.value;
  if (!s) return <NoChat />;
  const now = s.rate[s.rate.length - 1] ?? 0;
  const peak = Math.max(0, ...s.rate);
  const avg = s.rate.length ? s.rate.reduce((a, b) => a + b, 0) / s.rate.length : 0;
  const v3 = s.vibe.slice(-3);
  const mood = v3.length ? v3.reduce((a, b) => a + b, 0) / v3.length : 0;
  const ms = modelSummary(s.model);
  const solo = views.value.solo;

  return (
    <div class="sp-stack">
      <Hero inChat={s.inChat} />

      <Card
        title={<Titled title="Messages per second" window="last 60 s" />}
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
        title={<Titled title="Mood" window="last 5 min" />}
        action={
          <span class="sp-metric" data-vibe={vibeTone(mood)} title={`${signed(mood)} on a scale from −1 (all negative) to +1 (all positive), last 15 s`}>
            <b>{vibeWord(mood)}</b>
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

      <Card title={<Titled title="Categories" window="in chat now" />} action={<PresetPicker />} pad={false}>
        <div class="sp-cats">
          {CATEGORIES.map((c) => (
            <CatRow cat={c} count={s.inChat.byCat[c]} total={s.inChat.rows} action={settings.value.actions[c]} solo={solo} />
          ))}
        </div>
        {solo && (
          <div class="sp-solo" data-c={solo} role="status">
            <Icon name={solo} size={13} fill />
            <span>Only {CATEGORY_META[solo].label} in chat</span>
            <button type="button" class="k-btn k-btn-sm k-btn-subtle" disabled={!canView.value} onClick={() => setSolo(null)}>
              Show all
            </button>
          </div>
        )}
      </Card>

      {s.waves.length > 0 && (
        <Card title="Waves" action={<span class="sp-metric">same message, many people</span>}>
          <div class="sp-waves">
            {s.waves.map((w) => (
              <div class="sp-wave" data-live={Date.now() - w.lastAt < 10_000 ? '' : undefined}>
                <span class="sp-wave-t" dir="auto">
                  {w.text}
                </span>
                <span class="sp-wave-n">×{compact(w.count)}</span>
                <span class="sp-wave-meta">
                  {w.users} people · {ago(w.lastAt) === 'now' ? 'now' : `${ago(w.lastAt)} ago`}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Performance" action={<span class={`sp-tone sp-tone-${ms.tone}`}>{ms.title}</span>}>
        <div class="sp-perf">
          <Perf label="Latency p50" window="recent" value={`${s.perf.p50ms.toFixed(0)} ms`} />
          <Perf label="Latency p95" window="recent" value={`${s.perf.p95ms.toFixed(0)} ms`} />
          <Perf label="Inferences / s" window="now" value={fmtRate(s.perf.inferPerSec)} />
          <Perf label="Cache hits" window="since this chat opened" value={pct(s.perf.cacheHitRate)} />
        </div>
      </Card>
    </div>
  );
}

/** What the chat list holds now: hidden and folded rows, and Show hidden for that tab. */
function Hero({ inChat }: { inChat: InChat }) {
  const { peek, solo } = views.value;
  const away = inChat.hidden + inChat.folded;
  return (
    <section class="sp-hero">
      <span class="k-label">In chat now</span>
      <b class="sp-hero-num">
        {grouped(away)}
        <span>hidden or folded</span>
      </b>
      <span class="sp-hero-sub">
        {grouped(inChat.hidden)} hidden · {grouped(inChat.folded)} folded · {grouped(inChat.rows)} messages
      </span>
      <button
        type="button"
        class={`k-btn k-btn-sm sp-peek ${peek ? 'k-btn-subtle' : ''}`}
        aria-pressed={peek}
        disabled={!canView.value || !!solo}
        title={solo ? 'Not while one category is shown alone' : peek ? 'Hidden messages are back in chat, faded' : 'Bring back what Tiho hid in that tab, faded'}
        onClick={() => setPeek(!peek)}
      >
        <Icon name={peek ? 'eyeOff' : 'show'} size={13} strokeWidth={1.8} />
        {peek ? 'Hide again' : 'Show hidden in chat'}
      </button>
    </section>
  );
}

function Perf({ label, window: w, value }: { label: string; window: string; value: string }) {
  return (
    <div class="sp-perf-cell">
      <span>{label}</span>
      <b>{value}</b>
      <em>{w}</em>
    </div>
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

function CatRow({ cat, count, total, action, solo }: { cat: Category; count: number; total: number; action: Action; solo: Category | null }) {
  const share = total ? count / total : 0;
  const meta = CATEGORY_META[cat];
  const only = solo === cat;
  const set = (a: Action) => updateSettings({ preset: 'custom', actions: { ...settings.value.actions, [cat]: a } });
  return (
    <div class="sp-cat" data-c={cat} data-a={action} data-solo={only ? '' : undefined} data-faded={solo && !only ? '' : undefined}>
      <span class="sp-cat-ico">
        <Icon name={cat} size={14} fill />
      </span>
      <div class="sp-cat-body">
        <div class="sp-cat-top">
          <span class="sp-cat-name" title={meta.desc}>
            {meta.label}
          </span>
          <span class="sp-cat-n">{compact(count)}</span>
        </div>
        <div class="sp-cat-bar">
          <span style={{ width: `${Math.max(share * 100, count ? 1.5 : 0)}%` }} />
        </div>
      </div>
      <button
        type="button"
        class="sp-only"
        aria-pressed={only}
        aria-label={only ? 'Show all messages in chat' : `Show only ${meta.label.toLowerCase()} in chat`}
        title={only ? 'Show every category again' : `Show only ${meta.label.toLowerCase()} in chat, to check what Tiho put there`}
        disabled={!canView.value}
        onClick={() => setSolo(cat)}
      >
        {only ? 'Show all' : 'Only'}
      </button>
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
