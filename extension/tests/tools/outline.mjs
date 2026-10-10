// Throwaway: print a structural outline of an HTML file.
//   node tests/tools/outline.mjs <file.html> [selector] [maxDepth] [maxChildren]
import { Window } from 'happy-dom';
import fs from 'node:fs';

const [file, selector, depthArg, kidsArg] = process.argv.slice(2);
const maxDepth = Number(depthArg ?? 40);
const maxKids = Number(kidsArg ?? 6);
const win = new Window();
const doc = win.document;
doc.body.innerHTML = fs.readFileSync(file, 'utf8');
const root = selector ? doc.querySelector(selector) : doc.body;
if (!root) {
  console.log('no match');
  process.exit(1);
}
const SKIP = new Set(['svg', 'path', 'g', 'defs', 'clippath', 'rect', 'circle', 'mask']);
function line(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = el.getAttribute('class');
  if (cls) s += '.' + cls.trim().split(/\s+/).filter((c) => !/^(Layout|InjectLayout|Sc[A-Z])/.test(c) || true).slice(0, 6).join('.');
  for (const a of el.attributes) {
    if (a.name === 'class' || a.name === 'id' || a.name === 'style') continue;
    s += ` ${a.name}="${a.value.slice(0, 60)}"`;
  }
  return s;
}
function walk(el, d) {
  if (d > maxDepth) return;
  const pad = '  '.repeat(d);
  console.log(pad + line(el) + (el.children.length ? ` [${el.children.length}]` : ''));
  let txt = '';
  for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent;
  txt = txt.trim();
  if (txt) console.log(pad + '  "' + txt.slice(0, 80) + '"');
  if (SKIP.has(el.tagName.toLowerCase())) return;
  let i = 0;
  for (const c of el.children) {
    if (i++ >= maxKids) {
      console.log(pad + `  … ${el.children.length - maxKids} more`);
      break;
    }
    walk(c, d + 1);
  }
}
walk(root, 0);
await win.happyDOM.close();
