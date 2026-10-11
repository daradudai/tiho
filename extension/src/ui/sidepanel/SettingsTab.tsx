import { DEFAULT_SETTINGS, type Settings } from '../../core/settings';
import type { Platform } from '../../core/types';
import { Mark } from '../brand';
import { Icon, PlatformGlyph } from '../icons';
import { Button, Card, Row, Segmented, Slider, Toggle, modelStatus, settings, updateSettings } from '../kit/kit';
import { BACKEND_LABEL, modelLayers, modelProblem, modelSummary, prettyModel, retryModel } from '../model-status';
import { strictWord } from '../format';
import { REPO_URL } from './filter-presets';

const SITES: { id: Platform; name: string }[] = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'twitch', name: 'Twitch' },
  { id: 'kick', name: 'Kick' },
];

/**
 * What "Reset filters to defaults" restores: how chat is filtered. Where
 * (sites), whether (on / off), how Hush looks (bar, decorations, GPU), rules
 * and the engine stay as they are.
 */
export function filterDefaults(): Partial<Settings> {
  const d = DEFAULT_SETTINGS;
  return {
    preset: d.preset,
    actions: { ...d.actions },
    strictness: d.strictness,
    collapseWaves: d.collapseWaves,
    holdMs: d.holdMs,
    trustPrivileged: d.trustPrivileged,
  };
}

export function SettingsTab() {
  const s = settings.value;
  const set = updateSettings;
  return (
    <div class="sp-stack">
      <Card title="Mode">
        <Segmented
          label="Mode"
          value={s.uiMode}
          options={[
            { value: 'basic', label: 'Basic' },
            { value: 'advanced', label: 'Advanced' },
          ]}
          onChange={(m) => set({ uiMode: m })}
        />
        <p class="sp-field-hint">Advanced adds categories, rules, stats and custom AI filters. Made for streamers. Filtering is the same in both.</p>
      </Card>

      <Card title="Sites">
        {SITES.map((x) => (
          <Row icon={<PlatformGlyph platform={x.id} size={15} />} title={x.name} desc={s.sites[x.id] ? 'Filtering live chat' : 'Off'}>
            <Toggle checked={s.sites[x.id]} label={x.name} onChange={(v) => set({ sites: { ...s.sites, [x.id]: v } })} />
          </Row>
        ))}
      </Card>

      <Card title="Filtering">
        <div class="sp-field">
          <div class="sp-field-head">
            <span>Strictness</span>
            <b>{strictWord(s.strictness)}</b>
          </div>
          <Slider value={s.strictness} label="Strictness" left="Lenient" right="Strict" onChange={(v) => set({ strictness: v })} />
          <p class="sp-field-hint">Shifts every model threshold. Strict catches more, with more false alarms.</p>
        </div>
        <div class="sp-field">
          <div class="sp-field-head">
            <span>Hold new messages</span>
            <b>{s.holdMs === 0 ? 'Never' : `${s.holdMs} ms`}</b>
          </div>
          <Slider value={s.holdMs} min={0} max={600} step={25} label="Hold new messages" left="Instant" right="Cleaner" onChange={(v) => set({ holdMs: v })} />
          <p class="sp-field-hint">Waits briefly for the model so hidden messages never flash on screen.</p>
        </div>
        <Row icon={<Icon name="shield" size={14} />} title="Trust mods & VIPs" desc="Never filter the broadcaster, moderators or VIPs">
          <Toggle checked={s.trustPrivileged} label="Trust mods & VIPs" onChange={(v) => set({ trustPrivileged: v })} />
        </Row>
        <Row icon={<Icon name="wave" size={14} />} title="Fold waves" desc={'Many people, same message → one line with a counter ("KEKW ×37")'}>
          <Toggle checked={s.collapseWaves} label="Fold waves" onChange={(v) => set({ collapseWaves: v })} />
        </Row>
      </Card>

      <Card title="Appearance">
        <Row icon={<Mark size={15} />} title="Bar above chat" desc="The bar with levels and Show hidden (Basic) or presets and categories (Advanced)">
          <Toggle checked={s.showBar} label="Bar above chat" onChange={(v) => set({ showBar: v })} />
        </Row>
        <Row icon={<Icon name="highlight" size={14} fill />} title="Message decorations" desc="Category tint, question glow, reason on hover (Advanced mode)">
          <Toggle checked={s.decorate} label="Message decorations" onChange={(v) => set({ decorate: v })} />
        </Row>
        <Row icon={<Icon name="zap" size={14} />} title="Use the GPU" desc="WebGPU when available, otherwise CPU">
          <Toggle checked={s.preferGpu} label="Use the GPU" onChange={(v) => set({ preferGpu: v })} />
        </Row>
      </Card>

      <ModelCard />

      <div class="sp-foot-actions">
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => set(filterDefaults())}>
          Reset filters to defaults
        </Button>
        <a class="sp-gh" href={REPO_URL} target="_blank" rel="noreferrer">
          <Icon name="github" size={13} /> Open source
        </a>
      </div>
    </div>
  );
}

/** The two students of the shipped model folder (docs/MODEL_CARD.md), by layer count: parameters (M) and file size (MB). */
const STUDENTS: Record<number, { params: number; mb: number }> = { 6: { params: 110, mb: 113 }, 3: { params: 104, mb: 105 } };

function ModelCard() {
  const m = modelStatus.value;
  const sum = m ? modelSummary(m) : null;
  const layers = modelLayers(m);
  const student = layers ? STUDENTS[layers] : undefined;
  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    /* ignore */
  }
  return (
    <section class="sp-model">
      <div class="sp-model-head">
        <div class="sp-model-badge">
          <Mark size={26} />
        </div>
        <div>
          <h3>{prettyModel(m?.modelId)}</h3>
          <p>{m?.modelId ?? 'hush-lite · mmBERT-small, distilled for live chat'}</p>
        </div>
        {m?.state === 'error' ? (
          // what failed is in the box below
          <Button variant="subtle" size="sm" icon="refresh" onClick={retryModel}>
            Retry
          </Button>
        ) : (
          sum && <span class={`sp-tone sp-tone-${sum.tone}`}>{m!.state === 'ready' ? BACKEND_LABEL[m!.backend] ?? m!.backend : sum.title}</span>
        )}
      </div>
      {m?.state === 'downloading' && (
        <div class="sp-model-prog">
          <span style={{ width: `${Math.round((m.progress ?? 0) * 100)}%` }} />
        </div>
      )}
      {m?.state === 'error' && (
        <details class="sp-setup sp-model-err">
          <summary>
            <Icon name="info" size={13} /> {modelProblem(m.error)} · rules still filter chat
          </summary>
          {m.error && <code>{m.error}</code>}
        </details>
      )}
      <dl class="sp-model-grid">
        <div>
          <dt>Languages</dt>
          <dd>1800+ seen in pre-training · tuned on EN ES DE PT FR RU BG PL TR IT JA KO</dd>
        </div>
        <div>
          <dt>Detects</dt>
          <dd>Toxic · scam · spam · noise · questions · positive · negative</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            Adaptive: 6 layers on the GPU, 3 on the CPU, distilled from 22{layers ? ` · this device runs ${layers}` : ''}
          </dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>
            {student ? `≈ ${student.params} M parameters · ${student.mb} MB` : '≈ 104–110 M parameters · 105–113 MB'} + 14 MB tokenizer, bundled or
            downloaded once
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            {m?.version ?? '—'} · extension {version || '—'}
          </dd>
        </div>
      </dl>
      <div class="sp-privacy">
        <span class="sp-privacy-ico">
          <Icon name="lock" size={14} />
        </span>
        <div>
          <b>Nothing leaves your machine.</b>
          <span>Every message is classified right here in your browser. No accounts, no analytics, no cloud.</span>
        </div>
      </div>
    </section>
  );
}
