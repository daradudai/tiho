import path from 'node:path';
import { defineConfig } from 'wxt';

/**
 * Host permissions for the remote model source (WXT_TIHO_MODEL_URL): its
 * origin, plus Hugging Face's file CDN when it is a Hugging Face `resolve/`
 * URL (those redirect there). None without one: such a build bundles the model
 * or filters with rules only (modules/tiho-inference.ts).
 */
function modelHosts(url: string | undefined): string[] {
  if (!url) return [];
  const u = URL.parse(url);
  if (u?.protocol !== 'https:' && u?.protocol !== 'http:') throw new Error(`WXT_TIHO_MODEL_URL must be an http(s) URL, got "${url}"`);
  const hf = /(^|\.)(huggingface\.co|hf\.co)$/.test(u.hostname);
  return [`${u.origin}/*`, ...(hf ? ['https://*.hf.co/*'] : [])];
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  // Separate outDirs let parallel builds (tests, agents) not clobber each other.
  outDir: process.env.TIHO_OUT ?? '.output',
  vite: () => ({
    // Preact JSX via the built-in transformer (no plugin needed).
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  }),
  // A function so it runs after WXT has loaded .env files (WXT_TIHO_MODEL_URL may come from one).
  manifest: () => ({
    name: 'Tiho — live chat filter',
    short_name: 'Tiho',
    // name, short_name and description are the Chrome Web Store listing title and summary (docs/store/chrome-web-store.md).
    description: 'Hides spam, scam links and abuse in YouTube, Twitch and Kick live chat. A small AI model runs on your own computer.',
    homepage_url: 'https://tiho.chat',
    // scripting: inject the content script into chats already open on install / update (background.ts).
    // No unlimitedStorage: the model is bundled; a WXT_TIHO_MODEL_URL build caches one model file and
    // the tokenizer (about 126 MB) in Cache Storage, which the normal origin quota covers.
    permissions: ['storage', 'offscreen', 'sidePanel', 'scripting'],
    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.twitch.tv/*',
      '*://kick.com/*',
      '*://*.kick.com/*',
      // Tiho Engine
      'http://127.0.0.1/*',
      'http://localhost/*',
      ...modelHosts(process.env.WXT_TIHO_MODEL_URL),
    ],
    // WASM + WebGPU inference inside extension pages.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: { default_title: 'Tiho' },
    side_panel: { default_path: 'sidepanel.html' },
    minimum_chrome_version: '124',
  }),
  hooks: {
    // A build is a copy of Tiho and of what it bundles (ONNX Runtime, Transformers.js, Preact, the model),
    // so it carries the repo's license and third-party notices.
    'build:publicAssets': (wxt, files) => {
      for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) files.push({ absoluteSrc: path.resolve(wxt.config.root, '..', f), relativeDest: f });
    },
  },
});
