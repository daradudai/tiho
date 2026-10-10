import { useState } from 'preact/hooks';
import type { LogEntry } from '../../core/store';
import type { Category } from '../../core/types';
import { markNotFiltered } from '../bridge';
import { ago, compact } from '../format';
import { Icon } from '../icons';
import { Empty, settings, updateSettings, useTick } from '../kit/kit';
import { ACTION_META, CATEGORY_META } from '../tokens';
import { Avatar } from './InboxTab';
import { NoChat } from './SidePanelApp';
import { connection, filtered, live } from './state';

const SENSITIVE = new Set<Category>(['toxic']);

export function LogTab() {
  useTick(10_000);
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  if (!live.value && !filtered.value.length) return <NoChat />;

  const all = filtered.value.filter((e) => !cleared.has(e.msg.key));
  const counts = new Map<Category, number>();
  for (const e of all) counts.set(e.verdict.category, (counts.get(e.verdict.category) ?? 0) + 1);
  const list = cat === 'all' ? all : all.filter((e) => e.verdict.category === cat);

  const allow = async (e: LogEntry, scope: 'author' | 'text') => {
    const rule = await markNotFiltered(e, scope, connection());
    setCleared(new Set(cleared).add(e.msg.key));
    setToast({
      text: scope === 'author' ? `Always showing @${e.msg.author}` : 'Phrase allowed',
      undo: () => {
        void updateSettings({ rules: settings.value.rules.filter((r) => r.id !== rule.id) });
        const n = new Set(cleared);
        n.delete(e.msg.key);
        setCleared(n);
        setToast(null);
      },
    });
    setTimeout(() => setToast((t) => (t?.text.includes(e.msg.author) || t?.text === 'Phrase allowed' ? null : t)), 5000);
  };

  return (
    <div class="sp-stack">
      <div class="sp-toolbar">
        <div>
          <h2 class="sp-h2">Filtered</h2>
          <p class="sp-h2-sub">What Hush kept out of chat, and why</p>
        </div>
      </div>
      <div class="sp-filters" role="tablist">
        <button class="sp-filter" aria-selected={cat === 'all'} onClick={() => setCat('all')}>
          All <em>{compact(all.length)}</em>
        </button>
        {[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => (
            <button class="sp-filter" data-c={c} aria-selected={cat === c} onClick={() => setCat(c)}>
              <Icon name={c} size={12} fill />
              {CATEGORY_META[c].label} <em>{n}</em>
            </button>
          ))}
      </div>
      {list.length ? (
        <div class="sp-list">
          {list.slice(0, 150).map((e) => (
            <LogItem e={e} onAllow={allow} />
          ))}
        </div>
      ) : (
        <div class="k-card">
          <Empty icon="shield" title="Nothing filtered yet">
            When Hush hides or folds a message, it shows up here with the reason.
          </Empty>
        </div>
      )}
      {toast && (
        <div class="sp-toast" role="status">
          <Icon name="check" size={13} strokeWidth={2} />
          <span>{toast.text}</span>
          <button onClick={toast.undo}>Undo</button>
        </div>
      )}
    </div>
  );
}

function LogItem({ e, onAllow }: { e: LogEntry; onAllow: (e: LogEntry, scope: 'author' | 'text') => void }) {
  const [ask, setAsk] = useState(false);
  const c = e.verdict.category;
  const blur = SENSITIVE.has(c);
  const notLabel = c === 'question' || c === 'positive' || c === 'clean' ? 'Wrong call' : `Not ${c}`;
  return (
    <article class="sp-log" data-c={c} data-ask={ask ? '' : undefined}>
      <Avatar name={e.msg.author} />
      <div class="sp-log-body">
        <div class="sp-q-meta">
          <b>{e.msg.author}</b>
          <span class="sp-reason" data-c={c}>
            <Icon name={c} size={11} fill />
            {e.verdict.reason || CATEGORY_META[c].label.toLowerCase()}
          </span>
          <span class="sp-log-act">{ACTION_META[e.verdict.action].verb.toLowerCase()}</span>
          <span class="sp-log-t">{ago(e.msg.ts)}</span>
          <span class="sp-log-tools">
            <button class="sp-chipbtn" onClick={() => setAsk(!ask)} aria-expanded={ask}>
              <Icon name="thumbUp" size={12} /> {notLabel}
            </button>
            <button class="sp-iconbtn" onClick={() => connection()?.send({ type: 'reveal', key: e.msg.key })} title="Show in chat" aria-label="Show in chat">
              <Icon name="arrowUpRight" size={12} strokeWidth={1.9} />
            </button>
          </span>
        </div>
        <p class={`sp-log-text ${blur ? 'is-blur' : ''}`} tabIndex={blur ? 0 : undefined} title={blur ? 'Hover to read' : undefined}>
          {e.msg.text}
        </p>
        {ask && (
          <div class="sp-q-actions">
            <button class="sp-chipbtn sp-chipbtn-accent" onClick={() => onAllow(e, 'author')}>
              <Icon name="user" size={12} /> Always show @{e.msg.author.length > 14 ? `${e.msg.author.slice(0, 13)}…` : e.msg.author}
            </button>
            <button class="sp-chipbtn" onClick={() => onAllow(e, 'text')}>
              <Icon name="type" size={12} /> Allow this phrase
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
