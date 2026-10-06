/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// ---------------------------------------------------------------------------
// FUSIONONE — Vite + React SPA
//
// ONE local runtime: the Vite development server on port 3000 (the port the
// immutable platform gateway proxies to the preview root). No local API
// server, no PDF server, no Next.js. Supabase (cloud) + the separately
// hosted FUSION ONE backend are reached directly from the browser.
// ---------------------------------------------------------------------------
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',
    // The sandbox preview is served through a platform gateway. Both host
    // families have been observed in the wild: *.space-z.ai / *.z.ai and the
    // Alibaba-FC gateway host (*.cn-hongkong-vpc.fcapp.run) — allow both so
    // the gateway never gets a "Blocked request" 403 from the dev server.
    allowedHosts: [
      '.space-z.ai',
      '.z.ai',
      'ws-edc-b-beddbd-ifbijxckew.cn-hongkong-vpc.fcapp.run',
      '.fcapp.run',
    ],
    watch: {
      // The workspace root also contains backend/ — ignore it so backend
      // hot-reload restarts do not trigger Vite rebuilds.
      ignored: ['**/backend/**', '**/database/**'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // chunkSizeWarningLimit raised: pdfkit standalone is deliberately split
    // into its own lazy chunk (loaded only when an invoice PDF is requested).
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-supabase': ['@supabase/supabase-js', '@supabase/ssr'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
  optimizeDeps: {
    // The workspace root contains non-app directories (backend/,
    // database/, skills/) — never let the dep scanner crawl them.
    entries: ['index.html', 'src/**/*'],
    exclude: ['pdfkit/js/pdfkit.standalone.js'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
