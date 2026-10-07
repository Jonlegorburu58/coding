/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The strict CSP lives in index.html and ships unchanged in every build.
 * Only the Vite dev server needs inline scripts (React Fast Refresh preamble)
 * and a websocket for hot reload, so the policy is relaxed for `vite serve` only.
 */
function devCspRelax(): Plugin {
  return {
    name: 'dev-csp-relax',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "default-src 'self';",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*;",
      );
    },
  };
}

const LOCAL_API = 'http://127.0.0.1:8765';

export default defineConfig(({ mode }) => {
  const isMock = mode === 'mock';
  return {
    plugins: [react(), devCspRelax()],
    // The MSW service worker is only published in mock builds; production
    // builds have no public directory at all.
    publicDir: isMock ? 'mock-public' : false,
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
    server: {
      host: '127.0.0.1',
      port: isMock ? 5174 : 5173,
      strictPort: true,
      proxy: isMock
        ? undefined
        : {
            // changeOrigin rewrites Host to 127.0.0.1:8765 so the backend's Host check passes in dev.
            '/api': { target: LOCAL_API, changeOrigin: true },
            '/launch': { target: LOCAL_API, changeOrigin: true },
          },
    },
    preview: { host: '127.0.0.1' },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      testTimeout: 15000,
    },
  };
});
