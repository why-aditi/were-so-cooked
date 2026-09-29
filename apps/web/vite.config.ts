import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    // The Worker owns the API, the agent socket and auth; Vite serves the SPA.
    // Mirrors wrangler.jsonc's `run_worker_first` so dev and production route
    // the same paths to the same place.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      '/agents': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
      '/healthz': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
