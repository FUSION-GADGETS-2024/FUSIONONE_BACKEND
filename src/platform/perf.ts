/**
 * Dev-only invoice-path timing marks (development diagnostics).
 *
 * Gated by `import.meta.env.DEV`: in production builds every function is a
 * no-op (the constant folds to `false`, so the calls disappear), and nothing
 * is written to the console or to `window` — normal users never see this.
 *
 * In development it traces the Invoice View loading path so regressions in
 * the PDF pipeline can be measured end-to-end:
 *
 *   click → mount → data fetch → cache lookup → generation → PDF.js
 *         → document opened → first page rendered
 *
 * Usage: `window.__invoicePerf.log` holds one summary line per completed
 * open (readable from the devtools console), and `window.__invoicePerf.counters`
 * exposes the pipeline/cache counters used to verify "no generation on cache
 * hit" behavior.
 */

const ENABLED = import.meta.env.DEV

export interface InvoicePerfCounters {
  /** buildInvoicePdf pipeline runs (whole compose step, any outcome). */
  pipelineRuns: number
  /** PDFKit renderer executions (must stay 0 on cache hits). */
  generationRuns: number
  /** Cache reads and their outcomes. */
  cacheReads: number
  memoryHits: number
  idbHits: number
  misses: number
  /** pdfjs module loads (worker warmups) — expect 1 per session. */
  pdfjsLoads: number
}

interface PerfState {
  t0: number | null
  marks: Record<string, number>
  log: string[]
  counters: InvoicePerfCounters
}

const emptyCounters = (): InvoicePerfCounters => ({
  pipelineRuns: 0,
  generationRuns: 0,
  cacheReads: 0,
  memoryHits: 0,
  idbHits: 0,
  misses: 0,
  pdfjsLoads: 0,
})

function state(): PerfState | null {
  if (!ENABLED) return null
  const w = window as unknown as { __invoicePerf?: PerfState }
  if (!w.__invoicePerf) {
    w.__invoicePerf = { t0: null, marks: {}, log: [], counters: emptyCounters() }
  }
  return w.__invoicePerf
}

/** T0 — the user activated VIEW (dev diagnostics only; no-op in prod). */
export function perfViewClick(): void {
  const s = state()
  if (!s) return
  s.t0 = performance.now()
  s.marks = {}
}

/** Begin a trace at page mount when no click mark exists (direct URL). */
export function perfTraceMount(label: string): void {
  const s = state()
  if (!s) return
  if (s.t0 === null) {
    // A new trace begins at mount (direct URL / browser refresh) — stale
    // marks from the previous trace must not leak into this one.
    s.t0 = performance.now()
    s.marks = {}
  }
  s.marks[label] = performance.now()
}

/** Record a named point on the current trace. */
export function perfMark(name: string): void {
  const s = state()
  if (!s) return
  if (s.t0 === null) s.t0 = performance.now()
  s.marks[name] = performance.now()
}

export function perfIncrement(counter: keyof InvoicePerfCounters): void {
  const s = state()
  if (!s) return
  s.counters[counter] += 1
}

function ms(from: number | undefined, to: number | undefined): string {
  if (from === undefined || to === undefined) return '—'
  return `${Math.round(to - from)}ms`
}

/**
 * Close the current trace at "viewer usable" (first PDF page rendered) and
 * emit ONE summary line. Subsequent page renders / interactions do not log.
 */
export function perfReport(context: string): void {
  const s = state()
  if (!s || s.t0 === null) return
  const m = s.marks
  const t0 = s.t0
  const cache =
    m['cache-hit-mem'] !== undefined ? 'HIT(mem)'
    : m['cache-hit-idb'] !== undefined ? 'HIT(idb)'
    : m['cache-miss'] !== undefined ? 'MISS'
    : 'bypassed'
  const parts = [
    `mount ${ms(t0, m['mount'])}`,
    `→data ${ms(m['mount'], m['data-end'])}`,
    `cache ${cache}`,
    `gen ${ms(m['gen-start'], m['gen-end'])}`,
    `pdfjs ${ms(m['blob-set'], m['pdfjs-ready'])}`,
    `parse ${ms(m['pdfjs-ready'], m['doc-opened'])}`,
    `page1 ${ms(m['doc-opened'], m['page1-rendered'])}`,
  ]
  const total = ms(t0, m['page1-rendered'])
  const line = `[invoice-perf] ${context} | ${parts.join(' | ')} | TOTAL ${total}`
  s.log.push(line)
  s.t0 = null // further marks for this open are ignored until the next click
  // eslint-disable-next-line no-console
  console.log(line)
}
