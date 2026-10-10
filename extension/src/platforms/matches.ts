// Content-script injection targets per platform. The lead wires these into
// the WXT content-script entrypoint(s) (`matches`, `allFrames`, `runAt`).
//
// YouTube: the chat lives in the same-origin iframe #chatframe
//   (https://www.youtube.com/live_chat?continuation=…|?v=…). The watch page
//   itself has no chat DOM, so the script must run in that frame → allFrames.
//   The popout (live_chat?is_popout=1&v=…) is a top-level page with the same
//   DOM; `live_chat*` also covers VOD chat replay (live_chat_replay?…).
// Twitch: SPA — inject on every page and let adapter.matches() decide on each
//   navigation (channel page, /popout/<ch>/chat, /embed/<ch>/chat,
//   /moderator/<ch>, dashboard stream manager). allFrames so embedded/popout
//   chat iframes work too.
// Kick: SPA on kick.com (www redirects); popout is top-level.

export interface PlatformMatch {
  matches: string[];
  allFrames: boolean;
  runAt: 'document_start' | 'document_end' | 'document_idle';
}

export const PLATFORM_MATCHES = {
  youtube: {
    matches: ['*://www.youtube.com/live_chat*'],
    allFrames: true,
    runAt: 'document_idle',
  },
  twitch: {
    matches: ['*://www.twitch.tv/*', '*://dashboard.twitch.tv/*'],
    allFrames: true,
    runAt: 'document_idle',
  },
  kick: {
    matches: ['*://kick.com/*'],
    allFrames: false,
    runAt: 'document_idle',
  },
} as const satisfies Record<string, PlatformMatch>;

/** Union of all patterns (for a single content-script entrypoint with allFrames: true). */
export const CHAT_MATCHES: string[] = [
  ...PLATFORM_MATCHES.youtube.matches,
  ...PLATFORM_MATCHES.twitch.matches,
  ...PLATFORM_MATCHES.kick.matches,
];
