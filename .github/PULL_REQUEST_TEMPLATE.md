## What and why

<!-- What does this change, and why? Link the issue: "Fixes #123". -->

## How I tested it

<!-- Commands you ran and what you saw. For UI changes, screenshots (light and dark). -->

- [ ] `npx tsc --noEmit` and `npx vitest run` in `extension/`
- [ ] `npm run build` in `extension/`, loaded unpacked and tried on a live chat
- [ ] `pytest -q -m "not integration"` in `engine/` (if the engine changed)

## Checklist

- [ ] No chat text leaves the device; no new network destinations, analytics or remote code
- [ ] Content-script hot path: no layout reads, writes batched per frame, memory bounded
  (if `src/runtime`, `src/core` or `src/platforms` changed: stress numbers before / after below)
- [ ] Adapter changes come with a sanitized fixture and a test
- [ ] SPEC.md, READMEs and the model card still match the code
