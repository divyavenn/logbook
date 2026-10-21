import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    // The shell is precached so the logbook opens, and stays editable, with no
    // network. Entry edits queue locally and flush when one returns.
    registerType: 'autoUpdate',
    injectRegister: 'inline',
    manifest: false,
    workbox: {
      inlineWorkboxRuntime: true,
      // Take over the open page too, so the first visit is already covered.
      clientsClaim: true,
      skipWaiting: true,
      globPatterns: ['**/*.{js,css,html,woff2,svg}'],
      navigateFallback: 'index.html',
      // Reads and writes must reach the server, and these are its own routes.
      navigateFallbackDenylist: [/^\/api\//, /^\/journal\.md$/, /^\/llms\.txt$/, /^\/openapi\.json$/, /^\/docs/, /^\/sw\.js$/],
    },
  })],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(['/api', '/journal.md', '/llms.txt', '/openapi.json', '/docs'].map(path => [path, 'http://127.0.0.1:8000'])),
  },
});
