// Commands the in-chat bar (src/ui/bar) sends to the content-script runtime.
// The runtime implements this; the UI only calls it.

import type { Action, Category, Platform } from './types';
import { PRESETS, levelPatch, type BasicLevel, type PresetId, type Settings, type UiMode } from './settings';
import type { Store } from './store';

export interface BarActions {
  /** Apply a preset (also resets per-category actions to the preset's). */
  setPreset(preset: PresetId): void;
  /** Override one category's action (switches the preset to 'custom'). */
  setAction(category: Category, action: Action): void;
  /** Turn Tiho on/off (global). */
  toggleEnabled(): void;
  /** Ask the background to open the side panel dashboard for this tab. */
  openSidePanel(): void;
  /** Scroll the chat to a message and un-hide it (e.g. from the questions list). */
  revealMessage(key: string): void;
  /** Switch the UI (saved, all tabs). Never changes filtering. */
  setMode(mode: UiMode): void;
  /** Basic's one control. 'off' → enabled:false. Otherwise one save: enabled:true, this site on, preset + its actions. */
  setLevel(level: BasicLevel): void;
  /** Show hidden in this tab (not saved). */
  setPeek(on: boolean): void;
  /** Show only this category in this tab (not saved); null shows everything. Ignored in Basic and while Tiho is off. */
  setSolo(cat: Category | null): void;
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
  /** The site this bar sits on: picking a level turns it on there. */
  platform: Platform;
  /** The runtime's views of this tab (TihoRuntime.setPeek / setSolo). */
  setPeek(on: boolean): void;
  setSolo(cat: Category | null): void;
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
    setMode(mode) {
      d.save({ uiMode: mode });
    },
    setLevel(level) {
      d.save(levelPatch(d.getSettings(), level, d.platform));
    },
    setPeek(on) {
      d.setPeek(on);
    },
    setSolo(cat) {
      d.setSolo(cat);
    },
  };
}
