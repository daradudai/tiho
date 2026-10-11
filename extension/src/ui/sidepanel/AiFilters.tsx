// Custom AI filters, answered by the optional Tiho Engine: connection status
// and setup help, per-channel stream context, filters (own words or presets)
// and "Test filter" with a sample message.

import { useEffect, useState } from 'preact/hooks';
import { FILTER_THRESHOLD } from '../../core/policy';
import type { EngineTestResult } from '../../core/protocol';
import { DEFAULT_SETTINGS, channelKey, engineQuestion, filterKey, filterLabel, type EngineFilter, type EngineSettings } from '../../core/settings';
import type { Action } from '../../core/types';
import { engineSummary, testEngine } from '../bridge';
import { Icon } from '../icons';
import { Badge, Button, Card, Toggle, settings, updateSettings } from '../kit/kit';
import { ACTION_META } from '../tokens';
import { ENGINE_README_URL, FILTER_PRESETS } from './filter-presets';
import { engineStatus, live, refreshEngine, startEngineStatus } from './state';

const FILTER_ACTIONS: Action[] = ['hide', 'collapse', 'dim', 'highlight'];
/** Engine limit for the stream context. */
const MAX_CONTEXT = 300;

const uid = () => `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Patch engine settings against the latest value (handlers may outlive a render). */
const saveEngine = (patch: Partial<EngineSettings>) => updateSettings({ engine: { ...settings.value.engine, ...patch } });

export function AiFilters() {
  const eng = settings.value.engine;
  useEffect(() => startEngineStatus(), []);

  return (
    <Card
      title={
        <span class="sp-ai-title">
          <Icon name="sparkles" size={13} /> Custom AI filters
        </span>
      }
      action={
        <Toggle
          size="sm"
          checked={eng.enabled}
          label="Use Tiho Engine"
          onChange={(v) => void saveEngine({ enabled: v }).then(() => refreshEngine(true))}
        />
      }
    >
      <p class="sp-ai-lead">
        Describe what to filter in plain words. Answered by <b>Tiho Engine</b>, an optional local AI server on your own GPU — still nothing leaves your machine.
      </p>
      <EngineConnection />
      {eng.enabled && <StreamContext />}
      <FilterForm />
      <FilterList />
      {eng.enabled && eng.filters.length > 0 && <FilterTest />}
    </Card>
  );
}

function EngineConnection() {
  const eng = settings.value.engine;
  const st = engineStatus.value;
  const sum = engineSummary(eng.enabled ? st : { state: 'off', url: eng.url, answered: 0, expired: 0, latencyMs: 0 });
  const [url, setUrl] = useState(eng.url);
  const [checking, setChecking] = useState(false);
  useEffect(() => setUrl(eng.url), [eng.url]);

  const recheck = async () => {
    setChecking(true);
    await refreshEngine(true);
    setChecking(false);
  };
  const down = eng.enabled && (st?.state === 'unreachable' || st?.state === 'error');
  const refined = st && st.state === 'ready' && st.answered > 0;

  return (
    <>
      <div class="sp-engine" data-tone={sum.tone}>
        <span class={`sp-engine-dot ${checking || sum.tone === 'load' ? 'is-checking' : ''}`} />
        <div class="sp-engine-text">
          <b>{sum.title}</b>
          {sum.sub && <span title={sum.sub}>{sum.sub}</span>}
        </div>
        {eng.enabled && <Button size="sm" variant="ghost" icon="refresh" onClick={() => void recheck()} title="Check again" />}
      </div>
      {refined && (
        <p class="sp-engine-stats">
          {st!.answered.toLocaleString()} messages refined
          {st!.expired > 0 && ` · ${st!.expired.toLocaleString()} skipped (engine busy)`}
        </p>
      )}
      {(down || !eng.enabled) && <SetupHelp open={down} />}
      {eng.enabled && (
        <div class="sp-engine-url">
          <input
            class="k-input is-mono"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            onBlur={() => url.trim() !== eng.url && void saveEngine({ url: url.trim() || DEFAULT_SETTINGS.engine.url })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            aria-label="Engine URL"
            spellcheck={false}
          />
          <label class="sp-inline-toggle">
            <Toggle size="sm" checked={eng.refineUncertain} label="Second opinion" onChange={(v) => saveEngine({ refineUncertain: v })} />
            <span>Second opinion on messages the built-in model is unsure about</span>
          </label>
        </div>
      )}
    </>
  );
}

function SetupHelp({ open }: { open: boolean }) {
  return (
    <details class="sp-setup" open={open}>
      <summary>
        <Icon name="info" size={13} /> How to start Tiho Engine
      </summary>
      <ol>
        <li>
          Needs <b>Python 3.10+</b>. Best on an <b>NVIDIA GPU with 8 GB+</b> (14 GB+ for the full-size model); other GPUs run it through Vulkan (Metal
          on macOS), usually slower.
        </li>
        <li>
          Get Tiho from GitHub (<i>Code → Download ZIP</i>) and open the <code>engine</code> folder.
        </li>
        <li>
          Run <code>.\start.ps1</code> in PowerShell (or <code>./start.sh</code> on Linux / macOS). The first start downloads the model (6–9 GB); later starts take
          about 30 s.
        </li>
        <li>Keep that window open. Tiho connects by itself as soon as the engine is ready.</li>
      </ol>
      <a class="sp-setup-link" href={ENGINE_README_URL} target="_blank" rel="noreferrer">
        Full guide: engine/README <Icon name="external" size={11} />
      </a>
    </details>
  );
}

function StreamContext() {
  const snap = live.value;
  const key = snap?.channel ? channelKey(snap.platform, snap.channel) : null;
  const saved = key ? (settings.value.engine.contexts[key] ?? '') : '';
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [key, saved]);

  if (!key) {
    return <p class="sp-ai-hint">Open a stream to give the engine context about it (game, topic, “no spoilers”).</p>;
  }
  const commit = () => {
    const t = text.trim().slice(0, MAX_CONTEXT);
    if (t === saved) return;
    const contexts = { ...settings.value.engine.contexts };
    if (t) contexts[key] = t;
    else delete contexts[key];
    void saveEngine({ contexts });
  };
  return (
    <div class="sp-context">
      <label class="sp-ai-sub" for="sp-context">
        Stream context · <span>{snap!.channel}</span>
      </label>
      <textarea
        id="sp-context"
        class="k-input sp-context-input"
        rows={2}
        maxLength={MAX_CONTEXT}
        placeholder="e.g. Playing Elden Ring for the first time, no spoilers"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onBlur={commit}
      />
      <p class="sp-ai-hint">Helps filters like spoilers and off-topic. Saved for this channel only.</p>
    </div>
  );
}

function FilterForm() {
  const eng = settings.value.engine;
  const [q, setQ] = useState('');
  const [act, setAct] = useState<Action>('hide');
  const add = (f: Omit<EngineFilter, 'id' | 'enabled'>) => saveEngine({ filters: [{ id: uid(), enabled: true, ...f }, ...settings.value.engine.filters] });
  const presets = FILTER_PRESETS.filter((p) => !eng.filters.some((f) => f.preset === p.id || f.question === p.question));

  return (
    <>
      <form
        class="sp-ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = q.trim();
          if (!t) return;
          void add({ question: t, action: act });
          setQ('');
        }}
      >
        <div class="sp-ai-input">
          <span class="sp-ai-prefix">{ACTION_META[act].label} messages that</span>
          <input
            class="k-input"
            placeholder="…ask the streamer to play another game"
            value={q}
            maxLength={300}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            aria-label="Filter description"
          />
        </div>
        <div class="sp-ruleform-row">
          <select class="k-select" value={act} onChange={(e) => setAct((e.target as HTMLSelectElement).value as Action)} aria-label="Action">
            {FILTER_ACTIONS.map((a) => (
              <option value={a}>{ACTION_META[a].label}</option>
            ))}
          </select>
          <Button type="submit" variant="primary" icon="plus" disabled={!q.trim()}>
            Add filter
          </Button>
        </div>
      </form>
      {presets.length > 0 && (
        <div class="sp-suggest" aria-label="Popular filters">
          {presets.map((p) => (
            <button
              class="sp-chipbtn"
              title={`${ACTION_META[p.action].label}: ${p.question}`}
              onClick={() => void add({ question: p.question, label: p.label, action: p.action, preset: p.id })}
            >
              <Icon name="plus" size={11} /> {p.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function FilterList() {
  const eng = settings.value.engine;
  if (!eng.filters.length) return null;
  const update = (id: string, patch: Partial<EngineFilter>) =>
    saveEngine({ filters: settings.value.engine.filters.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const contextless = !Object.keys(eng.contexts).length;
  return (
    <div class="sp-rules">
      {eng.filters.map((f) => {
        const preset = f.preset ? FILTER_PRESETS.find((p) => p.id === f.preset) : undefined;
        return (
          <div class="sp-rule" data-off={f.enabled && eng.enabled ? undefined : ''}>
            <span class="sp-rule-ico sp-rule-ico-ai">
              <Icon name="sparkles" size={13} />
            </span>
            <span class="sp-rule-p" title={engineQuestion(f.question)}>
              {filterLabel(f, 48)}
              {preset?.wantsContext && contextless && eng.enabled && <em class="sp-rule-note"> · add stream context</em>}
            </span>
            <button
              class="sp-rule-mode"
              title="Click to change"
              onClick={() => update(f.id, { action: FILTER_ACTIONS[(FILTER_ACTIONS.indexOf(f.action) + 1) % FILTER_ACTIONS.length] })}
            >
              <Badge tone={f.action === 'highlight' ? 'accent' : f.action === 'hide' ? 'err' : 'neutral'}>{ACTION_META[f.action].label}</Badge>
            </button>
            <Toggle size="sm" checked={f.enabled} label="Enabled" onChange={(v) => update(f.id, { enabled: v })} />
            <Button
              variant="danger"
              size="sm"
              icon="trash"
              title="Delete filter"
              onClick={() => saveEngine({ filters: settings.value.engine.filters.filter((x) => x.id !== f.id) })}
            />
          </div>
        );
      })}
    </div>
  );
}

function FilterTest() {
  const eng = settings.value.engine;
  const snap = live.value;
  const ready = engineStatus.value?.state === 'ready';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ filters: EngineFilter[]; out: EngineTestResult } | null>(null);
  const filters = eng.filters.filter((f) => f.enabled);

  const run = async (e: Event) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !filters.length) return;
    setBusy(true);
    const context = snap?.channel ? eng.contexts[channelKey(snap.platform, snap.channel)] : undefined;
    const out = await testEngine({
      text: t,
      filters: filters.map((f) => ({ id: filterKey(f), question: engineQuestion(f.question) })),
      context,
      platform: snap?.platform,
    });
    setRes({ filters, out });
    setBusy(false);
  };

  return (
    <form class="sp-test" onSubmit={run}>
      <div class="sp-ai-sub">Test your filters</div>
      <div class="sp-ruleform-row">
        <input
          class="k-input"
          placeholder="Type a chat message…"
          value={text}
          maxLength={500}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          aria-label="Sample message"
        />
        <Button type="submit" icon="play" disabled={!text.trim() || !filters.length || busy || !ready} title={ready ? undefined : 'Connect Tiho Engine to test'}>
          {busy ? 'Asking…' : 'Test'}
        </Button>
      </div>
      {!filters.length && <p class="sp-ai-hint">Turn on at least one filter to test it.</p>}
      {res && !res.out.ok && <p class="sp-err">{res.out.error}</p>}
      {res && res.out.ok && (
        <div class="sp-test-out" aria-live="polite">
          {res.filters.map((f) => {
            const p = (res.out as Extract<EngineTestResult, { ok: true }>).filters[filterKey(f)] ?? 0;
            const hit = p >= FILTER_THRESHOLD;
            return (
              <div class="sp-test-row" data-hit={hit ? '' : undefined}>
                <span class="sp-test-name">{filterLabel(f)}</span>
                <span class="sp-test-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(p * 100)}%` }} />
                </span>
                <b class="sp-test-p">{Math.round(p * 100)}%</b>
                <span class="sp-test-verdict">{hit ? ACTION_META[f.action].verb : 'Shown'}</span>
              </div>
            );
          })}
          <p class="sp-ai-hint">
            Answered in {Math.round(res.out.ms)} ms · a filter acts at {Math.round(FILTER_THRESHOLD * 100)}% or more
          </p>
        </div>
      )}
    </form>
  );
}
