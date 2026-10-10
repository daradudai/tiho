// Sample real chat lines from ml/data/raw/*.jsonl into tests/stress/.corpus/corpus.json
// (git-ignored: raw chat logs are never committed).
//
//   node tests/stress/make-corpus.mjs [count=20000] [seed=7]
//
// Output: { messages: [{ u, r, s, b, f }] } where
//   u = user login, r = roles bitmask (Role.*), b = bits (0 = none), f = first-time chatter
//   s = segments: string (text) | [code] (emote image)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawDir = path.resolve(here, '../../../ml/data/raw');
const outDir = path.join(here, '.corpus');
const count = Number(process.argv[2] ?? 20000);
let seed = Number(process.argv[3] ?? 7);
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const ROLE = { broadcaster: 1, moderator: 2, 'lead_moderator': 2, vip: 4, subscriber: 8, founder: 8, partner: 32 };

function roles(badges) {
  let r = 0;
  for (const b of (badges || '').split(',')) r |= ROLE[b.split('/')[0]] ?? 0;
  return r;
}

/** IRC emote ranges ("25:0-4,12-16/1902:6-10", code-point indices) → segments. */
function segments(text, emotes) {
  if (!emotes) return [text];
  const cps = Array.from(text);
  const ranges = [];
  for (const part of emotes.split('/')) {
    const [, pos] = part.split(':');
    if (!pos) continue;
    for (const r of pos.split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) ranges.push([a, b]);
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const out = [];
  let i = 0;
  for (const [a, b] of ranges) {
    if (a < i || b >= cps.length) continue;
    if (a > i) out.push(cps.slice(i, a).join(''));
    out.push([cps.slice(a, b + 1).join('')]);
    i = b + 1;
  }
  if (i < cps.length) out.push(cps.slice(i).join(''));
  return out;
}

const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.jsonl')) : [];
if (!files.length) {
  console.error(`no raw chat logs in ${rawDir}`);
  process.exit(1);
}

const all = [];
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(rawDir, f), 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.text !== 'string' || !j.text.trim()) continue;
      all.push({
        u: String(j.u || j.uid || 'anon'),
        r: roles(j.badges),
        s: segments(j.text, j.emotes),
        b: Number(j.bits) || 0,
        f: j.first ? 1 : 0,
      });
    } catch {
      /* skip bad line */
    }
  }
}

// Uniform sample, original order kept (natural local bursts survive).
const idx = all.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const pick = idx.slice(0, Math.min(count, idx.length)).sort((a, b) => a - b).map((i) => all[i]);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify({ messages: pick }));
const emotes = pick.filter((m) => m.s.some((x) => Array.isArray(x))).length;
console.log(`corpus: ${pick.length} of ${all.length} lines (${emotes} with emotes) → ${path.join(outDir, 'corpus.json')}`);
