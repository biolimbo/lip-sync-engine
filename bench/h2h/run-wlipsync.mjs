// Run wlipsync offline on the benchmark answers.
// node bench/h2h/run-wlipsync.mjs <package_dir> <profile.json> <audio_dir> <out.json>
//
// Mirrors dist/audio-processor.js: 24 kHz input, analysis every 512 samples
// (its default blockSize). Records the matched phoneme and the volume.
// The main thread maps volume as in its audio-node: clamp((log10(rms) + 2.5), 0, 1).
import fs from 'node:fs';
import path from 'node:path';

const [pkg, profilePath, audioDir, out] = process.argv.slice(2);
const k = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const wasm = await WebAssembly.compile(fs.readFileSync(path.join(pkg, 'dist', 'wlipsync.wasm')));
const answers = JSON.parse(fs.readFileSync(path.join(audioDir, 'answers.json'), 'utf8'));
const BLOCK = 512, RATE = 24000;
const result = { library: 'wlipsync', profile: path.basename(profilePath), timeline: {} };
let cpuMs = 0, audioS = 0;

for (const a of answers) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const { exports: z } = await WebAssembly.instantiate(wasm, { env: { memory } });
  const E = k.mfccs.length;
  const W = z.load_profile(k.targetSampleRate, k.sampleCount, k.melFilterBankChannels, k.compareMethod, E, k.mfccDataCount, k.useStandardization ? 1 : 0);
  const dv = new DataView(memory.buffer, W, E * k.mfccDataCount * 12 * 4);
  let off = 0;
  for (const m of k.mfccs) for (const q of m.mfccCalibrationDataList) for (const v of q.array) { dv.setFloat32(off, v, true); off += 4; }
  z.precompute_profile();
  z.set_input(RATE);
  const ptr = z.get_input_buffer(), size = z.get_input_buffer_size();
  const input = new Float32Array(memory.buffer, ptr, size);
  const vol = new DataView(memory.buffer, z.get_volume_ptr(), 4);

  const raw = fs.readFileSync(path.join(audioDir, `${a.name}.24k.pcm`));
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  let idx = 0, last = 0;
  const cues = [];
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i++) {
    input[idx] = pcm[i] / 32768;
    idx = (idx + 1) % size;
    if ((idx + size - last) % size === BLOCK) {
      const which = z.execute(idx);
      const volume = vol.getFloat32(0, true);
      const t = (i + 1) / RATE; // time of the newest sample analysed
      const level = Math.min(1, Math.max(0, Math.log10(Math.max(volume, 1e-9)) + 2.5));
      cues.push({ start: t - BLOCK / RATE, end: t, value: k.mfccs[which].name, level });
      last = idx;
    }
  }
  cpuMs += performance.now() - t0;
  audioS += pcm.length / RATE;
  result.timeline[a.name] = cues;
}
result.msPerAudioSecond = cpuMs / audioS;
fs.writeFileSync(out, JSON.stringify(result));
const all = Object.values(result.timeline).flat();
console.log('wlipsync: ms CPU per audio second', result.msPerAudioSecond.toFixed(2), 'values', [...new Set(all.map((c) => c.value))].join(','), 'level p10/p50/p90', [0.1, 0.5, 0.9].map((q) => all.map((c) => c.level).sort((x, y) => x - y)[Math.floor(q * all.length)].toFixed(2)).join('/'));
