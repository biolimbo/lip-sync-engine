import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Serve the shared images in ../assets at the site root (/visemes/X.png)
  publicDir: '../assets',
  server: {
    port: 3002,
  },
});
