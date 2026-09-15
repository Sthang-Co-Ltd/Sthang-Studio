import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Monterey can run Safari 17; do not let Vite's moving default silently
  // raise the browser floor above the macOS source compatibility target.
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari17'],
    cssTarget: 'safari17'
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/exports': 'http://127.0.0.1:8787'
    }
  }
});
