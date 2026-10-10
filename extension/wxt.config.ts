import path from 'node:path';
import { defineConfig } from 'wxt';

/**
 * Host permissions for the remote model source (WXT_HUSH_MODEL_URL): its
 * origin, plus Hugging Face's file CDN when it is a Hugging Face `resolve/`
 * URL (those redirect there). None without one: such a build bundles the model
 * or filters with rules only (modules/hush-inference.ts).
 */
function modelHosts(url: string | undefined): string[] {
  if (!url) return [];
  const u = URL.parse(url);
  if (u?.protocol !== 'https:' && u?.protocol !== 'http:') throw new Error(`WXT_HUSH_MODEL_URL must be an http(s) URL, got "${url}"`);
  const hf = /(^|\.)(huggingface\.co|hf\.co)$/.test(u.hostname);
  return [`${u.origin}/*`, ...(hf ? ['https://*.hf.co/*'] : [])];
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  // Separate outDirs let parallel builds (tests, agents) not clobber each other.
  outDir: process.env.HUSH_OUT ?? '.output',
  vite: () => ({
    // Preact JSX via the built-in transformer (no plugin needed).
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  }),
  // A function so it runs after WXT has loaded .env files (WXT_HUSH_MODEL_URL may come from one).
  manifest: () => ({
    name: 'Hush — live chat filter',
    short_name: 'Hush',
    description:
      'An ad-blocker for live chat. On-device AI hides spam, scams and toxicity on YouTube, Twitch and Kick — in any language.',
    homepage_url: 'https://github.com/daradudai/hush',
    // scripting: inject the content script into chats already open on install / update (background.ts)
    permissions: ['storage', 'offscreen', 'sidePanel', 'unlimitedStorage', 'scripting'],
    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.twitch.tv/*',
      '*://kick.com/*',
      '*://*.kick.com/*',
      // Hush Engine
      'http://127.0.0.1/*',
      'http://localhost/*',
      ...modelHosts(process.env.WXT_HUSH_MODEL_URL),
    ],
    // WASM + WebGPU inference inside extension pages.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: { default_title: 'Hush' },
    side_panel: { default_path: 'sidepanel.html' },
    minimum_chrome_version: '124',
  }),
  hooks: {
    // A build is a copy of Hush and of what it bundles (ONNX Runtime, Transformers.js, Preact, the model),
    // so it carries the repo's license and third-party notices.
    'build:publicAssets': (wxt, files) => {
      for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) files.push({ absoluteSrc: path.resolve(wxt.config.root, '..', f), relativeDest: f });
    },
  },
});
