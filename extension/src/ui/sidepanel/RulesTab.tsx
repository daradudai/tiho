import { useEffect, useState } from 'preact/hooks';
import type { UserRule } from '../../core/settings';
import type { Action } from '../../core/types';
import { checkEngine, type EngineHealth } from '../bridge';
import { Icon, type IconName } from '../icons';
import { Badge, Button, Card, Empty, Segmented, Toggle, settings, updateSettings } from '../kit/kit';
import { ACTION_META } from '../tokens';

const KIND: Record<UserRule['kind'], { label: string; icon: IconName; ph: string }> = {
  word: { label: 'Word', icon: 'type', ph: 'e.g. spoiler, giveaway' },
  regex: { label: 'Regex', icon: 'regex', ph: 'e.g. \\b(free|cheap)\\s+v-?bucks\\b' },
  user: { label: 'User', icon: 'user', ph: 'e.g. nightbot' },
};
const MODE: Record<UserRule['mode'], { label: string; tone: 'err' | 'ok' | 'accent' }> = {
  block: { label: 'Hide', tone: 'err' },
  allow: { label: 'Always show', tone: 'ok' },
  highlight: { label: 'Highlight', tone: 'accent' },
};
const MODES: UserRule['mode'][] = ['block', 'allow', 'highlight'];

function regexError(p: string): string | null {
  try {
    new RegExp(p, 'iu');
    return null;
  } catch (e) {
    return (e as Error).message.replace(/^Invalid regular expression: /, '');
  }
}

const uid = () => `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function RulesTab() {
  return (
    <div class="sp-stack">
      <UserRules />
      <AiFilters />
    </div>
  );
}

function UserRules() {
  const rules = settings.value.rules;
  const [kind, setKind] = useState<UserRule['kind']>('word');
  const [mode, setMode] = useState<UserRule['mode']>('block');
  const [pattern, setPattern] = useState('');
  const err = kind === 'regex' && pattern ? regexError(pattern) : null;
  const save = (next: UserRule[]) => updateSettings({ rules: next });
  const add = (e: Event) => {
    e.preventDefault();
    const raw = pattern.trim();
    const p = kind === 'user' ? raw.replace(/^@/, '') : raw;
    if (!p || err) return;
    save([{ id: uid(), kind, pattern: p, mode, enabled: true }, ...rules]);
    setPattern('');
  };
  return (
    <Card title="Your rules" action={<span class="sp-metric">checked before the model, instantly</span>}>
      <form class="sp-ruleform" onSubmit={add}>
        <div class="sp-ruleform-top">
          <Segmented size="sm" label="Match" value={kind} options={(['word', 'regex', 'user'] as const).map((k) => ({ value: k, label: KIND[k].label }))} onChange={setKind} />
          <select class="k-select sp-mode" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as UserRule['mode'])} aria-label="Then">
            {MODES.map((m) => (
              <option value={m}>{MODE[m].label}</option>
            ))}
          </select>
        </div>
        <div class="sp-ruleform-row">
          <input
            class={`k-input ${kind === 'regex' ? 'is-mono' : ''}`}
            placeholder={KIND[kind].ph}
            value={pattern}
            aria-invalid={err ? 'true' : undefined}
            onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
            aria-label="Pattern"
          />
          <Button type="submit" variant="primary" icon="plus" disabled={!pattern.trim() || !!err}>
            Add
          </Button>
        </div>
        {err && <p class="sp-err">{err}</p>}
      </form>
      {rules.length ? (
        <div class="sp-rules">
          {rules.map((r) => (
            <div class="sp-rule" data-off={r.enabled ? undefined : ''}>
              <span class="sp-rule-ico" title={KIND[r.kind].label}>
                <Icon name={KIND[r.kind].icon} size={13} />
              </span>
              <span class={`sp-rule-p ${r.kind === 'regex' ? 'is-mono' : ''}`}>{r.kind === 'user' ? `@${r.pattern}` : r.pattern}</span>
              <button
                class="sp-rule-mode"
                title="Click to change"
                onClick={() => save(rules.map((x) => (x.id === r.id ? { ...x, mode: MODES[(MODES.indexOf(x.mode) + 1) % MODES.length] } : x)))}
              >
                <Badge tone={MODE[r.mode].tone}>{MODE[r.mode].label}</Badge>
              </button>
              <Toggle size="sm" checked={r.enabled} label="Enabled" onChange={(v) => save(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
              <Button variant="danger" size="sm" icon="trash" title="Delete rule" onClick={() => save(rules.filter((x) => x.id !== r.id))} />
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="sliders" title="No rules yet">
          Hide a word, always show a friend, or highlight your name. Rules run before the AI, in microseconds.
        </Empty>
      )}
    </Card>
  );
}

const SUGGEST = ['are backseating the streamer', 'spoil the story or the ending', 'talk about other streamers', 'beg for follows or subs', 'argue about politics'];

function AiFilters() {
  const eng = settings.value.engine;
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [url, setUrl] = useState(eng.url);
  const [q, setQ] = useState('');
  const [act, setAct] = useState<Action>('hide');

  const check = async (u = url) => {
    setChecking(true);
    setHealth(await checkEngine(u));
    setChecking(false);
  };
  useEffect(() => {
    void check(eng.url);
    const id = setInterval(() => void check(eng.url), 15_000);
    return () => clearInterval(id);
  }, [eng.url]);

  const saveEngine = (patch: Partial<typeof eng>) => updateSettings({ engine: { ...eng, ...patch } });
  const add = (text = q) => {
    const t = text.trim();
    if (!t) return;
    saveEngine({ filters: [{ id: uid(), question: t, action: act, enabled: true }, ...eng.filters] });
    setQ('');
  };

  const ok = health?.ok;
  return (
    <Card
      title={
        <span class="sp-ai-title">
          <Icon name="sparkles" size={13} /> Custom AI filters
        </span>
      }
      action={<Toggle size="sm" checked={eng.enabled} label="Use Hush Engine" onChange={(v) => saveEngine({ enabled: v })} />}
    >
      <p class="sp-ai-lead">
        Describe what to filter in plain words. Answered by <b>Hush Engine</b>, an optional local AI server on your own GPU — still nothing leaves your machine.
      </p>

      <div class="sp-engine" data-ok={ok ? '' : undefined}>
        <span class={`sp-engine-dot ${checking ? 'is-checking' : ''}`} />
        <div class="sp-engine-text">
          <b>{health == null ? 'Checking…' : ok ? 'Connected' : health.error ?? 'Not running'}</b>
          <span>
            {ok
              ? [health!.model, health!.device, health!.ms != null ? `${health!.ms} ms` : ''].filter(Boolean).join(' · ')
              : 'Start Hush Engine on this computer to enable custom filters'}
          </span>
        </div>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void check()} title="Check again" />
      </div>
      <div class="sp-engine-url">
        <input
          class="k-input is-mono"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onBlur={() => url !== eng.url && saveEngine({ url })}
          aria-label="Engine URL"
        />
        <label class="sp-inline-toggle">
          <Toggle size="sm" checked={eng.refineUncertain} label="Second opinion" onChange={(v) => saveEngine({ refineUncertain: v })} />
          <span>Second opinion on unsure messages</span>
        </label>
      </div>

      <form
        class="sp-ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div class="sp-ai-input">
          <span class="sp-ai-prefix">Hide messages that</span>
          <input class="k-input" placeholder="…are backseating the streamer" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Filter description" />
        </div>
        <div class="sp-ruleform-row">
          <select class="k-select" value={act} onChange={(e) => setAct((e.target as HTMLSelectElement).value as Action)} aria-label="Action">
            {(['hide', 'collapse', 'dim', 'highlight'] as Action[]).map((a) => (
              <option value={a}>{ACTION_META[a].label}</option>
            ))}
          </select>
          <Button type="submit" variant="primary" icon="plus" disabled={!q.trim()}>
            Add filter
          </Button>
        </div>
      </form>
      {eng.filters.length === 0 && (
        <div class="sp-suggest">
          {SUGGEST.map((s) => (
            <button class="sp-chipbtn" onClick={() => add(s)}>
              <Icon name="plus" size={11} /> {s}
            </button>
          ))}
        </div>
      )}
      {eng.filters.length > 0 && (
        <div class="sp-rules">
          {eng.filters.map((f) => (
            <div class="sp-rule" data-off={f.enabled && eng.enabled ? undefined : ''}>
              <span class="sp-rule-ico sp-rule-ico-ai">
                <Icon name="sparkles" size={13} />
              </span>
              <span class="sp-rule-p">{f.question}</span>
              <Badge tone={f.action === 'highlight' ? 'accent' : 'neutral'}>{ACTION_META[f.action].label}</Badge>
              <Toggle size="sm" checked={f.enabled} label="Enabled" onChange={(v) => saveEngine({ filters: eng.filters.map((x) => (x.id === f.id ? { ...x, enabled: v } : x)) })} />
              <Button variant="danger" size="sm" icon="trash" title="Delete filter" onClick={() => saveEngine({ filters: eng.filters.filter((x) => x.id !== f.id) })} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
