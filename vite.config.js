import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

/*
 * The build stamps its own version into the bundle. Everything that needs to
 * know "which build is this?" - the menu footer, the updater, the changelog's
 * "you are here" marker - reads the same value, so they can never disagree,
 * and a release can never be published claiming a version it is not.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: {
    __AETHERIS_VERSION__: JSON.stringify(pkg.version),
  },
  // Never let the browser keep a module from a previous run of the server.
  // Dev serves many small ES modules; if the browser holds an old copy of one
  // while fetching a fresh copy of another, the graph disagrees and the page
  // dies with "does not provide an export named ..." — which is exactly what a
  // tab left open across a server restart produces. The e2e bundle is a single
  // file and cannot hit this.
  server: {
    host: '0.0.0.0',
    headers: {
      'Cache-Control': 'no-store',
    },
    // 5173 is the usual port; if an older build of the game is already holding
    // it, step to the next free one instead of refusing to start.
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
});
