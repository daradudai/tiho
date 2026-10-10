// Decides which classified texts go to the Hush Engine and sends its answers
// back to the content Port that asked, as a follow-up to the local scores:
//
//   hub: local scores → Port ──▶ router.onLocalScores({port, batchId, items, ids, scores})
//        ──▶ client.ask() per text (custom filters for every text; the engine's
//            own scores only where the local model was unsure)
//        ──▶ Port {type:'engine', batchId, ids, filters, base}   (texts answered in time)
//
// Asking after the local scores (≈ 20–50 ms) rather than alongside them lets
// one engine request per text carry both the filters and, when needed, the
// second opinion: the engine's capacity (~10 texts/s on an RTX 3090) is what
// limits this, not the wait.

import type { LocalScores, PortLike } from '../inference/hub';
import { isUnsure, policyContext, type PolicyContext } from '../core/policy';
import type { EngineFollowUp } from '../core/protocol';
import { activeFilters, channelKey, DEFAULT_SETTINGS, engineQuestion, filterKey, type Settings } from '../core/settings';
import type { Platform } from '../core/types';
import { MAX_FILTERS } from './api';
import type { EngineAnswer, EngineClient, EngineQuery } from './client';

export interface RouterDeps {
  client: Pick<EngineClient, 'ask' | 'ready'>;
  /** Raw per-label thresholds of the local model (its status), for "unsure". */
  thresholds(): ArrayLike<number> | undefined;
  /** Platform / channel a tab is showing (from its content-script reports). */
  tabInfo(tabId: number): { platform?: string; channel?: string } | undefined;
}

const PLATFORM_HOSTS: [RegExp, Platform][] = [
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)twitch\.tv$/, 'twitch'],
  [/(^|\.)kick\.com$/, 'kick'],
];

function platformOfUrl(url: string | undefined): Platform | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return PLATFORM_HOSTS.find(([re]) => re.test(host))?.[1];
  } catch {
    return undefined;
  }
}

export class EngineRouter {
  private settings: Settings = DEFAULT_SETTINGS;
  private filters: EngineQuery['filters'] = [];
  private ctx: PolicyContext | null = null;
  private ctxThresholds: ArrayLike<number> | undefined;

  constructor(private deps: RouterDeps) {}

  setSettings(s: Settings): void {
    this.settings = s;
    this.filters = activeFilters(s.engine)
      .map((f) => ({ id: filterKey(f), question: engineQuestion(f.question) }))
      .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i)
      .slice(0, MAX_FILTERS);
    this.ctx = null;
  }

  /** Anything to ask the engine at all. */
  get active(): boolean {
    const e = this.settings.engine;
    return e.enabled && (this.filters.length > 0 || e.refineUncertain);
  }

  /** Local scores for a batch went to its Port: ask the engine and post its answers there later. */
  onLocalScores({ port, batchId, items, ids, scores }: LocalScores): void {
    if (!this.active || !this.deps.client.ready || !ids.length) return;
    const ctx = this.settings.engine.refineUncertain ? this.policy() : null;
    const filters = this.filters;
    const { platform, context } = this.where(port);
    const texts = new Map<string, string>();
    for (const it of items) texts.set(it.id, it.text);

    const asked: string[] = [];
    const answers: Promise<EngineAnswer | null>[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const text = texts.get(id);
      const s = scores[i];
      if (!text || !s) continue;
      const base = !!ctx && isUnsure(s, ctx);
      if (!base && !filters.length) continue;
      asked.push(id);
      answers.push(this.deps.client.ask({ text, platform, context, filters, base }));
    }
    if (!asked.length) return;
    void Promise.all(answers).then((res) => {
      const msg = followUp(batchId, asked, res, filters);
      if (!msg) return;
      try {
        port.postMessage(msg);
      } catch {
        /* port closed meanwhile */
      }
    });
  }

  private policy(): PolicyContext {
    const thr = this.deps.thresholds();
    if (!this.ctx || thr !== this.ctxThresholds) {
      this.ctx = policyContext(this.settings, thr);
      this.ctxThresholds = thr;
    }
    return this.ctx;
  }

  private where(port: PortLike): { platform?: Platform; context?: string } {
    const tabId = port.sender?.tab?.id;
    const info = tabId !== undefined ? this.deps.tabInfo(tabId) : undefined;
    const platform = (info?.platform as Platform | undefined) ?? platformOfUrl(port.sender?.url);
    const channel = info?.channel;
    const context = platform && channel ? this.settings.engine.contexts[channelKey(platform, channel)]?.trim() : undefined;
    return { platform, context: context || undefined };
  }
}

/** The Port message for the texts that got an answer; null when none did. */
export function followUp(
  batchId: number,
  ids: string[],
  answers: (EngineAnswer | null)[],
  filters: EngineQuery['filters'],
): EngineFollowUp | null {
  const out: EngineFollowUp = { type: 'engine', batchId, ids: [], filters: {} };
  for (const f of filters) out.filters[f.id] = [];
  const base: (number[] | null)[] = [];
  for (let i = 0; i < ids.length; i++) {
    const a = answers[i];
    if (!a) continue;
    out.ids.push(ids[i]!);
    for (const f of filters) out.filters[f.id]!.push(a.filters[f.id] ?? Number.NaN);
    base.push(a.base ?? null);
  }
  if (!out.ids.length) return null;
  if (base.some((b) => b)) out.base = base;
  return out;
}
