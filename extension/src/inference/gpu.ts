// WebGPU capability probe (no onnxruntime import, safe for any page).

// Minimal structural types (the project does not pull in @webgpu/types).
interface GpuAdapterLike {
  features: { has(f: string): boolean };
  info?: { vendor?: string; architecture?: string; description?: string };
}
interface GpuLike {
  requestAdapter(o?: { powerPreference?: string }): Promise<GpuAdapterLike | null>;
}

export async function webgpuInfo(): Promise<{ ok: boolean; f16: boolean; adapter?: string; error?: string }> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) return { ok: false, f16: false, error: 'navigator.gpu missing' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, f16: false, error: 'no adapter' };
    const info = adapter.info;
    return {
      ok: true,
      f16: adapter.features.has('shader-f16'),
      adapter: info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : undefined,
    };
  } catch (e) {
    return { ok: false, f16: false, error: String(e) };
  }
}
