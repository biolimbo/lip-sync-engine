import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // Serve the shared images in ../assets at the site root (/visemes/X.png)
  publicDir: '../assets',
  server: {
    port: 3001,
  },
});
