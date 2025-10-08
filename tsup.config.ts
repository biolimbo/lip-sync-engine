import { defineConfig } from 'tsup';

export default defineConfig({
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
    console.log('✅ TypeScript build complete');
  },
});
