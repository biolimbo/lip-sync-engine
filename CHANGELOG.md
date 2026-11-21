# Changelog

All notable changes to `lip-sync-engine` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A failed main-thread load is no longer kept: after `LipSyncEngine.init()` or
  `WasmLoader.load()` rejects, the next `init()`, `analyze()`, or `load()` loads again instead of
  returning the same error until the page is reloaded. A load still in progress when
  `WasmLoader.reset()` is called no longer fills the cache afterwards.
- `LipSyncEngine.init()` without options, `analyze()`, and the exported `analyze()` reuse the
  options of the last `init(options)` call that started a load, so a self-hosted app whose
  `init(options)` failed retries from its own paths instead of the unpkg CDN. `destroy()` clears
  the options.
- `LipSyncEngine.init()` and `analyze()` no longer stay pending forever when the `.data` model file
  fails to download on the main thread. They reject with
  `Failed to load model data from <dataPath>: <reason>`.
- A main-thread retry reuses the loader script that already ran instead of adding another
  `<script>` and running it again. When the loader script fails to load, it is removed from the page
  and the `.data` and `.wasm` downloads are canceled.
- `WorkerPool.init()` and `warmup()` no longer stay pending when a worker fails to download the
  `.data` model file. The startup rejects with
  `Worker initialization failed: Failed to load model data from <dataPath>: <reason>`, and calling
  `init()` or `warmup()` again retries. A network error during the download is retried once without
  the HTTP cache, so concurrent downloads that fail with `ERR_CACHE_WRITE_FAILURE` (seen in private
  windows and fresh browser profiles) no longer stop the pool from starting.
- `WorkerPool.init()` and `warmup()` reject with
  `Worker initialization failed: could not read the worker's reply` when the pool cannot read a
  starting worker's reply, instead of staying pending.
- The pool's first worker downloads the `.data` file while it compiles the `.wasm`, instead of
  after.
- `WorkerPool.getMemoryStats()` no longer stays pending when a worker crashes before it answers;
  that worker counts as `0` bytes.
- `StreamAnalyzerController.addChunk()` after `end()` throws
  `Cannot add chunks after end() has been called` instead of naming `finalize()`.

## [2.0.0] - 2026-11-20

Measurements behind the figures below are in [BENCHMARK.md](./BENCHMARK.md).

### Added

- `extendedShapes` analysis option: any combination of `'G'`, `'H'`, and `'X'` (default `'GHX'`).
- Streaming analyzer options `contextMs` and `lookaheadMs` analyze each chunk together with the
  audio around it. With 250 to 1000 ms chunks and nine mouth shapes, agreement with whole-utterance
  analysis is about 32-65% when each chunk is analyzed alone and 85-86% with both options at 500,
  and the mouth closes far less often at chunk boundaries (see
  [Context and Lookahead](./docs/streaming-analysis.md#context-and-lookahead)). Related options:
  `firstChunkLookahead`, `deadlineMarginMs`, `maxWaitMs`, `maxConcurrent`, and `maxBatchMs`.
- `StreamAnalyzerController.getResult(index)` and `end()`.
- `WorkerPool.init()` options `prewarm`, `shareAssets`, and `recognizer` (`'pocketsphinx'` or the
  faster, less accurate `'phonetic'`).
- `WorkerPool.getMemoryStats()`.
- `WasmLoaderOptions.wasmModule` and `dataBuffer`, to pass an already compiled `.wasm` module or the
  contents of the `.data` file instead of downloading them.
- Optional `LipSyncEngineModule` functions `_lipsyncengine_prewarm()`,
  `_lipsyncengine_set_recognizer()`, and `_lipsyncengine_set_extended_shapes()`.
- Exports: `WorkerPoolDestroyedError`, and the types `StreamAnalyzerOptions`, `PrewarmMode`,
  `RecognizerKind`, `WorkerStatsRequest`, and `WorkerStatsResponse`.

### Changed

- **Breaking:** results use Rhubarb's nine mouth shapes by default: A-F plus the extended shapes G,
  H, and X (see [Mouth Shapes](./README.md#mouth-shapes)). Pass `extendedShapes: ''` to get only
  A-F; without `contextMs` or `lookaheadMs`, output is then byte-identical to 1.0.3 for the same
  input.

  Upgrading from 1.x:

  - If your character only has art for A-F, pass `extendedShapes: ''`.
  - Create one `WorkerPool` and keep it for the whole session instead of destroying it after each
    utterance. Each worker keeps its speech decoder between calls, so reusing a pool is much faster
    than starting a new one (see
    [Pool Lifecycle and Sizing](./docs/worker-usage.md#pool-lifecycle-and-sizing)).
  - In cleanup code, ignore `WorkerPoolDestroyedError` (check with `instanceof`): pending promises
    reject with it when the pool is destroyed.
- The engine keeps its PocketSphinx decoder between calls, on the main thread and in each worker,
  instead of rebuilding it on every call (about 0.4 s per call in 1.0.3). A 250 ms chunk takes
  under 100 ms to analyze instead of about 450 ms, and the first chunk on a pool kept from an
  earlier utterance about 130 ms instead of about 480 ms. Calls with a `dialogText` different from
  the last one used still build a decoder for that text.
- Workers build their decoder during `init()` and `warmup()` (see the `prewarm` option), so the
  first analysis does not wait for it. A fresh pool still reaches its first cue sooner than in
  1.0.3; startup time grows with the worker count, most on devices with few cores.
- Decoders built without `dialogText` load only the dictionary words the language model knows (79k
  instead of 134k entries), which shortens decoder builds without changing output. The `.data` file
  is about 2 MB larger.
- PocketSphinx log messages below the active log level are no longer formatted.
- `WorkerPool` compiles the `.wasm` file once and shares the compiled module with its other workers
  (see the `shareAssets` option), and fetches the worker script once per pool.
- `WorkerPool.destroy()` rejects pending `init()`, `warmup()`, and analysis promises with
  `WorkerPoolDestroyedError`.
- `analyzeAsync()` starts the shared `WorkerPool` itself when the app has not started it.
- The `WorkerRequest` and `WorkerResponse` types include `WorkerStatsRequest` and
  `WorkerStatsResponse`.

### Fixed

- Workers no longer run out of memory after about 480 calls.
- `WorkerPool.init()` and `warmup()` no longer hang or leak workers when a worker fails to start or
  the pool is destroyed during startup.
- `recordAudio()` and `loadAudio()` close the `AudioContext` they create.

## [1.0.3] - 2025-10-09

### Fixed

- `WorkerPool` starts workers from a cross-origin (CDN) worker script by fetching it and running it
  from a blob URL.

## [1.0.2] - 2025-10-09

### Changed

- The WASM files and the worker script load from `https://unpkg.com/lip-sync-engine@<version>/dist/`
  for the installed version by default, instead of from `/dist/` on the page's origin.

## [1.0.1] - 2025-10-09

First release available on npm.

### Added

- `LipSyncEngine` class and the `analyze()` and `analyzeAsync()` functions.
- `WorkerPool` with `init()`, `warmup()`, `analyze()`, `analyzeChunks()`, `createStreamAnalyzer()`,
  `getStats()`, and `destroy()`, and `StreamAnalyzerController`.
- Audio utilities: `recordAudio()`, `loadAudio()`, `audioBufferToInt16()`, `float32ToInt16()`, and
  `resample()`.

[Unreleased]: https://github.com/biolimbo/lip-sync-engine/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/biolimbo/lip-sync-engine/releases/tag/v1.0.1
