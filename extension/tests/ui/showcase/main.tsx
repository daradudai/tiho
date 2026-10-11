// Showcase router: ?view=chat|popup|sidepanel|onboarding|overview & theme=dark|light
import { render } from 'preact';
import '../../../src/ui/tokens.css';
import '../../../src/ui/kit/kit.css';
import './backdrops.css';
import './showcase.css';
import { makeStore, runLive } from './fake';
import { installChrome } from './mock-chrome';
import { ChatBackdrop } from './backdrops';
import type { Store } from '../../../src/core/store';
import type { Category, ModelStatus } from '../../../src/core/types';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'overview';
const theme = (q.get('theme') as 'dark' | 'light') ?? 'dark';
const platform = (q.get('platform') as 'twitch' | 'youtube' | 'kick') ?? 'twitch';
const live = q.has('live');
const app = document.getElementById('app')!;
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.view = view;

const MODEL: Record<string, ModelStatus> = {
  ready: { state: 'ready', backend: 'webgpu', modelId: 'tiho-lite/q8', version: 'v2-6L' },
  wasm: { state: 'ready', backend: 'wasm', modelId: 'tiho-lite/uint8', version: 'v2-3L' },
  downloading: { state: 'downloading', backend: 'none', progress: 0.42, modelId: 'tiho-lite/q8' },
  loading: { state: 'loading', backend: 'webgpu' },
  error: { state: 'error', backend: 'none', error: 'WebGPU adapter lost; falling back' },
};

/**
 * The UI mode and the tab's views: mode=basic|advanced (default basic), peek,
 * solo=<category> (Advanced only, as in the runtime); off, siteoff.
 */
function applyParams(store: Store) {
  const s = store.settings.value;
  store.settings.value = {
    ...s,
    uiMode: q.get('mode') === 'advanced' ? 'advanced' : 'basic',
    enabled: !q.has('off'),
    sites: q.has('siteoff') ? { ...s.sites, [platform]: false } : s.sites,
  };
  const on = !q.has('off') && !q.has('siteoff');
  store.peek.value = on && q.has('peek') && !q.get('solo');
  store.solo.value = on && q.get('mode') === 'advanced' ? ((q.get('solo') as Category | null) ?? null) : null;
}

async function main() {
  const modelKey = q.get('model') ?? 'ready';
  if (view === 'chat') {
    const store = makeStore(platform, theme, (q.get('preset') as any) ?? 'chill');
    store.model.value = MODEL[modelKey] ?? MODEL.ready;
    applyParams(store);
    if (q.has('empty')) {
      store.questions.value = [];
      store.waves.value = [];
    }
    if (live) runLive(store, Number(q.get('mps') ?? 90));
    const w = Number(q.get('w') ?? (platform === 'youtube' ? 400 : 340));
    (window as any).__store = store;
    render(
      <div class="sc-stage" style={{ width: `${w}px` }}>
        <ChatBackdrop platform={platform} theme={theme} store={store} live={live} />
      </div>,
      app,
    );
    return;
  }

  if (view === 'popup' || view === 'sidepanel' || view === 'onboarding') {
    const store = q.has('nochat') ? null : makeStore(platform, theme, (q.get('preset') as any) ?? 'chill');
    if (store) {
      store.model.value = MODEL[modelKey] ?? MODEL.ready;
      applyParams(store);
    }
    installChrome({
      store,
      url: q.has('nochat') ? 'https://github.com/' : platform === 'youtube' ? 'https://www.youtube.com/watch?v=jfKfPfyJRdk' : platform === 'kick' ? 'https://kick.com/trainwreckstv' : 'https://www.twitch.tv/xqc',
      model: MODEL[modelKey] ?? MODEL.ready,
      engine: q.has('engine'),
      downloading: q.has('downloading'),
    });
    if (store && live) runLive(store, 90);
    if (view === 'popup') {
      const { PopupApp } = await import('../../../src/ui/popup/PopupApp');
      render(
        <div class="sc-popup">
          <PopupApp />
        </div>,
        app,
      );
    } else if (view === 'sidepanel') {
      const { SidePanelApp } = await import('../../../src/ui/sidepanel/SidePanelApp');
      render(
        <div class="sc-sidepanel" style={{ width: `${q.get('w') ?? 400}px` }}>
          <SidePanelApp initialTab={(q.get('tab') as any) ?? 'live'} />
        </div>,
        app,
      );
    } else {
      const { OnboardingApp } = await import('../../../src/ui/onboarding/OnboardingApp');
      render(<OnboardingApp />, app);
    }
    return;
  }

  // Overview: every surface in iframes.
  const frames: { title: string; src: string; w: number; h: number }[] = [];
  for (const t of ['dark', 'light'])
    for (const p of ['twitch', 'youtube', 'kick'])
      frames.push({ title: `${p} · ${t}`, src: `?view=chat&platform=${p}&theme=${t}&live`, w: p === 'youtube' ? 400 : 340, h: 640 });
  for (const t of ['dark', 'light']) {
    frames.push({ title: `popup · ${t}`, src: `?view=popup&theme=${t}`, w: 360, h: 600 });
    frames.push({ title: `side panel · ${t}`, src: `?view=sidepanel&theme=${t}&live`, w: 400, h: 820 });
  }
  frames.push({ title: 'onboarding · dark', src: '?view=onboarding&theme=dark&downloading', w: 1200, h: 900 });
  frames.push({ title: 'onboarding · light', src: '?view=onboarding&theme=light&downloading', w: 1200, h: 900 });
  render(
    <div class="sc-overview">
      <h1>Tiho — UI showcase</h1>
      <p>Real components, fake data. Click chips, presets and the mark; everything is live.</p>
      <div class="sc-grid">
        {frames.map((f) => (
          <figure>
            <figcaption>
              <a href={f.src}>{f.title}</a>
            </figcaption>
            <iframe src={f.src} width={f.w} height={f.h} loading="lazy" />
          </figure>
        ))}
      </div>
    </div>,
    app,
  );
}

void main();
