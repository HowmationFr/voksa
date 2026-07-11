import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Production CSP: no localhost, no inline scripts (the built bundle is an
// external module script). Inline styles are still needed for Tailwind/React
// style props, hence 'unsafe-inline' on style-src only.
const PROD_CSP =
  "default-src 'self' data: blob:; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  'img-src * data: blob: crx: chrome-extension:; ' +
  "font-src 'self' data:; " +
  "connect-src 'self';";

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname, 'src/ui'),
  base: './',
  plugins: [
    react(),
    {
      name: 'hbb-prod-csp',
      transformIndexHtml(html) {
        if (command !== 'build') return html;
        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
          `<meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`,
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/ui'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-ui'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome128',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
