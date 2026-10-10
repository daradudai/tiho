import type { ChatMessage, Platform } from '../core/types';

/**
 * A platform adapter knows the DOM of one site's live chat. Everything
 * platform-specific lives behind this interface; the runtime is generic.
 *
 * Adapters must be cheap: `extract` runs for every message (budget ≈ 20 µs),
 * must not force layout and must not query outside the given row.
 */
export interface PlatformAdapter {
  platform: Platform;
  /** True if this frame shows a chat this adapter handles (checked on load and SPA navigations). */
  matches(loc: Location): boolean;
  /** The element whose direct children are message rows, or null if not mounted yet. */
  findChatList(doc: Document): HTMLElement | null;
  /** CSS selector matching message rows (used by the observer and the injected stylesheet). */
  rowSelector: string;
  /** Extract a user message from a row; null for system rows, separators, placeholders. */
  extract(row: HTMLElement): ChatMessage | null;
  /** Current channel identifier (login / handle / video id). */
  channel(doc: Document): string;
  /** Element the in-chat bar is inserted before/into (top of the chat column). */
  barAnchor(doc: Document): { el: HTMLElement; where: 'before' | 'prepend' } | null;
  /** Platform theme, used to theme the bar and decorations. */
  theme(doc: Document): 'dark' | 'light';
  /** Logged-in viewer name if detectable (messages mentioning them are never hidden). */
  viewer?(doc: Document): string | null;
}
