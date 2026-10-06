'use client';

/**
 * InvoicePdfViewer — displays the ACTUAL generated invoice PDF.
 *
 * The PDF Blob always comes from the application's one established invoice
 * pipeline (buildInvoicePdf) — this component never composes, caches, or
 * re-renders invoice data itself. It is purely a document surface:
 *
 *   - the viewer root is the page's ONLY vertical scroll container: the
 *     document scrolls inside this box while the invoice header and action
 *     sidebar around it stay stationary (zooming also affects only this box)
 *   - real PDF pages, rendered with pdf.js onto white document sheets
 *   - correct page proportions at every scale (never distorted)
 *   - multi-page documents rendered progressively (visible pages first,
 *     offscreen pages as they approach the viewport)
 *   - minimal FUSIONONE-styled controls: page indicator, zoom out / level /
 *     zoom in, fit width — floating at the bottom of the scroll area
 *
 *   Loading rules (PDF areas never use document-shaped skeletons):
 *   - while the document parses, the viewer keeps its stable geometry and
 *     shows a clean neutral sheet plus — only after a short grace period —
 *     one very small local loading ring. No fake invoice content, no
 *     shimmering bars, no animated large surface.
 *   - each not-yet-rendered page reserves its exact sheet geometry as a
 *     plain white sheet; the real page simply appears when painted.
 *   - inline error with Retry, and a subtle regeneration indicator that
 *     never removes the visible document.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { Expand, Minus, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { InvoiceViewError } from './InvoiceViewError';
import { perfMark, perfIncrement, perfReport } from '@/platform/perf';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ── pdf.js loader ────────────────────────────────────────────────────────────
// Loaded through a dynamic import so the (large) pdf.js core stays out of the
// initial bundle — the same lazy-loading pattern the app uses for PDFKit.

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    perfIncrement('pdfjsLoads');
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise.then((pdfjs) => {
    // Marked per document load — instant when the module is already warm.
    perfMark('pdfjs-ready');
    return pdfjs;
  });
}

/**
 * Idle prewarm for the invoice viewer — loads the pdf.js module + worker in
 * the background after the app becomes idle, so the FIRST invoice open of a
 * session does not pay their startup (~200ms measured). Purely an
 * optimization: failures are ignored and the viewer loads pdf.js on demand
 * exactly as before. pdf.js itself stays OUT of the initial bundle (the
 * dynamic import above is the only entry).
 */
export function warmInvoicePdfViewer(): void {
  void loadPdfjs().catch(() => { /* best-effort prewarm */ });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface InvoicePdfViewerProps {
  /** The generated PDF from the existing invoice pipeline. */
  blob: Blob | null;
  /** 'loading' until the first document is ready (viewer shows its skeleton). */
  status: 'loading' | 'ready' | 'error';
  /** Document-level failure message (shown in the inline error state). */
  error?: string | null;
  /** Regenerate through the existing pipeline (Retry button). */
  onRetry: () => void;
  /** True while a regeneration is running with a document already on screen. */
  isRefreshing?: boolean;
  /**
   * Regenerate/revalidate the document through the existing pipeline — the
   * invoice-specific refresh action, presented inside the preview controls.
   * NOT a page reload: the page stays mounted and the current document
   * remains visible until the fresh one is ready.
   */
  onRegenerate?: () => void;
}

interface LoadedDocument {
  pdf: PDFDocumentProxy;
  numPages: number;
  /** Unscaled page size (PDF points) — A4: 595.28 × 841.89. */
  pageW: number;
  pageH: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
const DPR_CAP = 2;
const A4_ASPECT = '595.28 / 841.89';

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

// ── Single PDF page ──────────────────────────────────────────────────────────

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Eager pages render without waiting to approach the viewport. */
  eager: boolean;
  onRegister: (pageNumber: number, el: HTMLDivElement | null) => void;
}

function PdfPage({ pdf, pageNumber, scale, eager, onRegister }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(eager);
  const [rendered, setRendered] = useState(false);

  // Resolve the page proxy + its unscaled size once per document.
  useEffect(() => {
    let alive = true;
    setPage(null);
    setSize(null);
    setRendered(false);
    pdf.getPage(pageNumber).then((p) => {
      if (!alive) return;
      const vp = p.getViewport({ scale: 1 });
      setPage(p);
      setSize({ w: vp.width, h: vp.height });
    }).catch(() => { /* page-level failures keep the reserved skeleton */ });
    return () => { alive = false; };
  }, [pdf, pageNumber]);

  // Progressive rendering: draw the page the first time it approaches the
  // viewport (rootMargin looks ahead roughly one viewport height).
  useEffect(() => {
    if (visible) return;
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: '120% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // Render (and re-render on scale change) onto the canvas.
  useEffect(() => {
    if (!visible || !page || !size || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const viewport = page.getViewport({ scale });

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;

    taskRef.current?.cancel();
    setRendered(false);
    const task = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    taskRef.current = task;
    let alive = true;
    task.promise.then(() => {
      if (alive) {
        setRendered(true);
        // Dev-only trace close: the moment the FIRST page paints is "viewer
        // usable". Later pages/zooms re-render but do not re-report.
        if (pageNumber === 1) {
          perfMark('page1-rendered');
          perfReport('invoice-view');
        }
      }
    }).catch(() => { /* cancelled renders fall through to the next run */ });
    return () => {
      alive = false;
      task.cancel();
      taskRef.current = null;
    };
  }, [page, size, scale, visible]);

  const w = size ? Math.floor(size.w * scale) : undefined;
  const h = size ? Math.floor(size.h * scale) : undefined;

  return (
    <div
      ref={(el) => onRegister(pageNumber, el)}
      className="relative bg-white shadow-md shadow-slate-900/10 ring-1 ring-slate-900/5 rounded-sm"
      style={w && h ? { width: w, height: h } : undefined}
      data-page={pageNumber}
    >
      {/* Sheet geometry placeholder (A4 proportion) until measured. */}
      {!w && <div className="w-full" style={{ aspectRatio: A4_ASPECT }} />}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Invoice page ${pageNumber}`}
        className={cn('absolute inset-0', !rendered && 'invisible')}
      />
      {/* Until the page paints, the reserved sheet simply stays a clean
          neutral surface (the page box is bg-white). No skeleton content,
          no per-page shimmer — the real page appears when rendered. */}
    </div>
  );
}

// ── Viewer ───────────────────────────────────────────────────────────────────

export function InvoicePdfViewer({
  blob, status, error, onRetry, isRefreshing = false, onRegenerate,
}: InvoicePdfViewerProps) {
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  // The tiny parsing indicator only appears if parsing outlasts the grace
  // period — a cached/fast document never flashes a loader (visual-only
  // gate; it never delays the document itself). The grace is 300 ms here
  // (not the app-wide 150 ms) because a typical warm parse itself measures
  // 120–180 ms (pdf.js document open + first-page viewport): at 150 ms the
  // ring blipped for a frame or two on otherwise-fast opens, which is
  // exactly the transient flash this threshold exists to prevent.
  const showParsingIndicator = useSkeletonDelay(!doc, 300);

  const scrollRef = useRef<HTMLDivElement>(null); // the viewer's scroll box
  const panRef = useRef<HTMLDivElement>(null); // width measurement + horizontal pan
  const pagesRef = useRef(new Map<number, HTMLDivElement>());

  // ── Document lifecycle: existing pipeline Blob → pdf.js document ──
  useEffect(() => {
    if (!blob) {
      setDoc(null);
      setDocError(null);
      return;
    }
    let cancelled = false;
    let loadingTask: ReturnType<typeof import('pdfjs-dist').getDocument> | null = null;
    setDocError(null);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // A fresh byte copy per load — pdf.js transfers the buffer to its worker.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        loadingTask = pdfjs.getDocument({ data: bytes });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        perfMark('doc-opened');
        const first = await loaded.getPage(1);
        if (cancelled) return;
        const vp = first.getViewport({ scale: 1 });
        setDoc({
          pdf: loaded,
          numPages: loaded.numPages,
          pageW: vp.width,
          pageH: vp.height,
        });
        setCurrentPage(1);
      } catch (cause) {
        if (cancelled) return;
        setDoc(null);
        setDocError(
          cause instanceof Error && cause.message
            ? cause.message
            : 'The invoice PDF could not be opened.',
        );
      }
    })();
    return () => {
      cancelled = true;
      // v6: the loading task owns the worker lifecycle.
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  // ── Fit width: scale the sheet to the available document width ──
  const applyFit = useCallback((pageW: number) => {
    const available = panRef.current?.clientWidth ?? 0;
    if (available > 0 && pageW > 0) {
      setScale(clampScale(available / pageW));
    }
  }, []);

  useEffect(() => {
    if (fitWidth && doc) applyFit(doc.pageW);
  }, [fitWidth, doc, applyFit]);

  useEffect(() => {
    if (!fitWidth || !doc) return;
    const el = panRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => applyFit(doc.pageW));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth, doc, applyFit]);

  // ── Page indicator: which sheet sits at the reading position ──
  useEffect(() => {
    if (!doc || doc.numPages < 2) return;
    const pages = pagesRef.current;
    const atReadingPosition = () => {
      // The reading line is measured against THIS viewer's scroll box, not
      // the window — the surrounding page never scrolls.
      const box = scrollRef.current?.getBoundingClientRect();
      if (!box) return;
      const centerY = box.top + box.height * 0.4;
      let found = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const el = pages.get(n);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top <= centerY && r.bottom >= centerY) { found = n; break; }
        if (r.top > centerY && n > 1) { found = n - 1; break; }
      }
      if (found > 0) setCurrentPage(found);
    };
    // Capture-phase listener catches scroll events from this viewer's own
    // scroll box (scroll events do not bubble, but they do traverse the
    // capture phase up to the document).
    document.addEventListener('scroll', atReadingPosition, { capture: true, passive: true });
    atReadingPosition();
    return () => document.removeEventListener('scroll', atReadingPosition, true);
  }, [doc]);

  const registerPage = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pagesRef.current.set(pageNumber, el);
    else pagesRef.current.delete(pageNumber);
  }, []);

  const zoomIn = () => { setFitWidth(false); setScale((s) => clampScale(s * ZOOM_STEP)); };
  const zoomOut = () => { setFitWidth(false); setScale((s) => clampScale(s / ZOOM_STEP)); };

  const pages = useMemo(() => {
    if (!doc) return null;
    return [...Array(doc.numPages)].map((_, i) => (
      <PdfPage
        key={i + 1}
        pdf={doc.pdf}
        pageNumber={i + 1}
        scale={scale}
        eager={i < 2}
        onRegister={registerPage}
      />
    ));
  }, [doc, scale, registerPage]);

  // ── Inline error state (document failed to open — recoverable) ──
  if (status === 'error' || docError) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center p-4 sm:p-6">
        <InvoiceViewError
          message={error ?? docError ?? 'The invoice PDF could not be opened.'}
          onRetry={onRetry}
        />
      </div>
    );
  }

  const parsing = !doc; // pipeline still composing, or document still parsing

  return (
    // The viewer root is the page's single vertical scroll container. Zoom
    // and scroll affect only what is inside this box.
    <div ref={scrollRef} className="relative h-full min-h-0 overflow-y-auto overscroll-contain">
      {/* Subtle regeneration indicator — the document itself never disappears. */}
      {isRefreshing && doc && (
        <div className="absolute top-0 left-3 right-3 h-0.5 z-10 overflow-hidden rounded-full">
          <div className="h-full w-full bg-indigo-400/80 animate-pulse" />
        </div>
      )}

      {/* Document area — neutral surround, white sheets, natural page flow. */}
      <div className="relative rounded-xl border border-slate-200/90 bg-slate-100/70 p-3 sm:p-5 lg:p-6">
        <div ref={panRef} className="overflow-x-auto">
          {parsing ? (
            // Clean neutral viewer surface: the same full-width A4 sheet the
            // fit-width document will occupy (geometry reserved — no layout
            // shift), kept empty. NO skeleton content of any kind. A very
            // small local loading ring appears only after the grace period.
            <div
              className="relative w-full overflow-hidden rounded-sm bg-white ring-1 ring-slate-900/5 shadow-md shadow-slate-900/10"
              style={{ aspectRatio: A4_ASPECT }}
            >
              {showParsingIndicator && (
                <div className="absolute inset-0 flex items-center justify-center" role="status">
                  <span className="sr-only">Opening invoice PDF…</span>
                  <span
                    aria-hidden="true"
                    className="h-5 w-5 rounded-full border-2 border-slate-200 border-t-slate-400 animate-spin"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="min-w-full w-fit flex flex-col items-center gap-4 sm:gap-5">
              {pages}
            </div>
          )}
        </div>
      </div>

      {/* Minimal viewer controls — a floating FUSIONONE pill, always reachable
          at the bottom of the document scroll area. Compacts on narrow
          screens so it never widens the page. The regenerate action lives
          here: an invoice-specific document action, presented with the
          document — never as a page-level "Refresh". */}
      {doc && (
        <div className="sticky bottom-4 z-20 mt-4 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-0.5 sm:gap-1 rounded-full border border-slate-200 bg-white/95 backdrop-blur shadow-lg shadow-slate-900/10 px-1 sm:px-1.5 h-9 sm:h-10">
            <span className="px-1.5 sm:px-2.5 text-[10px] sm:text-[11px] font-semibold tabular-nums text-slate-600 min-w-[34px] sm:min-w-[58px] text-center" aria-live="polite">
              {Math.min(currentPage, doc.numPages)} / {doc.numPages}
            </span>
            <span className="w-px h-4 sm:h-5 bg-slate-200 mx-0.5" />
            <button
              type="button" onClick={zoomOut} disabled={scale <= MIN_SCALE + 0.001}
              aria-label="Zoom out"
              className="h-7 w-7 sm:h-8 sm:w-8 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <Minus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>
            <span className="hidden sm:inline-block px-1 text-[11px] font-semibold tabular-nums text-slate-600 min-w-[42px] text-center" aria-live="polite">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button" onClick={zoomIn} disabled={scale >= MAX_SCALE - 0.001}
              aria-label="Zoom in"
              className="h-7 w-7 sm:h-8 sm:w-8 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>
            <span className="w-px h-4 sm:h-5 bg-slate-200 mx-0.5" />
            <button
              type="button" onClick={() => setFitWidth(true)} aria-pressed={fitWidth}
              aria-label="Fit width" title="Fit width"
              className={cn(
                'h-7 w-7 sm:h-8 sm:w-8 flex items-center justify-center rounded-full transition-colors',
                fitWidth
                  ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100',
              )}
            >
              <Expand className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>
            {onRegenerate && (
              <>
                <span className="w-px h-4 sm:h-5 bg-slate-200 mx-0.5" />
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={isRefreshing}
                  aria-label="Regenerate invoice PDF"
                  title="Regenerate invoice PDF"
                  className={cn(
                    'h-7 w-7 sm:h-8 sm:w-8 flex items-center justify-center rounded-full transition-colors',
                    'text-slate-500 hover:text-slate-900 hover:bg-slate-100',
                    'disabled:opacity-40 disabled:pointer-events-none',
                  )}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5 sm:h-4 sm:w-4', isRefreshing && 'animate-spin')} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
