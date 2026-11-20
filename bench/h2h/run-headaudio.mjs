// Run @met4citizen/headaudio offline on the benchmark answers.
// node bench/h2h/run-headaudio.mjs <package_dir> <audio_dir> <out.json>
//
// Feeds the 24 kHz answer audio in 128-sample blocks (like its AudioWorklet)
// and records the viseme the worklet would send to the main thread. That is
// the classifier output after its own majority vote, before the main-thread
// hold/ramp animation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkg, audioDir, out] = process.argv.slice(2);
const mod = (f) => import(pathToFileURL(path.join(pkg, 'modules', f)).href);
const { Processor } = await mod('processor.mjs');
const { Training } = await mod('training.mjs');
const PARAMS = await mod('parameters.mjs');

const NAMES = ['aa', 'E', 'I', 'O', 'U', 'PP', 'SS', 'TH', 'DD', 'FF', 'kk', 'nn', 'RR', 'CH', 'sil'];

// Decode the binary model like Training.loadModel (which needs fetch)
const bin = fs.readFileSync(path.join(pkg, 'dist', 'model-en-mixed.bin'));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const training = new Training();
const model = [];
for (let pos = 0; pos + PARAMS.RECORD_OFFSET <= buffer.byteLength; pos += PARAMS.RECORD_OFFSET) {
  model.push(training.decodeBinaryRecord(new Float32Array(buffer, pos, PARAMS.RECORD_LEN)));
}

const answers = JSON.parse(fs.readFileSync(path.join(audioDir, 'answers.json'), 'utf8'));
const result = { library: 'headaudio', model: 'model-en-mixed.bin', timeline: {}, msPerAudioSecond: 0 };
let cpuMs = 0, audioS = 0;
for (const a of answers) {
  const raw = fs.readFileSync(path.join(audioDir, `${a.name}.24k.pcm`));
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const events = [];
  const worklet = { port: { onmessage: null, postMessage: (m) => { if (m.event === 'viseme' || m.event === 'ended') events.push(m); } } };
  const p = new Processor({ sampleRate: 24000, processorOptions: {}, parameterData: {} }, worklet);
  p._onmessage({ data: { event: 'model', model } });
  const block = new Float32Array(128);
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i += 128) {
    const n = Math.min(128, pcm.length - i);
    for (let j = 0; j < n; j++) block[j] = pcm[i + j] / 32768;
    p.process(n === 128 ? block : block.subarray(0, n));
  }
  cpuMs += performance.now() - t0;
  audioS += pcm.length / 24000;
  // Each viseme event covers one 16 ms hop centred on t; 'ended' = silence
  const cues = [];
  const hop = PARAMS.MFCC_SAMPLES_HOP / PARAMS.AUDIO_SAMPLE_RATE;
  for (const e of events) {
    if (e.event !== 'viseme') continue;
    cues.push({ start: Math.max(0, e.t - hop / 2), end: e.t + hop / 2, value: NAMES[e.viseme] ?? String(e.viseme) });
  }
  result.timeline[a.name] = cues;
}
result.msPerAudioSecond = cpuMs / audioS;
fs.writeFileSync(out, JSON.stringify(result));
console.log('headaudio: ms CPU per audio second', result.msPerAudioSecond.toFixed(2), 'values', [...new Set(Object.values(result.timeline).flat().map((c) => c.value))].join(','));
