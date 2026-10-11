// Human-readable model status, shared by the bar and extension pages.

import type { RuntimeMessage } from '../core/protocol';
import type { ModelStatus } from '../core/types';
import { pct } from './format';
import { PLAIN } from './tokens';

export type StatusTone = 'ok' | 'gpu' | 'cpu' | 'engine' | 'load' | 'err' | 'idle';

export const BACKEND_LABEL: Record<string, string> = { webgpu: 'WebGPU', wasm: 'CPU (WASM)', engine: 'Hush Engine', none: 'Rules only' };

/** "hush-lite/q8" (the worker's model id: name/variant) → "Hush Lite" */
export function prettyModel(id?: string): string {
  if (!id || /hush[-_ ]?lite/i.test(id)) return 'Hush Lite';
  return id.split('/').pop()!;
}

/** Layers of the running model, from its version ("v2-6L" → 6); null until it is ready. */
export function modelLayers(m: ModelStatus | null | undefined): number | null {
  const x = m?.state === 'ready' ? /(\d+)L\b/.exec(m.version ?? '') : null;
  return x ? Number(x[1]) : null;
}

/**
 * A model load error in plain words (the raw error, URLs and all, is shown
 * only in the side panel's model card).
 */
export function modelProblem(error?: string): string {
  const e = error ?? '';
  if (/model not found/i.test(e)) return 'Model not included in this build';
  if (/^GET |failed to fetch|network/i.test(e)) return 'Model download failed';
  if (/no usable model file|non-finite|webgpu|wasm|backend|session/i.test(e)) return 'Model could not run on this device';
  return 'Model could not load';
}

/** Retry: the background loads a model that failed to load again now (it also retries by itself, with backoff, while a chat is open). */
export function retryModel(): void {
  try {
    chrome.runtime.sendMessage({ type: 'hush:reloadModel' } satisfies RuntimeMessage).catch(() => {});
  } catch {
    /* no extension context (showcase) */
  }
}

/**
 * The model in plain words, for Basic surfaces: a line only while it is not
 * ready (no layers, backends or numbers; `progress` drives a bar, never a
 * percentage), null when there is nothing to say (ready, idle, unknown).
 */
export function plainModelStatus(m: ModelStatus | null | undefined): { text: string; tone: 'load' | 'err'; progress?: number } | null {
  if (m?.state === 'downloading' || m?.state === 'loading') return { text: PLAIN.loading, tone: 'load', progress: m.state === 'downloading' ? m.progress : undefined };
  if (m?.state === 'error') return { text: PLAIN.error, tone: 'err' };
  return null;
}

export function modelSummary(m: ModelStatus): { title: string; sub: string; tone: StatusTone } {
  switch (m.state) {
    case 'downloading':
      return { title: `Downloading model · ${m.progress != null ? pct(m.progress) : '…'}`, sub: 'One-time download, then cached', tone: 'load' };
    case 'loading':
      return { title: 'Warming up the model', sub: 'Rules are already filtering', tone: 'load' };
    case 'error':
      return { title: modelProblem(m.error), sub: 'Rules still filter chat', tone: 'err' };
    case 'idle':
      return { title: 'Model idle', sub: 'Starts when chat appears', tone: 'idle' };
    case 'ready': {
      const tone = m.backend === 'webgpu' ? 'gpu' : m.backend === 'engine' ? 'engine' : 'cpu';
      const layers = modelLayers(m);
      return { title: `Ready · ${BACKEND_LABEL[m.backend] ?? m.backend}`, sub: `${prettyModel(m.modelId)}${layers ? ` · ${layers} layers` : ''} · on-device`, tone };
    }
  }
}

