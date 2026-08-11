// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { resolve } from 'path';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const devPort = Number(process.env.MPS_DEV_PORT || 5173);

export default defineConfig({
  base: './',
  define: {
    __MPS_APP_VERSION__: JSON.stringify(pkg.version)
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@renderer': resolve(__dirname, 'src')
    }
  },
  server: {
    host: '127.0.0.1',
    port: Number.isFinite(devPort) ? devPort : 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: ['@huggingface/transformers', '@mediapipe/tasks-vision']
    }
  }
});
