/**
 * useInvoicePdf — the Invoice View page's THIN adapter over the EXISTING
 * client-side invoice PDF pipeline.
 *
 * It introduces no second pipeline and no renderer of its own — every
 * document it hands to the viewer comes from the one established compose
 * step, `buildInvoicePdf` (download.ts → loadInvoiceData → the PDFKit
 * renderer, now fronted by the content-fingerprint PDF cache), the exact
 * same source the download and print actions use.
 *
 * Responsibilities (presentation only):
 *   1. ask the existing pipeline for the invoice PDF,
 *   2. keep the produced Blob available for the PDF viewer,
 *   3. regenerate when the underlying invoice data changes (`revision` —
 *      the detail query's dataUpdatedAt) or on manual refresh, while
 *      KEEPING the current document visible until the refreshed one is
 *      ready (no blank viewer, no full-screen spinner).
 *
 * Cache behavior (pdf-cache.ts, inside buildInvoicePdf):
 *   - normal open / data revision: unchanged invoice → cached PDF,
 *     changed invoice (new fingerprint) → regenerate;
 *   - manual refresh: forced regeneration (cache bypass) that replaces the
 *     cached entry — the explicit way to re-render.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InvoiceType } from './types'
import { buildInvoicePdf } from './download'
import { perfMark } from '@/platform/perf'

export type InvoicePdfStatus = 'loading' | 'ready' | 'error'

export interface InvoicePdfState {
  /** The current PDF. The previous document stays in place during regeneration. */
  blob: Blob | null
  /** Viewer-level status: 'loading' until the first document is ready. */
  status: InvoicePdfStatus
  /** Last failure message (background refresh failures keep status 'ready'). */
  error: string | null
  /** True while regenerating with a document already on screen. */
  isRefreshing: boolean
  /** Regenerate the PDF through the existing pipeline (manual refresh / retry). */
  refresh: () => void
}

export function useInvoicePdf(
  invoiceId: string | undefined,
  invoiceType: InvoiceType,
  /**
   * Bumped whenever the underlying invoice data may have changed (the detail
   * query's `dataUpdatedAt`). Zero means "invoice data not loaded yet" — the
   * first generation starts only once the row is known to exist, so the
   * pipeline never composes a document for an id that failed to load.
   */
  revision: number,
): InvoicePdfState {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [status, setStatus] = useState<InvoicePdfStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const runIdRef = useRef(0)
  const hasDocumentRef = useRef(false)
  /** Set by refresh() — the next pipeline run bypasses the cache READ. */
  const forceNextRef = useRef(false)
  /** Whether the LATEST pipeline run has settled, and whether it was forced. */
  const lastRunSettledRef = useRef(true)
  const lastRunForcedRef = useRef(false)

  useEffect(() => {
    if (!invoiceId || revision <= 0) return

    // A forced refresh re-reads the invoice data through the shared query
    // cache, which bumps the detail query's dataUpdatedAt — a self-induced
    // revision bump. That bump must not supersede the forced run it came
    // from (it would discard the freshly regenerated document the user
    // explicitly asked to see). Non-forced runs are only skipped while a
    // forced run is still in flight; once it settles, later revision bumps
    // (real data changes) run normally.
    if (!forceNextRef.current && !lastRunSettledRef.current && lastRunForcedRef.current) {
      return
    }

    const runId = ++runIdRef.current
    perfMark('pipeline-start')
    const background = hasDocumentRef.current
    const force = forceNextRef.current
    forceNextRef.current = false
    lastRunForcedRef.current = force
    lastRunSettledRef.current = false
    if (background) {
      setIsRefreshing(true)
    } else {
      setStatus('loading')
      setError(null)
    }

    buildInvoicePdf(invoiceId, invoiceType, { force })
      .then(({ blob: next }) => {
        if (runId !== runIdRef.current) return // superseded by a newer run
        hasDocumentRef.current = true
        perfMark('blob-set')
        setBlob(next)
        setStatus('ready')
        setError(null)
      })
      .catch((cause: unknown) => {
        if (runId !== runIdRef.current) return
        const message = cause instanceof Error && cause.message
          ? cause.message
          : 'Unable to load the invoice PDF.'
        if (hasDocumentRef.current) {
          // Background refresh failed — keep the current document on screen;
          // the page surfaces the failure as a toast.
          setError(message)
        } else {
          setStatus('error')
          setError(message)
        }
      })
      .finally(() => {
        // Track the LATEST run's lifecycle (a superseded run leaves the
        // flags to its successor).
        if (runId === runIdRef.current) {
          lastRunSettledRef.current = true
          lastRunForcedRef.current = false
          setIsRefreshing(false)
        }
      })
  }, [invoiceId, invoiceType, revision, attempt])

  const refresh = useCallback(() => {
    forceNextRef.current = true
    setAttempt((a) => a + 1)
  }, [])

  return { blob, status, error, isRefreshing, refresh }
}
