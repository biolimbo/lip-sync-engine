# Development Guide

How to build lip-sync-engine from source, test changes against the examples, and publish a release.

## Prerequisites

- Node.js 20 or newer, and npm
- Emscripten SDK, activated in your shell (`source ./emsdk_env.sh`) so `emcmake` and `emmake` are on `PATH`. Needed only for the WASM build.
- CMake 3.13 or newer (WASM build only)
- Python 3, only for the [speech model](#speech-models) script and the benchmark audio scripts in `bench/`

## Setup

```bash
git clone https://github.com/biolimbo/lip-sync-engine.git
cd lip-sync-engine
npm ci
npm run build
```

`npm run build` runs the WASM build and then the TypeScript build. Without Emscripten you can still run `npm run build:ts`, `npm run typecheck`, and `npm test`.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | `build:wasm`, then `build:ts` |
| `npm run build:wasm` | Configures CMake with Emscripten in `build/` and compiles the C++ engine to `dist/wasm/`. Packages `models/sphinx/` into `lip-sync-engine.data` (mounted at `/wasm/res/sphinx`). |
| `npm run build:ts` | Bundles the TypeScript wrapper with tsup: CJS and ESM bundles, type definitions, and `dist/worker.js`. Leaves `dist/wasm/` in place. |
| `npm run dev` | `tsup --watch`: rebuilds the TypeScript bundles on every change |
| `npm test` | Runs the Vitest unit tests in `test/` once. No WASM build needed. |
| `npm run test:watch` | Runs Vitest in watch mode |
| `npm run typecheck` | Type-checks `src/ts/` and `test/` |
| `npm run clean` | Deletes `dist/` and `build/` |

For a clean rebuild, run `npm run clean && rm -rf node_modules`, then `npm ci && npm run build`.

Every TypeScript build is minified and writes source maps (`.map` files) next to the bundles.

## Project Structure

```
lip-sync-engine/
├── src/
│   ├── cpp/              # C++ engine, compiled to WebAssembly
│   └── ts/               # TypeScript wrapper and worker
├── lib/                  # Vendored C/C++ dependencies (PocketSphinx, WebRTC VAD, ...)
├── models/sphinx/        # Speech models packaged into the .data file
├── test/                 # Vitest unit tests
├── bench/                # Benchmarks (see BENCHMARK.md)
├── examples/             # React, Vue, Svelte, and vanilla examples
├── docs/                 # Documentation
├── scripts/              # Build and release scripts
├── build/                # CMake build directory (created by build:wasm)
└── dist/                 # Built package
    ├── wasm/             # lip-sync-engine.js, .wasm, .data
    ├── index.js          # CJS bundle
    ├── index.mjs         # ESM bundle
    ├── index.d.ts        # Type definitions (plus index.d.mts)
    └── worker.js         # Web Worker bundle
```

## Speech Models

`models/sphinx/` is packaged into `lip-sync-engine.data` by the WASM build:

- `acoustic-model/`: PocketSphinx acoustic model
- `en-us.lm.bin`: word language model
- `en-us-phone.lm.bin`: phone language model
- `cmudict-en-us.dict`: full pronunciation dictionary
- `cmudict-en-us.lm-vocab.dict`: the dictionary entries whose words are in `en-us.lm.bin`, used when there is no dialog text. The engine falls back to the full dictionary if this file is missing.

After changing `en-us.lm.bin` or `cmudict-en-us.dict`, regenerate the filtered dictionary and rebuild the WASM:

```bash
python3 scripts/filter-dict.py models/sphinx
npm run build:wasm
```

## Testing Against the Examples

The examples depend on the published `lip-sync-engine`. How you test a local change depends on what you changed:

| Change | Route |
|---|---|
| TypeScript API in the main bundle (`dist/index.*`) | [Link the package](#link-the-package-into-an-example) into an example |
| C++, speech models, or `src/ts/worker.ts` | [Vanilla example with `?local`](#vanilla-example-with-local), or a [framework example with local paths](#framework-example-with-local-paths) |

`npm link` replaces only the JavaScript bundle. The React, Vue, and Svelte examples call `init()` without paths, so the WASM files and `worker.js` still load from `https://unpkg.com/lip-sync-engine@<version>/dist/`, where `<version>` is the version in `package.json`. Changes to the C++ engine, the models, or the worker are not exercised that way. After a version bump to an unpublished version, those unpkg URLs return 404 and the linked examples fail to load until you point them at local paths.

### Link the Package into an Example

Build, then register the repository as a global link:

```bash
npm run build:ts
npm link
```

Then install and link one example. Run each block from the repository root:

```bash
cd examples/react
npm install
npm link lip-sync-engine
npm run dev   # http://localhost:3000
```

```bash
cd examples/vue
npm install
npm link lip-sync-engine
npm run dev   # http://localhost:3001
```

```bash
cd examples/svelte
npm install
npm link lip-sync-engine
npm run dev   # http://localhost:3002
```

Running `npm install` in an example again replaces the link with the published package, so run `npm link lip-sync-engine` again afterwards. Keep `npm run dev` running in the repository root (in a second terminal) to rebuild the bundle on every change, then reload the example page. Vite serves the linked bundle straight from `dist/`, so a rebuild needs no dev server restart.

### Vanilla Example with `?local`

The vanilla page loads the library from unpkg unless the URL has `?local`. With `?local` it loads `index.mjs`, `worker.js`, and the WASM files from `../../dist/` relative to the page, so serve the repository root:

```bash
npm run build
npx http-server -p 8000 -c-1
# Open http://localhost:8000/examples/vanilla/?local
```

`-c-1` turns off caching, so a reload picks up a rebuilt `dist/`. Any static server works if it serves `.mjs` files as JavaScript.

### Framework Example with Local Paths

To run the React, Vue, or Svelte example against a local WASM and worker build, serve the repository root with CORS enabled (the dev server runs on a different port):

```bash
npm run build
npx http-server -p 8000 -c-1 --cors
```

Then pass local URLs where the example creates the engine and the pool: `examples/react/src/hooks/useLipSyncEngine.ts`, `examples/vue/src/composables/useLipSyncEngine.ts`, or `examples/svelte/src/stores/lipSyncEngine.ts`. Add the paths near the top of the file. Use absolute URLs, because workers resolve relative paths against the worker script, not the page:

```typescript
const DIST = 'http://localhost:8000/dist/';
const paths = {
  wasmPath: `${DIST}wasm/lip-sync-engine.wasm`,
  dataPath: `${DIST}wasm/lip-sync-engine.data`,
  jsPath: `${DIST}wasm/lip-sync-engine.js`,
};
```

In `prepare()`, change `LipSyncEngine.getInstance().init()` to `LipSyncEngine.getInstance().init(paths)` and `pool.init()` to `` pool.init({ ...paths, workerScriptUrl: `${DIST}worker.js` }) ``. Do not commit these edits. Combine them with [the link step](#link-the-package-into-an-example) to test TypeScript and WASM changes together.

## Adding a Feature

1. Implement the API in `src/ts/`. Methods on `LipSyncEngine` or `WorkerPool` need no extra export. Export a new standalone function or type from `src/ts/index.ts`.
2. Add tests in `test/` and run `npm test`.
3. Try the change in an example (see [Testing Against the Examples](#testing-against-the-examples)).
4. Update the documentation in `docs/` and `README.md`.
5. Run the checks CI runs (`.github/workflows/build.yml`):

   ```bash
   npm run build
   npm run typecheck
   npm test
   npm pack --dry-run --ignore-scripts
   ```

   `npm pack --dry-run` lists the files that would be published. Check that `dist/wasm/` and `dist/worker.js` are included.

CI runs these checks on every push and pull request to `main`. Before publishing, the publish workflow runs the build, the type check, and the tests again.

## Debugging the WASM Build

`npm run build:wasm` always configures a Release build, and `CMakeLists.txt` sets `-O3` and `-sASSERTIONS=0` in the link flags for every build type. To get Emscripten runtime assertions or readable stack traces, change those flags locally (for example to `-O0 -g -sASSERTIONS=1`), run `npm run build:wasm`, and revert the change before committing. The build writes to `dist/wasm/` and replaces the release build there.

To inspect the compiled module, use `wasm-objdump` from [WABT](https://github.com/WebAssembly/wabt):

```bash
wasm-objdump -x dist/wasm/lip-sync-engine.wasm
```

## Benchmarks

The benchmark and quality scripts in `bench/` drive headless Chromium through `playwright-core`, and `bench/prepare-audio.py` and `bench/h2h/truth.py` prepare the test audio and reference data with Python 3. See [BENCHMARK.md](../BENCHMARK.md) for the setup and results.

## Releasing

Releases are published by GitHub Actions (`.github/workflows/publish.yml`) with npm trusted publishing, so no npm token is stored in the repository. The package's trusted publisher on npmjs.com names this repository and the workflow file `publish.yml`.

1. Add the release notes to [CHANGELOG.md](../CHANGELOG.md) under a `## [X.Y.Z] - YYYY-MM-DD` heading. The workflow uses this section as the GitHub release notes.
2. Bump the version (updates `package.json` and `package-lock.json` without creating a tag):

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

3. Run the [CI checks](#adding-a-feature) locally, commit the version bump and changelog, and push the commit to `main` (directly or through a pull request).
4. Optional: publish a release candidate of the pushed commit under the `next` dist-tag. `package.json` stays at `X.Y.Z`; the workflow applies the prerelease version in CI.

   ```bash
   git tag vX.Y.Z-rc.N
   git push origin vX.Y.Z-rc.N
   # Test it with: npm install lip-sync-engine@next
   ```

5. Publish the stable release under the `latest` dist-tag by tagging the pushed commit:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow rejects a tag whose version does not match `package.json` (for a prerelease tag, its `X.Y.Z` part), or a stable tag without a CHANGELOG section, before anything is published. Any prerelease tag publishes under `next`. After publishing, it creates the GitHub release for the tag (a prerelease for prerelease tags), with notes from `scripts/release-notes.mjs`; preview them with `node scripts/release-notes.mjs vX.Y.Z`. To check the workflow without publishing, run it from the Actions tab ("Run workflow") with "dry run" ticked.

## Troubleshooting

### Changes Do Not Show Up in an Example

- C++, model, or worker changes: linked examples still load the WASM files and `worker.js` from unpkg. Use one of the [local routes](#testing-against-the-examples).
- TypeScript changes: rebuild with `npm run build:ts` (or keep `npm run dev` running), then check that the example is still linked: `ls -l node_modules/lip-sync-engine` in the example shows a symlink. If it does not, run `npm link lip-sync-engine` again and restart the example's dev server.

### WASM Does Not Load

Open the browser's Network tab and find the requests for `lip-sync-engine.wasm`, `lip-sync-engine.data`, `lip-sync-engine.js`, and `worker.js`:

- Requests go to `https://unpkg.com/lip-sync-engine@<version>/dist/...` when the example passes no paths. A 404 there means `<version>` (from `package.json`) is not published; use local paths.
- Requests go to the `wasmPath`, `dataPath`, `jsPath`, and `workerScriptUrl` you configured otherwise. A CORS error means the server needs CORS headers (`--cors` for `http-server`).

A failed load is not cached: after fixing the cause, calling `init()` again (or switching modes in an example) loads the files again.

### Type Errors in an Example

Run `npm run build:ts` to regenerate `dist/index.d.ts`, then make sure the example is still linked (`npm link lip-sync-engine`).

## Getting Help

- [API Reference](./api-reference.md)
- [Examples](../examples/)
- [Report a bug](https://github.com/biolimbo/lip-sync-engine/issues)
