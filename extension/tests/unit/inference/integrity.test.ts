import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pinFor, sha256Hex, verifyPin } from '../../../src/inference/integrity';

const bytes = new TextEncoder().encode('{"hush":{"thresholds":{"toxic":0.22}}}');
const pin = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
const REMOTE = 'https://huggingface.co/someone/hush-lite/resolve/0123abc/';

describe('remote model integrity', () => {
  it('hashes like sha256sum', async () => {
    expect(await sha256Hex(bytes)).toBe(pin.sha256);
  });

  it('accepts exactly the pinned file', async () => {
    await expect(verifyPin(REMOTE + 'config.json', bytes, pin)).resolves.toBeUndefined();
    await expect(verifyPin('chrome-extension://x/models/hush-lite/config.json', bytes, null)).resolves.toBeUndefined();
  });

  it('rejects a changed file, even one of the same size', async () => {
    const tampered = new TextEncoder().encode('{"hush":{"thresholds":{"toxic":1.00}}}');
    expect(tampered.byteLength).toBe(bytes.byteLength);
    await expect(verifyPin(REMOTE + 'config.json', tampered, pin)).rejects.toThrow(/sha256/);
    await expect(verifyPin(REMOTE + 'config.json', bytes.subarray(1), pin)).rejects.toThrow(/sha256/);
  });

  it('needs a pin for every remote file, none for bundled ones', () => {
    const pins = { 'config.json': pin };
    expect(pinFor(pins, REMOTE, 'config.json')).toBe(pin);
    expect(() => pinFor(pins, REMOTE, 'onnx/model_evil.onnx')).toThrow(/not pinned/);
    expect(() => pinFor(null, REMOTE, 'config.json')).toThrow(/not pinned/);
    expect(pinFor(null, 'chrome-extension://abc/models/hush-lite/', 'config.json')).toBeNull();
  });
});
