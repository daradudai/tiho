// Tokenizer parity: transformers.js (what the worker runs) vs HF tokenizers in Python
// (what training used), on real chat lines, with the worker's preprocessing
// (whitespace collapse + truncation to max_len keeping EOS).
//
//   node tests/bench/make-sample.mjs        # once
//   node tests/bench/tokenizer-parity.mjs [modelDir=public/models/tiho-lite]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const modelDir = path.resolve(root, process.argv[2] ?? 'public/models/tiho-lite');
const py = path.resolve(root, '../ml/.venv/Scripts/python.exe');
const sample = JSON.parse(fs.readFileSync(path.join(here, '.data/chat_sample.json'), 'utf8')).map((r) => r.text);
const texts = [...sample, 'x '.repeat(200), 'ab'.repeat(100), '🔥'.repeat(90), 'KEKW '.repeat(70), 'a  b\t\tc'];
const clean = (t) => (t.length > 1024 ? t.slice(0, 1024) : t).replace(/\s+/g, ' ').trim();
const cfg = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
const maxLen = cfg.tiho?.max_len ?? cfg.tiho?.max_length ?? 64;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiho-tok-'));
fs.writeFileSync(path.join(tmp, 'in.json'), JSON.stringify(texts.map(clean)));
execFileSync(py, [
  '-c',
  `import json,sys
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(sys.argv[1])
t = json.load(open(sys.argv[2], encoding='utf-8'))
json.dump(tok(t, truncation=True, max_length=int(sys.argv[4]))['input_ids'], open(sys.argv[3], 'w'))`,
  modelDir,
  path.join(tmp, 'in.json'),
  path.join(tmp, 'out.json'),
  String(maxLen),
]);
const ref = JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });

const { PreTrainedTokenizer } = await import(
  pathToFileURL(path.join(root, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href
);
const tok = new PreTrainedTokenizer(
  JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8')),
);
const probe = tok.encode('a');
const eos = probe[probe.length - 1];
const tokenize = (t) => {
  const ids = tok.encode(clean(t));
  if (ids.length <= maxLen) return ids;
  const c = ids.slice(0, maxLen);
  c[maxLen - 1] = eos;
  return c;
};

let bad = 0;
const t0 = performance.now();
for (let i = 0; i < texts.length; i++) {
  const a = tokenize(texts[i]);
  const b = ref[i];
  if (a.length !== b.length || a.some((x, j) => x !== b[j])) {
    if (bad++ < 10) console.log('MISMATCH', JSON.stringify(texts[i]).slice(0, 100), '\n  js', a.join(','), '\n  py', b.join(','));
  }
}
const us = ((performance.now() - t0) / texts.length) * 1000;
console.log(`checked ${texts.length} texts: ${bad} mismatches; JS tokenize ${us.toFixed(0)} µs/text`);
process.exit(bad ? 1 : 0);
