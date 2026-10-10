// Content script for every live-chat frame (YouTube live_chat iframe, Twitch,
// Kick). Picks the platform adapter and starts the Hush runtime.
//
// One copy per frame: the background injects this script again into chats
// that were open when Hush was installed or updated, so a frame can get it
// twice. WXT invalidates the older copy's context as soon as a newer one starts
// in the frame (an orphan of the previous version included); the older copy
// then stops and the newer one runs.

import { defineContentScript } from 'wxt/utils/define-content-script';
import { detectAdapter, kick, twitch, youtube } from '../platforms';
import { CHAT_MATCHES } from '../platforms/matches';
import type { PlatformAdapter } from '../platforms/types';
import { startHush } from '../runtime';

/**
 * Adapter for this frame. Twitch / Kick are SPAs: the first page may not be a
 * channel (home, directory), so fall back to the host's adapter and let the
 * runtime re-check `adapter.matches()` on every navigation.
 */
function adapterFor(loc: Location): PlatformAdapter | null {
  const a = detectAdapter(loc);
  if (a) return a;
  const h = loc.hostname;
  if (h.endsWith('twitch.tv')) return twitch;
  if (h === 'kick.com' || h === 'www.kick.com') return kick;
  if (h.endsWith('youtube.com') && loc.pathname.startsWith('/live_chat')) return youtube;
  return null;
}

export default defineContentScript({
  matches: CHAT_MATCHES,
  allFrames: true,
  runAt: 'document_idle',
  async main(ctx) {
    const adapter = adapterFor(location);
    if (!adapter) return;
    const hush = await startHush({ adapter });
    // a newer copy started while this one was loading its settings
    if (ctx.isInvalid) return hush.stop();
    ctx.onInvalidated(() => hush.stop());
  },
});
