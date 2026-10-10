// Renders the Hush mark (src/assets/logo.svg geometry) into the extension's
// toolbar / store icons: public/icon/{16,32,48,96,128}.png
//
//   node tests/ui/render-icons.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../public/icon');
fs.mkdirSync(outDir, { recursive: true });

const BUBBLE =
  'M16 3.5C22.9 3.5 28.5 8.2 28.5 14C28.5 19.8 22.9 24.5 16 24.5C14.5 24.5 13.1 24.3 11.8 23.9C10.2 25.4 7.9 26.6 5.2 27C6.4 25.6 7.1 24 7.3 22.4C4.9 20.5 3.5 17.4 3.5 14C3.5 8.2 9.1 3.5 16 3.5Z';
const WAVE =
  'M9 14 C9.75 9.47 11.25 9.47 12 14 C12.75 17.07 14.25 17.07 15 14 C15.75 12.53 17.25 12.53 18 14 C18.63 14.47 19.88 14.47 20.5 14 C21.13 14 22.38 14 23 14';

// Small sizes: tight crop + heavier wave so it survives 16px.
const variants = {
  16: { vb: '3 2.6 26.2 26.2', stroke: 2.9 },
  32: { vb: '3 2.6 26.2 26.2', stroke: 2.6 },
  48: { vb: '2.4 2 27.4 27.4', stroke: 2.4 },
  96: { vb: '0.6 0.2 31 31', stroke: 2.3 },
  128: { vb: '-0.4 -0.8 33 33', stroke: 2.3 },
};

const svg = (vb, stroke, size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}">
  <defs>
    <linearGradient id="g" x1="4" y1="3" x2="29" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7c83ff"/><stop offset="0.55" stop-color="#a78bfa"/><stop offset="1" stop-color="#5ab2ff"/>
    </linearGradient>
    <linearGradient id="s" x1="16" y1="3.5" x2="16" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="${BUBBLE}" fill="url(#g)"/>
  ${size >= 48 ? `<path d="${BUBBLE}" fill="url(#s)"/>` : ''}
  <path d="${WAVE}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, v] of Object.entries(variants)) {
  const n = Number(size);
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg(v.vb, v.stroke, n)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: path.join(outDir, `${n}.png`), omitBackground: true });
  console.log('wrote', path.join(outDir, `${n}.png`));
}
await browser.close();
