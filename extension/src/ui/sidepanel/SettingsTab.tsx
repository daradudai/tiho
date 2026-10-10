import { DEFAULT_SETTINGS } from '../../core/settings';
import type { Platform } from '../../core/types';
import { Mark } from '../brand';
import { Icon, PlatformGlyph } from '../icons';
import { Button, Card, Row, Slider, Toggle, modelStatus, settings, updateSettings } from '../kit/kit';
import { BACKEND_LABEL, modelSummary, prettyModel } from '../model-status';
import { strictWord } from '../format';

const SITES: { id: Platform; name: string }[] = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'twitch', name: 'Twitch' },
  { id: 'kick', name: 'Kick' },
];

export function SettingsTab() {
  const s = settings.value;
  const set = updateSettings;
  return (
    <div class="sp-stack">
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
        <Row icon={<Mark size={15} />} title="Bar above chat" desc="Live counters, presets and quick stats inside the chat">
          <Toggle checked={s.showBar} label="Bar above chat" onChange={(v) => set({ showBar: v })} />
        </Row>
        <Row icon={<Icon name="highlight" size={14} fill />} title="Message decorations" desc="Category tint, question glow, reason on hover">
          <Toggle checked={s.decorate} label="Message decorations" onChange={(v) => set({ decorate: v })} />
        </Row>
        <Row icon={<Icon name="zap" size={14} />} title="Use the GPU" desc="WebGPU when available, otherwise CPU">
          <Toggle checked={s.preferGpu} label="Use the GPU" onChange={(v) => set({ preferGpu: v })} />
        </Row>
      </Card>

      <ModelCard />

      <div class="sp-foot-actions">
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => set({ ...DEFAULT_SETTINGS, rules: s.rules, engine: s.engine })}>
          Reset filters to defaults
        </Button>
        <a class="sp-gh" href="https://github.com/" target="_blank" rel="noreferrer">
          <Icon name="github" size={13} /> Open source
        </a>
      </div>
    </div>
  );
}

function ModelCard() {
  const m = modelStatus.value;
  const sum = m ? modelSummary(m) : null;
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
          <p>{m?.modelId ?? 'hush-lite · mmBERT-small, fine-tuned for live chat'}</p>
        </div>
        {sum && <span class={`sp-tone sp-tone-${sum.tone}`}>{m!.state === 'ready' ? BACKEND_LABEL[m!.backend] ?? m!.backend : sum.title}</span>}
      </div>
      {m?.state === 'downloading' && (
        <div class="sp-model-prog">
          <span style={{ width: `${Math.round((m.progress ?? 0) * 100)}%` }} />
        </div>
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
          <dt>Size</dt>
          <dd>≈ 140 M parameters · one-time download, cached</dd>
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
