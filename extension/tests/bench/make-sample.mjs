// Sample real chat texts from ml/data/raw/*.jsonl into tests/bench/.data/chat_sample.json
// (git-ignored). Usage: node tests/bench/make-sample.mjs [count=4000]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.resolve(here, '../../../ml/data/raw');
const outDir = path.join(here, '.data');
const N = Number(process.argv[2] ?? 4000);

// Deterministic PRNG (mulberry32) so runs are comparable.
let seed = 1234567;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.jsonl'));
const reservoir = [];
let seen = 0;
const uniq = new Set();
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(rawDir, f), 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || uniq.has(text)) continue;
    uniq.add(text);
    const item = { text, lang: o.lang ?? '', p: o.p ?? '' };
    seen++;
    if (reservoir.length < N) reservoir.push(item);
    else {
      const j = Math.floor(rand() * seen);
      if (j < N) reservoir[j] = item;
    }
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'chat_sample.json'), JSON.stringify(reservoir));
const langs = {};
for (const r of reservoir) langs[r.lang] = (langs[r.lang] ?? 0) + 1;
console.log(`sampled ${reservoir.length} of ${seen} unique texts from ${files.length} files`, langs);
