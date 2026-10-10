// Mock chat columns (Twitch / YouTube / Kick skins) that host the real bar and
// the real row stylesheet. Dev-only: approximations of each site's chat, with
// the row structure the adapters see on the live sites (Twitch: row > div >
// .chat-line__message; YouTube: a flex renderer row; Kick: positioned rows of
// a virtual list), so decorations are checked against the real box shapes.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Store } from '../../../src/core/store';
import type { Action } from '../../../src/core/types';
import { mountBar } from '../../../src/ui/bar';
import { buildCss } from '../../../src/runtime/styles';
import { CHAT, fakeActions, rnd, type FakeMsg } from './fake';

type Platform = 'twitch' | 'youtube' | 'kick';

function useDecorations(platform: Platform, theme: 'dark' | 'light', decorate = true) {
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'hush-deco';
    // Exactly what ships: the runtime's row stylesheet (decorations included).
    el.textContent = buildCss({ platform, decorate, theme });
    document.head.appendChild(el);
    return () => el.remove();
  }, [platform, theme, decorate]);
}

interface Row extends FakeMsg {
  key: string;
  peek?: boolean;
}

const EXTRA: FakeMsg[] = [
  { author: 'spamton', color: '#daa520', text: 'BUY BUY BUY BUY BUY BUY BUY BUY BUY', c: 'spam', r: 'repeat ×9' },
];

function initialRows(): Row[] {
  const rows: Row[] = [];
  CHAT.forEach((m, i) => {
    rows.push({ ...m, key: `m${i}` });
    if (m.c === 'spam') rows.push({ ...EXTRA[0], key: `x${i}` });
  });
  return rows;
}

export function ChatBackdrop({ platform, theme, store, live }: { platform: Platform; theme: 'dark' | 'light'; store: Store; live?: boolean }) {
  useDecorations(platform, theme, store.settings.value.decorate);
  const listRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const actions = store.settings.value.actions;
  const enabled = store.settings.value.enabled;

  useEffect(() => {
    const el = listRef.current!;
    const reveal = (key: string) =>
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, peek: true } : r)));
    // open: shoot.mjs and perf.mjs reach into the bar (Playwright cannot pierce a closed root)
    const dispose = mountBar({ el, where: 'before' }, store, fakeActions(store, reveal), { shadow: 'open' });
    return dispose;
  }, [store]);

  useEffect(() => {
    if (!live) return;
    let i = 0;
    const id = setInterval(() => {
      const m = CHAT[Math.floor(rnd() * CHAT.length)];
      setRows((rs) => [...rs.slice(-80), { ...m, key: `l${++i}` }]);
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, 160);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Clicking a pill reveals its whole run (what the runtime does).
  const onClick = (e: MouseEvent) => {
    const row = (e.target as Element).closest('[data-hush-run]') as HTMLElement | null;
    if (!row) return;
    const keys: string[] = [];
    for (let n: Element | null = row; n && n.matches('[data-hush-a="collapse"],[data-hush-a="hide"]'); n = n.previousElementSibling)
      keys.push((n as HTMLElement).dataset.key!);
    setRows((rs) => rs.map((r) => (keys.includes(r.key) && act(r) === 'collapse' ? { ...r, peek: true } : r)));
  };

  const act = (r: Row): Action => (!enabled ? 'show' : (r.a ?? actions[r.c]));
  const runs = runMarks(rows, act);

  return (
    <div class={`bd bd-${platform}`} data-theme={theme}>
      <Header platform={platform} />
      <div class="bd-list" ref={listRef} onClick={onClick}>
        {rows.map((r) => (
          <div
            key={r.key}
            data-key={r.key}
            class="bd-row"
            data-hush-c={r.c}
            data-hush-a={act(r)}
            data-hush-r={r.r}
            data-hush-wh={r.w ? String(r.w) : undefined}
            data-hush-run={runs.get(r.key)}
            data-hush-open={r.peek ? '' : undefined}
          >
            <RowBody platform={platform} m={r} />
          </div>
        ))}
      </div>
      <Composer platform={platform} />
    </div>
  );
}

/** The runtime's pill-run marks: the last collapsed row of each run → run length (hidden rows take no space). */
function runMarks(rows: Row[], act: (r: Row) => Action): Map<string, string> {
  const marks = new Map<string, string>();
  let n = 0;
  let last = '';
  for (const r of rows) {
    const a = r.peek ? 'show' : act(r);
    if (a === 'hide') continue;
    if (a === 'collapse') {
      n++;
      last = r.key;
      continue;
    }
    if (n) marks.set(last, String(n));
    n = 0;
  }
  if (n) marks.set(last, String(n));
  return marks;
}

function Header({ platform }: { platform: Platform }) {
  if (platform === 'youtube')
    return (
      <div class="bd-head">
        <span class="yt-title">
          Top chat <span class="yt-caret">▾</span>
        </span>
        <span class="bd-dots">⋮</span>
      </div>
    );
  if (platform === 'kick')
    return (
      <div class="bd-head">
        <span class="kk-ico">⇤</span>
        <span class="kk-title">Chat</span>
        <span class="kk-ico">⚙</span>
      </div>
    );
  return (
    <div class="bd-head">
      <span class="tw-ico">⇥</span>
      <span class="tw-title">Stream chat</span>
      <span class="tw-ico">👥</span>
    </div>
  );
}

function RowBody({ platform, m }: { platform: Platform; m: FakeMsg }) {
  if (platform === 'youtube')
    return (
      <>
        <span class="yt-av" style={{ background: m.color }}>
          {m.author[0].toUpperCase()}
        </span>
        <span class="yt-content">
          <span class="yt-author" data-mod={m.badges?.includes('mod') ? '' : undefined}>
            {m.author}
          </span>
          <span class="yt-msg">{m.text}</span>
        </span>
        <span class="yt-menu">⋮</span>
      </>
    );
  const line = (
    <span class="tw-line">
      {m.badges?.includes('mod') && <span class="tw-badge">⚔</span>}
      <span class="tw-user" style={{ color: m.color }}>
        {m.author}
      </span>
      <span class="tw-colon">: </span>
      <span class="tw-text">{m.text}</span>
    </span>
  );
  if (platform === 'kick')
    return (
      <div class="kk-group">
        <div class="kk-msg">{line}</div>
      </div>
    );
  return (
    <div>
      <div class="tw-msg">{line}</div>
    </div>
  );
}

function Composer({ platform }: { platform: Platform }) {
  return (
    <div class="bd-composer">
      <div class="bd-input">{platform === 'youtube' ? 'Chat…' : platform === 'kick' ? 'Send a message' : 'Send a message'}</div>
      <div class="bd-send">{platform === 'youtube' ? '➤' : 'Chat'}</div>
    </div>
  );
}
