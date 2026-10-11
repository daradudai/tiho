import { useState } from 'preact/hooks';
import type { LogEntry } from '../../core/store';
import type { Category } from '../../core/types';
import { markNotFiltered } from '../bridge';
import { ago, compact, scoreDetail } from '../format';
import { Icon } from '../icons';
import { Empty, useTick } from '../kit/kit';
import { ACTION_META, CATEGORY_META } from '../tokens';
import { Avatar } from './InboxTab';
import { NoChat } from './SidePanelApp';
import { canView, connection, filtered, live, setSolo, views } from './state';

const SENSITIVE = new Set<Category>(['toxic']);

/** Check a category in chat: everything else is hidden there until "Show all". */
function SoloButton({ cat }: { cat: Category }) {
  const on = views.value.solo === cat;
  return (
    <button type="button" class={`k-btn k-btn-sm ${on ? 'k-btn-subtle' : ''}`} aria-pressed={on} disabled={!canView.value} onClick={() => setSolo(cat)}>
      <Icon name={on ? 'x' : 'show'} size={12} strokeWidth={1.8} />
      {on ? 'Show all in chat' : 'Show only these in chat'}
    </button>
  );
}

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
    const res = await markNotFiltered(e, scope, connection());
    setCleared(new Set(cleared).add(e.msg.key));
    setToast({
      text: scope === 'author' ? `Always showing @${e.msg.author}` : 'Phrase allowed',
      undo: () => {
        void res.undo();
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
      <div class="sp-toolbar sp-toolbar-wrap">
        <div>
          <h2 class="sp-h2">Hidden messages</h2>
          <p class="sp-h2-sub">What Tiho hid or folded since you opened this panel, newest first</p>
        </div>
        {cat !== 'all' && <SoloButton cat={cat} />}
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
          <Empty icon="shield" title="Nothing hidden yet">
            When Tiho hides or folds a message, it shows up here with the reason.
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
  const reason = e.verdict.reason || CATEGORY_META[c].label.toLowerCase();
  // the raw score stays one hover away (the reason says how sure, in words)
  const detail = scoreDetail(e.verdict, live.value?.model.thresholds);
  return (
    <article class="sp-log" data-c={c} data-ask={ask ? '' : undefined}>
      <Avatar name={e.msg.author} />
      <div class="sp-log-body">
        <div class="sp-q-meta">
          <b>
            <bdi>{e.msg.author}</bdi>
          </b>
          <span class="sp-reason" data-c={c} title={detail ? `${reason}\n${detail}` : reason}>
            <Icon name={c} size={11} fill />
            <span>{reason}</span>
          </span>
          <span class="sp-log-act">{ACTION_META[e.verdict.action].verb.toLowerCase()}</span>
          <span class="sp-log-t">{ago(e.msg.ts)}</span>
        </div>
        <p class={`sp-log-text ${blur ? 'is-blur' : ''}`} dir="auto" tabIndex={blur ? 0 : undefined} title={blur ? 'Hover to read' : undefined}>
          {e.msg.text}
        </p>
        {/* after the text, so it reads first; CSS lifts the tools into the meta line */}
        <span class="sp-log-tools">
          <button class="sp-chipbtn" onClick={() => setAsk(!ask)} aria-expanded={ask}>
            <Icon name="thumbUp" size={12} /> {notLabel}
          </button>
          <button class="sp-iconbtn" onClick={() => connection()?.send({ type: 'reveal', key: e.msg.key })} title="Show in chat" aria-label="Show in chat">
            <Icon name="arrowUpRight" size={12} strokeWidth={1.9} />
          </button>
        </span>
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
