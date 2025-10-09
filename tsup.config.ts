import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library bundle
  {
    entry: ['src/ts/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: false, // Don't clean - preserves WASM files from build:wasm
    sourcemap: true,
    splitting: false,
    minify: true,
    treeshake: true,
    external: [],
    outDir: 'dist',
    onSuccess: async () => {
      console.log('✅ Main library build complete');
    },
  },
  // Worker bundle (separate entry point)
  {
    entry: ['src/ts/worker.ts'],
    format: ['esm'], // Workers only support ESM
    dts: false, // No need for type definitions for worker
    clean: false,
    sourcemap: true,
    splitting: false,
    minify: true,
    treeshake: true,
    external: [],
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
    onSuccess: async () => {
      console.log('✅ Worker build complete');
    },
  }
]);
