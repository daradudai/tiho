import { useState } from 'preact/hooks';
import type { UserRule } from '../../core/settings';
import { Icon, type IconName } from '../icons';
import { Badge, Button, Card, Empty, Segmented, Toggle, settings, updateSettings } from '../kit/kit';
import { AiFilters } from './AiFilters';

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
