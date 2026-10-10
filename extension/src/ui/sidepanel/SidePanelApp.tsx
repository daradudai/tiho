// Side panel dashboard: Live · Inbox · Log · Rules · Settings.

import { useEffect, useState } from 'preact/hooks';
import { Mark } from '../brand';
import { Icon, PlatformGlyph, type IconName } from '../icons';
import { Toggle, initModelStatus, initSettings, initTheme, settings, updateSettings } from '../kit/kit';
import { LiveTab } from './LiveTab';
import { InboxTab } from './InboxTab';
import { LogTab } from './LogTab';
import { RulesTab } from './RulesTab';
import { SettingsTab } from './SettingsTab';
import { activeTab, done, live, questions, startLive } from './state';
import './sidepanel.css';

export type TabId = 'live' | 'inbox' | 'log' | 'rules' | 'settings';

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'live', label: 'Live', icon: 'activity' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'log', label: 'Log', icon: 'list' },
  { id: 'rules', label: 'Rules', icon: 'sliders' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

const SITE: Record<string, string> = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };

export function SidePanelApp({ initialTab = 'live' }: { initialTab?: TabId }) {
  const [tab, setTab] = useState<TabId>(() => {
    try {
      return (sessionStorage.getItem('hush.sp.tab') as TabId) || initialTab;
    } catch {
      return initialTab;
    }
  });
  useEffect(() => {
    initTheme();
    initSettings();
    initModelStatus(2000);
    startLive();
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem('hush.sp.tab', tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  const s = settings.value;
  const snap = live.value;
  const t = activeTab.value;
  const unanswered = questions.value.filter((q) => !done.value.has(q.msg.key)).length;
  const idx = TABS.findIndex((x) => x.id === tab);

  return (
    <div class="sp" data-off={s.enabled ? undefined : ''}>
      <header class="sp-head">
        <div class="sp-top">
          <div class="sp-brand">
            <Mark size={22} />
            <span class="sp-name">Hush</span>
          </div>
          <div class="sp-where">
            {snap ? (
              <>
                <PlatformGlyph platform={snap.platform} size={14} />
                <span class="sp-chan">{snap.channel || SITE[snap.platform]}</span>
                <span class="sp-live">Live</span>
              </>
            ) : t?.platform ? (
              <>
                <PlatformGlyph platform={t.platform} size={14} />
                <span class="sp-chan sp-chan-dim">Waiting for chat…</span>
              </>
            ) : (
              <span class="sp-chan sp-chan-dim">No stream open</span>
            )}
          </div>
          <Toggle size="sm" checked={s.enabled} label="Hush on/off" onChange={(v) => updateSettings({ enabled: v })} />
        </div>
        <nav class="sp-tabs" role="tablist" style={{ '--i': idx, '--n': TABS.length } as any}>
          {TABS.map((x) => (
            <button role="tab" aria-selected={tab === x.id} class="sp-tab" onClick={() => setTab(x.id)}>
              <Icon name={x.icon} size={14} strokeWidth={1.7} />
              <span>{x.label}</span>
              {x.id === 'inbox' && unanswered > 0 && <em class="sp-count">{unanswered > 99 ? '99+' : unanswered}</em>}
            </button>
          ))}
          <span class="sp-tab-ink" aria-hidden="true" />
        </nav>
      </header>
      <main class="sp-main" key={tab}>
        {tab === 'live' && <LiveTab />}
        {tab === 'inbox' && <InboxTab />}
        {tab === 'log' && <LogTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
}

/** Shown in live tabs when no chat is connected. */
export function NoChat() {
  const t = activeTab.value;
  return (
    <div class="sp-nochat">
      <div class="sp-nochat-mark">
        <Mark size={40} />
      </div>
      <h2>{t?.platform ? 'Waiting for chat' : 'Open a live stream'}</h2>
      <p>
        {t?.platform
          ? `Hush connects as soon as ${SITE[t.platform]} chat appears on this page.`
          : 'Live stats, questions and the filtered log show up here while you watch a stream.'}
      </p>
      {!t?.platform && (
        <div class="sp-nochat-sites">
          {(['youtube', 'twitch', 'kick'] as const).map((p) => (
            <span class="sp-site-pill">
              <PlatformGlyph platform={p} size={13} />
              {SITE[p]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
