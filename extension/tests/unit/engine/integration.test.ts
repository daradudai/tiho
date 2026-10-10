// @vitest-environment node
//
// Against a real Hush Engine (Clef-Flash). Skipped when none answers:
//   engine\.venv\Scripts\python.exe -m hush_engine --attach http://127.0.0.1:7378
//   HUSH_ENGINE_URL=http://127.0.0.1:7377 npx vitest run tests/unit/engine/integration.test.ts

import { describe, expect, it } from 'vitest';
import type { EngineFollowUp } from '../../../src/core/protocol';
import { DEFAULT_SETTINGS, engineQuestion, filterKey, type EngineFilter, type Settings } from '../../../src/core/settings';
import { EngineClient } from '../../../src/engine-client/client';
import { EngineRouter } from '../../../src/engine-client/router';
import { InferenceHub, type PortLike } from '../../../src/inference/hub';
import { FILTER_PRESETS } from '../../../src/ui/sidepanel/filter-presets';

const URL = process.env.HUSH_ENGINE_URL ?? 'http://127.0.0.1:7377';

async function engineUp(): Promise<boolean> {
  try {
    const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

const up = await engineUp();
const preset = (id: string): EngineFilter => {
  const p = FILTER_PRESETS.find((x) => x.id === id)!;
  return { id: p.id, question: p.question, label: p.label, action: p.action, enabled: true, preset: p.id };
};
const BACKSEAT = preset('backseat');
const BEGGING = preset('begging');
// A shared GPU can be slow: give answers time (the extension uses 2.5 s).
const DEADLINE_MS = 30_000;

async function connected(): Promise<EngineClient> {
  const c = new EngineClient({ deadlineMs: DEADLINE_MS });
  c.configure(true, URL);
  await c.check();
  expect(c.status.state).toBe('ready');
  return c;
}

describe.skipIf(!up)('Hush Engine (live)', () => {
  it('reports model and device', async () => {
    const c = await connected();
    expect(c.status.model).toMatch(/clef/i);
    expect(c.status.device).toBeTruthy();
    c.dispose();
  });

  it('answers preset filters sensibly', { timeout: 60_000 }, async () => {
    const c = await connected();
    const filters = [BACKSEAT, BEGGING].map((f) => ({ id: filterKey(f), question: engineQuestion(f.question) }));
    const ask = (text: string) => c.ask({ text, platform: 'twitch', filters, base: false });
    const [back, beg, fine] = await Promise.all([ask('bro just jump on the left ledge, why are you going right??'), ask('can someone gift me a sub pls'), ask('nice play!!')]);
    const [kb, kg] = filters.map((f) => f.id) as [string, string];
    expect(back!.filters[kb]).toBeGreaterThan(0.5);
    expect(back!.filters[kg]).toBeLessThan(0.5);
    expect(beg!.filters[kg]).toBeGreaterThan(0.5);
    expect(fine!.filters[kb]).toBeLessThan(0.5);
    expect(fine!.filters[kg]).toBeLessThan(0.5);
    c.dispose();
  });

  it('gives a second opinion in LABELS order', { timeout: 60_000 }, async () => {
    const c = await connected();
    const a = await c.ask({ text: 'you are a worthless idiot, uninstall', platform: 'twitch', filters: [], base: true });
    expect(a!.base).toHaveLength(7);
    expect(a!.base![0]).toBeGreaterThan(0.5); // toxic
    c.dispose();
  });

  it('runs "Test filter" with a stream context', { timeout: 60_000 }, async () => {
    const c = await connected();
    const spoil = preset('spoilers');
    const r = await c.test({
      text: 'wait till you see Malenia, she is the hardest boss in the game',
      filters: [{ id: 's', question: engineQuestion(spoil.question) }],
      context: 'Streamer is playing Elden Ring for the first time, no spoilers',
      platform: 'twitch',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters.s).toBeGreaterThan(0.5);
    c.dispose();
  });

  it('end to end: hub → router → engine → follow-up on the content Port', { timeout: 60_000 }, async () => {
    const c = await connected();
    const settings: Settings = { ...DEFAULT_SETTINGS, engine: { ...DEFAULT_SETTINGS.engine, enabled: true, url: URL, filters: [BACKSEAT] } };
    const router = new EngineRouter({ client: c, thresholds: () => undefined, tabInfo: () => ({ platform: 'twitch', channel: 'test' }) });
    router.setSettings(settings);
    const hub = new InferenceHub({ ensureOffscreen: async () => {}, broadcast: () => {}, onScores: (r) => router.onLocalScores(r) });

    const got: EngineFollowUp[] = [];
    let offMsg: (m: any) => void = () => {};
    const sentOff: any[] = [];
    const port = (name: string, onPost: (m: any) => void): PortLike & { emit(m: unknown): void } => {
      let l: (m: any) => void = () => {};
      return {
        name,
        sender: { tab: { id: 1 } },
        postMessage: onPost,
        onMessage: { addListener: (cb) => void (l = cb) },
        onDisconnect: { addListener: () => {} },
        emit: (m) => l(m),
      };
    };
    const content = port('hush:classify', (m) => m.type === 'engine' && got.push(m));
    const off = port('hush:offscreen', (m) => sentOff.push(m));
    offMsg = off.emit;
    hub.addClient(content);
    hub.attachOffscreen(off);
    content.emit({ type: 'classify', batchId: 1, items: [{ id: 'a', text: 'use the bow on him, way easier' }, { id: 'b', text: 'lol' }] });
    const req = sentOff.find((m) => m.type === 'classify');
    offMsg({ type: 'scores', id: req.id, ids: ['a', 'b'], scores: [[0.01, 0.01, 0.01, 0.02, 0.01, 0.1, 0.02], [0, 0, 0, 0.9, 0, 0, 0]], ms: 2, backend: 'webgpu' });

    for (let i = 0; i < 600 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    const k = filterKey(BACKSEAT);
    expect(got[0]).toMatchObject({ type: 'engine', batchId: 1, ids: ['a', 'b'] });
    expect(got[0]!.filters[k]![0]).toBeGreaterThan(0.5);
    expect(got[0]!.filters[k]![1]).toBeLessThan(0.5);
    c.dispose();
  });
});
