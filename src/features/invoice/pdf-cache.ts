/**
 * Invoice PDF cache — the persistence layer for the ONE established invoice
 * PDF pipeline (`buildInvoicePdf` in download.ts).
 *
 * It introduces no renderer and no generator of its own: it only stores and
 * returns the PDFs that pipeline has already produced, so an unchanged
 * invoice is never re-rendered.
 *
 * Identity (§ cache key) is CONTENT-based and deterministic:
 *
 *   key = rendererVersion : invoiceType : invoiceId : digest
 *
 * where `digest` is a 128-bit hash of a canonical (key-sorted, stable)
 * serialization of the complete InvoiceData — the exact object the renderer
 * receives (document rows, items, trade-ins, party, store profile, totals).
 * For an unchanged invoice this digest is identical on every open; any real
 * change (edit, payment, store profile, template/renderer version bump)
 * produces a different digest and therefore a fresh PDF.
 *
 * Two layers, in lookup order:
 *   1. memory  — a module Map that survives route navigation and unmounts
 *                within the session (second open of the same invoice);
 *   2. IndexedDB — survives page reloads / browser refresh.
 *
 * All persistent operations are best-effort: a storage failure (private
 * mode, quota, corrupted DB) silently degrades to memory-only caching and
 * never breaks PDF viewing.
 */
import type { InvoiceData, InvoiceType } from './types'
import { perfMark, perfIncrement } from '@/platform/perf'

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Renderer namespace for cache keys. Bump when the PDF template/renderer
 * output changes for the same data, so previously cached PDFs are not
 * reused across renderer versions.
 */
export const INVOICE_PDF_RENDERER_VERSION = '1'

/**
 * Deterministic 128-bit string hash (cyrb128). Pure JS — no async crypto
 * dependency — with far more collision resistance than a cache key needs.
 */
function digestOf(input: string): string {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h3 >>> 0).toString(16).padStart(8, '0') +
    (h4 >>> 0).toString(16).padStart(8, '0')
  )
}

/**
 * Canonical JSON — object keys sorted recursively, `undefined` properties
 * omitted — so the serialization of the same data is byte-identical on every
 * open, regardless of key insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'undefined' ? 'null' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

/**
 * The cache key for a rendered invoice PDF. Deterministic for identical
 * invoice data; different for ANY change to the rendered content.
 */
export function invoicePdfCacheKey(
  invoiceId: string,
  invoiceType: InvoiceType,
  data: InvoiceData,
): string {
  const digest = digestOf(
    canonicalJson({
      rendererVersion: INVOICE_PDF_RENDERER_VERSION,
      invoiceId,
      data,
    }),
  )
  return `v${INVOICE_PDF_RENDERER_VERSION}:${invoiceType}:${invoiceId}:${digest}`
}

// ── Cached record shape ─────────────────────────────────────────────────────

export interface CachedInvoicePdf {
  key: string
  invoiceType: InvoiceType
  invoiceId: string
  billNumber: string
  blob: Blob
  createdAt: number
  byteSize: number
}

// ── Layer 1: memory ─────────────────────────────────────────────────────────

const memoryCache = new Map<string, CachedInvoicePdf>()

// ── Layer 2: IndexedDB (best-effort) ────────────────────────────────────────

const DB_NAME = 'fusionone-invoice-pdfs'
const STORE = 'pdfs'
/** Upper bound on persisted entries — oldest are evicted beyond this. */
const MAX_ENTRIES = 50

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

async function idbGet(key: string): Promise<CachedInvoicePdf | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(STORE, 'readonly')
    const value = await requestAsPromise<CachedInvoicePdf | undefined>(
      tx.objectStore(STORE).get(key),
    )
    return value && value.blob instanceof Blob ? value : null
  } catch {
    return null
  }
}

async function idbPut(record: CachedInvoicePdf): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  try {
    const tx = db.transaction(STORE, 'readwrite')
    await requestAsPromise(tx.objectStore(STORE).put(record))
    return true
  } catch {
    return false
  }
}

/** Evict oldest entries beyond MAX_ENTRIES (by createdAt). Best-effort. */
async function idbTrim(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const entries = await requestAsPromise<CachedInvoicePdf[]>(store.getAll())
    if (entries.length <= MAX_ENTRIES) return
    const excess = entries.length - MAX_ENTRIES
    const oldest = [...entries].sort((a, b) => a.createdAt - b.createdAt).slice(0, excess)
    const tx2 = db.transaction(STORE, 'readwrite')
    for (const entry of oldest) tx2.objectStore(STORE).delete(entry.key)
    stats.evictions += oldest.length
  } catch {
    // Trimming is an optimization — ignore failures.
  }
}

async function idbClear(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    await requestAsPromise(tx.objectStore(STORE).clear())
  } catch {
    // Best-effort.
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up a cached PDF: memory first, then IndexedDB (an IDB hit is promoted
 * into the memory cache). Returns null on any miss/failure.
 */
export async function readCachedInvoicePdf(key: string): Promise<Blob | null> {
  stats.reads += 1
  const memoryHit = memoryCache.get(key)
  if (memoryHit) {
    stats.memoryHits += 1
    perfIncrement('memoryHits')
    perfMark('cache-hit-mem')
    return memoryHit.blob
  }
  const persistentHit = await idbGet(key)
  if (persistentHit) {
    memoryCache.set(key, persistentHit)
    stats.persistentHits += 1
    perfIncrement('idbHits')
    perfMark('cache-hit-idb')
    return persistentHit.blob
  }
  stats.misses += 1
  perfIncrement('misses')
  perfMark('cache-miss')
  return null
}

/**
 * Store a rendered PDF in both layers (memory + IndexedDB). Never throws —
 * a caching failure must not affect PDF viewing.
 */
export async function writeCachedInvoicePdf(record: Omit<CachedInvoicePdf, 'createdAt' | 'byteSize'>): Promise<void> {
  const full: CachedInvoicePdf = {
    ...record,
    createdAt: Date.now(),
    byteSize: record.blob.size,
  }
  memoryCache.set(full.key, full)
  stats.writes += 1
  if (await idbPut(full)) {
    stats.persistentWrites += 1
    await idbTrim()
  }
}

/** Clear both layers (sign-out — cached documents are user/store-scoped). */
export async function clearInvoicePdfCache(): Promise<void> {
  memoryCache.clear()
  stats.clears += 1
  await idbClear()
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export interface InvoicePdfCacheStats {
  reads: number
  memoryHits: number
  persistentHits: number
  misses: number
  writes: number
  persistentWrites: number
  evictions: number
  clears: number
  memoryEntries: number
}

const stats: InvoicePdfCacheStats = {
  reads: 0,
  memoryHits: 0,
  persistentHits: 0,
  misses: 0,
  writes: 0,
  persistentWrites: 0,
  evictions: 0,
  clears: 0,
  memoryEntries: 0,
}

/** Live counters — used to verify cache behavior (hit vs regeneration). */
export function getInvoicePdfCacheStats(): InvoicePdfCacheStats {
  return { ...stats, memoryEntries: memoryCache.size }
}
