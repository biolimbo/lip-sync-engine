import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    fs: {
      // Allow serving files from the parent directory (for npm link)
      allow: ['..', '../..'],
    },
  },
  optimizeDeps: {
    exclude: ['lip-sync-engine'],
  },
  worker: {
    format: 'iife', // Use classic worker format, not ES module
  },
});
