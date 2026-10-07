/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

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

/** Demo build only: drop the CSP meta, because the page is inlined into one file. */
function demoStripCsp(): Plugin {
  return {
    name: 'demo-strip-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
    },
  };
}

/**
 * Portal build only: one self-contained file, opened from disk or hosted in a
 * sandboxed frame. Everything is inlined, so the policy allows inline script and
 * style and data: images only, and no connections at all (the in-page API never
 * touches the network).
 */
export const PORTAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

function portalHtml(): Plugin {
  return {
    name: 'portal-html',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/, `$1${PORTAL_CSP}$2`)
        .replace(/<title>[^<]*<\/title>/, '<title>BWS Risk Portal</title>');
    },
  };
}

const LOCAL_API = 'http://127.0.0.1:8765';

export default defineConfig(({ mode }) => {
  const isMock = mode === 'mock';
  const isDemo = mode === 'demo';
  const isPortal = mode === 'portal';
  return {
    plugins: [
      react(),
      devCspRelax(),
      ...(isDemo ? [demoStripCsp(), viteSingleFile()] : []),
      ...(isPortal ? [portalHtml(), viteSingleFile()] : []),
    ],
    // The MSW service worker is only published in mock builds; production
    // builds have no public directory at all.
    publicDir: isMock ? 'mock-public' : false,
    build: {
      outDir: isDemo ? 'dist-demo' : isPortal ? 'dist-portal' : 'dist',
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
