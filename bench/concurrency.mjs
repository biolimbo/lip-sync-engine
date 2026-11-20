// Checks that overlapping init()/warmup() calls create maxWorkers workers, not more.
// node bench/concurrency.mjs <origin> <variant>
import { chromium } from 'playwright-core';
const [origin, variant] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const p = await b.newPage();
await p.goto(origin + '/bench.html');
await p.waitForFunction(() => window.benchReady);
const r = await p.evaluate(async (v) => {
  const lib = await import(`/v/${v}/index.mjs`);
  const base = `${location.origin}/v/${v}`;
  const opts = { wasmPath: `${base}/wasm/lip-sync-engine.wasm`, dataPath: `${base}/wasm/lip-sync-engine.data`, jsPath: `${base}/wasm/lip-sync-engine.js`, workerScriptUrl: `${base}/worker.js` };
  const pool = lib.WorkerPool.getInstance(3, opts.workerScriptUrl);
  await Promise.all([pool.init(opts), pool.init(opts)]);
  const afterInit = pool.getStats().totalWorkers;
  await Promise.all([pool.warmup(), pool.warmup()]);
  const afterWarmup = pool.getStats().totalWorkers;
  pool.destroy();
  return { afterInit, afterWarmup };
}, variant);
console.log(variant, JSON.stringify(r));
await b.close();
