// Score lip-sync outputs against CMU ARCTIC phone labels on a common scale.
//
// node bench/h2h/score.mjs <truth.json> <label>=<file>#<path> ... [--json out.json]
//   path is a dot path inside the file to { answer: cues[] }, e.g.
//   variants.final.sequential.250.cues, or timeline for the h2h runners.
//
// Every library uses a different mouth-shape set, so the truth phones and
// every library's shapes are mapped to five mouth classes:
//   CLOSED  silence, m, b, p
//   FV      f, v (teeth on lip)
//   ROUND   uw, uh, ow, ao, w
//   OPEN    aa, ae, aw, ay (wide jaw)
//   MID     everything else (other vowels and consonants)
// Scores on a 10 ms grid, at the constant time shift that maximises balanced
// accuracy (searched -150..+250 ms), because frame-by-frame analysers report
// a little after the sound and apps compensate with an audio delay.
import fs from 'node:fs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const truth = JSON.parse(fs.readFileSync(args[0], 'utf8'));
const runs = args.slice(1).filter((a) => a.includes('=')).map((spec) => {
  const [label, rest] = spec.split('=');
  const [file, p] = rest.split('#');
  let data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of p.split('.')) data = data[key];
  return { label, data };
});

const CLASSES = ['CLOSED', 'FV', 'ROUND', 'OPEN', 'MID'];
const phoneClass = (p) => {
  if (['pau', 'sil', 'm', 'b', 'p'].includes(p)) return 'CLOSED';
  if (['f', 'v'].includes(p)) return 'FV';
  if (['uw', 'uh', 'ow', 'ao', 'w', 'oy'].includes(p)) return 'ROUND';
  if (['aa', 'ae', 'aw', 'ay'].includes(p)) return 'OPEN';
  return 'MID';
};
const shapeClass = {
  // Rhubarb (lip-sync-engine)
  A: 'CLOSED', X: 'CLOSED', B: 'MID', C: 'MID', D: 'OPEN', E: 'ROUND', F: 'ROUND', G: 'FV', H: 'MID',
  // Oculus visemes (headaudio)
  sil: 'CLOSED', PP: 'CLOSED', FF: 'FV', aa: 'OPEN', O: 'ROUND', U: 'ROUND',
  SS: 'MID', TH: 'MID', DD: 'MID', kk: 'MID', nn: 'MID', RR: 'MID', CH: 'MID', I: 'MID',
  // wlipsync vowels: A, I, U, E, O, S (S = silence); 'E' and 'I' map to MID,
  // 'O'/'U' to ROUND, 'A' to OPEN
};
const wlipsyncClass = { A: 'OPEN', I: 'MID', U: 'ROUND', E: 'MID', O: 'ROUND', S: 'CLOSED' };
const VOWELS_OPEN = new Set(['aa', 'ae', 'aw', 'ay', 'ah', 'eh', 'ey', 'iy', 'ih', 'uw', 'uh', 'ow', 'ao', 'er', 'ax']);

const STEP = 0.01;
function truthFrames(phones, n) {
  const cls = new Array(n).fill('CLOSED');
  const ph = new Array(n).fill('pau');
  for (const p of phones) {
    for (let i = Math.round(p.start / STEP); i < Math.min(n, Math.round(p.end / STEP)); i++) {
      cls[i] = phoneClass(p.phone);
      ph[i] = p.phone;
    }
  }
  return { cls, ph };
}
function runFrames(cues, n, shift, levelThreshold, isWlipsync) {
  const out = new Array(n).fill('CLOSED'); // no output = mouth at rest
  for (const c of cues) {
    let k = isWlipsync ? wlipsyncClass[c.value] : shapeClass[c.value];
    if (!k) throw new Error(`unmapped value ${c.value}`);
    if (isWlipsync && c.level !== undefined && c.level < levelThreshold) k = 'CLOSED';
    const a = Math.max(0, Math.round((c.start - shift) / STEP));
    const b = Math.min(n, Math.round((c.end - shift) / STEP));
    for (let i = a; i < b; i++) out[i] = k;
  }
  return out;
}

function score(run, shift, thr) {
  const conf = Object.fromEntries(CLASSES.map((c) => [c, Object.fromEntries(CLASSES.map((d) => [d, 0]))]));
  let n = 0, correct = 0, closureSeg = 0, closureHit = 0, vowelFrames = 0, vowelClosed = 0;
  const isW = run.label.startsWith('wlipsync');
  for (const [name, phones] of Object.entries(truth)) {
    const cues = run.data[name];
    if (!cues) continue;
    const len = Math.round(phones[phones.length - 1].end / STEP);
    const t = truthFrames(phones, len);
    const r = runFrames(cues, len, shift, thr, isW);
    for (let i = 0; i < len; i++) {
      conf[t.cls[i]][r[i]]++;
      n++;
      if (t.cls[i] === r[i]) correct++;
      if (VOWELS_OPEN.has(t.ph[i])) { vowelFrames++; if (r[i] === 'CLOSED') vowelClosed++; }
    }
    // closure segments: m/b/p phones; hit if any frame within +-20 ms shows CLOSED
    for (const p of phones) {
      if (!['m', 'b', 'p'].includes(p.phone)) continue;
      closureSeg++;
      const a = Math.max(0, Math.round(p.start / STEP) - 2), b = Math.min(len, Math.round(p.end / STEP) + 2);
      let hit = false;
      for (let i = a; i < b; i++) if (r[i] === 'CLOSED') { hit = true; break; }
      if (hit) closureHit++;
    }
  }
  const recall = Object.fromEntries(CLASSES.map((c) => {
    const tot = CLASSES.reduce((s, d) => s + conf[c][d], 0);
    return [c, tot ? conf[c][c] / tot : 0];
  }));
  const balanced = CLASSES.reduce((s, c) => s + recall[c], 0) / CLASSES.length;
  return { accuracy: correct / n, balanced, recall, closureHit: closureHit / closureSeg, vowelClosed: vowelClosed / vowelFrames, shift, thr };
}

const rows = [];
for (const run of runs) {
  const isW = run.label.startsWith('wlipsync');
  let best = null;
  for (let s = -0.15; s <= 0.2501; s += 0.01) {
    for (const thr of isW ? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] : [0]) {
      const r = score(run, Math.round(s * 100) / 100, thr);
      if (!best || r.balanced > best.balanced) best = r;
    }
  }
  const at0 = score(run, 0, best.thr);
  rows.push({
    run: run.label,
    balanced: (100 * best.balanced).toFixed(1),
    accuracy: (100 * best.accuracy).toFixed(1),
    closed: (100 * best.recall.CLOSED).toFixed(0),
    fv: (100 * best.recall.FV).toFixed(0),
    round: (100 * best.recall.ROUND).toFixed(0),
    open: (100 * best.recall.OPEN).toFixed(0),
    mid: (100 * best.recall.MID).toFixed(0),
    'm/b/p shown closed': (100 * best.closureHit).toFixed(0),
    'vowels shown closed': (100 * best.vowelClosed).toFixed(0),
    'best shift ms': Math.round(best.shift * 1000),
    'balanced at 0 ms': (100 * at0.balanced).toFixed(1),
    ...(isW ? { 'level thr': best.thr } : {}),
  });
}
console.table(rows);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
