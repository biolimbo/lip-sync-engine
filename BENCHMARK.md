# Benchmark: lip-sync-engine 1.0.3 vs 2.0.0

Goal: less waiting before a voice avatar's first mouth cue, less CPU and memory on weak devices, and no worse mouth movement.

## How it was measured

- **Audio:** 116 s of real read speech (CMU ARCTIC, one female and one male speaker), joined into 8 "answers" of about 15 s each. Each answer was upsampled to 24 kHz, cut into streaming chunks of 100, 250, 500 or 1000 ms, and each chunk was resampled to 16 kHz with linear interpolation, exactly as the Librarium app does. Timing tables use 4 of the answers (about 60 s); quality tables use all 8.
- **Runtime:** headless Chromium 1255 with real Web Workers, driven by `bench/run.mjs` (Linux, 8 cores). "2 cores" means the browser was pinned to 2 cores (`taskset -c 0,1`) to stand in for a tablet or kiosk.
- **Baseline:** the published npm package 1.0.3. A from-source build of the same code with the current compiler gave the same speed within noise, so none of the gains come from the compiler.
- **Memory:** total PSS of all browser processes, minus the same figure before the pool existed.
- **CPU:** CPU time of all browser processes during analysis, divided by seconds of audio analysed.
- **Noise:** other unrelated jobs were sometimes running on the same machine. Single numbers can be off by 10 to 20%; the changes reported here are much larger than that.
- **Reproduce:** `bench/prepare-audio.py` builds the audio, `bench/build-variant.sh` builds a variant, `bench/run.mjs` measures, `bench/quality.mjs` scores mouth cues, `bench/leak.mjs` repeats calls until a worker fails.

Terms:

- **Fresh pool:** create the pool, `init()`, `warmup()`, then analyse the first chunk. This is what Librarium does before every answer today.
- **Warm pool:** the pool already exists (kept from an earlier answer).
- **Per chunk:** time for one `analyze()` call on a warm worker, chunks sent one at a time.

## What was wrong

1. **Every call rebuilt the speech decoder.** A "Phase 0" comment said the recognizer was reused, but the object kept between calls was stateless. Each `analyze()` loaded the acoustic model, parsed the 134k-word dictionary, read the 26 MB language model and built the search tree. That took about 0.4 s per call, whatever the chunk length. A 250 ms chunk took about 450 ms to analyse, slower than real time.
2. **Workers ran out of memory.** Building and freeing a decoder on every call grew the WebAssembly heap until allocation failed. A 1.0.3 worker failed after 482 calls of 100 ms chunks (about 48 s of audio). Destroying the pool after every answer hides this.
3. **Short chunks lose most mouth shapes.** Recognition needs surrounding audio. A 100 ms chunk analysed alone comes out as almost nothing but shape B. Chunk ends also tend to close the mouth for no reason.
4. **Wasted work in logging.** Every PocketSphinx log line (hundreds while building a decoder) was formatted and run through a freshly compiled regex, then thrown away by the level filter.

## Changes and their effect

Each row adds one change on top of the previous one. 8 cores, 5 workers (Librarium's setting), 250 ms chunks unless stated, median of 4 answers.

| Change | Fresh pool to first cue | Per chunk 250 ms (p50 / p95) | Per chunk 1000 ms (p50 / p95) | CPU per audio second (250 / 1000 ms chunks) | First chunk, warm pool | Pool memory after warmup / after use |
|---|---|---|---|---|---|---|
| 1.0.3 | 1463 ms | 448 / 797 ms | 536 / 778 ms | 2.03 / 0.57 s | 480 ms | 312 / 875 MB |
| 1. Keep decoders between calls, build them during init | 1400 ms | 75 / 190 ms | 208 / 348 ms | 0.37 / 0.22 s | 113 ms | 711 / 634 MB |
| 2. Skip formatting of dropped log messages | 1352 ms | 72 / 172 ms | 216 / 343 ms | 0.34 / 0.22 s | 136 ms | 702 / 635 MB |
| 3. Pool: compile the WASM once and share it, send jobs to workers whose decoder is ready, fetch the worker script once | 1303 ms | 83 / 211 ms | 211 / 581 ms | 0.39 / 0.25 s | 144 ms | 780 / 800 MB |
| 4. Load only the dictionary words the language model knows | 1236 ms | 73 / 185 ms | 194 / 321 ms | 0.35 / 0.21 s | 124 ms | 739 / 761 MB |
| Final 2.0.0 (step 3 no longer copies the 39 MB model file into each worker) | 1154 ms | 85 / 215 ms | 188 / 327 ms | 0.40 / 0.20 s | 131 ms | 562 / 583 MB |

Notes on each change:

- **Change 1 (decoder cache)** is almost all of the per-chunk gain: about 6x faster per 250 ms chunk and 5x less CPU. A fresh pool only gets slightly faster, because building each worker's decoder (about 0.5 s of CPU) now happens during `init()`/`warmup()` instead of during the first chunk. Memory right after warmup is higher for the same reason, but memory after use is lower, and it stays flat. The repeat-call test ran 3000 calls with the heap steady at 128 MB, where 1.0.3 failed after 482. Output is byte-identical to 1.0.3: the dither random generator is re-seeded on each call, as a fresh decoder would be.
- **Change 2 (logging)** cut decoder build time by about 10% in an isolated profile (690 to 600 ms for one worker). End to end it is within noise.
- **Change 3 (pool)** also had to be corrected. The first version copied the 39 MB model file through `postMessage` into every worker. That made start-up about 0.3 s faster but cost about 200 MB more for 5 workers. The final version shares only the compiled WASM module. Each worker reads the model file from the HTTP cache.
- **Change 4 (dictionary)** loads 79k instead of 134k dictionary entries when there is no dialog text. PocketSphinx never considers words outside the language model, so output is unchanged; decoders built for dialog text still use the full dictionary. It makes the `.data` file 2 MB larger.
- **Decoder build breakdown** (one worker, after these changes): dictionary parse about 110 ms, search tree about 130 ms, word mapping about 30 ms, acoustic model about 20 ms, language model read about 30 ms, plus about 150 ms to load the module.

## Weak devices and worker count

Final build against 1.0.3, 250 ms chunks. "Streaming" means all chunks of an answer arrive at once (the voice model sends faster than real time) and each chunk is analysed alone, as Librarium does today. Stalls are moments when the player waits for a chunk's cues, summed over an answer.

**2 cores:**

| Workers | Version | Fresh pool to first cue | Per chunk p50 | CPU per audio s | Streaming: first audio / stalls | Memory after use |
|---|---|---|---|---|---|---|
| 1 | 1.0.3 | 783 ms | 414 ms | 1.76 s | 464 ms / 12.0 s | 384 MB |
| 1 | 2.0.0 | 671 ms | 93 ms | 0.44 s | 110 ms / 0 | 120 MB |
| 2 | 1.0.3 | 1160 ms | 442 ms | 1.83 s | 439 ms / 0 (worst answer 0.3 s) | 507 MB |
| 2 | 2.0.0 | 933 ms | 71 ms | 0.34 s | 219 ms / 0 | 241 MB |
| 5 | 1.0.3 | 2638 ms | 414 ms | 1.76 s | 1324 ms / 0 | 861 MB |
| 5 | 2.0.0 | 1960 ms | 93 ms | 0.43 s | 242 ms / 0 | 577 MB |

**8 cores:**

| Workers | Version | Fresh pool to first cue | Per chunk p50 | CPU per audio s | Streaming: first audio / stalls | Memory after use |
|---|---|---|---|---|---|---|
| 1 | 1.0.3 | 710 ms | 495 ms | 2.09 s | 499 ms / 16.5 s | n/a (see note) |
| 1 | 2.0.0 | 508 ms | 97 ms | 0.43 s | 170 ms / 0 | 127 MB |
| 2 | 1.0.3 | 965 ms | 419 ms | 1.70 s | 489 ms / 0.26 s | 508 MB |
| 2 | 2.0.0 | 915 ms | 73 ms | 0.34 s | 114 ms / 0 | 240 MB |
| 5 | 1.0.3 | 1525 ms | 438 ms | 1.82 s | 721 ms / 0 | 868 MB |
| 5 | 2.0.0 | 1154 ms | 85 ms | 0.40 s | 157 ms / 0 | 583 MB |

Note: the 1.0.3 1-worker memory reading on 8 cores was disturbed by work still queued from the previous test, so it is left out. The 1-worker "fresh pool" figures come from a separate clean rerun.

What this means:

- **One worker now keeps up with real-time speech.** 1.0.3 needs about 1.8 CPU seconds per second of audio at 250 ms chunks, so with one or two workers it falls behind and the player stalls for seconds. 2.0.0 needs about 0.4.
- **Memory is about 115 MB per warm worker** (1.0.3: about 170 MB after use, and growing until it fails). On a 2-core device, 2 workers of 2.0.0 use 241 MB, against 861 MB for Librarium's current 5 workers of 1.0.3.
- **More workers make a fresh pool slower,** especially on 2 cores (1.96 s with 5 workers, 0.67 s with 1). All workers build their decoders at the same time.

## Mouth-cue quality

Reference: each whole answer analysed in one call with its transcript. Results are compared on a 10 ms grid.

- **Agreement:** share of frames with the same mouth shape as the reference.
- **False closures:** frames within 150 ms of a chunk boundary where the result shows a closed mouth but the reference shows it open.

**The speed and memory changes cost no quality.** With `extendedShapes: ''` (the 1.x shape set), 2.0.0 output is byte-identical to 1.0.3 on all 8 answers at all 4 chunk sizes (32 of 32). The only change to default output in 2.0.0 is the switch to nine mouth shapes (below). The tables in this section use six shapes so the versions compare like for like.

**Chunking is what hurts quality, and the new streaming options fix most of it.** In the table, "context and lookahead" means `createStreamAnalyzer({ contextMs: 500, lookaheadMs: 500 })`, measured end to end with the real controller:

| Setup | 100 ms chunks | 250 ms | 500 ms | 1000 ms |
|---|---|---|---|---|
| Each chunk alone (1.0.3, and 2.0.0 with six shapes): agreement | 41.9% | 36.8% | 53.0% | 68.0% |
| Each chunk alone: false closures | 10.8% | 33.7% | 25.6% | 24.9% |
| Context only (`contextMs: 500`): agreement | 39.3% | 54.0% | 66.0% | 75.4% |
| Context and lookahead, audio arriving faster than playback: agreement | **90.4%** | **88.4%** | **87.7%** | **87.9%** |
| Same: false closures | 1.3% | 1.7% | 1.4% | 2.2% |
| Context and lookahead, audio arriving at 3x playback speed: agreement | 83.4% | 81.8% | 83.1% | 85.3% |
| Whole answer in one call, no transcript | 94.2% | | | |

How the lookahead avoids adding delay:

- **The first chunk is analysed at once,** with no lookahead.
- **Later chunks wait for following audio** only until their estimated playback time.
- **Chunks that are ready at the same time** are analysed in one window, which keeps CPU low.
- **If a chunk can't make its deadline,** its lookahead is shortened.

Cost and stalls with context and lookahead (2 workers, median per answer, worst answer in brackets):

| Chunk size | Arrival | First audio | Stalls | CPU per audio s |
|---|---|---|---|---|
| 100 ms | burst | 2 ms | 933 ms (1274 ms) | 0.37 s |
| 250 ms | burst | 120 ms | 0 (68 ms) | 0.34 s |
| 500 ms | burst | 123 ms | 0 | 0.28 s |
| 1000 ms | burst | 296 ms | 0 | 0.32 s |
| 100 ms | 3x playback speed | 1 ms | 349 ms (497 ms) | 0.70 s |
| 250 ms | 3x playback speed | 98 ms | 0 (14 ms) | 0.67 s |
| 250 ms | burst, 2 cores | 110 ms | 0 (62 ms) | 0.34 s |

Known limit: with 100 ms chunks, playback starts after only 100 ms of audio, and every later chunk must be analysed within that rhythm. That causes stalls of about 0.3 to 0.9 s per answer. For chunks that small, either accept the lower quality of chunk-by-chunk analysis (no stalls), or join deltas into chunks of at least 250 ms before analysing.

**Nine mouth shapes** (the 2.0.0 default, `extendedShapes: 'GHX'`): adds G (f, v), H (l) and X (idle). This is the breaking change behind the major version: `extendedShapes: ''` restores 1.x output. Scored against a nine-shape reference:

| Setup | 250 ms | 1000 ms |
|---|---|---|
| Each chunk alone | 31.9% | 65.1% |
| Context and lookahead, burst | 85.1% | 86.4% |

Speed is unchanged. Agreement is slightly lower than with six shapes only because there are more shapes to match exactly.

**Phonetic recognizer** (`recognizer: 'phonetic'`, new, not default):

| Recognizer | Agreement (250 / 1000 ms, context and lookahead) | CPU per audio s | Memory per extra worker | First chunk, fresh pool |
|---|---|---|---|---|
| Default (words) | 87.0% / 87.9% | 0.39 s | 140 MB | 136 ms |
| Phonetic | 61.9% / 62.0% | 0.12 s | 80 MB | 26 ms |

It is much cheaper but clearly worse, so it is only for devices that cannot keep up otherwise.

## Recommendations for a streaming voice avatar (Librarium)

1. **Create the pool once and keep it.** Stop destroying it after each answer. The first chunk of an answer then takes about 0.1 s instead of about 1.5 s. Destroying the pool was also hiding the 1.0.3 memory failure, which 2.0.0 no longer has.
2. **Use 2 workers instead of 5.** That saves about 340 MB with no stalls in these tests. Use 1 on very weak devices.
3. **Switch to `createStreamAnalyzer({ sampleRate: 16000, contextMs: 500, lookaheadMs: 500 })`.** Use `getResult(i)` for each chunk, and call `end()` when the response's audio is done. This is the big quality gain at the same latency.
4. **Nothing to do for nine shapes.** They are the 2.0.0 default, and Librarium's avatar already supports all nine.
5. **If the voice model's deltas are around 100 ms,** join them into chunks of at least 250 ms before analysing, or accept chunk-by-chunk quality.
