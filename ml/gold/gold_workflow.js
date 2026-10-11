export const meta = {
  name: 'tiho-gold-labels',
  description: 'Two independent annotators per chunk + adjudicator build the multilingual gold eval set for Tiho',
  phases: [
    { title: 'Annotate', detail: 'two blind annotators per chunk' },
    { title: 'Adjudicate', detail: 'resolve disagreements per chunk' },
  ],
}

const L = ['toxic', 'spam', 'scam', 'noise', 'question', 'positive', 'negative']

const GUIDE = `You are annotating a GOLD evaluation set for Tiho, an open-source browser extension that filters live-stream chat (YouTube, Twitch, Kick) so viewers can hide harassment, scams and spam. Accuracy matters more than speed. Messages are real, in many languages (read them in their language; translate mentally). Emote names (KEKW, LUL, Pog, OMEGALUL, Sadge, catJAM, :face-blue-smiling:, etc.) are images in the original chat.

Labels (multi-label, 0/1 each):
- toxic: insult, harassment, hate, slur, threat or sexual harassment aimed at someone (streamer, chatter, a group). Swearing at a game/situation, friendly banter, self-deprecation and gaming violence ("kill him") are NOT toxic.
- spam: flood, copypasta, wall of repeated characters/words/emotes (e.g. 4+ repeats), keyboard mash, ASCII art.
- scam: self-promotion, bots, fake giveaways, "free X", crypto/gambling/casino/betting promos, viewer/follower selling, "check my channel", phishing, sponsor/affiliate ad copy.
- noise: low-effort reaction with no content: a single emote/word or very short reaction (W, L, lol, KEKW, first, ?, F, +1, xd, 1, "LETS GOOO"). Not noise if it says something (an opinion, a fact, a joke with content).
- question: asks a genuine question (to the streamer or chat). A bare "?" or "what??" outburst is noise.
- positive: clearly supportive, kind, grateful, excited/hype tone.
- negative: clearly complaining, critical, annoyed or hostile tone (toxic messages are also negative).
Neutral normal chat = all zeros. Be conservative with positive/negative: plain statements are neutral.`

const ITEM = {
  type: 'object',
  properties: Object.fromEntries([['i', { type: 'integer' }], ...L.map(k => [k, { type: 'integer', enum: [0, 1] }])]),
  required: ['i', ...L],
}
const SCHEMA = { type: 'object', properties: { labels: { type: 'array', items: ITEM } }, required: ['labels'] }

const chunks = args.chunks // [[{i, text, p, lang}]]

function render(chunk) {
  return chunk.map(m => `[${m.i}] (${m.p}${m.lang ? ', ' + m.lang : ''}) ${m.text}`).join('\n')
}

const results = await pipeline(
  chunks,
  (chunk, _o, idx) => parallel([0, 1].map(a => () => agent(
    `${GUIDE}\n\nAnnotate EVERY message below (${chunk.length} messages). Return one entry per message index [i].\n\n${render(chunk)}`,
    { label: `annotate:${idx}:${a ? 'B' : 'A'}`, phase: 'Annotate', schema: SCHEMA },
  ))),
  async (pair, chunk, idx) => {
    const [A, B] = pair
    if (!A || !B) return { idx, merged: [], failed: true }
    const mapA = new Map(A.labels.map(x => [x.i, x]))
    const mapB = new Map(B.labels.map(x => [x.i, x]))
    const merged = []
    const disputes = []
    for (const m of chunk) {
      const a = mapA.get(m.i), b = mapB.get(m.i)
      if (!a || !b) { disputes.push({ m, a, b }); continue }
      const diff = L.filter(k => a[k] !== b[k])
      if (diff.length === 0) merged.push({ i: m.i, ...Object.fromEntries(L.map(k => [k, a[k]])), agree: 1 })
      else disputes.push({ m, a, b, diff })
    }
    if (disputes.length) {
      const fmt = d => `[${d.m.i}] (${d.m.p}${d.m.lang ? ', ' + d.m.lang : ''}) ${d.m.text}\n    A: ${d.a ? L.filter(k => d.a[k]).join(',') || 'none' : 'missing'} | B: ${d.b ? L.filter(k => d.b[k]).join(',') || 'none' : 'missing'}`
      const adj = await agent(
        `${GUIDE}\n\nTwo annotators disagreed on the messages below. Decide the correct full label set for each (consider all 7 labels, not only the disputed ones). Return one entry per message index.\n\n${disputes.map(fmt).join('\n')}`,
        { label: `adjudicate:${idx}`, phase: 'Adjudicate', schema: SCHEMA },
      )
      for (const x of (adj && adj.labels) || []) merged.push({ ...x, agree: 0 })
    }
    return { idx, merged, disputes: disputes.length }
  },
)

const out = results.filter(Boolean).flatMap(r => r.merged)
const nd = results.filter(Boolean).reduce((s, r) => s + (r.disputes || 0), 0)
log(`gold: ${out.length} labeled, ${nd} adjudicated`)
return { labels: out }
