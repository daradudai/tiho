import { kick } from './kick';
import { twitch } from './twitch';
import type { PlatformAdapter } from './types';
import { youtube } from './youtube';

export { kick, twitch, youtube };
export { PLATFORM_MATCHES, CHAT_MATCHES } from './matches';
export type { PlatformAdapter } from './types';

/**
 * All adapters. observeSubtree is false on all three platforms (verified live
 * 2026-10-10): rows are inserted fully rendered as direct children of
 * findChatList() and never patched in place, so {childList: true} suffices.
 */
export const ADAPTERS: readonly PlatformAdapter[] = [youtube, twitch, kick];

/** The adapter for this frame's location, or null. Re-run on SPA navigations. */
export function detectAdapter(loc: Location): PlatformAdapter | null {
  for (const a of ADAPTERS) if (a.matches(loc)) return a;
  return null;
}
