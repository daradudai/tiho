// Commands the in-chat bar (src/ui/bar) sends to the content-script runtime.
// The runtime implements this; the UI only calls it.

import type { Action, Category } from './types';
import { PRESETS, type PresetId, type Settings } from './settings';
import type { Store } from './store';

export interface BarActions {
  /** Apply a preset (also resets per-category actions to the preset's). */
  setPreset(preset: PresetId): void;
  /** Override one category's action (switches the preset to 'custom'). */
  setAction(category: Category, action: Action): void;
  /** Turn Hush on/off (global). */
  toggleEnabled(): void;
  /** Ask the background to open the side panel dashboard for this tab. */
  openSidePanel(): void;
  /** Scroll the chat to a message and un-hide it (e.g. from the questions list). */
  revealMessage(key: string): void;
}

/** Signature of `mountBar` exported by src/ui/bar (the runtime mounts it if present). */
export type MountBar = (
  anchor: { el: HTMLElement; where: 'before' | 'prepend' },
  store: Store,
  actions: BarActions,
) => void | (() => void);

export interface BarActionDeps {
  getSettings(): Settings;
  /** Persist a settings patch; the runtime picks it up via onSettingsChanged. */
  save(patch: Partial<Settings>): unknown;
  openSidePanel(): void;
  reveal(key: string): void;
}

/** Default BarActions implementation used by the content-script runtime. */
export function createBarActions(d: BarActionDeps): BarActions {
  return {
    setPreset(id) {
      if (id === 'custom') d.save({ preset: 'custom' });
      else d.save({ preset: id, actions: { ...PRESETS[id] } });
    },
    setAction(category, action) {
      const s = d.getSettings();
      d.save({ preset: 'custom', actions: { ...s.actions, [category]: action } });
    },
    toggleEnabled() {
      d.save({ enabled: !d.getSettings().enabled });
    },
    openSidePanel() {
      d.openSidePanel();
    },
    revealMessage(key) {
      d.reveal(key);
    },
  };
}
