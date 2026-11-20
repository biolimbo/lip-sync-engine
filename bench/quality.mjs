// Mouth-cue quality comparison.
//
// node bench/quality.mjs --ref results.json[:variant] --runs a.json:variant[:label],b.json:variant[:label] [--chunks 100,250]
//
// Reference = whole answer analysed in one call with its transcript
// (dialogText), from the `reference` scenario. Each run's chunked cues are
// compared with it on a 10 ms grid:
//   agree    share of frames with the same mouth shape
//   openErr  mean absolute difference in mouth openness (0 closed .. 3 wide)
//   edgeAgree agreement within 150 ms of a chunk boundary
//   falseClose share of boundary frames where the run shows a closed mouth
//              (A/X) but the reference shows an open one
// Also reports agreement between each run and the first run (same chunks).
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const load = (spec) => {
  const [file, variant, label] = spec.split(':');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = variant || Object.keys(data.variants)[0];
  return { data: data.variants[v], label: label || v };
};
const ref = load(args.ref).data;
const runs = args.runs.split(',').map(load);
const scenario = args.scenario || 'sequential'; // or streamingCues
const chunkSizes = (args.chunks || Object.keys(runs[0].data[scenario]).join(',')).split(',');

const OPEN = { A: 0, X: 0, B: 1, F: 1, G: 1, C: 2, E: 2, H: 2, D: 3 };
const STEP = 0.01;

function frames(cues, n) {
  const out = new Array(n).fill('X');
  for (const c of cues) {
    const a = Math.max(0, Math.round(c.start / STEP));
    const b = Math.min(n, Math.round(c.end / STEP));
    for (let i = a; i < b; i++) out[i] = c.value;
  }
  return out;
}

function compare(refCues, runCues, chunkMs) {
  const end = refCues[refCues.length - 1].end;
  const n = Math.round(end / STEP);
  const r = frames(refCues, n);
  const x = frames(runCues, n);
  let agree = 0, err = 0, edgeN = 0, edgeAgree = 0, falseClose = 0;
  const period = chunkMs / 1000;
  for (let i = 0; i < n; i++) {
    const t = i * STEP;
    if (r[i] === x[i]) agree++;
    err += Math.abs(OPEN[r[i]] - OPEN[x[i]]);
    const phase = t % period;
    const dist = Math.min(phase, period - phase);
    if (t > 0.15 && dist <= 0.15) {
      edgeN++;
      if (r[i] === x[i]) edgeAgree++;
      if (OPEN[x[i]] === 0 && OPEN[r[i]] > 0) falseClose++;
    }
  }
  return { n, agree, err, edgeN, edgeAgree, falseClose, x };
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-');
const rows = [];
for (const cm of chunkSizes) {
  const base = {};
  for (const [ri, run] of runs.entries()) {
    const seq = run.data[scenario]?.[cm];
    if (!seq) continue;
    const tot = { n: 0, agree: 0, err: 0, edgeN: 0, edgeAgree: 0, falseClose: 0, vsFirst: 0 };
    for (const name of Object.keys(ref.reference)) {
      if (!seq.cues[name]) continue;
      const c = compare(ref.reference[name], seq.cues[name], Number(cm));
      for (const k of ['n', 'agree', 'err', 'edgeN', 'edgeAgree', 'falseClose']) tot[k] += c[k];
      if (ri === 0) base[name] = c.x;
      else if (base[name]) tot.vsFirst += c.x.filter((v, i) => v === base[name][i]).length;
      else tot.vsFirst = NaN;
    }
    rows.push({
      chunkMs: cm,
      run: run.label,
      agree: pct(tot.agree, tot.n),
      openErr: (tot.err / tot.n).toFixed(3),
      edgeAgree: pct(tot.edgeAgree, tot.edgeN),
      falseClose: pct(tot.falseClose, tot.edgeN),
      sameAsFirst: ri === 0 ? '-' : pct(tot.vsFirst, tot.n),
    });
  }
}
// whole-answer, no transcript: what you get without chunking
if (ref.whole) {
  const tot = { n: 0, agree: 0, err: 0 };
  for (const name of Object.keys(ref.reference)) {
    const c = compare(ref.reference[name], ref.whole[name], 1e9);
    tot.n += c.n; tot.agree += c.agree; tot.err += c.err;
  }
  rows.push({ chunkMs: 'whole', run: 'no transcript, 1 call', agree: pct(tot.agree, tot.n), openErr: (tot.err / tot.n).toFixed(3), edgeAgree: '-', falseClose: '-', sameAsFirst: '-' });
}
console.table(rows);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 1));
