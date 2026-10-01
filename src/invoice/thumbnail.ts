/**
 * Invoice thumbnail generator (WhatsApp document preview) — Canvas worker.
 *
 * ARCHITECTURE (the thumbnail is NOT derived from the rendered PDF):
 *
 *   InvoiceData ──┬─→ PDFKit        → PDF buffer      (invoice/pdf.ts)
 *                 └─→ Canvas worker → JPEG thumbnail  (this module)
 *
 * The thumbnail renders the UPPER SECTION of the same Prestige design straight
 * from the canonical InvoiceData (never raw DB rows, never re-calculated
 * totals, never a re-parsed PDF). Colors, layout geometry, column widths,
 * fonts sizes, labels and icons are the shared constants from prestige.ts,
 * serialized into the worker environment — one visual source of truth.
 *
 * PERSISTENT WORKER: a single plain-Node child process is spawned once,
 * loads @napi-rs/canvas + fonts ONCE, reports readiness, and then serves
 * an unlimited number of thumbnail jobs over stdin/stdout:
 *
 *   parent → worker : one JSON line per job  {"id":N,"data":InvoiceData}
 *   worker → parent : {"t":"ready"} line, then per job:
 *                     {"id":N,"ok":true,...,"jpegLen":K}\n + K raw JPEG bytes
 *                     (or {"id":N,"ok":false,"error":"..."} on failure)
 *
 * WHY A SEPARATE NODE PROCESS: the backend runs under Bun and the
 * @napi-rs/canvas native binding hard-crashes the Bun runtime (verified in
 * this sandbox). The worker therefore always runs under plain Node, outside
 * the Bun process — crash-isolated by construction.
 *
 * CRASH/FAILURE SEMANTICS (the thumbnail is purely cosmetic):
 *   - worker crash  → pending jobs resolve null, worker restarts lazily on
 *     the next request (the backend and the WhatsApp state machine are
 *     unaffected)
 *   - job timeout   → job resolves null, hung worker is killed and replaced
 *   - ANY thumbnail failure → the caller sends the invoice PDF WITHOUT a
 *     preview (never blocks the send)
 *
 * NO FILESYSTEM I/O: InvoiceData → Canvas → JPEG buffer, entirely in memory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getLogger } from '../logging/logger.js';
import type { InvoiceData } from './types.js';
import {
  PRESTIGE_COLORS,
  PRESTIGE_LAYOUT,
  PRESTIGE_TABLE_HEADERS,
  PRESTIGE_TRADE_IN_HEADERS,
  PRESTIGE_ICONS,
} from './prestige.js';

// ── Public configuration ───────────────────────────────────────────────────

/**
 * Thumbnail width in pixels (A4 width 595.28pt → scale ≈ 0.7458). 444px is
 * the production-safe WhatsApp document-thumbnail envelope established by
 * live testing on the real logged-in account: previews at this width
 * rendered reliably in the recipient's document bubble, while the previous
 * wider output (~587px) fell outside the client's renderable envelope and
 * was silently not displayed. The width is fixed; only the height varies
 * with the invoice content.
 */
const THUMBNAIL_WIDTH_PX = 444;

/**
 * Maximum thumbnail height in pixels. 250px keeps the preview inside the
 * same live-verified envelope (rendering was confirmed up to 270px tall;
 * 250px leaves ~20px of production safety margin below the largest
 * confirmed-good case). The crop remains content-driven: only complete
 * item rows are ever shown, a short invoice renders SHORTER than this cap,
 * and the height is never padded up to it.
 */
const THUMBNAIL_MAX_HEIGHT_PX = 250;

/**
 * JPEG quality ladder — quality first, byte size second.
 *
 * The pixel dimensions above are the safety constraint, so image quality
 * is not sacrificed preemptively: the primary encode runs at quality 100,
 * and the lower rungs exist ONLY as a byte-budget safeguard (a re-encode
 * when the output exceeds the soft limit below). The ladder never reduces
 * the resolution.
 *
 * @napi-rs/canvas 0.1.68 takes quality on a 0-100 scale in
 * toBuffer('image/jpeg', quality). Values below 1 (e.g. a legacy 0.85)
 * encode at near-zero quality: the output loses chroma on thin colored
 * features and looks washed out (the Prestige gold bar decodes gray).
 * All ladder values below are therefore proper 0-100 numbers.
 */
const THUMBNAIL_JPEG_QUALITY = 100;
const THUMBNAIL_JPEG_QUALITY_FALLBACK = 90;
const THUMBNAIL_JPEG_QUALITY_LAST_RESORT = 80;

/**
 * Soft ceiling for the inline jpegThumbnail payload. WhatsApp carries the
 * thumbnail inside the message itself (not as uploaded media), so a sane
 * bound is enforced by re-encoding at a lower quality — never by shrinking
 * the resolution.
 */
const THUMBNAIL_JPEG_SOFT_LIMIT_BYTES = 65_536;

/** Hard per-job timeout — a hung worker must never hang a send. */
const THUMBNAIL_JOB_TIMEOUT_MS = 10_000;

/** Worker startup budget (node boot + canvas import + font registration). */
const THUMBNAIL_READY_TIMEOUT_MS = 20_000;

/** Cooldown after a failed spawn (prevents crash-loop spawning). */
const THUMBNAIL_SPAWN_COOLDOWN_MS = 1_000;

// ── Result contract ────────────────────────────────────────────────────────

/** Outcome of a thumbnail generation request. `jpeg` is null on ANY failure. */
export interface InvoiceThumbnail {
  jpeg: Buffer | null;
  width: number | null;
  height: number | null;
  /** Number of complete item rows visible in the crop (never a partial row). */
  rows: number | null;
  /** Number of complete trade-in rows visible in the crop. */
  tradeInRows: number | null;
  /** Bottom of the rendered content in PDF points (the safe crop boundary). */
  bottomPt: number | null;
  /** Full pipeline timing (ms): total = request→JPEG in hand. */
  ms: { total: number; draw: number | null; encode: number | null };
}

type WorkerOkReply = {
  ok: true;
  w: number;
  h: number;
  rows: number;
  tradeInRows: number;
  bottomPt: number;
  jpeg: Buffer;
  ms: { draw: number; encode: number };
};
type WorkerReply = WorkerOkReply | { ok: false; error: string };

/** A worker stdout header line (before the raw JPEG payload, if any). */
interface WorkerHeader {
  id: number;
  ok?: boolean;
  w?: number;
  h?: number;
  rows?: number;
  tradeInRows?: number;
  bottomPt?: number;
  jpegLen?: number;
  ms?: { draw: number; encode: number };
  error?: string;
}

// ── Worker environment resolution (once, cached) ───────────────────────────

interface WorkerEnv {
  canvas: string;
  fontRegular: string;
  fontBold: string;
  spec: string;
}

/** Helvetica-metric-compatible sans faces, in preference order. */
const FONT_CANDIDATES = {
  regular: [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
  bold: [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ],
} as const;

let workerEnvCache: WorkerEnv | null | undefined;
let workerEnvWarned = false;

/**
 * Resolve everything the worker needs: the @napi-rs/canvas module path (the
 * eval'd child has no module context of its own) and a Helvetica-metric font
 * pair. The Prestige visual spec (colors/layout/labels/icons) is serialized
 * from prestige.ts so the worker cannot drift from the PDF design.
 */
function resolveWorkerEnv(): WorkerEnv | null {
  if (workerEnvCache !== undefined) return workerEnvCache;
  try {
    const require = createRequire(import.meta.url);
    const canvas = require.resolve('@napi-rs/canvas');
    const fontRegular = FONT_CANDIDATES.regular.find((p) => existsSync(p));
    const fontBold = FONT_CANDIDATES.bold.find((p) => existsSync(p));
    if (!fontRegular || !fontBold) throw new Error('no Helvetica-metric font found');
    const spec = JSON.stringify({
      colors: PRESTIGE_COLORS,
      layout: PRESTIGE_LAYOUT,
      texts: { table: PRESTIGE_TABLE_HEADERS, tradeIn: PRESTIGE_TRADE_IN_HEADERS },
      icons: PRESTIGE_ICONS,
    });
    workerEnvCache = { canvas, fontRegular, fontBold, spec };
  } catch (err) {
    workerEnvCache = null;
    if (!workerEnvWarned) {
      workerEnvWarned = true;
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Thumbnail worker environment unavailable — invoices will send without chat previews',
      );
    }
  }
  return workerEnvCache;
}

// ── The worker source (plain JavaScript — executed by NODE, never Bun) ─────
//
// Protocol (see module docstring). The source receives its configuration via
// environment variables resolved by the parent; it performs NO filesystem
// writes and keeps everything in memory.
//
// NOTE: this string uses String.raw — every backslash below must remain a
// literal backslash in the emitted source. No template literals are used
// inside the worker source (no ${ } interpolation hazards).

const WORKER_SOURCE = String.raw`
'use strict';
// ── Persistent thumbnail worker: Prestige upper-section renderer ──────────
// Draws the invoice preview directly from InvoiceData with the SAME layout
// constants as the PDFKit document (injected via THUMB_SPEC). The crop ends
// at a SAFE boundary: only complete rows are ever visible.

const CANVAS_PATH = process.env.THUMB_CANVAS;
const SPEC = JSON.parse(process.env.THUMB_SPEC);
const C = SPEC.colors;
const L = SPEC.layout;
const T = SPEC.texts;
const ICONS = SPEC.icons;

const OUT_WIDTH = Number(process.env.THUMB_WIDTH);
const OUT_MAX_HEIGHT = Number(process.env.THUMB_MAX_HEIGHT);
const JPEG_QUALITY = Number(process.env.THUMB_JPEG_QUALITY);
const JPEG_QUALITY_FALLBACK = Number(process.env.THUMB_JPEG_QUALITY_FALLBACK);
const JPEG_QUALITY_LAST = Number(process.env.THUMB_JPEG_QUALITY_LAST);
const JPEG_SOFT_LIMIT = Number(process.env.THUMB_JPEG_SOFT_LIMIT);

const SCALE = OUT_WIDTH / L.pageW;              // pt → px
const CROP_BUDGET_PT = OUT_MAX_HEIGHT / SCALE;  // max preview height in pt
// White margin guaranteed below the last drawn row so the crop always reads
// as intentionally composed (never as a row sliced at the image edge).
const PAD_BOTTOM = 10;

// Helvetica metrics (matches PDFKit baseline/line geometry in the PDF):
const ASCENT = 0.718;          // first-line baseline offset (per em)
const LINE_H_REG = 1.156;      // PDFKit Helvetica line height (per em)
const LINE_H_BOLD = 1.18971;   // PDFKit Helvetica-Bold line height (per em)

const F_REG = 'PrestigeSans';
const F_BOLD = 'PrestigeSansBold';

const canvasMod = await import(CANVAS_PATH);
const createCanvas = canvasMod.createCanvas;
const GlobalFonts = canvasMod.GlobalFonts;
const Path2D = canvasMod.Path2D;
const loadImage = canvasMod.loadImage;

const okReg = GlobalFonts.registerFromPath(process.env.THUMB_FONT_REGULAR, F_REG);
const okBold = GlobalFonts.registerFromPath(process.env.THUMB_FONT_BOLD, F_BOLD);
if (!okReg || !okBold) {
  process.stderr.write('thumbnail worker: font registration failed\n');
  process.exit(3);
}

// ── Item text semantics (identical to prestige.ts — keep in sync) ─────────

function fmt(n) {
  return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Rs.';
}
function descText(item) {
  return item.description || ((item.brand || '') + ' ' + (item.model || '')).trim();
}
function subLineText(item, isTradeIn) {
  if (isTradeIn) return item.imei ? 'IMEI: ' + item.imei : '';
  const parts = [item.ram_rom, item.color, item.imei ? 'IMEI: ' + item.imei : ''].filter(Boolean);
  return parts.join(' \u2022 ');
}
function amountText(item, isTradeIn) {
  if (isTradeIn) {
    const qty = item.qty || 1;
    const rate = item.rate || item.credit_value || 0;
    return fmt(qty * rate);
  }
  return fmt(item.value || item.price || 0);
}
function billingLabel(type) {
  return type === 'purchase' ? 'RECEIVED FROM' : 'BILL TO';
}
function invoiceTitle(type) {
  return type === 'proforma' ? 'QUOTATION' : type === 'sale' ? 'TAX INVOICE' : 'PURCHASE BILL';
}

// ── Logo cache (the store logo rarely changes — fetch once per TTL) ───────

const logoCache = new Map(); // url → { image, at }
const LOGO_TTL_MS = 10 * 60 * 1000;
const LOGO_MAX_ENTRIES = 8;

async function fetchLogoImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const hit = logoCache.get(url);
  if (hit && Date.now() - hit.at < LOGO_TTL_MS) return hit.image;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes || bytes.length === 0) return null;
    const image = await loadImage(bytes).catch(() => null); // validates decodability
    if (!image) return null;
    if (logoCache.size >= LOGO_MAX_ENTRIES) logoCache.delete(logoCache.keys().next().value);
    logoCache.set(url, { image: image, at: Date.now() });
    return image;
  } catch {
    return null;
  }
}

// ── Text helpers (all coordinates in PDF points) ──────────────────────────

function setFont(ctx, bold, size) {
  ctx.font = size + 'px ' + (bold ? F_BOLD : F_REG);
}
function measure(ctx, text, bold, size) {
  setFont(ctx, bold, size);
  return ctx.measureText(text).width;
}
/** Word-wrap like PDFKit (collapses whitespace, breaks on spaces). */
function wrapLines(ctx, text, bold, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (measure(ctx, candidate, bold, size) <= maxWidth || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function lineHeight(size, bold) {
  return size * (bold ? LINE_H_BOLD : LINE_H_REG);
}
/**
 * Draw a single text line. (x, y) are PDFKit-style coordinates: x is the
 * LEFT edge for align 'left', the RIGHT edge for 'right', the CENTER for
 * 'center'; y is the TOP of the line box.
 */
function textLine(ctx, text, x, y, opts) {
  if (!text) return;
  setFont(ctx, opts.bold, opts.size);
  ctx.fillStyle = opts.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = opts.align || 'left';
  ctx.fillText(text, x, y + ASCENT * opts.size);
}
/** Draw a wrapped block; returns its height in pt (PDFKit heightOfString). */
function textBlock(ctx, text, x, y, opts) {
  const lines = wrapLines(ctx, text, opts.bold, opts.size, opts.maxWidth);
  const lh = lineHeight(opts.size, opts.bold);
  lines.forEach((line, i) => {
    textLine(ctx, line, x, y + i * lh, opts);
  });
  return lines.length * lh;
}
function strokeLine(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
/** Gold contact icon: 24-unit viewBox scaled to 10pt, stroked. */
function drawIcon(ctx, pathData, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(10 / 24, 10 / 24);
  ctx.lineWidth = 2;
  ctx.strokeStyle = C.gold;
  ctx.stroke(new Path2D(pathData));
  ctx.restore();
}

// ── Row measurement (must mirror the PDF row height formula) ──────────────

const MEASURE_CTX = createCanvas(8, 8).getContext('2d');

function rowLayout(ctx, item, isTradeIn) {
  const desc = descText(item);
  const sub = subLineText(item, isTradeIn);
  const descLines = wrapLines(ctx, desc, true, 7.1, L.col.desc.w);
  const subLines = sub ? wrapLines(ctx, sub, false, 6.375, L.col.desc.w) : [];
  const descH = descLines.length * lineHeight(7.1, true);
  const subH = subLines.length * lineHeight(6.375, false);
  const height = Math.max(
    30,
    descH + subH + (sub ? 2.25 : 0) + L.rowPadV * 2 + L.rowFudge,
  );
  return { desc, sub, descLines, subLines, descH, subH, height };
}

// ── The renderer ───────────────────────────────────────────────────────────

async function renderThumbnail(data) {
  const tDrawStart = performance.now();

  const store = data.store || {};
  const storeName = store.name || 'FUSION GADGETS';
  const party = data.party || {};
  const partyName = party.name || 'Cash Customer';
  const items = Array.isArray(data.items) ? data.items : [];
  const tradeIns = Array.isArray(data.trade_ins) ? data.trade_ins : [];

  // ── Plan the crop: only COMPLETE rows, never through content ──────────
  let y = L.tableHeaderY + L.tableHeaderH; // first row top
  const itemPlans = [];
  for (const item of items) {
    const layout = rowLayout(MEASURE_CTX, item, false);
    if (y + layout.height > CROP_BUDGET_PT - PAD_BOTTOM) break;
    itemPlans.push({ item, layout, top: y });
    y += layout.height;
  }
  const itemsBottom = y;
  const itemsTruncated = itemPlans.length < items.length;

  // Trade-in section: included only when at least one COMPLETE row fits
  // (label 12 + 18 + header 21.75 + row height).
  const tradeInLabelTop = itemsBottom + 12;
  const tradeInHeaderTop = tradeInLabelTop + 18;
  const tradeInRowsTop = tradeInHeaderTop + L.tableHeaderH;
  const tradeInPlans = [];
  let ty = tradeInRowsTop;
  if (tradeIns.length > 0) {
    for (const item of tradeIns) {
      const layout = rowLayout(MEASURE_CTX, item, true);
      if (ty + layout.height > CROP_BUDGET_PT - PAD_BOTTOM) break;
      tradeInPlans.push({ item, layout, top: ty });
      ty += layout.height;
    }
  }
  const tradeInsTruncated = tradeInPlans.length < tradeIns.length;

  let safeBottomPt;
  if (tradeInPlans.length > 0) {
    safeBottomPt = ty + PAD_BOTTOM;
  } else if (itemPlans.length > 0) {
    safeBottomPt = itemsBottom + PAD_BOTTOM;
  } else {
    safeBottomPt = L.tableHeaderY + L.tableHeaderH + 20; // header-only preview
  }
  safeBottomPt = Math.min(safeBottomPt, CROP_BUDGET_PT);

  const widthPx = OUT_WIDTH;
  const heightPx = Math.min(Math.ceil(safeBottomPt * SCALE), OUT_MAX_HEIGHT);

  // ── Draw (all coordinates in PDF points; ctx scaled pt → px) ──────────
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // Page background
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, L.pageW, heightPx / SCALE);

  // Gold top accent bar
  ctx.fillStyle = C.gold;
  ctx.fillRect(0, 0, L.pageW, L.goldBarH);

  // ── Header: logo box + store name + contact column ────────────────────
  ctx.strokeStyle = C.black;
  ctx.lineWidth = 1.1;
  ctx.strokeRect(L.marginX, L.headerStartY, 36, 36);

  const logo = await fetchLogoImage(store.logo_url);
  if (logo) {
    // contain-fit, centered in the 36×36 box (PDFKit fit semantics).
    // High-quality smoothing: the logo raster is downscaled to the
    // thumbnail resolution and the default 'low' filter softens it.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const s = Math.min(36 / logo.width, 36 / logo.height);
    const dw = logo.width * s;
    const dh = logo.height * s;
    ctx.drawImage(
      logo,
      L.marginX + (36 - dw) / 2,
      L.headerStartY + (36 - dh) / 2,
      dw,
      dh,
    );
  } else {
    const initials = storeName.substring(0, 2).toUpperCase();
    const initH = 15 * LINE_H_BOLD; // PDFKit heightOfString(initials)
    textLine(ctx, initials, L.marginX + 18, L.headerStartY + (36 - initH) / 2, {
      bold: true, size: 15, color: C.black, align: 'center',
    });
  }

  textLine(ctx, storeName, L.marginX + 46, L.headerStartY + 8, {
    bold: true, size: 14, color: C.black,
  });
  if (store.gstin) {
    textLine(ctx, 'GSTIN: ' + store.gstin, L.marginX + 46, L.headerStartY + 26, {
      bold: false, size: 6.75, color: C.textSecondary,
    });
  }

  // Right-aligned contact lines with gold icons (icons hug their text)
  const rightX = L.contentRight;
  let contactY = L.headerStartY + 2.5;
  const contactLine = (text, iconPath, wrapWidth) => {
    const lines = wrapLines(MEASURE_CTX, text, false, 6.75, wrapWidth);
    const textW = Math.min(measure(MEASURE_CTX, text, false, 6.75), wrapWidth);
    drawIcon(ctx, iconPath, rightX - textW - 14, contactY - 1);
    const lh = lineHeight(6.75, false);
    lines.forEach((line, i) => {
      textLine(ctx, line, rightX, contactY + i * lh, {
        bold: false, size: 6.75, color: C.textSecondary, align: 'right',
      });
    });
    contactY += lines.length * lh + 6.6;
  };
  if (store.phone) contactLine(store.phone, ICONS.phone, 110);
  if (store.email) contactLine(store.email, ICONS.email, 110);
  if (store.address) {
    contactLine(String(store.address).split('\n').join(', '), ICONS.mapPin, 240);
  }

  // Header bottom border (full page width)
  strokeLine(ctx, 0, L.headerBorderY, L.pageW, L.headerBorderY, C.black, 1.5);

  // ── Billing (left) + invoice meta (right) ──────────────────────────────
  const labelY = L.billingLabelY;
  textLine(ctx, billingLabel(data.type), L.marginX, labelY, {
    bold: true, size: 8.25, color: C.gold,
  });
  textLine(ctx, partyName, L.marginX, labelY + 17, {
    bold: true, size: 12, color: C.textPrimary,
  });

  let cursorY = labelY + 37;
  if (party.address) {
    const blockH = textBlock(ctx, String(party.address).split('\n').join(', '), L.marginX, cursorY, {
      bold: false, size: 7.1, color: C.textSecondary, maxWidth: 254,
    });
    cursorY += Math.max(17.5, blockH);
  }
  if (party.number) {
    textLine(ctx, 'Contact No.', L.marginX, cursorY, {
      bold: true, size: 7.1, color: C.textPrimary,
    });
    textLine(ctx, party.number, L.marginX + 54, cursorY, {
      bold: false, size: 7.1, color: C.textSecondary,
    });
  }

  // Vertical divider between billing and meta columns
  strokeLine(ctx, L.pageW / 2, labelY, L.pageW / 2, L.billingBorderY - 24, C.border, 0.75);

  const metaX = L.pageW / 2 + 12;
  textLine(ctx, invoiceTitle(data.type), metaX, labelY - 5, {
    bold: true, size: 21, color: C.black,
  });
  textLine(ctx, 'INVOICE NO.', metaX, labelY + 22, {
    bold: true, size: 6.75, color: C.textPrimary,
  });
  textLine(ctx, data.bill_number, metaX + 67.5, labelY + 22, {
    bold: false, size: 7.1, color: C.textSecondary,
  });
  textLine(ctx, 'DATE', metaX, labelY + 32, {
    bold: true, size: 6.75, color: C.textPrimary,
  });
  textLine(ctx, data.date, metaX + 67.5, labelY + 32, {
    bold: false, size: 7.1, color: C.textSecondary,
  });

  // Billing bottom border (full page width)
  strokeLine(ctx, 0, L.billingBorderY, L.pageW, L.billingBorderY, C.border, 0.75);

  // ── Items section ───────────────────────────────────────────────────────
  textLine(ctx, 'ITEMS PURCHASED', L.marginX, L.itemsLabelY, {
    bold: true, size: 8.25, color: C.textSecondary,
  });

  // Table header bar (black)
  ctx.fillStyle = C.black;
  ctx.fillRect(L.marginX, L.tableHeaderY, L.pageW - L.marginX * 2, L.tableHeaderH);
  const headY = L.tableHeaderY + 7.5;
  const headerOpts = { bold: true, size: 6.75, color: C.white };
  textLine(ctx, T.table.idx, L.col.idx.x, headY, { ...headerOpts, align: L.col.idx.align });
  textLine(ctx, T.table.desc, L.col.desc.x, headY, { ...headerOpts, align: L.col.desc.align });
  textLine(ctx, T.table.qty, L.col.qty.x + L.col.qty.w / 2, headY, { ...headerOpts, align: 'center' });
  textLine(ctx, T.table.rate, L.col.rate.x + L.col.rate.w, headY, { ...headerOpts, align: 'right' });
  textLine(ctx, T.table.discount, L.col.discount.x + L.col.discount.w, headY, { ...headerOpts, align: 'right' });
  textLine(ctx, T.table.amount, L.col.amount.x + L.col.amount.w, headY, { ...headerOpts, align: 'right' });

  // ── Item rows (only the planned, complete ones) ─────────────────────────
  const drawRow = (plan, isTradeIn, rowIdx, drawSeparator) => {
    const { item, layout, top } = plan;
    const txtColor = isTradeIn ? C.tradeInText : C.textPrimary;

    if (isTradeIn) {
      ctx.fillStyle = C.tradeInBg;
      ctx.fillRect(L.marginX, top, L.pageW - L.marginX * 2, layout.height);
    }

    const yOffset = top + L.rowPadV;
    const cell = { bold: false, size: 7.1, color: txtColor };

    textLine(ctx, String(rowIdx + 1), L.col.idx.x, yOffset, cell);

    // Description (bold, wrapped)
    setFont(ctx, true, 7.1);
    const descLh = lineHeight(7.1, true);
    layout.descLines.forEach((line, i) => {
      textLine(ctx, line, L.col.desc.x, yOffset + i * descLh, { ...cell, bold: true });
    });
    // Sub-line (secondary / trade-in green)
    if (layout.sub) {
      const subLh = lineHeight(6.375, false);
      layout.subLines.forEach((line, i) => {
        textLine(ctx, line, L.col.desc.x, yOffset + layout.descH + 2.25 + i * subLh, {
          bold: false, size: 6.375,
          color: isTradeIn ? C.tradeInSub : C.textSecondary,
        });
      });
    }

    // Qty (trade-ins render qty only when set — Prestige semantics)
    const qtyText = isTradeIn && !item.qty ? '' : String(item.qty || 1);
    textLine(ctx, qtyText, L.col.qty.x + L.col.qty.w / 2, yOffset, { ...cell, align: 'center' });

    if (!isTradeIn) {
      textLine(ctx, fmt(item.rate || item.price || 0), L.col.rate.x + L.col.rate.w, yOffset, { ...cell, align: 'right' });
      textLine(
        ctx,
        Number(item.discount) > 0 ? '\u2013 ' + fmt(item.discount || 0) : '\u2014',
        L.col.discount.x + L.col.discount.w,
        yOffset,
        { ...cell, align: 'right' },
      );
    }
    textLine(ctx, amountText(item, isTradeIn), L.col.amount.x + L.col.amount.w, yOffset, { ...cell, align: 'right' });

    if (drawSeparator) {
      strokeLine(
        ctx,
        L.marginX,
        top + layout.height,
        L.contentRight,
        top + layout.height,
        isTradeIn ? C.tradeInBorder : C.border,
        0.75,
      );
    }
  };

  itemPlans.forEach((plan, i) => {
    const isLastOfSection = i === items.length - 1;
    // PDF semantics: separator between rows — also under a truncated last
    // row (more content follows below the crop).
    const drawSeparator = !isLastOfSection || itemsTruncated;
    drawRow(plan, false, i, drawSeparator);
  });

  // ── Trade-in section (only when at least one complete row fits) ─────────
  if (tradeInPlans.length > 0) {
    textLine(ctx, 'TRADE-IN', L.marginX, tradeInLabelTop, {
      bold: true, size: 8.25, color: C.tradeInText,
    });
    ctx.fillStyle = C.tradeInBg;
    ctx.fillRect(L.marginX, tradeInHeaderTop, L.pageW - L.marginX * 2, L.tableHeaderH);
    strokeLine(ctx, L.marginX, tradeInHeaderTop, L.contentRight, tradeInHeaderTop, C.tradeInText, 1.125);
    const tHeadY = tradeInHeaderTop + 7.5;
    const tHeaderOpts = { bold: true, size: 6.75, color: C.tradeInText };
    textLine(ctx, T.tradeIn.idx, L.col.idx.x, tHeadY, { ...tHeaderOpts, align: L.col.idx.align });
    textLine(ctx, T.tradeIn.desc, L.col.desc.x, tHeadY, { ...tHeaderOpts, align: L.col.desc.align });
    textLine(ctx, T.tradeIn.qty, L.col.qty.x + L.col.qty.w / 2, tHeadY, { ...tHeaderOpts, align: 'center' });
    textLine(ctx, T.tradeIn.amount, L.col.amount.x + L.col.amount.w, tHeadY, { ...tHeaderOpts, align: 'right' });

    tradeInPlans.forEach((plan, i) => {
      const isLastOfSection = i === tradeIns.length - 1;
      const drawSeparator = !isLastOfSection || tradeInsTruncated;
      drawRow(plan, true, i, drawSeparator);
    });
  }

  // ── Encode: quality ladder, resolution is NEVER reduced ────────────────
  const tEncodeStart = performance.now();
  // @napi-rs/canvas 0.1.68 encoder contract (verified empirically):
  //   toBuffer('image/jpeg', q) — q is honored on a 0-100 scale. A value
  //                              below 1 (e.g. a legacy 0.85) encodes at
  //                              near-zero quality: heavy artifacts and
  //                              desaturated thin colored features (the
  //                              Prestige gold bar turns gray — the
  //                              "washed-out preview" failure mode).
  //   toBuffer('image/jpeg', {}) — an options object is NOT part of the
  //                              0.1.68 API; it is silently ignored and
  //                              the undocumented default (92) is used.
  // The canvas was initialized with an opaque solid-white background, so
  // the encode is a plain RGB JPEG — no alpha, no premultiply artifacts.
  let jpeg = canvas.toBuffer('image/jpeg', JPEG_QUALITY);
  if (jpeg.length > JPEG_SOFT_LIMIT) {
    jpeg = canvas.toBuffer('image/jpeg', JPEG_QUALITY_FALLBACK);
  }
  if (jpeg.length > JPEG_SOFT_LIMIT) {
    jpeg = canvas.toBuffer('image/jpeg', JPEG_QUALITY_LAST);
  }
  const encodeMs = performance.now() - tEncodeStart;
  const drawMs = tEncodeStart - tDrawStart;

  return {
    width: widthPx,
    height: heightPx,
    rows: itemPlans.length,
    tradeInRows: tradeInPlans.length,
    safeBottomPt: safeBottomPt,
    jpeg: jpeg,
    drawMs: drawMs,
    encodeMs: encodeMs,
  };
}

// ── Job loop: serialized, one job at a time ────────────────────────────────

function sendLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let jobQueue = Promise.resolve();

async function handleJobLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // malformed request — ignore (parent protocol violation)
  }
  if (!msg || typeof msg.id !== 'number' || !msg.data) return;
  try {
    const out = await renderThumbnail(msg.data);
    sendLine({
      id: msg.id,
      ok: true,
      w: out.width,
      h: out.height,
      rows: out.rows,
      tradeInRows: out.tradeInRows,
      bottomPt: Math.round(out.safeBottomPt * 100) / 100,
      jpegLen: out.jpeg.length,
      ms: {
        draw: Math.round(out.drawMs * 100) / 100,
        encode: Math.round(out.encodeMs * 100) / 100,
      },
    });
    process.stdout.write(out.jpeg);
  } catch (err) {
    sendLine({ id: msg.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { /* parent went away */ });
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.trim()) {
      const l = line;
      jobQueue = jobQueue.then(() => handleJobLine(l)).catch((err) => {
        process.stderr.write('thumbnail worker: job crashed: ' + String(err) + '\n');
      });
    }
  }
});

// Ready — canvas loaded, fonts registered.
sendLine({ t: 'ready' });
`;

// ── Parent-side persistent worker manager ──────────────────────────────────

interface PendingJob {
  resolve: (reply: WorkerReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerHandle {
  child: ChildProcess;
  ready: boolean;
  starting: Promise<WorkerHandle | null>;
}

/** Module state is stored on globalThis so a `bun --hot` reload adopts and
 *  kills the previous worker instead of orphaning it. */
interface ThumbnailGlobals {
  __fusionThumbWorker?: WorkerHandle;
  __fusionThumbStopping?: boolean;
}
const g = globalThis as typeof globalThis & ThumbnailGlobals;

let stopping = g.__fusionThumbStopping === true;
let handle: WorkerHandle | null = g.__fusionThumbWorker ?? null;
const pending = new Map<number, PendingJob>();
let nextId = 1;
let lastSpawnAt = 0;
let lastSpawnFailed = false;

/** Adopt-and-kill on hot reload (see above). */
if (handle) {
  try { handle.child.kill('SIGKILL'); } catch { /* already dead */ }
  handle = null;
}

/**
 * Spawn (or reuse) the persistent worker. Safe to call concurrently —
 * callers share the same starting promise. Resolves null when the worker
 * cannot be started (missing modules/fonts, spawn error, ready timeout).
 */
function ensureWorker(): Promise<WorkerHandle | null> {
  if (stopping) return Promise.resolve(null);
  if (handle?.ready) return Promise.resolve(handle);
  if (handle && !handle.ready) return handle.starting;
  if (
    lastSpawnFailed &&
    Date.now() - lastSpawnAt < THUMBNAIL_SPAWN_COOLDOWN_MS
  ) {
    return Promise.resolve(null);
  }

  const env = resolveWorkerEnv();
  if (!env) {
    lastSpawnAt = Date.now();
    lastSpawnFailed = true;
    return Promise.resolve(null);
  }

  lastSpawnAt = Date.now();
  lastSpawnFailed = false;
  const startedAt = lastSpawnAt;

  const log = getLogger();
  let child: ChildProcess;
  try {
    child = spawn('node', ['--input-type=module', '-e', WORKER_SOURCE], {
      env: {
        ...process.env,
        THUMB_CANVAS: env.canvas,
        THUMB_FONT_REGULAR: env.fontRegular,
        THUMB_FONT_BOLD: env.fontBold,
        THUMB_SPEC: env.spec,
        THUMB_WIDTH: String(THUMBNAIL_WIDTH_PX),
        THUMB_MAX_HEIGHT: String(THUMBNAIL_MAX_HEIGHT_PX),
        THUMB_JPEG_QUALITY: String(THUMBNAIL_JPEG_QUALITY),
        THUMB_JPEG_QUALITY_FALLBACK: String(THUMBNAIL_JPEG_QUALITY_FALLBACK),
        THUMB_JPEG_QUALITY_LAST: String(THUMBNAIL_JPEG_QUALITY_LAST_RESORT),
        THUMB_JPEG_SOFT_LIMIT: String(THUMBNAIL_JPEG_SOFT_LIMIT_BYTES),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    lastSpawnFailed = true;
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Thumbnail worker spawn failed — sending without chat preview',
    );
    return Promise.resolve(null);
  }

  const w: WorkerHandle = {
    child,
    ready: false,
    starting: new Promise<WorkerHandle | null>((resolveStarting) => {
      let settled = false;
      const settle = (result: WorkerHandle | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolveStarting(result);
      };

      const readyTimer = setTimeout(() => {
        if (!settled) {
          log.warn({ pid: child.pid }, 'Thumbnail worker ready timeout — killing');
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
          if (handle === w) handle = null;
          settle(null);
        }
      }, THUMBNAIL_READY_TIMEOUT_MS);
      readyTimer.unref?.();

      // ── stdout: JSON line framing + raw JPEG payloads ─────────────────
      let buf = Buffer.alloc(0);
      let expectBytes = 0;
      let expectHeader: WorkerHeader | null = null;

      const takeBytes = (n: number): Buffer => {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
      };

      const finishJob = (header: WorkerHeader, payload: Buffer | null): void => {
        const job = pending.get(header.id);
        if (!job) return;
        pending.delete(header.id);
        clearTimeout(job.timer);
        if (header.ok) {
          job.resolve({
            ok: true,
            w: header.w ?? 0,
            h: header.h ?? 0,
            rows: header.rows ?? 0,
            tradeInRows: header.tradeInRows ?? 0,
            bottomPt: header.bottomPt ?? 0,
            jpeg: payload ?? Buffer.alloc(0),
            ms: header.ms ?? { draw: 0, encode: 0 },
          } satisfies WorkerOkReply);
        } else {
          job.resolve({ ok: false, error: header.error ?? 'worker error' });
        }
      };

      child.stdout!.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (expectBytes > 0) {
            if (buf.length < expectBytes) return;
            const payload = takeBytes(expectBytes);
            const header = expectHeader!;
            expectBytes = 0;
            expectHeader = null;
            finishJob(header, payload);
            continue;
          }
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const line = takeBytes(nl + 1).toString('utf8').trim();
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            log.debug({ line: line.slice(0, 200) }, 'Thumbnail worker: unparsable stdout line');
            continue;
          }
          if (msg.t === 'ready') {
            w.ready = true;
            g.__fusionThumbWorker = w;
            settle(w);
            log.info(
              { pid: child.pid },
              'Thumbnail worker ready (persistent canvas renderer)',
            );
          } else if (typeof msg.jpegLen === 'number') {
            expectBytes = msg.jpegLen;
            expectHeader = msg as unknown as WorkerHeader;
          } else if (typeof msg.id === 'number') {
            finishJob(msg as unknown as WorkerHeader, null);
          }
        }
      });

      child.stdout!.on('error', () => { /* handled via 'exit' */ });

      let stderrTail = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
      });
      child.stderr!.on('error', () => { /* ignore */ });

      child.on('error', (err) => {
        log.warn({ err: err.message }, 'Thumbnail worker process error');
        if (handle === w) handle = null;
        settle(null);
      });

      child.on('exit', (code, signal) => {
        if (handle === w) handle = null;
        g.__fusionThumbWorker = undefined;
        // Crash-loop guard: a worker that died within a second of spawning
        // puts the manager on cooldown (no rapid respawn spam).
        if (Date.now() - startedAt < THUMBNAIL_SPAWN_COOLDOWN_MS && !stopping) {
          lastSpawnFailed = true;
        }
        // Every pending job fails — the send proceeds WITHOUT a preview.
        failAllPending('worker exited');
        if (!stopping) {
          log.warn(
            { code, signal, pid: child.pid, stderr: stderrTail.slice(0, 300) || undefined },
            'Thumbnail worker exited — it will restart on the next invoice send',
          );
        }
        settle(null);
      });

      // A dead worker's stdin must not throw in the parent.
      child.stdin!.on('error', () => { /* handled via 'exit' */ });
    }),
  };

  handle = w;
  return w.starting;
}

/** Resolve every in-flight job as failed (worker crash/kill). */
function failAllPending(reason: string): void {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve({ ok: false, error: reason });
  }
  pending.clear();
}

/** One thumbnail request over the persistent worker. Never rejects. */
async function requestThumbnail(data: InvoiceData): Promise<WorkerReply> {
  const w = await ensureWorker();
  if (!w) return { ok: false, error: 'thumbnail worker unavailable' };

  return new Promise<WorkerReply>((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      // A hung worker is a broken worker: kill it; the next request respawns.
      try { w.child.kill('SIGKILL'); } catch { /* already dead */ }
      resolve({ ok: false, error: `thumbnail job timed out after ${THUMBNAIL_JOB_TIMEOUT_MS}ms` });
    }, THUMBNAIL_JOB_TIMEOUT_MS);
    timer.unref?.();

    pending.set(id, { resolve, timer });
    try {
      w.child.stdin!.write(JSON.stringify({ id, data }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: `stdin write failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate the WhatsApp chat-bubble preview for an invoice: a crisp JPEG of
 * the UPPER SECTION of the Prestige design (store header, billing/meta,
 * items table with the first complete rows) rendered directly from the
 * canonical InvoiceData by the persistent canvas worker.
 *
 * NEVER rejects and never blocks the caller on failure — a cosmetic preview
 * is not allowed to break an invoice send. Any failure resolves with
 * `jpeg: null` (plus a warning log).
 */
export async function generateInvoiceThumbnail(data: InvoiceData): Promise<InvoiceThumbnail> {
  const t0 = performance.now();
  const log = getLogger();

  let reply: WorkerReply;
  try {
    reply = await requestThumbnail(data);
  } catch (err) {
    // requestThumbnail never rejects, but stay defensive.
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const totalMs = performance.now() - t0;

  if (!reply.ok) {
    log.warn(
      { reason: reply.error, ms: Math.round(totalMs) },
      'Invoice thumbnail generation failed — sending without chat preview',
    );
    return {
      jpeg: null, width: null, height: null, rows: null, tradeInRows: null,
      bottomPt: null, ms: { total: totalMs, draw: null, encode: null },
    };
  }

  if (!reply.jpeg || reply.jpeg.length === 0 || reply.jpeg[0] !== 0xff || reply.jpeg[1] !== 0xd8) {
    log.warn(
      { bytes: reply.jpeg?.length ?? 0 },
      'Invoice thumbnail produced invalid JPEG data — sending without chat preview',
    );
    return {
      jpeg: null, width: null, height: null, rows: null, tradeInRows: null,
      bottomPt: null, ms: { total: totalMs, draw: null, encode: null },
    };
  }

  log.info(
    {
      width: reply.w,
      height: reply.h,
      rows: reply.rows,
      tradeInRows: reply.tradeInRows,
      bytes: reply.jpeg.length,
      ms: Math.round(totalMs),
      drawMs: reply.ms.draw,
      encodeMs: reply.ms.encode,
    },
    'Invoice thumbnail generated (Prestige upper-section preview)',
  );

  return {
    jpeg: reply.jpeg,
    width: reply.w,
    height: reply.h,
    rows: reply.rows,
    tradeInRows: reply.tradeInRows,
    bottomPt: reply.bottomPt,
    ms: { total: totalMs, draw: reply.ms.draw, encode: reply.ms.encode },
  };
}

/**
 * Start the persistent worker at backend startup so the first invoice send
 * does not pay the Node/canvas/font initialization cost.
 * Never throws — a failed warmup only means the first send pays it instead.
 */
export async function warmupThumbnailWorker(): Promise<boolean> {
  const w = await ensureWorker();
  return w !== null;
}

/**
 * Stop the persistent worker (application shutdown). In-flight jobs fail
 * with 'worker exited' and resolve as thumbnail-less sends.
 */
export function stopThumbnailWorker(reason = 'shutdown'): void {
  stopping = true;
  g.__fusionThumbStopping = true;
  if (handle) {
    try {
      handle.child.kill('SIGKILL');
    } catch { /* already dead */ }
    handle = null;
    g.__fusionThumbWorker = undefined;
  }
  getLogger().info({ reason }, 'Thumbnail worker stopped');
}
