'use client';

/**
 * DocumentPreviewDialog — the IN-APP document preview surface.
 *
 * Preview never leaves the application: no new browser tab, no external
 * PDF viewer, no public storage URL. The decrypted bytes come from the
 * existing secure backend preview route (authenticated fetch → R2 →
 * decrypt → stream), and are rendered here:
 *
 *   - images (JPEG / PNG / WebP): centered inside the dialog, aspect
 *     ratio preserved, fitted to the available dialog area;
 *   - PDFs: rendered with the application's existing pdf.js capability
 *     (the same lazy-loaded pdfjs-dist module the invoice viewer uses —
 *     one shared copy, no redundant PDF implementation): multi-page,
 *     scrolling, zoom, page indicator.
 *
 * Download is a SEPARATE action (the app's authenticated download route
 * with the original filename) — previewing never saves a file.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Download, Expand, Minus, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/utils';
import { useToast } from '@/components/ui/Toast';
import {
  downloadPartyDocument,
  fetchPartyDocumentPreview,
  type PartyDocument,
} from '@/features/party-documents/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ── pdf.js loader ────────────────────────────────────────────────────────────
// The SAME lazy-load pattern (and module instance) as the invoice viewer:
// the dynamic import is cached by the module system, so pdf.js is loaded
// exactly once per session and shared — no second PDF implementation.

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const isImage = (mime: string) => IMAGE_MIMES.has(mime);
const isPdf = (mime: string) => mime === 'application/pdf';

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ── Image preview ────────────────────────────────────────────────────────────

function ImagePreview({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    setFailed(false);
    setLoaded(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  if (failed) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
        <p className="text-xs font-semibold text-rose-700">This image could not be displayed.</p>
        <p className="text-[11px] text-slate-400">The file may be damaged — try downloading it instead.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center p-2">
      {!loaded && (
        <div role="status" className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="sr-only">Opening image…</span>
          <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-slate-200 border-t-slate-400 animate-spin" />
        </div>
      )}
      {url && (
        <img
          src={url}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn('max-h-full max-w-full object-contain rounded-md shadow-md shadow-slate-900/10 ring-1 ring-slate-900/5 transition-opacity duration-200', loaded ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </div>
  );
}

// ── PDF preview (pdf.js — the app's existing capability) ─────────────────────

const PDF_MIN_SCALE = 0.3;
const PDF_MAX_SCALE = 3;
const PDF_ZOOM_STEP = 1.25;
const DPR_CAP = 2;

const clampScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

/** One rendered PDF page — canvas geometry reserved, painted when ready. */
function PdfPage({ pdf, pageNumber, scale }: { pdf: PDFDocumentProxy; pageNumber: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const pageRef = useRef<import('pdfjs-dist').PDFPageProxy | null>(null);

  // Resolve the page + its unscaled size once per document.
  useEffect(() => {
    let alive = true;
    pdf.getPage(pageNumber)
      .then((page) => {
        if (!alive) { void page.cleanup(); return; }
        pageRef.current = page;
        const vp = page.getViewport({ scale: 1 });
        setSize({ w: vp.width, h: vp.height });
      })
      .catch(() => { /* a failing page keeps its reserved sheet */ });
    return () => {
      alive = false;
      pageRef.current = null;
    };
  }, [pdf, pageNumber]);

  // Render (and re-render on scale change).
  useEffect(() => {
    const page = pageRef.current;
    const canvas = canvasRef.current;
    if (!page || !size || !canvas) return;
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;
    const task = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    return () => { task.cancel(); };
  }, [size, scale]);

  const w = size ? Math.floor(size.w * scale) : undefined;
  const h = size ? Math.floor(size.h * scale) : undefined;

  return (
    <div
      className="relative bg-white rounded-sm shadow-md shadow-slate-900/10 ring-1 ring-slate-900/5"
      style={w && h ? { width: w, height: h } : { aspectRatio: '595.28 / 841.89', width: '100%' }}
      data-page={pageNumber}
    >
      <canvas ref={canvasRef} role="img" aria-label={`Document page ${pageNumber}`} className="absolute inset-0" />
    </div>
  );
}

function PdfPreview({ blob }: { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);

  // Parse the document (pdf.js — the app's existing rendering capability).
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof import('pdfjs-dist').getDocument> | null = null;
    setPdf(null);
    setError(null);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // A fresh byte copy — pdf.js transfers the buffer to its worker.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        loadingTask = pdfjs.getDocument({ data: bytes });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        setPdf(loaded);
        setCurrentPage(1);
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : 'This PDF could not be opened.',
        );
      }
    })();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  // Fit width: scale the page to the available document width.
  const applyFit = useCallback(async () => {
    const page = pdf ? await pdf.getPage(1).catch(() => null) : null;
    const available = panRef.current?.clientWidth ?? 0;
    if (!page || available <= 0) return;
    const vp = page.getViewport({ scale: 1 });
    setScale(clampScale(available / vp.width));
  }, [pdf]);

  useEffect(() => {
    if (fitWidth && pdf) void applyFit();
  }, [fitWidth, pdf, applyFit]);

  // Page indicator: which sheet sits at the reading position of THIS
  // preview's own scroll box (capture phase — scroll does not bubble).
  useEffect(() => {
    if (!pdf || pdf.numPages < 2) return;
    const atReadingPosition = () => {
      const box = scrollRef.current?.getBoundingClientRect();
      if (!box) return;
      const centerY = box.top + box.height * 0.4;
      const pages = scrollRef.current?.querySelectorAll('[data-page]');
      if (!pages) return;
      let found = 0;
      pages.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top <= centerY && r.bottom >= centerY) found = Number((el as HTMLElement).dataset.page);
        else if (r.top > centerY && !found) found = Number((el as HTMLElement).dataset.page) - 1;
      });
      if (found > 0) setCurrentPage(Math.min(found, pdf.numPages));
    };
    document.addEventListener('scroll', atReadingPosition, { capture: true, passive: true });
    atReadingPosition();
    return () => document.removeEventListener('scroll', atReadingPosition, true);
  }, [pdf, scale]);

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
        <p className="text-xs font-semibold text-rose-700">This PDF could not be opened.</p>
        <p className="text-[11px] text-slate-400">{error}</p>
        <p className="text-[11px] text-slate-400">The file may be damaged — try downloading it instead.</p>
      </div>
    );
  }

  if (!pdf) {
    return (
      <div className="h-full flex items-center justify-center" role="status">
        <span className="sr-only">Opening document…</span>
        <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-slate-200 border-t-slate-400 animate-spin" />
      </div>
    );
  }

  const zoomIn = () => { setFitWidth(false); setScale((s) => clampScale(s * PDF_ZOOM_STEP)); };
  const zoomOut = () => { setFitWidth(false); setScale((s) => clampScale(s / PDF_ZOOM_STEP)); };

  return (
    <div ref={scrollRef} className="relative h-full min-h-0 overflow-y-auto overscroll-contain">
      <div className="rounded-xl border border-slate-200/90 bg-slate-100/70 p-3 sm:p-4">
        <div ref={panRef} className="overflow-x-auto">
          <div className="min-w-full w-fit flex flex-col items-center gap-4">
            {[...Array(pdf.numPages)].map((_, i) => (
              <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} scale={scale} />
            ))}
          </div>
        </div>
      </div>

      {/* Viewer controls — the app's floating pill pattern (zoom + pages). */}
      <div className="sticky bottom-3 z-20 mt-3 flex justify-center pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-0.5 sm:gap-1 rounded-full border border-slate-200 bg-white/95 backdrop-blur shadow-lg shadow-slate-900/10 px-1 sm:px-1.5 h-9">
          <span className="px-1.5 sm:px-2.5 text-[10px] sm:text-[11px] font-semibold tabular-nums text-slate-600 min-w-[34px] sm:min-w-[58px] text-center" aria-live="polite">
            {Math.min(currentPage, pdf.numPages)} / {pdf.numPages}
          </span>
          <span className="w-px h-4 bg-slate-200 mx-0.5" />
          <button
            type="button" onClick={zoomOut} disabled={scale <= PDF_MIN_SCALE + 0.001}
            aria-label="Zoom out"
            className="h-7 w-7 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button" onClick={zoomIn} disabled={scale >= PDF_MAX_SCALE - 0.001}
            aria-label="Zoom in"
            className="h-7 w-7 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <span className="w-px h-4 bg-slate-200 mx-0.5" />
          <button
            type="button" onClick={() => setFitWidth(true)} aria-pressed={fitWidth}
            aria-label="Fit width" title="Fit width"
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-full transition-colors',
              fitWidth
                ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100',
            )}
          >
            <Expand className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────

export function DocumentPreviewDialog({
  isOpen,
  onClose,
  partyId,
  document: doc,
}: {
  isOpen: boolean;
  onClose: () => void;
  partyId: string;
  document: PartyDocument | null;
}) {
  const { error: toastError } = useToast();
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch the decrypted preview stream through the secure backend route
  // whenever the dialog opens for a document.
  useEffect(() => {
    if (!isOpen || !doc) {
      setBlob(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setBlob(null);
    fetchPartyDocumentPreview(partyId, doc.id)
      .then(({ blob: fetched }) => { if (alive) setBlob(fetched); })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : 'The document could not be opened.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isOpen, doc, partyId]);

  const retry = () => {
    if (!doc) return;
    setLoading(true);
    setLoadError(null);
    setBlob(null);
    fetchPartyDocumentPreview(partyId, doc.id)
      .then(({ blob: fetched }) => setBlob(fetched))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'The document could not be opened.'))
      .finally(() => setLoading(false));
  };

  // Download stays a SEPARATE action (the authenticated download route).
  const handleDownload = async () => {
    if (!doc) return;
    try {
      await downloadPartyDocument(partyId, doc.id);
    } catch (err) {
      toastError('Download Failed', err instanceof Error ? err.message : 'The document could not be downloaded.');
    }
  };

  const typeLabel = doc
    ? doc.mime_type === 'application/pdf'
      ? 'PDF'
      : doc.mime_type === 'image/jpeg'
        ? 'JPEG'
        : doc.mime_type.replace('image/', '').toUpperCase()
    : '';

  return (
    <Modal
      isOpen={isOpen && !!doc}
      onClose={onClose}
      title={doc?.file_name ?? 'Document'}
      description={doc ? `${typeLabel} · ${fmtSize(doc.file_size)}${doc.status === 'archived' ? ' · Archived' : ''}` : undefined}
      className="max-w-4xl"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button variant="outline" onClick={() => void handleDownload()}>
            <Download className="h-3.5 w-3.5" /> Download
          </Button>
        </>
      }
    >
      <div className="relative h-[70vh] min-h-0 bg-slate-50">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center" role="status">
            <span className="sr-only">Opening document…</span>
            <span aria-hidden="true" className="h-6 w-6 rounded-full border-2 border-slate-200 border-t-slate-400 animate-spin" />
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
            <p className="text-xs font-semibold text-rose-700">The document could not be opened.</p>
            <p className="text-[11px] text-slate-400 max-w-sm">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-1 h-7 text-[11px]" onClick={retry}>
              Try Again
            </Button>
          </div>
        )}
        {blob && doc && isImage(doc.mime_type) && <ImagePreview blob={blob} alt={doc.file_name} />}
        {blob && doc && isPdf(doc.mime_type) && <PdfPreview blob={blob} />}
      </div>
    </Modal>
  );
}
