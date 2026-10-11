import { useState } from 'preact/hooks';
import type { LogEntry } from '../../core/store';
import { ago } from '../format';
import { Icon } from '../icons';
import { Empty, Segmented, useTick } from '../kit/kit';
import { NoChat } from './SidePanelApp';
import { connection, done, live, questions } from './state';

/** Stable pastel hue per author. */
export function authorHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({ name }: { name: string }) {
  return (
    <span class="sp-av" style={{ '--h': authorHue(name) } as any} aria-hidden="true">
      {name.replace(/^[^a-z0-9]+/i, '')[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export function InboxTab() {
  useTick(10_000);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  if (!live.value && !questions.value.length) return <NoChat />;
  const all = questions.value;
  const d = done.value;
  const list = filter === 'open' ? all.filter((q) => !d.has(q.msg.key)) : all;
  const toggle = (k: string) => {
    const n = new Set(d);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    done.value = n;
  };
  return (
    <div class="sp-stack">
      <div class="sp-toolbar">
        <div>
          <h2 class="sp-h2">Questions</h2>
          <p class="sp-h2-sub">
            {all.length} asked since you opened this panel · {all.length - all.filter((q) => d.has(q.msg.key)).length} open
          </p>
        </div>
        <Segmented
          size="sm"
          label="Show"
          value={filter}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
          onChange={setFilter}
        />
      </div>
      {list.length ? (
        <div class="sp-list">
          {list.map((q) => (
            <QuestionItem q={q} done={d.has(q.msg.key)} onDone={() => toggle(q.msg.key)} />
          ))}
        </div>
      ) : (
        <div class="k-card">
          <Empty icon="inbox" title={all.length ? 'Inbox zero' : 'No questions yet'}>
            {all.length ? 'You have gone through every question. Nice.' : 'Real questions from chat land here, so you never miss one in the flood.'}
          </Empty>
        </div>
      )}
    </div>
  );
}

function QuestionItem({ q, done: isDone, onDone }: { q: LogEntry; done: boolean; onDone: () => void }) {
  const reveal = () => connection()?.send({ type: 'reveal', key: q.msg.key });
  return (
    <article class="sp-q" data-done={isDone ? '' : undefined}>
      <Avatar name={q.msg.author} />
      <button class="sp-q-body" onClick={reveal} title="Show in chat">
        <span class="sp-q-meta">
          <b>
            <bdi>{q.msg.author}</bdi>
          </b>
          <span class="sp-q-time">{ago(q.msg.ts)}</span>
          <span class="sp-q-go">
            Show in chat <Icon name="arrowUpRight" size={11} strokeWidth={1.9} />
          </span>
        </span>
        <span class="sp-q-text" dir="auto">
          {q.msg.text}
        </span>
      </button>
      <button class={`sp-check ${isDone ? 'is-on' : ''}`} onClick={onDone} aria-pressed={isDone} title={isDone ? 'Mark as open' : 'Mark as answered'}>
        <Icon name="check" size={12} strokeWidth={2.2} />
      </button>
    </article>
  );
}
