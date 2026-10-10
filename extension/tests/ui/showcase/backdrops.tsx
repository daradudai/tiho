// Mock chat columns (Twitch / YouTube / Kick skins) that host the real bar and
// the real decoration stylesheet. Dev-only: approximations of each site's chat.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Store } from '../../../src/core/store';
import type { Action } from '../../../src/core/types';
import { mountBar } from '../../../src/ui/bar';
import { decorationCss } from '../../../src/ui/decorations';
import { buildCss } from '../../../src/runtime/styles';
import { CHAT, fakeActions, rnd, type FakeMsg } from './fake';

type Platform = 'twitch' | 'youtube' | 'kick';

function useDecorations(platform: Platform, theme: 'dark' | 'light', decorate = true) {
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'hush-deco';
    // Exactly what ships: the runtime's base sheet + the UI theme layer on top.
    const rowSelector = '.bd-row';
    el.textContent = buildCss({ rowSelector, decorate, theme }) + decorationCss(platform, theme, { decorate, rowSelector });
    document.head.appendChild(el);
    return () => el.remove();
  }, [platform, theme, decorate]);
}

interface Row extends FakeMsg {
  key: string;
  peek?: boolean;
}

const EXTRA: FakeMsg[] = [
  { author: 'spamton', color: '#daa520', text: 'BUY BUY BUY BUY BUY BUY BUY BUY BUY', c: 'spam', r: 'spam · flood' },
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
    const dispose = mountBar({ el, where: 'before' }, store, fakeActions(store, reveal));
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

  // Clicking a collapsed pill reveals the whole run (what the runtime does).
  const onClick = (e: MouseEvent) => {
    const row = (e.target as Element).closest('[data-hush-a="collapse"]') as HTMLElement | null;
    if (!row) return;
    const keys: string[] = [];
    let n: Element | null = row;
    while (n && n.getAttribute('data-hush-a') === 'collapse') {
      keys.push((n as HTMLElement).dataset.key!);
      n = n.previousElementSibling;
    }
    setRows((rs) => rs.map((r) => (keys.includes(r.key) ? { ...r, peek: true } : r)));
  };

  const act = (r: Row): Action => (!enabled ? 'show' : (r.a ?? actions[r.c]));

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
      </>
    );
  return (
    <span class="tw-line">
      {m.badges?.includes('mod') && <span class="tw-badge">⚔</span>}
      <span class="tw-user" style={{ color: m.color }}>
        {m.author}
      </span>
      <span class="tw-colon">: </span>
      <span class="tw-text">{m.text}</span>
    </span>
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
