/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

// ---------------------------------------------------------------------------
// FUSIONONE — Vite + React SPA
//
// ONE local runtime: the Vite development server on port 3000 (the port the
// immutable platform gateway proxies to the preview root). No local API
// server, no PDF server, no Next.js. Supabase (cloud) + the separately
// hosted FUSION ONE backend are reached directly from the browser.
// ---------------------------------------------------------------------------

// ── Backend companion (dev sandbox self-healing) ─────────────────────────────
//
// The dev sandbox normally boots BOTH servers via .zscripts/dev.sh (backend
// on :3001 first, then this Vite server). A platform restart race can leave
// the backend stopped while the frontend keeps running — every /backend/*
// proxy request then fails. This plugin makes the frontend self-heal that
// state: when the Vite dev server (re)starts it probes :3001 and, ONLY if
// nothing is listening, starts `bun run dev` in backend/ as a detached child
// (same command/env as dev.sh). When dev.sh already started the backend the
// probe succeeds and the plugin does nothing — the normal boot path is
// completely unchanged.
const BACKEND_PORT = 3001

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1', timeout: 500 })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

function ensureBackendCompanion(): Plugin {
  let spawning = false
  return {
    name: 'fusionone-ensure-backend',
    configureServer(server) {
      // Fire-and-forget: never blocks Vite's own startup.
      void (async () => {
        if (spawning || (await probePort(BACKEND_PORT))) return
        spawning = true
        const logFd = fs.openSync(path.resolve(__dirname, 'dev.log'), 'a')
        const child = spawn('bun', ['run', 'dev'], {
          cwd: path.resolve(__dirname, 'backend'),
          env: { ...process.env, PORT: String(BACKEND_PORT), HOST: '0.0.0.0' },
          detached: true, // survives a Vite exit, like dev.sh's disowned sibling
          stdio: ['ignore', logFd, logFd],
        })
        child.unref()
        server.config.logger.info(
          `[fusionone] backend on :${BACKEND_PORT} was not running — started it (pid ${child.pid})`,
        )
      })()
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ensureBackendCompanion()],
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
      // hot-reload restarts do not trigger Vite rebuilds. Also ignore the
      // sandbox-provided trees that live next to the project (skills/ is
      // re-extracted from ~10k files on every boot; upload/ is an OSS mount)
      // so the dev-server watcher never crawls them.
      ignored: ['**/backend/**', '**/database/**', '**/skills/**', '**/upload/**'],
    },
    // DEV-SANDBOX ROUTING (environment wiring — no application change):
    // the browser can only reach this sandbox through the platform gateway
    // (:81 → this dev server), so the locally running FUSION ONE backend
    // (Fastify on :3001) is exposed SAME-ORIGIN under the /backend path
    // prefix: VITE_FUSIONONE_BACKEND_BASE=/backend makes the SPA call
    // /backend/api/..., the rewrite below strips the prefix, and the backend
    // serves its native /api/... routes (no double prefix). SSE
    // (fetch-streamed /api/events) passes through unbuffered.
    proxy: {
      '/backend': {
        target: 'http://localhost:3001',
        ws: true,
        rewrite: (p) => p.replace(/^\/backend/, ''),
      },
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
