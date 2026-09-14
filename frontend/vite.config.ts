import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All KIP API routes (projects, sources, admin) — without this, unmatched
      // /v1 calls fall back to index.html (200 text/html) and break the client.
      '/v1': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist' },
});