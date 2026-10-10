// A scriptable stand-in for the Hush Engine HTTP API, used as `fetch`.

import type { ClassifyRequest, Health } from '../../../src/engine-client/api';

export interface Call {
  url: string;
  path: string;
  body?: ClassifyRequest;
  signal?: AbortSignal | null;
}

type Reply = Response | Error | Promise<Response>;

export const READY: Health = {
  ok: true,
  status: 'ready',
  detail: '',
  version: '0.1.0',
  decision_model: 'Clef-Flash-Q8_0',
  device: 'NVIDIA GeForce RTX 3090 (24 GB)',
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers every message: filter probability from `score(text, filterId)`, base when asked. */
export function answerAll(score: (text: string, filter: string) => number = () => 0.9) {
  return (req: ClassifyRequest) =>
    json({
      results: req.messages.map((m) => ({
        id: m.id,
        filters: Object.fromEntries(req.filters.map((f) => [f.id, score(m.text, f.id)])),
        ...(req.base
          ? { base: { toxic: 0.8, spam: 0.01, scam: 0.01, noise: 0.02, question: 0.01, clean: 0.15, positive: 0.05, negative: 0.7 } }
          : {}),
        cached: false,
      })),
      ms: 12,
    });
}

export class FakeEngine {
  calls: Call[] = [];
  health: () => Reply = () => json(READY);
  classify: (req: ClassifyRequest, call: Call) => Reply = answerAll();

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const call: Call = { url, path, signal: init?.signal };
    if (init?.body) call.body = JSON.parse(String(init.body)) as ClassifyRequest;
    this.calls.push(call);
    const r = path === '/health' ? this.health() : path === '/v1/classify' ? this.classify(call.body!, call) : json({}, 404);
    const res = await r;
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;

  get classifyCalls(): Call[] {
    return this.calls.filter((c) => c.path === '/v1/classify');
  }

  get healthCalls(): Call[] {
    return this.calls.filter((c) => c.path === '/health');
  }
}

/** A promise you resolve later (slow engine). */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
