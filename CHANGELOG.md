# Changelog

All notable changes to `lip-sync-engine` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

[2.0.0]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/biolimbo/lip-sync-engine/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/biolimbo/lip-sync-engine/releases/tag/v1.0.1
