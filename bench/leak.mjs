// Calls analyze() repeatedly on one worker with 100 ms chunks of real speech
// and reports how many calls succeed (and WASM heap size when available).
// node bench/leak.mjs <origin> <variant> <maxCalls>
import { chromium } from 'playwright-core';
const [origin, variant, maxCalls] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const p = await b.newPage();
await p.goto(origin + '/bench.html');
await p.waitForFunction(() => window.benchReady);
await p.evaluate((v) => window.B.load(v), variant);
await p.evaluate(() => window.B.createPool(1));
const r = await p.evaluate(async (max) => window.B.leak(max), Number(maxCalls));
console.log(variant, JSON.stringify(r));
await b.close();
