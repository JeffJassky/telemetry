import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// `base: './'` keeps every asset reference relative. The server injects a
// `<base href="<mountPath>/">` into index.html at request time, so one build
// works at any mount path — unlike a baked-in absolute base, which forces a
// rebuild per host. See standards/traps.md #8.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../dist/ui'),
    emptyOutDir: true,
    assetsDir: '_assets',
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api/telemetry': 'http://localhost:3000',
    },
  },
});
