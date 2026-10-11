# Basic and Advanced modes, Show hidden, Solo: UX spec

This is the implementation spec for splitting Hush's UI into **Basic** (the default: idiot-proof, for someone who sees chat for the first time) and **Advanced** (today's full power, organized, for streamers, mods and power users). It also adds **Show hidden** (a temporary view of what Hush hid) and **Solo** (show one category only, for checking the model). File paths are relative to `extension/src/` unless they say otherwise.

Three people build it in parallel:

- **A, core:** settings, store, bar actions, runtime, row stylesheet, policy, bridge.
- **B, in-chat bar:** `ui/bar/`, `ui/tokens.ts`.
- **C, extension pages:** popup, side panel, onboarding, README.

Section 4 is the contract between them. Build against it, not against each other's code.

## 1. Why

The owner tested Hush on live Twitch in Edge and gave three pieces of feedback:

1. The classification looks good, but the UI feels heavy and cluttered.
2. He wants to isolate one category with one click, to check that it caught the right messages.
3. "24% hushed" is unclear. Even with every category set to Hide, the percentage barely moves and does not match the chat.

Root cause of the stale percentage: `totals.seen` counts every message since page load, and `filtered` counts every row ever hidden. A settings change, on the other hand, re-decides only the ~150 rows the chat list holds now. The owner's conclusion: drop the percentage, make Basic mega easy, and keep the many options for streamers who need targeted filtering.

## 2. Principles

1. **Basic has one choice.** Off, Clean or Quiet, plus a way to see what was hidden. It shows no numbers, categories, percentages, model jargon or per-category controls. The only numbers are the ones chat already shows on the line they describe (`2 hidden · show`, `KEKW ×37`).
2. **Mode changes only the UI.** Rules, custom AI filters, strictness, wave folding and protected authors work the same in both modes. Switching modes never changes what is filtered.
3. **Every number is live or has a window.** A number is either *in chat now* (rows the chat list holds right now, recounted as verdicts change) or states its window (`last 60 s`, `last 5 min`, `since you opened this panel`). The cumulative "hushed %" is removed everywhere.
4. **The same words on every surface.** A setting has one name in the bar, the popup, the side panel, onboarding and the README.
5. **Show hidden and Solo are views, not settings.** They apply to one tab, are never saved, swap one stylesheet and write nothing on chat rows. The perf rules in [architecture.md](architecture.md) still hold: bar counters update at most 2× per second, animation is compositor-only and there are no per-frame DOM writes in chat.

## 3. Decisions

These settle the points where the proposals disagreed.

| Question | Decision | Why |
|---|---|---|
| Default mode | `basic` for new **and** existing installs | Lead's requirement. Nothing about filtering changes. If an existing user has their own setup, Basic says so and links to Advanced. |
| Basic level names | **Off · Clean · Quiet** | Each name says what it does. "Light" would collide with the light theme. |
| Advanced preset names | Raw · **Clean** · **Quiet** · Questions (ids stay `raw`, `chill`, `focus`, `questions`) | Same words everywhere. Only labels change, so no storage migration. |
| Peek | **Show hidden** in both modes, per tab | Answers a first-timer's "what did it take?" without categories. |
| Solo | Advanced only. Every other category is **hidden** (not dimmed or folded). | Most literal reading of "only that one". It is the cleanest precision check at 50 msg/s and the cheapest to build (one stylesheet). |
| Solo row readout | A visible tag on every soloed row: `spam · certain · folded` | Merges the always-visible reason (first-timer) with the normal action (native). |
| Chip click | Solo. Changing an action moves to right-click / long-press and the panel's `▾` | The owner's "easy click". Also ends accidental hides from blind click-to-cycle. |
| Counts | One definition, **in chat now**, on chips, panel rows, the Solo pill, the popup and the side panel | Never mix windows on one surface (streamer-pro's `Sp 13` vs `6 in chat` problem). |
| Basic row decorations | No category edges and no hover reason chips. The question glow, pills, `×N` and the dashed "opened" edge stay. | Most of the clutter in `live-twitch-chat.png`. |
| Basic side panel | One page: level, Advanced switch, privacy. Not linked from Basic. | Basic users don't need it. Anyone who opens it still lands somewhere useful. |
| Model status in Basic | Only when not ready: progress ring on the mark (no number), amber dot on error | No jargon and no numbers. |
| Percent signs | Only in cache hits (labelled) and download progress (Advanced). Model confidence is a word, measured against the label's calibrated threshold: `maybe` (under it: only Strict catches it), `likely`, `very likely`, `certain` (`toxic · likely`). The raw score is a tooltip in the side panel's Log and Inbox (`Model: toxic 25%, threshold 22%`). | Each percentage describes one process. A raw score reads wrong: thresholds differ per label (toxic 22%, negative 10%), so `toxic · 25%` is a confident call. |

## 4. Shared contract

### 4.1 Settings (`core/settings.ts`, A)

```ts
export type UiMode = 'basic' | 'advanced';
/** What Basic offers: Off, Clean (preset 'chill') or Quiet (preset 'focus'). */
export type BasicLevel = 'off' | 'chill' | 'focus';

export interface Settings {
  // ...existing fields
  /** Which UI the bar, popup and side panel show. UI only: filtering is the same in both modes. */
  uiMode: UiMode;
}
// DEFAULT_SETTINGS.uiMode = 'basic'
```

- `mergeSettings` sets `uiMode` to `stored.uiMode` when that is `'advanced'`, and to `'basic'` otherwise. That covers missing values (every install from before this change) and unknown ones, so existing installs land in Basic.
- `filterDefaults()` (Reset filters) never touches `uiMode`.
- `basicLevel(s: Settings, platform?: Platform): BasicLevel | null`
  - returns `'off'` when `!s.enabled`, or when `platform` is given and `s.sites[platform] === false`;
  - returns `s.preset` when it is `'chill'` or `'focus'`;
  - returns `null` otherwise (`raw`, `questions` or `custom`: "a custom setup from Advanced mode").
- `advancedExtras(s: Settings): string[]` lists the Advanced settings that still apply in Basic, in plain words and in this order:
  - `'your rules'`, when any rule is enabled;
  - `'custom AI filters'`, when `activeFilters(s.engine)` is not empty;
  - `'strictness'`, when `s.strictness !== DEFAULT_SETTINGS.strictness`.

  It returns `[]` for a fresh install.

### 4.2 Store (`core/store.ts`, A)

```ts
export interface InChat {
  /** Message rows the chat list holds now that have a verdict. */
  rows: number;
  /** ...whose action is hide (and the viewer has not opened them). */
  hidden: number;
  /** ...folded into "N hidden · show" pills (wave members not included). */
  folded: number;
  /** ...folded into a wave head's ×N. */
  inWaves: number;
  /** Per verdict category, wave members not included. Σ byCat + inWaves === rows. */
  byCat: Record<Category, number>;
}

export interface Store {
  // removed: counts, totals
  /** What the chat list holds right now (see 5.2). Flushed with the ≤ 4×/s store batch. */
  inChat: Signal<InChat>;
  /** Messages first seen since the chat attached. Drives the mark's activity pulse only; never shown. */
  seen: Signal<number>;
  /** Show hidden is on in this tab. */
  peek: Signal<boolean>;
  /** Category shown alone in this tab (Advanced only), or null. */
  solo: Signal<Category | null>;
  // ...everything else unchanged
}
```

`ui/bar/view.ts` `CADENCE` (A adds these, since the type requires them): `inChat: 500`, `seen: 500`, `peek: 0`, `solo: 0`. Remove `counts` and `totals`.

### 4.3 Bar actions (`core/bar-actions.ts`, A)

```ts
export interface BarActions {
  setPreset(preset: PresetId): void;          // unchanged
  setAction(category: Category, action: Action): void; // unchanged
  toggleEnabled(): void;                      // unchanged
  openSidePanel(): void;                      // unchanged
  revealMessage(key: string): void;           // unchanged
  /** Switch the UI (saved, all tabs). Never changes filtering. */
  setMode(mode: UiMode): void;
  /** Basic's one control. 'off' → enabled:false. Otherwise one save: enabled:true, this site on, preset + its actions. */
  setLevel(level: BasicLevel): void;
  /** Show hidden in this tab (not saved). */
  setPeek(on: boolean): void;
  /** Show only this category in this tab (not saved); null shows everything. Ignored in Basic and while Hush is off. */
  setSolo(cat: Category | null): void;
}

export interface BarActionDeps {
  // ...existing
  platform: Platform;
  setPeek(on: boolean): void;   // → runtime.setPeek
  setSolo(cat: Category | null): void; // → runtime.setSolo
}
```

`setLevel('chill')` saves `{ enabled: true, sites: { ...sites, [platform]: true }, preset: 'chill', actions: { ...PRESETS.chill } }` in one `save()`. Extension pages do the same through `updateSettings`, with the active tab's platform, or without `sites` when no chat tab is active.

### 4.4 Runtime (`runtime/engine.ts`, A)

```ts
setPeek(on: boolean): void;
setSolo(cat: Category | null): void;
```

Both write `store.peek` / `store.solo` at once (user actions, not batched), then `styles.update(styleOpts())`. Full behaviour is in 5.3 and 5.4.

### 4.5 Bridge (`ui/bridge.ts`, A; C consumes)

```ts
export interface LiveSnapshot {
  v: 2;                       // bumped: pages ignore v1 snapshots from an old content script
  // removed: counts, totals
  inChat: InChat;
  peek: boolean;
  solo: Category | null;
  // ...rest unchanged
}
export type LiveCommand =
  | { type: 'reveal'; key: string }
  | { type: 'feedback'; key: string; label: Category }
  | { type: 'peek'; on: boolean }
  | { type: 'solo'; cat: Category | null };
export interface LiveHandlers { reveal(key: string): void; feedback?(...): void; peek?(on: boolean): void; solo?(cat: Category | null): void }
```

- `serveLive` drops a `solo` command whose `cat` is neither `null` nor one of `CATEGORIES`.
- `runtime/index.ts` wires `peek` and `solo` to the runtime, for both the bar deps and `serveLive`.
- `RuntimeReport.stats.counts` and the background's `TabPerf.counts` are removed, because nothing reads them.

### 4.6 Row stylesheet options (`runtime/styles.ts`, `ui/decorations.ts`, A)

```ts
export interface StyleOptions { decorate: boolean; theme; platform; mode: UiMode; peek: boolean; solo: Category | null }
export interface DecorationOptions { decorate?: boolean; mode?: UiMode /* default 'advanced' */; peek?: boolean; solo?: Category | null }
```

Show hidden and Solo are **variants of the stylesheet `buildCss` produces**. They are not rules layered on top, because a later rule cannot undo `display:none!important`. Every selector stays a compound of attribute selectors on the row. The one existing `>` rule (pill content) is not emitted in these variants.

## 5. Core (A)

### 5.1 Modes in the runtime

- The effective decorations follow the mode. **Advanced** is today's behaviour. **Basic** never emits category edges or the hover reason chip, whatever `settings.decorate` says. It keeps the question glow (when `decorate`), the dashed edge on rows the viewer opened, pills, `×N`, dim and highlight.
- When `uiMode` becomes `'basic'`, Solo ends (5.4). Peek stays on.

### 5.2 In chat now

**Definition.** Everything in `InChat` describes the rows in `this.live` that have a verdict, with the action the runtime **wrote** on them (`st.a`). Opened rows count as shown, and `pending` rows count as nothing. On Twitch that is the ~150 messages the list keeps; on Kick, the ~30 mounted rows. That is small, but honest. It counts rows in the list, not rows in the viewport.

**Bookkeeping, O(1) per change:**

- Each `RowState` remembers its current contribution: its category and whether it is shown, hidden, folded or a wave member (`wm`). A single `tally(st, next)` moves the counters by the difference and sets `storeDirty`.
- **Invariant:** the counters always equal the sum of the contributions of the rows in `live`.
  - Every change of a live row's written `(a, c, wm)` goes through `tally`. Call it at the end of `writeRow`, which already computes `a`, `c` and `wm`.
  - Every `live.delete` un-tallies the row. That covers `onRemoved`, the old node in `recall`, and `process` when a recycled node gets a new message or stops being a message.
  - `live.clear()` in `detach` zeroes the counters and clears each live row's contribution first.
  - The "same message re-added" branch of `process` (`live.add` + return) re-tallies from `st`.
- Kick re-mounts rows as new nodes. The old node is un-tallied in `onRemoved`, and the new `RowState` starts with no contribution, so nothing is counted twice.
- `flushStore` writes `inChat` (a fresh object) together with the other store fields, in the same `batch()`, at the existing ≤ 4×/s cadence. A settings change therefore moves the numbers in the first store flush after `reevaluateAll`: the store follows within 250 ms and the bar within about 750 ms.
- After `detach` (Hush off, site off, navigation), schedule a store flush, so the numbers read 0 rather than freezing.

**Remove:** `counts`, `filteredCount`, `st.counted`, `st.filtered` and `totals`. Keep the internal `seen++` (store `seen`) for the pulse.

### 5.3 Show hidden (peek)

**Stylesheet variant `peek`** (in either mode, when Solo is off):

- `[data-hush-a="hide"]` and folded rows are **not** `display:none`. They render in place:
  - at `opacity:.6`, and `1` on `:hover`;
  - with the dashed "opened" edge;
  - with a **tag** (see below).
- The whole pill block (`RUN` rules, `RUN>*`) is not emitted. Pill rows render as plain rows.
- Wave members stay folded into their head (`[data-hush-wm]:not([data-hush-open])` stays `display:none`).
- `pending` rows, the `data-hush-list` birth rule, dim and highlight are unchanged.

**Tag** (`::before`, `float:right`; `float:left` on `:dir(rtl)`): it uses the wave badge's box (18 px pill, 11 px, `tabular-nums`) and is coloured with the row's `--hush-accent`. It never uses absolute positioning, so it cannot cover other rows.

| Mode | Row | Tag text |
|---|---|---|
| Basic | hide or collapse | `Hidden · ` + plain word: toxic `insult`, scam `scam`, spam `spam`, noise `one-word reply`, negative `complaint`, question `question`. Positive and clean (only hidden by rules or filters): just `Hidden` |
| Advanced | hide | `hidden · ` + `attr(data-hush-r)`. Without a reason: `hidden · ` + category |
| Advanced | collapse | `folded · ` + reason, same fallback |

**Lifecycle:**

- Peek is per tab, starts off and is never saved.
- **On:** `setPeek(true)`, from Show hidden in the bar or side panel.
- **Off:** `setPeek(false)`, Esc (bar, 6.5), Hush or this site turned off, a channel change or navigation (`detach`), entering Solo, `stop()`.
- Changing level, preset or mode keeps it on.

**Clicks:** while peek or Solo is on, `onClick` and `onKeyDown` on the list return at once. Otherwise, a click on a username inside a peeked folded row would open the run and leave it opened after peek ends.

**Accepted limitation:** the pill row keeps `role=button` and its `aria-label` during the view.

**Cost:** each toggle is one stylesheet text swap and one style recalc, the same as a theme change. It writes no row attributes and re-decides nothing. New rows follow automatically.

### 5.4 Solo

**Entering and switching:**

- `setSolo(cat)` with `cat ≠ null` turns on Solo, but only when `this.active` and `settings.uiMode === 'advanced'`; otherwise it is ignored.
- It also turns peek off.
- A different `cat` switches categories. The same `cat` again, or `null`, ends Solo.

**Stylesheet variant `solo` for category X:**

- `[data-hush-c]:not([data-hush-c="X"])` is `display:none!important`. This covers every decided row of another category, including rows the viewer opened.
- Rows with no `data-hush-c` keep their normal look:
  - platform notices and other non-message rows (`data-hush-a=""`) stay visible;
  - held rows stay invisible under the list rule.
- **Rows of X show in full whatever their action.** They have no pill, `opacity:1` even when dimmed, and keep the highlight glow.
  - X rows whose action is `hide` or `collapse` get the dashed "opened" edge, which here means "normally not shown".
- Wave members stay folded (as in 5.3). A wave head of X shows its `×N` inside the tag.
- No category edges and no hover chips: the tag replaces them.

**Tag** on every X row, always visible, in the same box as the peek tag:

- Text: `attr(data-hush-r)` + ` · ` + the normal action word: `shown`, `highlighted`, `dimmed`, `folded` or `hidden`, from `data-hush-a`.
- Opened rows (`[data-hush-open]`) end in `opened` instead.
- A reason that ends in `always shown` (`[data-hush-r$="always shown"]`) gets no action word.
- No reason (clean rows): the category word stands in for it (`other · shown`).
- On a wave head of X: `×` + `attr(data-hush-wh)` + `  ` + the text above.
- Examples: `spam · certain · folded`, `toxic · likely · hidden`, `blocked: giveaway · hidden`, `filter: backseating · hidden`, `repeat ×4 · folded`, `spam · very likely · always shown`, `×37  noise · certain · shown`.
- On Kick (absolute rows): verify the float does not make rows overlap. If it does, put the tag `position:absolute` inside the row there; Kick rows are positioned already (`PLATFORM_DECO.kick.positioned`).
  - Verified live: no overlap. But Kick's list is virtualized, and when most mounted rows take no space it mounts and unmounts rows about 1,000 times a second, and the soloed rows flicker. So on Kick (`PLATFORM_DECO.kick.virtual`) the other categories are `visibility:hidden` and keep their place instead of `display:none`.

**What Solo does and does not change:**

| Concern | Behaviour during Solo |
|---|---|
| Category → action mapping | The saved settings, unchanged. Solo never edits `actions` or `preset`. Verdicts, the log, the inbox, waves and counts are computed exactly as without Solo. The tag shows the normal action. |
| Settings changes during Solo | Applied as usual: `reevaluateAll` re-decides the live rows, and rows move in or out of the list live. Dragging strictness in the side panel while soloed on Spam is the tuning loop. Changing X's action keeps Solo on, and the tags update. |
| Protected authors (broadcaster, mods, VIPs, paid, own messages, mentions of the viewer) | Classified as usual. Shown when in X, hidden like the rest when not. Policy change (A, `core/policy.ts`): when `rule.protect` caps an action of dim or stronger to `show`, the reason gets ` · always shown` appended (`toxic · certain · always shown`). The hover chip shows it too. |
| User rules / custom AI filters | Under the category of their verdict. The tag names the source (`blocked: …`, `allowed: …`, `filter: …`). |
| Waves | Heads of X show with `×N`; members stay folded. |
| Counts | `inChat` is unchanged. The Solo pill reads `inChat.byCat[X]`, which equals the number of soloed message rows on screen (wave members excluded on both sides). |
| Re-decide on enter / exit | None: no verdict changes. Enter and exit are a stylesheet swap plus the hold changes below. |
| Hold and birth | While Solo is on, any new row may be hidden. So `holdAtBirth` is true, and `computeHold()` treats the model as able to hide (the `modelCanHide` term), while Solo is on. It still needs a holdable classifier and `holdMs > 0`. The list is marked (no flash of other categories), and rows that need the model are held for up to `holdMs` as usual. Both are recomputed on exit. Rows the model answers late (> `holdMs`) show with their rules-only verdict and may move when the score lands (accepted). |
| "Show in chat" (`reveal(key)`) | If the row's category is not X, Solo ends first, then the row is revealed and scrolled into view. |

**Ending Solo:** `setSolo(null)`, `uiMode` → `'basic'`, Hush or this site off, a channel change or navigation (`detach`), `stop()`. It is never saved, so a reload ends it too.

**Solo on Other (`clean`)** is how a streamer finds what the model missed. It is reachable from the panel's Other row and from the side panel (Other has no chip).

### 5.5 Policy, bridge, docs (A)

- Policy: the ` · always shown` suffix (5.4). Update the policy tests.
- Bridge: v2 snapshot and commands (4.5).
- [architecture.md](architecture.md): rewrite the Flush section (in chat now) and the UI surfaces section (modes, peek and Solo as stylesheet variants). Add `uiMode` to the settings mentioned there. No new row attributes.

## 6. In-chat bar (B)

The `.hb` root gets `data-mode="basic|advanced"`, `data-peek` and `data-solo`. In `ui/bar/index.ts`, the activity pulse reads `view.seen` instead of `view.totals.seen`. Both modes share the mark, menus, tooltips and theme. Basic must not read `inChat`, `rate`, `vibe`, `waves`, `questions` or `perf`, so it never re-renders while chat flows (only on settings, model status, peek, or the open state).

### 6.1 Basic, collapsed row (left to right)

1. **Mark** (30 px button). It opens and closes the sheet; Basic has no chevron.
   - aria-label `Hush options`; tooltip title is the status line (6.6), sub `Click for options`.
   - The ring is gone. It comes back only as model progress:
     - a determinate ring while `downloading` with `progress`;
     - a slow rotating ring (CSS transform, compositor) while `loading`;
     - nothing when `ready` or `idle`.
   - On `error`, an amber dot badge sits on the mark.
2. **Level control.**
   - A `role=radiogroup` labelled `How much should Hush hide?`, with three radios: `Off`, `Clean`, `Quiet`.
   - The selected one comes from `basicLevel(settings, platform)`. When it is `null`, nothing is selected and the thumb is hidden (`data-none`).
   - Each radio's tooltip is its description (6.6).
   - A click calls `actions.setLevel(...)`.
3. **Show hidden** (`aria-pressed`).
   - Off: eye icon + `Show hidden`. On: eye-off icon + `Hide again`.
   - A click calls `actions.setPeek(!peek)`.
   - When the container is narrower than 300 px, it shows the icon only; the aria-label stays.
   - While the level is `off`, the button is replaced by muted, non-interactive text: `Hush is off`, or `Off on Twitch` when only the site is off.

### 6.2 Basic sheet (the expanded panel)

The sheet contains, top to bottom:

1. The status line (6.6). On a model error it has a `Retry` button (`retryModel()`).
2. `How much should Hush hide?` with three radio rows. Each shows a name, its description and, for Clean, a `Recommended` badge.
3. When `basicLevel` is `null` and Hush is on: `You're using a custom setup from Advanced mode. Pick a level to replace it.`
   When it is `off` and the preset is not Clean or Quiet: `Your custom setup from Advanced mode is kept while Hush is off. Turn it back on in Advanced mode, or pick a level to replace it.`
4. When `advancedExtras(settings)` is not empty: `Also on from Advanced mode: ` + the list joined with `, ` + `.`
5. The hint `"Show hidden" brings back anything Hush hid.`
6. An `Advanced mode` switch with the hint `For streamers and mods: categories, stats, rules and custom AI filters.` Turning it on calls `setMode('advanced')`. The bar re-renders as Advanced with the panel still open.
7. Footer: a lock icon and `Runs on your computer. Nothing leaves it.`

It never shows a number.

### 6.3 Advanced, collapsed row

1. **Mark.** Opens the panel; tooltip `Hush` / `Open live view`. The ring follows the same model-progress rule as Basic. The `% hushed` ring and the `CalmText` are removed.
2. **Preset.**
   - Below 520 px it is a pill with a menu; at 520 px and wider, a segmented control (as today).
   - Labels: `Raw`, `Clean`, `Quiet`, `Q&A`, or `Custom`.
   - **During Solo, the Solo pill takes this place** (6.4).
3. **Chips**: one per `CHIP_CATEGORIES` entry, with `compact(inChat.byCat[c])`, as many as fit. The soloed chip comes first, then the categories Hush changes (hide, fold, dim, highlight), then the ones it shows as they are, those with messages in chat now first. The rest wrap out of sight, and a `+N` button (tooltip: their names) opens the panel, which lists all of them. The Solo pill, eye, model dot and chevron never give way to chips (at 340 px: three chips and `+4`).
   - **Click:** `setSolo(c)` when `c` is not soloed, `setSolo(null)` when it is. `aria-pressed` while soloed. During Solo the other chips get `data-faded` and stay clickable (to switch).
   - **Right-click / long-press:** chip menu (6.4).
   - Tooltip title `${SHORT[c]} · ${verb}` (e.g. `Spam · folded`); sub `8 in chat now · Click: show only these · Right-click: change`. When soloed, the sub is `Showing only these · Click: show everything`.
   - aria-label: `Spam, folded, 8 in chat now. Show only spam.`
   - Click-to-cycle is removed. Delete `nextAction` and `ACTION_CYCLE` from `ui/tokens.ts` and their tests.
4. **Show hidden** (eye icon only, `aria-pressed`, tooltip `Show hidden` / `Hide again`). Not shown during Solo.
5. **Model dot**, as today.
6. **Chevron**, as today.

When Hush is off, the row is: mark, `Hush is off`, a `Turn on` button (was `Hush is paused` / `Resume`), model dot, chevron.

### 6.4 Advanced: Solo pill, chip menu, panel

**Solo pill**: an accent-filled button that replaces the preset pill or segmented control.

- Content: category icon + `Only Spam · 8` + `×`. When `byCat[X]` is 0: `Only Scam · none yet`.
- A click calls `setSolo(null)`.
- aria-label `Showing only spam, 8 in chat now. Show all messages.`
- Tooltip `Showing only spam` / `8 in chat now · Esc or × shows everything`.
- The count updates at the 500 ms counter cadence.

**Chip menu**, from right-click or long-press on a chip, or from `▾` on a panel row:

- Header: icon, label, `8 in chat now`, the category description.
- First item: `Show only Spam`, or `Show everything` when Spam is soloed. It calls `setSolo`.
- A divider, then the five action radios: `Show`, `Highlight`, `Dim`, `Fold`, `Hide`. They call `setAction`.

**Preset menu**: header `Preset`. Items Raw, Clean, Quiet and Questions, each with its description. When the preset is custom, the note `Custom: you changed individual categories.`

**Panel** (expanded):

1. **Head**, without Solo:
   - `In chat now` (label), then `152 messages · 9 hidden · 4 folded`.
   - Buttons: `Show hidden` / `Hide again`, and `Turn off`.
2. **Head**, during Solo:
   - `Only Spam: 8 of 152 messages in chat now`.
   - Button: `Show everything`.
3. **Tiles:**
   - `Messages / s · last 60 s` with the last bucket's value and the sparkline.
   - `Mood · last 5 min` with the word and the diverging chart. "Vibe" is renamed to Mood everywhere.
4. **Categories:**
   - Header `Categories · in chat now`; hint `click: show only · ▾: change`.
   - All 8 categories, including `Other` (clean).
   - Each row has icon, name, action verb and `compact(byCat[c])`.
   - **A row click is Solo** (`aria-pressed`). A separate `▾` button (aria-label `Change what happens to spam`) opens the chip menu anchored to it.
5. **Waves**, unchanged (hint `same message, many people`).
6. **Latest questions**: the hint becomes `newest first`; `16 so far` is removed (the count had no window).
7. **Footer:**
   - Model line (`Ready · WebGPU · 47 ms`).
   - `Basic mode`, which calls `setMode('basic')` and keeps the sheet open.
   - `Side panel ↗` (was `Open dashboard`).

### 6.5 Keyboard

While peek or Solo is on, the bar adds one capture `keydown` listener on its document. Esc does the first applicable thing:

1. Close an open menu.
2. Close the open panel.
3. End Solo.
4. End peek.

Esc is ignored when the event's origin (`composedPath()[0]`) is an `input`, a `textarea` or a `contenteditable` element; Twitch's chat box is contenteditable. When it is ignored, the event is left alone. When it is handled, the bar does not call `preventDefault`. The listener is removed when neither view is on and no popover is open.

Chips and panel rows stay buttons: Enter or Space toggles Solo, and the context-menu key or Shift+F10 opens the chip menu.

### 6.6 Bar strings

| Key | Text |
|---|---|
| Status / mark tooltip, on | `Hush is cleaning up this chat.` |
| Status, off | `Hush is off. Chat shows every message.` |
| Status, site off | `Hush is off on Twitch.` (YouTube, Kick) |
| Status, model downloading or loading | `Getting ready… Simple filters already work.` |
| Status, model error | `Hush's AI didn't start. Simple filters still work.` + `Retry` |
| Level group label | `How much should Hush hide?` |
| Off | `Off`: `Shows every message.` |
| Clean (`chill`) | `Clean`: `Hides insults, scams and spam. Questions stand out.` |
| Quiet (`focus`) | `Quiet`: `Also hides one-word replies like "W" and "LOL". Complaints are dimmed.` |
| Raw (Advanced) | `Raw`: `Hides nothing. Marks every message.` |
| Questions (Advanced) | `Questions` (short `Q&A`): `Questions up front, the rest dimmed.` |
| Peek | `Show hidden` / `Hide again`; tooltip sub `Brings back what Hush hid in this tab, faded.` / `Esc also works.` |
| Mode | `Advanced mode` (switch), hint `For streamers and mods: categories, stats, rules and custom AI filters.`; back: `Basic mode` |
| Off row (Advanced) | `Hush is off` + `Turn on`; panel button `Turn off` |
| Never | `hushed`, `Vibe`, `Vibe preset`, `click to cycle`, `Open dashboard`, `Hush is paused`, `Resume` |

`PRESET_META` in `ui/tokens.ts` holds the preset labels and descriptions above (B owns the file; C reads it). Add a `LEVEL_META` with Off, Clean and Quiet (label, description) so the bar, popup, side panel and onboarding render the same words. `ACTION_META` is unchanged.

## 7. Popup, side panel, onboarding (C)

The mode toggle lives in:

- the popup footer (both modes);
- the Basic bar sheet, and the Advanced panel footer as `Basic mode`;
- the Basic side panel page;
- side panel → Settings → `Mode` (first card);
- onboarding step 2.

### 7.1 Popup, Basic (360 px)

1. **Header:** mark, `Hush` and the subtitle. There is no master toggle; Off is a level.
   - Subtitle: `Cleaning up Twitch chat`, `Hush is off`, `Hush is off on Twitch`, or `Open a live stream to start` on other sites.
2. **Model line**, only when not `ready`:
   - downloading or loading: `Getting ready… Simple filters already work.`, with a thin progress bar (no number);
   - error: `Hush's AI didn't start. Simple filters still work.` + `Retry`.
3. **Level cards.** `How much should Hush hide?`, then three cards: `Off`, `Clean`, `Quiet` (`role=radiogroup`). Below them, the description of the selected (or hovered) level.
   - With a custom setup: no card selected, and the custom-setup note from 6.2.
   - When `advancedExtras` is not empty: the `Also on…` line.
   - Picking a level saves the same patch as `setLevel`, with the active tab's platform.
4. **Peek hint**, only on a chat site: `To see what Hush hid, press "Show hidden" above the chat.`
5. **Footer:** the `Advanced mode` switch with its hint, then the privacy line.

No numbers, sparkline, strip, strictness, engine line or side panel button.

### 7.2 Popup, Advanced

Today's popup, with these changes:

- Header subtitle wording from 7.1. The master toggle stays.
- Site card KPIs: `13` / `hidden in chat now` (`inChat.hidden + inChat.folded`), `3` / `msgs/s now`, and `Neutral` / `mood`. The `hushed` KPI is removed.
- The sparkline gets a caption `last 60 s`.
- The category strip is labelled `In chat now`. Its bar and legend use `inChat.byCat`.
- The section `Vibe` becomes `Preset`. Cards use the new labels; `Custom mix` becomes `Custom`.
- Strictness and the model and engine lines are unchanged. `Dashboard` becomes `Side panel`.
- Footer: the `Advanced mode` switch (on) above the privacy line.

### 7.3 Side panel

**Basic** (one page, no tabs; Basic surfaces never link to it):

- Header: mark, channel line.
- Level cards and the notes, as in the popup.
- The `Advanced mode` switch with the hint `Adds live stats, the questions inbox, the hidden-messages log, rules and custom AI filters.`
- The privacy line.

**Advanced** (five tabs, as today):

- **Live:**
  - **Hero:** title `In chat now`, big `13 hidden or folded` (not `13 hidden` above `9 hidden`), sub `9 hidden · 4 folded · 152 messages`, and a button `Show hidden in chat` / `Hide again` (sends `peek`). The ring and the % are removed.
  - Cards: `Messages per second · last 60 s` (now / avg / peak, as today) and `Mood · last 5 min`. Mood is a word in its colour (`Positive`, `Neutral`, `Negative`); its score is only in a tooltip.
  - **Categories:**
    - Card title `Categories · in chat now`.
    - Each row shows the count and a bar with its share of `inChat.rows`, without the % text.
    - Each row also gets an **`Only`** button (sends `solo`) next to the action radios. In the soloed row it reads `Show all` (pressed).
    - While Solo is on, the card shows `Only Spam in chat` + `Show all`.
  - `Engine room` becomes `Performance`. Labels: `Latency p50 · recent`, `Latency p95 · recent`, `Inferences / s · now`, `Cache hits · since this chat opened`.
- **Inbox:** `{n} asked · {m} open` becomes `{n} asked since you opened this panel · {m} open`.
- **Log:**
  - Title `Hidden messages`, sub `What Hush hid or folded since you opened this panel, newest first`.
  - With a category filter selected, the toolbar shows `Show only these in chat` (sends `solo`).
- **Rules:** unchanged.
- **Settings:**
  - New first card `Mode`: a `Basic | Advanced` segmented control with the hint `Advanced adds categories, rules, stats and custom AI filters. Made for streamers. Filtering is the same in both.`
  - `Message decorations` gets the hint `Category tint, question glow, reason on hover (Advanced mode)`.
  - `Bar above chat` gets the hint `The bar with levels and Show hidden (Basic) or presets and categories (Advanced)`.
- **Peek and Solo state:**
  - Read them from the snapshot (`snapshot.peek`, `snapshot.solo`).
  - After sending a command, show the new state at once and keep it until the next snapshot.
  - Disable the buttons while `!snapshot.enabled` or when there is no snapshot.

### 7.4 Onboarding

- **Hero lead:** `Hush is an ad-blocker for live chat. It hides insults, scams and spam on YouTube, Twitch and Kick, and makes questions stand out. A small AI runs on your computer, in any language.`
- **Demo:**
  - The bar is the Basic bar: mark, `Off [Clean] Quiet` and `Show hidden`, decorative only.
  - `38% hushed` / `unfiltered` and the category chips are removed.
  - Rows use `decorationCss('twitch', theme, { mode: 'basic' })`.
- **Step 1 features:**
  - `Hides the ugly`: unchanged text.
  - `Questions stand out`: `Real questions glow softly, so the one person asking something doesn't drown in emotes.`
  - `Folds repeats` (replaces `Reads the room`): `When 37 people type KEKW, you see one line: KEKW ×37.`
- **Step 2:**
  - Title `How much should Hush hide?`, sub `You can change this any time in the bar above chat.`
  - Two cards, `Clean` (with `Recommended`) and `Quiet`, with the descriptions from 6.6 and no category dots.
  - Below them, a checkbox `I stream or moderate. Use Advanced mode (categories, stats, rules, custom AI filters).` It saves `uiMode` at once.
- **Step 3:**
  - Title `Getting ready`.
  - Ready: `Ready. Hush runs on this computer and works offline.`
  - Downloading or loading: `Getting ready…` + progress bar + `About 125 MB, once. Simple filters already work.`
  - Error: `Hush's AI didn't start.` + `Simple filters still work. Hush tries again by itself.` + `Retry`.
  - No layers, backends or WebGPU wording.
- **Good to know:**
  - `"Show hidden" above chat brings back anything Hush hid.`
  - `Click a "2 hidden · show" line to open it.`
  - `The streamer, mods and VIPs are never hidden.`
  - `Streamer or mod? Turn on Advanced mode in the toolbar popup.`
  - The conditional shortcut row stays. No command is defined in the manifest, so don't add copy for one.

### 7.5 README and screenshots (C, with B for chat shots)

**README:**

- Replace `Reads the room` with Basic / Advanced, Show hidden and Solo.
- Rename the presets in the table (Clean, Quiet).
- Rewrite every caption and alt text that mentions "hushed" or a %.

**`tests/ui/shoot.mjs` and the showcase:**

- New query params: `mode=basic|advanced` (default `basic`), `peek`, `solo=<cat>`.
- New shots:
  - B: `chat-twitch-dark-basic`, `-basic-open`, `-basic-peek`, `-basic-off`, `-advanced`, `-advanced-open`, `-advanced-solo`, `-advanced-chipmenu`;
  - C: `popup-basic-*`, `popup-advanced-*`, `sidepanel-basic-*`, `onboarding-*`.
- The `docs/img/live-*.png` captures are retaken on live streams after this ships. That is tracked separately and not part of this spec.

## 8. Mockups

The mockups use these symbols:

| Symbol | Meaning |
|---|---|
| `(~)` | Mark |
| `[x]` | Selected segment |
| `(o)` / `(/)` | Eye / eye-off |
| `~q` | Question glow |
| `:` at a row's start | Dashed "normally not shown" edge |
| `! $ # ~ :( ? +` | Toxic, scam, spam, noise, negative, question, positive |
| `*` | Model dot |
| `v` / `^` | Chevron |
| `+4` | Chips that did not fit (opens the panel) |

Widths are the bar at 340 px and the popup at 360 px.

**A. Basic bar, on (Clean), with chat below**

```text
+----------------------------------------------+
| (~)  Off [Clean] Quiet       (o) Show hidden |
+----------------------------------------------+
| sunny_fox: what rank is he right now      ~q |
|   ( * 2 hidden · show )                      |
| AtomicMole: o7                          ×5   |
| lazy_dog: that clutch was actually insane    |
+----------------------------------------------+
```

There are no category edges and no hover chips. The bar never changes while chat flows.

**A2. Basic, Show hidden pressed (this tab only)**

```text
+----------------------------------------------+
| (~)  Off [Clean] Quiet        (/) Hide again |
+----------------------------------------------+
| sunny_fox: what rank is he right now      ~q |
|:spamton: POGGERS POGGERS P   [Hidden · spam] |
|:crypto_kai: 100x signals i   [Hidden · scam] |
|:  in my bio                                  |
| AtomicMole: o7                          ×5   |
+----------------------------------------------+
```

Peeked rows are faded until hovered. Wave members stay inside `×5`.

**A3. Basic, off · A4. Basic, under 300 px**

```text
+----------------------------------------------+
| (~)  [Off] Clean Quiet           Hush is off |
+----------------------------------------------+

+------------------------------------+
| (~)  Off [Clean] Quiet         (o) |
+------------------------------------+
```

**B. Basic sheet (mark clicked)**

```text
+----------------------------------------------+
| (~)  Off [Clean] Quiet       (o) Show hidden |
+----------------------------------------------+
| Hush is cleaning up this chat.               |
|                                              |
| How much should Hush hide?                   |
|  ( ) Off     Shows every message.            |
|  (*) Clean   Hides insults, scams and spam.  |
|              Questions stand out.            |
|              [Recommended]                   |
|  ( ) Quiet   Also hides one-word replies     |
|              like "W" and "LOL". Complaints  |
|              are dimmed.                     |
|                                              |
| "Show hidden" brings back anything Hush hid. |
|                                              |
| Advanced mode                          [o  ] |
| For streamers and mods: categories, stats,   |
| rules and custom AI filters.                 |
+----------------------------------------------+
| [lock] Runs on your computer. Nothing leaves |
|        it.                                   |
+----------------------------------------------+
```

**B2. Basic sheet: model loading, custom setup, extras**

```text
+----------------------------------------------+
| (@)  Off  Clean  Quiet       (o) Show hidden |
+----------------------------------------------+
| Getting ready… Simple filters already work.  |
|                                              |
| How much should Hush hide?                   |
|  ( ) Off     Shows every message.            |
|  ( ) Clean   Hides insults, scams and spam.  |
|  ( ) Quiet   Also hides one-word replies ... |
| You're using a custom setup from Advanced    |
| mode. Pick a level to replace it.            |
| Also on from Advanced mode: your rules,      |
| custom AI filters.                           |
+----------------------------------------------+
```

`(@)` is the mark with the progress ring. No stop is selected because the preset is custom.

**C. Advanced bar (counts = in chat now)**

```text
+----------------------------------------------+
| (~) Clean v  !1  $0  #8  +4      (o)   *   v |
+----------------------------------------------+
```

- Chip click: show only that category. Right-click or long-press: change its action.
- The `%` ring and the "hushed" text are gone.

**D. Advanced, Solo on Spam**

```text
+----------------------------------------------+
| (~) [# Only Spam · 8  ×] [#]  !     +5  *  v |
+----------------------------------------------+
|:spamton: POGGERS P [spam · certain · folded] |
|:lazy_dog: LOL LOL LOL L [repeat ×4 · folded] |
| mod_rex: no spoilers  [spam · very likely ·  |
|   pls no spoilers          always shown]     |
|:bot_ivy: follow 4 fo [blocked: f4f · hidden] |
+----------------------------------------------+
```

- Every other category is hidden. The other chips are faded and switch Solo with one click.
- Esc or × shows everything.
- Empty state for the pill: `[$ Only Scam · none yet  ×]`.

**E. Advanced panel (expanded)**

```text
+----------------------------------------------+
| (~) Clean v  !1  $0  #8  +4      (o)   *   ^ |
+----------------------------------------------+
| IN CHAT NOW                                  |
| 152 messages · 9 hidden · 4 folded           |
|              [(o) Show hidden]  [Turn off]   |
| +--------------------+ +-------------------+ |
| | MESSAGES / S       | | MOOD     Neutral  | |
| | last 60 s        3 | | last 5 min        | |
| | ~~~~~~~~~~~~~~~~~~ | | ~~~~~~~~~~~~~~~~~ | |
| +--------------------+ +-------------------+ |
| CATEGORIES · in chat now                     |
|          click: show only · v: change        |
| ! Toxic  Hidden  1 v | $ Scam  Hidden   0 v  |
| # Spam   Folded  8 v | ~ Noise Shown  158 v  |
| :( Neg.  Shown  22 v | ? Quest. Highl.  3 v  |
| + Pos.   Shown  10 v | o Other Shown   85 v  |
| WAVES              same message, many people |
| YEP ×18   o7 ×8   MYHORSE ×6                 |
| LATEST QUESTIONS                newest first |
| ? SleepyOrca  Who would the Queen be?   now  |
+----------------------------------------------+
| * Ready · WebGPU · 47 ms                     |
|                     Basic mode  Side panel ↗ |
+----------------------------------------------+
```

**E2. Chip menu (right-click on Spam)**

```text
+------------------------------------+
| # Spam               8 in chat now |
|   Floods, copypasta, emote walls   |
+------------------------------------+
| (o) Show only Spam                 |
+------------------------------------+
|     Show                           |
|     Highlight                      |
|     Dim                            |
|  v  Fold                           |
|     Hide                           |
+------------------------------------+
```

**F. Popup, Basic**

```text
+------------------------------------------+
|  (~) Hush                                |
|      Cleaning up Twitch chat             |
|                                          |
|  How much should Hush hide?              |
|  +----------+ +----------+ +----------+  |
|  |   Off    | | * Clean  | |  Quiet   |  |
|  +----------+ +----------+ +----------+  |
|  Hides insults, scams and spam.          |
|  Questions stand out.                    |
|                                          |
|  To see what Hush hid, press "Show       |
|  hidden" above the chat.                 |
+------------------------------------------+
|  Advanced mode                    [o  ]  |
|  For streamers and mods: categories,     |
|  stats, rules and custom AI filters.     |
+------------------------------------------+
|  [lock] Runs on your computer. Nothing   |
|         leaves it.                       |
+------------------------------------------+
```

When the model is not ready, `Getting ready… Simple filters already work.` and a thin bar sit under the subtitle. On error the line is `Hush's AI didn't start. Simple filters still work.` with `[Retry]`.

**G. Popup, Advanced**

```text
+------------------------------------------+
|  (~) Hush                         [  o]  |
|      Cleaning up Twitch chat             |
|  +------------------------------------+  |
|  | [tw] caedrel                [  o]  |  |
|  |      * Live chat on Twitch         |  |
|  |  13           3           Neutral  |  |
|  |  hidden in    msgs/s now  mood     |  |
|  |  chat now                          |  |
|  |  ~~~~~~~~~~~~~~~~~~~~~~ last 60 s  |  |
|  |  IN CHAT NOW  [#|=========|==|=]   |  |
|  |  ! 1 toxic  $ 0 scam  # 8 spam     |  |
|  +------------------------------------+  |
|  PRESET                                  |
|  [ Raw ] [*Clean*] [ Quiet ] [Questions] |
|  Hides insults, scams and spam.          |
|  STRICTNESS                     Balanced |
|  Lenient ------------o----------- Strict |
+------------------------------------------+
|  * Ready · WebGPU        [Side panel ->] |
|    Hush Lite · 6 layers · on-device      |
|  Advanced mode                    [  o]  |
|  [lock] Runs on your computer. Nothing   |
|         leaves it.                       |
+------------------------------------------+
```

**H. Side panel, Basic**

```text
+--------------------------------------+
| (~) Hush            [tw] caedrel     |
+--------------------------------------+
| How much should Hush hide?           |
|  ( ) Off    Shows every message.     |
|  (*) Clean  Hides insults, scams     |
|             and spam. Questions      |
|             stand out.               |
|  ( ) Quiet  Also hides one-word      |
|             replies like "W" and     |
|             "LOL". Complaints are    |
|             dimmed.                  |
|                                      |
| Advanced mode                 [o  ]  |
| Adds live stats, the questions       |
| inbox, the hidden-messages log,      |
| rules and custom AI filters.         |
|                                      |
| [lock] Runs on your computer.        |
+--------------------------------------+
```

**I. Side panel, Advanced, Live tab**

```text
+--------------------------------------+
| (~) Hush   [tw] caedrel · Live [  o] |
| Live   Inbox   Log   Rules  Settings |
+--------------------------------------+
| IN CHAT NOW [(o) Show hidden in chat]|
| 13 hidden or folded                  |
| 9 hidden · 4 folded · 152 messages   |
+--------------------------------------+
| Messages per second · last 60 s      |
|   3 now · avg 2.4 · peak 7           |
| Mood · last 5 min           Neutral  |
+--------------------------------------+
| CATEGORIES · in chat now   [Clean v] |
| ! Toxic      1 =     [Only] s h d f H|
| # Spam       8 ==  [Show all] s h d F|
| ~ Noise    158 ========== [Only] S...|
| o Other     85 =====      [Only] S...|
+--------------------------------------+
| Only Spam in chat         [Show all] |
+--------------------------------------+
```

The letters after `[Only]` are today's five action radios.

**J. Onboarding, step 2**

```text
2  How much should Hush hide?
   You can change this any time in the bar above chat.

   +-----------------------------+  +-----------------------------+
   | Clean               (*)     |  | Quiet               ( )     |
   | Hides insults, scams and    |  | Also hides one-word replies |
   | spam. Questions stand out.  |  | like "W" and "LOL".         |
   | [Recommended]               |  | Complaints are dimmed.      |
   +-----------------------------+  +-----------------------------+

   [ ] I stream or moderate. Use Advanced mode
       (categories, stats, rules, custom AI filters).
```

## 9. Acceptance checklist

Each item is a statement a test or a manual check can confirm. "Live" means the manual check on Twitch in Edge.

### Core (A)

- [ ] **A1** A fresh `mergeSettings(undefined)` has `uiMode: 'basic'`. Stored settings without `uiMode`, or with an unknown value, merge to `'basic'`; `'advanced'` is kept. `filterDefaults()` has no `uiMode`.
- [ ] **A2** `basicLevel`:
  - `{enabled:false}` → `'off'`;
  - `sites.twitch=false` with platform twitch → `'off'`;
  - preset chill → `'chill'`, focus → `'focus'`;
  - raw, questions or custom → `null`.
- [ ] **A3** `advancedExtras(DEFAULT_SETTINGS)` is `[]`. With one enabled rule, it is `['your rules']`.
- [ ] **A4** `setLevel('focus')` makes one `save()` call with `enabled:true`, the current site on, `preset:'focus'` and `PRESETS.focus` actions. `setLevel('off')` saves only `{enabled:false}`.
- [ ] **A5** After any sequence of row adds, verdict changes, reveals, removals, recycled nodes and Kick-style re-mounts (same key, new node), `inChat` equals a recount over the list:
  - `rows` = rows with a verdict;
  - `hidden` = `data-hush-a="hide"`;
  - `folded` = `collapse` without `data-hush-wm`;
  - `inWaves` = `data-hush-wm`;
  - `byCat[c]` = `data-hush-c=c` without `data-hush-wm`;
  - and `Σ byCat + inWaves === rows`. Fake adapter, runtime test.
- [ ] **A6** With 100 decided rows on screen, setting every category to Hide gives `inChat.hidden === 100` in the next store flush (≤ 250 ms after the frame). Setting Spam back to Show lowers it by exactly the number of spam rows.
- [ ] **A7** Turning Hush off zeroes `inChat`, and the store is flushed (not frozen).
- [ ] **A8** `setPeek(true/false)` and `setSolo(x/null)` cause **zero attribute mutations on message rows** (MutationObserver on the list) and change only the stylesheet text.
- [ ] **A9** Peek stylesheet:
  - has no `display:none` for `[data-hush-a="hide"]` or folded rows;
  - still has it for `[data-hush-wm]:not([data-hush-open])`;
  - emits no `data-hush-run` rules;
  - every selector is attribute-only (decorations test).
- [ ] **A10** Solo stylesheet for `spam` contains `[data-hush-c]:not([data-hush-c="spam"])` with `display:none!important`, and spam rows with `hide` or `collapse` are not `display:none`.
- [ ] **A11** `setSolo('spam')` is a no-op while `uiMode === 'basic'` or Hush is off. Solo ends when:
  - `uiMode` changes to basic;
  - Hush is turned off;
  - the site is turned off;
  - the channel changes.
- [ ] **A12** Entering Solo turns peek off. Peek ends when Hush is off or the channel changes, and survives a level or mode change.
- [ ] **A13** While peek or Solo is on, a click or Enter on a folded row does not set `data-hush-open`, and the platform's own click handler still receives the event.
- [ ] **A14** While Solo is on, the list carries `data-hush-list` even with preset Raw, and rows that need the model are held up to `holdMs`. After exit both return to their usual values.
- [ ] **A15** `reveal(key)` of a row outside the soloed category ends Solo and reveals the row.
- [ ] **A16** A protected author's toxic message at 94% gets reason `toxic · certain · always shown` and action `show`.
- [ ] **A17** The snapshot has `v: 2` with `inChat`, `peek` and `solo`, and no `counts` or `totals`. The `solo` command with `cat: 'nope'` is ignored. `peek` and `solo` commands reach the runtime.
- [ ] **A18** The stress harness at 100 and 200 msg/s shows no regression in per-message main-thread cost compared with today: the tally adds O(1) per write.

### In-chat bar (B)

- [ ] **B1** Basic collapsed renders exactly: mark, a radiogroup labelled "How much should Hush hide?" with Off / Clean / Quiet, and the Show hidden button. It has no chevron, no chips and no model dot.
- [ ] **B2** The Basic bar's and sheet's text content contains no digit and no `%` while chat flows at 50 msg/s. The Basic bar's Preact tree does not re-render on store `inChat`, `rate` or `vibe` updates (render counter in the test).
- [ ] **B3** The Basic radio follows `basicLevel`. With preset custom, no radio is `aria-checked`, and the sheet shows the custom-setup note.
- [ ] **B4** When Hush is off, the Basic row shows `Hush is off` instead of Show hidden.
- [ ] **B5** Show hidden toggles `aria-pressed` and its label (`Show hidden` / `Hide again`), and calls `setPeek`. Under a 300 px container it shows the icon only, with the aria-label kept.
- [ ] **B6** The sheet's `Advanced mode` switch calls `setMode('advanced')`. The Advanced footer's `Basic mode` calls `setMode('basic')`.
- [ ] **B7** In Advanced, a chip click calls `setSolo(cat)` and never `setAction`. A second click on the soloed chip calls `setSolo(null)`. A right-click opens the menu, whose first item is `Show only <Cat>`.
- [ ] **B8** During Solo, the preset pill is replaced by `Only Spam · 8 ×`, with 8 = `inChat.byCat.spam`. With 0 it reads `Only Spam · none yet`. Clicking it calls `setSolo(null)`.
- [ ] **B9** Esc during Solo calls `setSolo(null)`. With the chat input (`contenteditable`) focused, Esc does nothing. With a menu open, Esc closes the menu first.
- [ ] **B10** Panel category rows: a click toggles Solo, `▾` opens the action menu, and `Other` is present. The head reads `152 messages · 9 hidden · 4 folded` from `inChat`.
- [ ] **B11** No surface of the bar contains the strings `hushed`, `Vibe`, `click to cycle`, `Open dashboard` or `Hush is paused`. `nextAction` no longer exists.
- [ ] **B12** Advanced chip counters still update at most 2× per second (view cadence 500 ms), and Basic animation is transform or opacity only (CSS review).
- [ ] **B13** Live: on Twitch at 340 px, the Basic row fits on one line in both themes, and Kick and YouTube look native.

### Popup, side panel, onboarding (C)

- [ ] **C1** The Basic popup shows the 3 level cards, the Advanced mode switch and the privacy line. It has no master toggle, no digits, no sparkline, no strictness and no side panel button.
- [ ] **C2** Picking Clean in the Basic popup on a Twitch tab with Twitch off turns Twitch on and sets preset chill in one save.
- [ ] **C3** The Advanced popup has no `hushed`. Its first KPI is `hidden in chat now` = `inChat.hidden + inChat.folded`. The presets read Raw / Clean / Quiet / Questions.
- [ ] **C4** With `uiMode: 'basic'`, the side panel renders the Basic page without tabs. Switching to Advanced shows the tabs without a reload.
- [ ] **C5** On the Advanced Live tab, `Only` on Spam sends `{type:'solo', cat:'spam'}`. The row shows `Show all` pressed at once and stays so after the next snapshot.
- [ ] **C6** The Live hero shows `In chat now` with numbers from `inChat`, without a ring or %. Every other number on the Live, Inbox and Log tabs has a window label (`last 60 s`, `last 5 min`, `since you opened this panel`, `since this chat opened`, `recent`, `now`).
- [ ] **C7** Settings has a `Mode` card first. Switching it changes `uiMode` and nothing else (snapshot of the other settings before and after).
- [ ] **C8** Onboarding step 2 shows Clean (Recommended) and Quiet plus the Advanced checkbox. The demo bar shows no `%`. There is no "Reads the room" or "calm meter".
- [ ] **C9** README: no "hushed" or "%" claims about the bar, and presets are named Clean / Quiet.

### End to end (live, Twitch in Edge)

- [ ] **E1** A new profile installs, opens a Twitch channel and sees the Basic bar with Clean selected. Spam folds into pills and toxic messages disappear. There are no numbers in Hush's UI.
- [ ] **E2** Show hidden brings back the hidden and folded messages faded, with `Hidden · spam` style tags. Hide again restores the view, and new messages follow the current view in both states.
- [ ] **E3** Advanced → set all categories to Hide → the panel head reads about `150 hidden` (Twitch's list) within 1 s. Setting Noise to Show drops it within 1 s.
- [ ] **E4** Advanced → click the Spam chip → only spam rows remain, each with a visible tag. The pill count equals the number of visible spam rows. Dragging strictness in the side panel moves rows in and out live. Esc restores everything.
- [ ] **E5** Switching Basic ↔ Advanced never changes which messages are hidden (compare the `data-hush-a` values before and after).

## 10. Out of scope / later

- **Solo by custom AI filter** (streamer-pro). This needs a `verdict.filter` id and a row attribute. Today a filter hit keeps the model's category and only changes the reason.
- A **"Fade the rest"** option in Solo for recall checks.
- A **"Recently hidden" page** in the Basic side panel.
- Retaking the `docs/img/live-*.png` captures.
- A keyboard command for on/off (not in the manifest today).
