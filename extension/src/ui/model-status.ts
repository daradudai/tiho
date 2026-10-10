// Human-readable model status, shared by the bar and extension pages.

import type { ModelStatus } from '../core/types';
import { pct } from './format';

export type StatusTone = 'ok' | 'gpu' | 'cpu' | 'engine' | 'load' | 'err' | 'idle';

export const BACKEND_LABEL: Record<string, string> = { webgpu: 'WebGPU', wasm: 'CPU (WASM)', engine: 'Hush Engine', none: 'Rules only' };

/** "hush/hush-lite-mmbert-small" → "Hush Lite" */
export function prettyModel(id?: string): string {
  if (!id) return 'Hush Lite';
  const last = id.split('/').pop()!;
  if (/hush[-_ ]?lite/i.test(last)) return 'Hush Lite';
  return last;
}

export function modelSummary(m: ModelStatus): { title: string; sub: string; tone: StatusTone } {
  switch (m.state) {
    case 'downloading':
      return { title: `Downloading model · ${m.progress != null ? pct(m.progress) : '…'}`, sub: 'One-time download, then cached', tone: 'load' };
    case 'loading':
      return { title: 'Warming up the model', sub: 'Rules are already filtering', tone: 'load' };
    case 'error':
      return { title: 'Model unavailable', sub: m.error ? m.error.slice(0, 80) : 'Rules still filter chat', tone: 'err' };
    case 'idle':
      return { title: 'Model idle', sub: 'Starts when chat appears', tone: 'idle' };
    case 'ready': {
      const tone = m.backend === 'webgpu' ? 'gpu' : m.backend === 'engine' ? 'engine' : 'cpu';
      return { title: `Ready · ${BACKEND_LABEL[m.backend] ?? m.backend}`, sub: `${prettyModel(m.modelId)} · on-device`, tone };
    }
  }
}

