import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Serve the shared images in ../assets at the site root (/visemes/X.png)
  publicDir: '../assets',
  server: {
    port: 3000,
  },
});
