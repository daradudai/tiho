// The side panel in Basic mode: one page, no tabs, no numbers. How much Hush
// hides, what Advanced mode would add, and the privacy line. Basic surfaces
// never link here; whoever opens it still lands somewhere useful.

import { basicLevel } from '../../core/settings';
import type { Platform } from '../../core/types';
import { modelStatus, settings } from '../kit/kit';
import { LevelNotes, LevelPicker, ModeSwitch, ModelNotice, PeekHint, PrivacyLine, pickLevel } from '../kit/levels';
import { PLAIN } from '../tokens';
import { Brand, Where } from './SidePanelApp';
import { activeTab, live } from './state';

export function BasicPage() {
  const s = settings.value;
  const platform = (live.value?.platform || activeTab.value?.platform || undefined) as Platform | undefined;
  const level = basicLevel(s, platform);
  return (
    <div class="sp sp-basic">
      <header class="sp-head">
        <div class="sp-top">
          <Brand />
          <Where />
        </div>
      </header>
      <main class="sp-main">
        <div class="sp-stack">
          <ModelNotice m={modelStatus.value} />
          <section class="k-card k-card-pad">
            <h2 class="sp-ask">{PLAIN.levelQuestion}</h2>
            <LevelPicker layout="list" value={level} onPick={(l) => void pickLevel(l, platform)} />
            <LevelNotes s={s} level={level} />
          </section>
          {platform && level !== 'off' && <PeekHint />}
          <section class="k-card k-card-pad">
            <ModeSwitch hint="Adds live stats, the questions inbox, the hidden-messages log, rules and custom AI filters." />
          </section>
          <PrivacyLine class="sp-basic-privacy" />
        </div>
      </main>
    </div>
  );
}
