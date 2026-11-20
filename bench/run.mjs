// Benchmark runner: serves variants + audio, drives headless Chromium.
//
// node bench/run.mjs --variants v1,v2 --variantsDir DIR --audioDir DIR --out FILE
//   [--workers 5] [--chunks 100,250,500,1000] [--scenarios fresh,sequential,streaming,memory,reference]
//   [--stream '{"contextMs":500}']   (passes streamOptions to the new streaming API)
//   [--pool '{"...":...}']           (extra pool.init options)
//   [--analyze '{"extendedShapes":"GHX"}'] (extra options for every analysis)
// Run under `taskset -c 0,1` to emulate a 2-core device.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const variants = args.variants.split(',');
const variantsDir = path.resolve(args.variantsDir);
const audioDir = path.resolve(args.audioDir);
const workers = Number(args.workers || 5);
const chunkSizes = (args.chunks || '100,250,500,1000').split(',').map(Number);
const scenarios = (args.scenarios || 'memory,fresh,sequential,streaming').split(',');
const streamOptions = args.stream ? JSON.parse(args.stream) : null;
const poolOptions = args.pool ? JSON.parse(args.pool) : {};
const answers = JSON.parse(fs.readFileSync(path.join(audioDir, 'answers.json'), 'utf8'));
const onlyAnswers = args.answers ? args.answers.split(',') : null;
const useAnswers = onlyAnswers ? answers.filter((a) => onlyAnswers.includes(a.name)) : answers;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/' || url === '/bench.html') file = path.join(here, 'bench.html');
  else if (url.startsWith('/v/')) file = path.join(variantsDir, url.slice(3));
  else if (url.startsWith('/audio/')) file = path.join(audioDir, url.slice(7));
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error('404', url);
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'max-age=3600' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- process metrics (Linux /proc) ----
function descendants(rootPid) {
  const children = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(d));
    } catch {}
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) || []));
  return out.slice(1); // exclude the runner itself
}
const CLK = 100; // USER_HZ on Linux
function cpuSeconds(pids) {
  let t = 0;
  for (const p of pids) {
    try {
      const s = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      t += (Number(f[11]) + Number(f[12])) / CLK;
    } catch {}
  }
  return t;
}
function pssMB(pids) {
  let kb = 0;
  for (const p of pids) {
    try {
      const m = /Pss:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'));
      if (m) kb += Number(m[1]);
    } catch {}
  }
  return kb / 1024;
}

const chromePath = process.env.CHROME_PATH || undefined;
const results = { meta: { date: new Date().toISOString(), workers, chunkSizes, scenarios, streamOptions, poolOptions, affinity: fs.readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list:\s+(.*)/)[1] }, variants: {} };

for (const v of variants) {
  console.error(`== ${v}`);
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--js-flags=--expose-gc'] });
  const rootPid = process.pid; // chromium processes are our descendants
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.stack));
  page.on('crash', () => console.error('[crash] renderer crashed'));
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') console.error('[worker]', m.text().slice(0, 300)); }));
  await page.goto(`${origin}/bench.html`);
  await page.waitForFunction(() => window.benchReady);
  await page.evaluate((v) => window.B.load(v), v);
  if (args.analyze) await page.evaluate((o) => window.B.setExtra(o), JSON.parse(args.analyze));
  const R = (results.variants[v] = {});
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  if (scenarios.includes('memory')) {
    // Warm the HTTP cache so download time is not counted, then measure.
    await page.evaluate((o) => window.B.createPool(1, o), poolOptions);
    await page.evaluate(() => window.B.destroyPool());
    await settle();
    const before = pssMB(descendants(rootPid));
    const t1 = await page.evaluate((o) => window.B.createPool(1, o), poolOptions);
    await settle();
    const one = pssMB(descendants(rootPid));
    await page.evaluate(() => window.B.destroyPool());
    await settle();
    const t = await page.evaluate((o) => window.B.createPool(o.workers, o.poolOptions), { workers, poolOptions });
    await settle();
    const all = pssMB(descendants(rootPid));
    const heapWarm = await page.evaluate(() => window.B.memStats());
    // memory after a burst of chunks, so every worker has analysed audio
    const afterRun = await (async () => {
      await page.evaluate(async (args) => {
        const { name, chunkMs } = args;
        await window.B.streaming({ name, chunkMs, paceFactor: Infinity });
      }, { name: useAnswers[0].name, chunkMs: 250 });
      await settle();
      return pssMB(descendants(rootPid));
    })();
    const heapUsed = await page.evaluate(() => window.B.memStats());
    await page.evaluate(() => window.B.destroyPool());
    R.memory = {
      initOneWorkerMs: t1.initMs,
      poolInitMs: t.initMs,
      poolWarmupMs: t.warmupMs,
      baseMB: before,
      firstWorkerMB: one - before,
      perExtraWorkerMB: (all - one) / Math.max(1, workers - 1),
      poolTotalMB: all - before,
      poolTotalAfterUseMB: afterRun - before,
      wasmHeapPerWorkerMB: heapWarm ? heapWarm.workers.map((b) => b / 2 ** 20) : null,
      wasmHeapPerWorkerAfterUseMB: heapUsed ? heapUsed.workers.map((b) => b / 2 ** 20) : null,
    };
    console.error('memory', JSON.stringify(R.memory));
  }

  if (scenarios.includes('fresh')) {
    R.fresh = {};
    for (const cm of chunkSizes) {
      const rows = [];
      for (const a of useAnswers) {
        rows.push(await page.evaluate((o) => window.B.freshAnswer(o), { name: a.name, chunkMs: cm, workers, poolOptions, streamOptions }));
      }
      R.fresh[cm] = rows;
      const med = (k) => rows.map((r) => r[k]).sort((x, y) => x - y)[Math.floor(rows.length / 2)];
      console.error(`fresh ${cm}ms: init ${med('initMs').toFixed(0)} warmup ${med('warmupMs').toFixed(0)} first ${med('firstChunkMs').toFixed(0)}`);
    }
  }

  if (scenarios.includes('sequential')) {
    R.sequential = {};
    // A fresh pool per answer (as Librarium does). Also keeps 1.0.3 workers
    // below the call count at which their heap runs out.
    for (const cm of chunkSizes) {
      const per = [];
      let audio = 0;
      let cpu = 0;
      const firsts = [];
      const cues = {};
      for (const a of useAnswers) {
        await page.evaluate((o) => window.B.createPool(o.workers, o.poolOptions), { workers, poolOptions });
        // one untimed call so the first-call cost is not counted as per-chunk time
        await page.evaluate(() => window.B.warmCall());
        const c0 = cpuSeconds(descendants(rootPid));
        const r = await page.evaluate((o) => window.B.sequential(o), { name: a.name, chunkMs: cm, streamOptions });
        cpu += cpuSeconds(descendants(rootPid)) - c0;
        await page.evaluate(() => window.B.destroyPool());
        per.push(...r.times);
        firsts.push(r.times[0]);
        audio += r.audioSeconds;
        cues[a.name] = r.cues;
      }
      const s = [...per].sort((x, y) => x - y);
      R.sequential[cm] = {
        n: s.length,
        meanMs: s.reduce((x, y) => x + y, 0) / s.length,
        p50Ms: s[Math.floor(s.length * 0.5)],
        p95Ms: s[Math.floor(s.length * 0.95)],
        cpuSecPerAudioSec: cpu / audio,
        // first chunk of each answer on an already running pool
        firstChunkWarmPoolMs: firsts,
        audioSeconds: audio,
        cues,
      };
      console.error(`sequential ${cm}ms: p50 ${R.sequential[cm].p50Ms.toFixed(1)} p95 ${R.sequential[cm].p95Ms.toFixed(1)} cpu/audio ${(cpu / audio).toFixed(3)}`);
    }
  }

  if (scenarios.includes('streaming')) {
    R.streaming = {};
    for (const cm of chunkSizes) {
      const rows = [];
      for (const a of useAnswers) {
        await page.evaluate((o) => window.B.createPool(o.workers, o.poolOptions), { workers, poolOptions });
        await page.evaluate(() => window.B.warmCall());
        const c0 = cpuSeconds(descendants(rootPid));
        const row = await page.evaluate((o) => window.B.streaming(o), { name: a.name, chunkMs: cm, paceFactor: Number(args.pace || 'Infinity'), streamOptions });
        row.cpuSeconds = cpuSeconds(descendants(rootPid)) - c0;
        row.answer = a.name;
        rows.push(row);
        await page.evaluate(() => window.B.destroyPool());
      }
      R.streaming[cm] = rows;
      // same shape as sequential for quality.mjs
      R.streamingCues = R.streamingCues || {};
      R.streamingCues[cm] = { cues: Object.fromEntries(rows.map((r) => [r.answer, r.cues])) };
      for (const r of rows) delete r.cues;
      const cpu = rows.reduce((x, r) => x + r.cpuSeconds, 0), aud = rows.reduce((x, r) => x + r.audioSeconds, 0);
      console.error(`streaming ${cm}ms cpu/audio ${(cpu / aud).toFixed(3)}`);
      const med = (f) => rows.map(f).sort((x, y) => x - y)[Math.floor(rows.length / 2)];
      console.error(`streaming ${cm}ms: firstAudio ${med((r) => r.firstAudioMs).toFixed(0)} stall ${med((r) => r.stallMs).toFixed(0)} p95lat ${med((r) => r.latency.p95).toFixed(0)}`);
    }
  }

  if (scenarios.includes('reference')) {
    await page.evaluate(() => window.B.createPool(1));
    R.reference = {};
    R.whole = {};
    for (const a of useAnswers) {
      R.reference[a.name] = await page.evaluate((o) => window.B.reference(o), a);
      R.whole[a.name] = await page.evaluate((o) => window.B.whole(o), a);
    }
    await page.evaluate(() => window.B.destroyPool());
    console.error('reference done');
  }

  await browser.close();
}

fs.writeFileSync(args.out, JSON.stringify(results));
server.close();
console.error('wrote', args.out);
