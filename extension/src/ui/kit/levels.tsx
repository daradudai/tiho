// Basic mode on extension pages (popup, side panel): the level picker (Off ·
// Clean · Quiet), the notes about a setup that Basic cannot show, the
// Advanced mode switch and the model in plain words. The bar says the same
// sentences (tokens.ts PLAIN), and none of them has a number.

import { useState } from 'preact/hooks';
import { advancedExtras, levelPatch, type BasicLevel, type Settings } from '../../core/settings';
import type { ModelStatus, Platform } from '../../core/types';
import { WAVE_CALM, WAVE_FLAT, WAVE_TURBULENT } from '../brand';
import { Icon } from '../icons';
import { plainModelStatus, retryModel } from '../model-status';
import { LEVEL_META, LEVEL_ORDER, PLAIN } from '../tokens';
import { Badge, Toggle, settings, updateSettings } from './kit';

/** Pick a level: one save, and on the site the viewer is looking at too (see levelPatch). */
export function pickLevel(level: BasicLevel, platform?: Platform | null): Promise<void> {
  return updateSettings(levelPatch(settings.value, level, platform ?? undefined));
}

/** A wave between two of the mark's (they share one command list, so their numbers pair up). */
function mixWave(a: string, b: string, t: number): string {
  const nb = b.match(/-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  return a.replace(/-?\d+(?:\.\d+)?/g, (x) => String(Math.round((Number(x) + (Number(nb[i++]) - Number(x)) * t) * 100) / 100));
}

/** Each level as the mark's wave: chat at full volume, calm, calmer. */
const LEVEL_WAVE: Record<BasicLevel, string> = { off: WAVE_TURBULENT, chill: WAVE_CALM, focus: mixWave(WAVE_CALM, WAVE_FLAT, 0.62) };

export function LevelGlyph({ level, size = 28 }: { level: BasicLevel; size?: number }) {
  return (
    <svg class="k-level-glyph" width={size} height={Math.round((size * 13) / 17)} viewBox="7.5 7.5 17 13" fill="none" aria-hidden="true">
      <path d={LEVEL_WAVE[level]} stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/**
 * The three levels as a radio group. 'cards' (popup): three tiles in a row,
 * the description of the chosen (or hovered) one below. 'list' (side panel):
 * one row each, with its description. `value` null: a custom setup, nothing
 * is chosen.
 */
export function LevelPicker({
  value,
  onPick,
  layout = 'cards',
}: {
  value: BasicLevel | null;
  onPick: (level: BasicLevel) => void;
  layout?: 'cards' | 'list';
}) {
  const [hover, setHover] = useState<BasicLevel | null>(null);
  const shown = hover ?? value;
  return (
    <div class={`k-levels k-levels-${layout}`}>
      <div class="k-levels-group" role="radiogroup" aria-label={PLAIN.levelQuestion} onPointerLeave={() => setHover(null)}>
        {LEVEL_ORDER.map((l) => {
          const meta = LEVEL_META[l];
          return (
            <button
              type="button"
              role="radio"
              aria-checked={value === l}
              class="k-level"
              data-level={l}
              onPointerEnter={() => setHover(l)}
              onFocus={() => setHover(l)}
              onBlur={() => setHover(null)}
              onClick={() => onPick(l)}
            >
              <span class="k-level-ico">
                <LevelGlyph level={l} />
              </span>
              {layout === 'list' ? (
                <>
                  <span class="k-level-text">
                    <b>
                      {meta.label}
                      {meta.recommended && <Badge tone="accent">Recommended</Badge>}
                    </b>
                    <span class="k-level-desc">{meta.desc}</span>
                  </span>
                  <span class="k-level-radio" aria-hidden="true" />
                </>
              ) : (
                <b>{meta.label}</b>
              )}
            </button>
          );
        })}
      </div>
      {layout === 'cards' && shown && (
        <p class="k-levels-desc" aria-live="polite">
          {LEVEL_META[shown].desc}
        </p>
      )}
    </div>
  );
}

/**
 * What Basic cannot show: a custom setup from Advanced mode (no level is
 * chosen) and the Advanced settings that still apply ("Also on from Advanced
 * mode: your rules.").
 */
export function LevelNotes({ s, level }: { s: Settings; level: BasicLevel | null }) {
  const extras = advancedExtras(s);
  const custom = level === null ? PLAIN.custom : level === 'off' && s.preset !== 'chill' && s.preset !== 'focus' ? PLAIN.customOff : null;
  if (!custom && !extras.length) return null;
  return (
    <div class="k-level-notes">
      {custom && (
        <p class="k-level-note" data-kind="custom">
          <Icon name="info" size={13} />
          <span>{custom}</span>
        </p>
      )}
      {extras.length > 0 && (
        <p class="k-level-note">
          <Icon name="sliders" size={13} />
          <span>{PLAIN.extras(extras)}</span>
        </p>
      )}
    </div>
  );
}

/** The Advanced mode switch: saved at once, all tabs; filtering stays the same. */
export function ModeSwitch({ hint }: { hint?: string }) {
  const on = settings.value.uiMode === 'advanced';
  return (
    <div class="k-modeswitch">
      <div class="k-modeswitch-text">
        <b>{PLAIN.advanced}</b>
        {hint && <span>{hint}</span>}
      </div>
      <Toggle checked={on} label={PLAIN.advanced} onChange={(v) => updateSettings({ uiMode: v ? 'advanced' : 'basic' })} />
    </div>
  );
}

/** The model in plain words while it is not ready: a thin bar while it gets ready, Retry when it failed. */
export function ModelNotice({ m }: { m: ModelStatus | null | undefined }) {
  const p = plainModelStatus(m);
  if (!p) return null;
  return (
    <div class="k-notice" data-tone={p.tone} role="status">
      {p.tone === 'err' && <span class="k-notice-dot" aria-hidden="true" />}
      <span class="k-notice-text">{p.text}</span>
      {p.tone === 'err' ? (
        <button type="button" class="k-notice-btn" onClick={retryModel}>
          Retry
        </button>
      ) : (
        <span class="k-notice-bar" data-busy={p.progress == null ? '' : undefined} aria-hidden="true">
          <i style={p.progress == null ? undefined : { transform: `scaleX(${Math.max(0.04, Math.min(1, p.progress))})` }} />
        </span>
      )}
    </div>
  );
}

/** "Runs on your computer. Nothing leaves it." */
export function PrivacyLine({ class: cls }: { class?: string }) {
  return (
    <p class={`k-privacy ${cls ?? ''}`}>
      <Icon name="lock" size={11} strokeWidth={1.8} />
      {PLAIN.privacy}
    </p>
  );
}

/** Where Show hidden is, for a page that cannot press it itself. */
export function PeekHint() {
  return (
    <p class="k-peekhint">
      <Icon name="show" size={14} />
      <span>To see what Hush hid, press "Show hidden" above the chat.</span>
    </p>
  );
}
