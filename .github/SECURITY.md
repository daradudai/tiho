# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: **[Report a vulnerability](https://github.com/daradudai/hush/security/advisories/new)** (Security tab → Advisories). Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. We aim to reply within a week. Fixes for confirmed issues ship as soon as they are ready, and you are credited in the advisory unless you prefer not to be.

## Scope

Especially interesting:

- **Hush Engine** (`engine/`), a local HTTP server: anything that lets a web page or another machine reach it or the `llama-server` it starts (CORS, Private Network Access, DNS rebinding, `Host` checks, the API key), read cached message text, or make it run commands.
- **The extension**: a chat message or page that can run script in an extension context, break out of the in-chat bar's shadow DOM, or make Hush send data anywhere.
- **Model downloads** (builds made with `WXT_HUSH_MODEL_URL`): loading model files from anywhere other than the configured source, or using a file that does not match the hash pinned in the build.

Out of scope: a message the model classifies wrongly (please use the wrong verdict issue template), and attacks that need someone who already controls your browser profile or your computer.

## Supported versions

Only the latest release gets security fixes.
