import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  vite: () => ({
    plugins: [preact()],
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  }),
  manifest: {
    name: 'Hush — live chat filter',
    short_name: 'Hush',
    description:
      'An ad-blocker for live chat. On-device AI hides spam, scams and toxicity on YouTube, Twitch and Kick — in any language.',
    permissions: ['storage', 'offscreen', 'sidePanel', 'unlimitedStorage'],
    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.twitch.tv/*',
      '*://kick.com/*',
      '*://*.kick.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
      'https://huggingface.co/*',
      'https://*.hf.co/*',
    ],
    // WASM + WebGPU inference inside extension pages.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: { default_title: 'Hush' },
    side_panel: { default_path: 'sidepanel.html' },
    minimum_chrome_version: '124',
  },
});
