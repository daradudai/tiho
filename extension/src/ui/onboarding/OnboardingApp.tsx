// Onboarding (opened once on install): hero with live demo, three steps
// (what Hush does · pick your vibe · model download), privacy, sites, tips.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PRESETS, type PresetId } from '../../core/settings';
import type { Action, Category } from '../../core/types';
import { BUBBLE_PATH, WAVE_CALM, WAVE_EXCITED, WAVE_FLAT, WAVE_TURBULENT } from '../brand';
import { decorationCss, pillRuns } from '../decorations';
import { pct } from '../format';
import { Icon, PlatformGlyph, type IconName } from '../icons';
import { Kbd, initModelStatus, initSettings, initTheme, modelStatus, settings, updateSettings } from '../kit/kit';
import { BACKEND_LABEL, modelLayers, modelProblem } from '../model-status';
import { CATEGORY_META, CHIP_CATEGORIES, PRESET_META, PRESET_ORDER } from '../tokens';
import './onboarding.css';

export function OnboardingApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    initTheme();
    initSettings();
    initModelStatus(1000);
    const read = () => setTheme((document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  return (
    <div class="ob">
      <div class="ob-glow" aria-hidden="true" />
      <header class="ob-nav">
        <span class="ob-logo">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="ob-nav-g" x1="4" y1="3" x2="29" y2="27" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#7c83ff" />
                <stop offset="0.55" stop-color="#a78bfa" />
                <stop offset="1" stop-color="#5ab2ff" />
              </linearGradient>
            </defs>
            <path d={BUBBLE_PATH} fill="url(#ob-nav-g)" />
            <path d={WAVE_CALM} stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Hush
        </span>
        <span class="ob-nav-note">
          <Icon name="lock" size={12} strokeWidth={1.8} /> Private by design · free & open source
        </span>
      </header>

      <section class="ob-hero">
        <div class="ob-hero-text">
          <HeroMark />
          <p class="ob-eyebrow">Welcome to Hush</p>
          <h1>
            Live chat,
            <br />
            <span class="ob-grad">minus the noise.</span>
          </h1>
          <p class="ob-lead">
            Hush is an ad-blocker for live chat. It quietly folds away toxicity, scams and spam on YouTube, Twitch and Kick, and lifts real questions to the
            top — with a small AI model that runs entirely on your device, in any language.
          </p>
          <div class="ob-hero-meta">
            <span>
              <Icon name="cpu" size={13} /> On-device AI
            </span>
            <span>
              <Icon name="globe" size={13} /> 1800+ languages
            </span>
            <span>
              <Icon name="zap" size={13} /> 100+ msgs/s, no lag
            </span>
          </div>
        </div>
        <ChatDemo theme={theme} />
      </section>

      <section class="ob-steps">
        <Step n={1} title="What Hush does" sub="Three quiet jobs, every message, in a couple of milliseconds.">
          <div class="ob-features">
            <Feature icon="shield" title="Hides the ugly" tone="toxic">
              Insults, scam links, bots and copypasta floods are hidden or folded into a thin <i>“3 hidden · show”</i> line. One click brings them back.
            </Feature>
            <Feature icon="question" title="Surfaces questions" tone="question">
              Real questions glow softly and gather in your inbox, so the one person asking something never drowns in the KEKWs.
            </Feature>
            <Feature icon="activity" title="Reads the room" tone="positive">
              A calm meter, the chat’s vibe and live waves (“KEKW ×37”) sit in a slim bar above chat. Nothing more.
            </Feature>
          </div>
        </Step>

        <Step n={2} title="Pick your vibe" sub="You can switch any time from the bar above chat or the toolbar.">
          <PresetPicker />
        </Step>

        <Step n={3} title="Get the model" sub="Release builds include it; otherwise it downloads once. After that Hush works offline.">
          <ModelStep />
        </Step>
      </section>

      <section class="ob-cards">
        <div class="ob-card ob-privacy">
          <span class="ob-card-ico">
            <Icon name="lock" size={16} />
          </span>
          <h3>Nothing leaves your machine</h3>
          <p>Every message is classified locally in your browser. No account, no analytics, no servers. The optional Hush Engine runs on your own GPU, too.</p>
        </div>
        <div class="ob-card">
          <span class="ob-card-ico">
            <Icon name="globe" size={16} />
          </span>
          <h3>Works on</h3>
          <div class="ob-sites">
            {(
              [
                ['youtube', 'YouTube', 'https://www.youtube.com/live'],
                ['twitch', 'Twitch', 'https://www.twitch.tv/directory'],
                ['kick', 'Kick', 'https://kick.com/browse'],
              ] as const
            ).map(([p, name, href]) => (
              <a class="ob-site" href={href} target="_blank" rel="noreferrer">
                <PlatformGlyph platform={p} size={18} />
                <span>{name}</span>
                <Icon name="arrowUpRight" size={12} />
              </a>
            ))}
          </div>
        </div>
        <Tips />
      </section>

      <footer class="ob-foot">
        <p>
          That’s it. Open any live stream — Hush is already listening. <span class="faint">Close this tab whenever you like.</span>
        </p>
      </footer>
    </div>
  );
}

/* ── hero mark: a turbulent wave settling into calm ──────────────── */

function HeroMark() {
  return (
    <div class="ob-mark" aria-hidden="true">
      <style>{`
        @keyframes ob-settle {
          0% { d: path("${WAVE_TURBULENT}"); }
          18% { d: path("${WAVE_EXCITED}"); }
          34% { d: path("${WAVE_TURBULENT}"); }
          58% { d: path("${WAVE_EXCITED}"); }
          100% { d: path("${WAVE_CALM}"); }
        }
        @keyframes ob-breathe {
          0%, 100% { d: path("${WAVE_CALM}"); }
          50% { d: path("${WAVE_FLAT}"); }
        }
      `}</style>
      <span class="ob-mark-halo" />
      <svg width="76" height="76" viewBox="0 0 32 32">
        <defs>
          <linearGradient id="ob-g" x1="4" y1="3" x2="29" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#7c83ff" />
            <stop offset="0.55" stop-color="#a78bfa" />
            <stop offset="1" stop-color="#5ab2ff" />
          </linearGradient>
          <linearGradient id="ob-shine" x1="16" y1="3.5" x2="16" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fff" stop-opacity=".25" />
            <stop offset=".55" stop-color="#fff" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={BUBBLE_PATH} fill="url(#ob-g)" />
        <path d={BUBBLE_PATH} fill="url(#ob-shine)" />
        <path class="ob-wave" d={WAVE_CALM} stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
  );
}

/* ── live demo: a tiny chat getting hushed ───────────────────────── */

interface DemoMsg {
  user: string;
  color: string;
  text: string;
  c: Category;
  r?: string;
}
const DEMO: DemoMsg[] = [
  { user: 'zoe_plays', color: '#9b8cff', text: 'first time catching the stream live!', c: 'positive', r: 'positive · 86%' },
  { user: 'marek_pl', color: '#e0a030', text: 'what rank is he right now', c: 'question', r: 'question · 90%' },
  { user: 'rook', color: '#6fa8dc', text: 'the music in this part is so good', c: 'positive', r: 'positive · 83%' },
  { user: 'lucky_luna', color: '#ffa07a', text: 'GG that was clean', c: 'positive', r: 'positive · 90%' },
  { user: 'hypetrain', color: '#ff69b4', text: 'LETSGOOO', c: 'noise', r: 'noise · 95%' },
  { user: 'grr_gamer', color: '#cd5c5c', text: 'ok this patch honestly ruined the game', c: 'negative', r: 'negative · 81%' },
  { user: 'crypto_kai', color: '#9acd32', text: '💰 100x signals in my bio 💰', c: 'scam', r: 'scam · 96%' },
  { user: 'devonk', color: '#5f9ea0', text: 'is the tournament on saturday or sunday?', c: 'question', r: 'question · 95%' },
  { user: 'ez_clap', color: '#ff4500', text: 'ez noob team diff', c: 'toxic', r: 'toxic · 71%' },
  { user: 'nightowl', color: '#ff7f50', text: 'that clutch was actually insane', c: 'positive', r: 'positive · 91%' },
  { user: 'tilted_tom', color: '#ff4500', text: 'you are so trash, uninstall', c: 'toxic', r: 'toxic · 94%' },
  { user: 'mira_lux', color: '#da70d6', text: 'what sensitivity do you play on?', c: 'question', r: 'question · 96%' },
  { user: 'free_skins', color: '#9acd32', text: 'FREE SKINS → csgo-drop .win/claim', c: 'scam', r: 'scam · 98%' },
  { user: 'ana_rs', color: '#00bfff', text: 'jajaja el último round 😂', c: 'positive', r: 'positive · 84%' },
  { user: 'spamton', color: '#daa520', text: 'POGGERS POGGERS POGGERS POGGERS POGGERS', c: 'spam', r: 'spam · 97%' },
  { user: 'Sven_DE', color: '#e05555', text: 'warum spielt er heute nicht ranked?', c: 'question', r: 'question · 92%' },
  { user: 'quietfox', color: '#2e8b57', text: 'chat is so calm today, love it', c: 'positive', r: 'positive · 88%' },
];

function ChatDemo({ theme }: { theme: 'dark' | 'light' }) {
  const [hushed, setHushed] = useState(false);
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = decorationCss('twitch', theme);
    document.head.appendChild(el);
    return () => el.remove();
  }, [theme]);
  // Flips by itself until the viewer touches the toggle; from then on their choice stays.
  const stopAuto = useRef(() => {});
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHushed(true);
      return;
    }
    const first = setTimeout(() => setHushed(true), 900);
    const id = setInterval(() => setHushed((h) => !h), 3600);
    stopAuto.current = () => {
      clearTimeout(first);
      clearInterval(id);
    };
    return () => stopAuto.current();
  }, []);
  const act = (m: DemoMsg): Action => (!hushed ? 'show' : (PRESETS.chill[m.c] as Action));
  const acts = DEMO.map(act);
  const runs = pillRuns(acts); // collapsed rows draw their "N hidden · show" pill only with a run mark
  return (
    <div class="ob-demo" data-theme={theme} data-hushed={hushed ? '' : undefined}>
      <div class="ob-demo-head">
        <span>Stream chat</span>
        <button
          type="button"
          class="ob-demo-toggle"
          aria-pressed={hushed}
          aria-label="With Hush"
          onFocus={() => stopAuto.current()}
          onClick={() => {
            stopAuto.current();
            setHushed(!hushed);
          }}
        >
          <span class={!hushed ? 'is-on' : ''}>Before</span>
          <span class={hushed ? 'is-on' : ''}>With Hush</span>
        </button>
      </div>
      <div class="ob-demo-bar">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
          <path d={BUBBLE_PATH} fill="url(#ob-g)" />
          <path d={WAVE_CALM} stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" />
        </svg>
        <span class="ob-demo-preset">Chill</span>
        {(['toxic', 'scam', 'spam', 'question'] as Category[]).map((c) => (
          <span class="ob-demo-chip" data-c={c} data-a={hushed ? PRESETS.chill[c] : 'show'}>
            <Icon name={c} size={12} fill />
          </span>
        ))}
        <span class="ob-demo-calm">{hushed ? '38% hushed' : 'unfiltered'}</span>
      </div>
      <div class="ob-demo-list">
        {DEMO.map((m, i) => (
          <div class="ob-demo-row" data-hush-c={m.c} data-hush-a={acts[i]} data-hush-r={m.r} data-hush-run={runs[i]}>
            <span>
              <b style={{ color: m.color }}>{m.user}</b>: {m.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── steps ───────────────────────────────────────────────────────── */

function Step({ n, title, sub, children }: { n: number; title: string; sub: string; children: ComponentChildren }) {
  return (
    <div class="ob-step">
      <div class="ob-step-rail">
        <span class="ob-step-n">{n}</span>
      </div>
      <div class="ob-step-body">
        <h2>{title}</h2>
        <p class="ob-step-sub">{sub}</p>
        <div class="ob-step-content">{children}</div>
      </div>
    </div>
  );
}

function Feature({ icon, title, tone, children }: { icon: IconName; title: string; tone: Category; children: ComponentChildren }) {
  return (
    <div class="ob-feature" data-c={tone}>
      <span class="ob-feature-ico">
        <Icon name={icon} size={16} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function PresetPicker() {
  const cur = settings.value.preset;
  const pick = (p: Exclude<PresetId, 'custom'>) => updateSettings({ preset: p, actions: { ...PRESETS[p] } });
  return (
    <div class="ob-presets" role="radiogroup" aria-label="Vibe preset">
      {PRESET_ORDER.map((p) => (
        <button role="radio" aria-checked={cur === p} class="ob-preset" onClick={() => pick(p)}>
          <span class="ob-preset-top">
            <b>{PRESET_META[p].label}</b>
            <span class="ob-radio" />
          </span>
          <span class="ob-preset-desc">{PRESET_META[p].desc}</span>
          <span class="ob-preset-cats">
            {CHIP_CATEGORIES.map((c) => (
              <span class="ob-pc" data-c={c} data-a={PRESETS[p][c]} title={`${CATEGORY_META[c].label}: ${PRESETS[p][c]}`}>
                <Icon name={c} size={11} fill />
              </span>
            ))}
          </span>
          {p === 'chill' && <span class="ob-rec">Recommended</span>}
        </button>
      ))}
    </div>
  );
}

function ModelStep() {
  const m = modelStatus.value;
  const state = m?.state ?? 'idle';
  const p = state === 'ready' ? 1 : (m?.progress ?? 0);
  const title =
    state === 'ready'
      ? `Ready — running on ${BACKEND_LABEL[m!.backend] ?? m!.backend}`
      : state === 'downloading'
        ? `Downloading Hush Lite · ${pct(p)}`
        : state === 'loading'
          ? 'Warming up…'
          : state === 'error'
            ? 'Could not load the model'
            : 'Starts when you open a stream';
  const layers = modelLayers(m);
  const sub =
    state === 'ready'
      ? `${layers ? `${layers}-layer model, picked for ${m!.backend === 'webgpu' ? 'your GPU' : 'your CPU'}. ` : ''}Stored on this device; Hush works offline.`
      : state === 'error'
        ? `${modelProblem(m?.error)}. Rules keep filtering chat meanwhile.`
        : 'About 125 MB if it has to be downloaded, once. Rules already filter meanwhile.';
  return (
    <div class="ob-model" data-state={state}>
      <div class="ob-model-ico">{state === 'ready' ? <Icon name="check" size={18} strokeWidth={2.2} /> : <Icon name="download" size={18} />}</div>
      <div class="ob-model-body">
        <div class="ob-model-top">
          <b>{title}</b>
          <span class="ob-model-pct">{state === 'downloading' ? pct(p) : state === 'ready' ? '100%' : ''}</span>
        </div>
        <div class="ob-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
          <span style={{ width: `${Math.max(2, p * 100)}%` }} />
        </div>
        <p>{sub}</p>
      </div>
    </div>
  );
}

function Tips() {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    chrome.commands
      ?.getAll?.()
      .then((cs) => {
        const c = cs.find((x) => x.shortcut && x.name !== '_execute_action') ?? cs.find((x) => x.shortcut);
        if (c?.shortcut) setShortcut(c.shortcut);
      })
      .catch(() => {});
  }, []);
  return (
    <div class="ob-card ob-tips">
      <span class="ob-card-ico">
        <Icon name="keyboard" size={16} />
      </span>
      <h3>Good to know</h3>
      <ul>
        <li>
          <Icon name="mouse" size={13} /> <span>Click a category chip to cycle <b>show → dim → fold → hide</b></span>
        </li>
        <li>
          <Icon name="more" size={13} /> <span>Right-click (or long-press) a chip for every option</span>
        </li>
        <li>
          <Icon name="info" size={13} /> <span>Hover a message to see why it was flagged</span>
        </li>
        {shortcut && (
          <li>
            <Icon name="keyboard" size={13} />
            <span>
              {shortcut.split('+').map((k, i) => (
                <>
                  {i > 0 && <span class="faint"> + </span>}
                  <Kbd>{k}</Kbd>
                </>
              ))}{' '}
              turns Hush on or off
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}
