// Integrity of remote model files. A remote host is not trusted to choose what
// runs: every file fetched from an http(s) base must match the sha256 and size
// pinned in the build (REMOTE_MODEL_PINS in config.ts). Bundled files are part
// of the extension package and need no pin.

import type { FilePin } from './config';

const isHttp = (u: string) => /^https?:/i.test(u);

/** The pin `file` of `base` must match; null for a bundled base. Throws for an unpinned remote file. */
export function pinFor(pins: Record<string, FilePin> | null | undefined, base: string, file: string): FilePin | null {
  if (!isHttp(base)) return null;
  const pin = pins?.[file];
  if (!pin) throw new Error(`${base}${file}: not pinned in this build, refusing a remote model file`);
  return pin;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Throw unless `bytes` are the pinned file (no pin: nothing to check). */
export async function verifyPin(url: string, bytes: Uint8Array, pin: FilePin | null): Promise<void> {
  if (!pin) return;
  if (bytes.byteLength === pin.size && (await sha256Hex(bytes)) === pin.sha256) return;
  throw new Error(`GET ${url}: not the file this build pins (sha256 / size mismatch)`);
}
