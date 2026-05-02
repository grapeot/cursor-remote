import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** E2E / alternate backend: override with full origin, e.g. http://127.0.0.1:8791 */
const apiProxyTarget =
  process.env.CURSOR_REMOTE_VITE_API_ORIGIN?.trim() || 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  }
});
