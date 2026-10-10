/**
 * Party document image processing — Canvas worker (plain-Node child process).
 *
 * PIPELINE for supported images (deliberately simple — no thumbnails, no
 * variant generation; the goal is efficient, reliable storage + preview):
 *
 *   input bytes → decode (@napi-rs/canvas) → correct EXIF orientation →
 *   cap the longest side at 2560 px (never upscale) → re-encode as JPEG
 *   (quality 85) → processed bytes
 *
 * Re-encoding strips ALL source metadata (EXIF/GPS/color profiles) as a
 * side effect — canvas output carries pixels only. Every image type is
 * normalized to image/jpeg: these are identity/declaration documents where
 * universal browser preview matters more than alpha/animation fidelity.
 *
 * WHY A SEPARATE NODE PROCESS: the backend runs under Bun and the
 * @napi-rs/canvas native binding hard-crashes the Bun runtime (the same
 * isolation as the WhatsApp thumbnail worker, an established pattern in
 * this codebase). The framing protocol is BINARY-SAFE on both directions
 * (a JSON header line followed by raw payload bytes; framing operates on
 * Buffers, never on decoded strings, so header and payload arriving in one
 * chunk are handled correctly):
 *
 *   parent → worker : {"id":N,"imageLen":K}\n + K raw image bytes
 *   worker → parent : {"t":"ready"}\n, then per job
 *                     {"id":N,"ok":true,"jpegLen":K,"ms":M}\n + K raw JPEG
 *                     bytes (or {"id":N,"ok":false,"error":"..."}\n)
 *
 * Failure semantics: a worker failure REJECTS the upload (document
 * processing is not cosmetic) — the service maps it to an invalid/processing
 * error and nothing is stored.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { getLogger } from '../logging/logger.js';

// ── Public configuration ───────────────────────────────────────────────────

/** Maximum stored dimension (longest side, never upscaled). 2560px is a
 *  comfortable bound for photographed identity documents: large enough to
 *  remain fully legible, small enough to keep objects light. */
const IMAGE_MAX_DIMENSION = 2560;

/** JPEG re-encode quality (0-100 on the @napi-rs/canvas scale). */
const IMAGE_JPEG_QUALITY = 85;

/** Hard per-job timeout — a hung worker must never hang an upload. */
const IMAGE_JOB_TIMEOUT_MS = 30_000;

/** Worker startup budget (node boot + canvas import). */
const IMAGE_READY_TIMEOUT_MS = 20_000;

/** Cooldown after a failed spawn (prevents crash-loop spawning). */
const IMAGE_SPAWN_COOLDOWN_MS = 1_000;

// ── Result contract ────────────────────────────────────────────────────────

export interface ProcessedImage {
  /** The processed JPEG bytes. */
  jpeg: Buffer;
  ms: number;
}

// ── Worker environment resolution (once, cached) ───────────────────────────

let canvasModulePath: string | null | undefined;

function resolveCanvasPath(): string | null {
  if (canvasModulePath !== undefined) return canvasModulePath;
  try {
    const require = createRequire(import.meta.url);
    canvasModulePath = require.resolve('@napi-rs/canvas');
  } catch {
    canvasModulePath = null;
    getLogger().warn(
      'Image worker environment unavailable — document image uploads will fail clearly',
    );
  }
  return canvasModulePath;
}

// ── The worker source (plain JavaScript — executed by NODE, never Bun) ──────
//
// Receives jobs as: one JSON header line {"id":N,"imageLen":K}\n followed by
// K raw image bytes. Replies with one JSON header line
// {"id":N,"ok":true,"jpegLen":K}\n followed by K raw JPEG bytes on stdout
// (or {"id":N,"ok":false,"error":"..."}\n). No filesystem I/O — entirely in
// memory. EXIF orientation is parsed minimally (a few dozen lines of pure
// JS for the orientation tag) and applied via canvas transforms, because
// canvas decoders do not apply EXIF rotation themselves.
//
// NOTE: this string uses String.raw — every backslash below must remain a
// literal backslash in the emitted source. No template literals are used
// inside the worker source (no ${ } interpolation hazards).

const WORKER_SOURCE = String.raw`
'use strict';
// ── Persistent image-processing worker ─────────────────────────────────────
const CANVAS_PATH = process.env.IMAGE_CANVAS;
const MAX_DIM = Number(process.env.IMAGE_MAX_DIM);
const JPEG_QUALITY = Number(process.env.IMAGE_JPEG_QUALITY);

const { loadImage, createCanvas } = require(CANVAS_PATH);

// EXIF orientation is corrected BY THE DECODER: @napi-rs/canvas's loadImage
// honors the EXIF orientation tag (the same behavior as <img> in browsers),
// so the decoded image is already the DISPLAYED image — dimensions swapped
// for orientations 5..8 and pixels positioned accordingly. Applying a second
// manual transform would double-rotate; none is performed here.

async function processImage(buf) {
  const started = Date.now();
  const img = await loadImage(buf); // throws on undecodable content
  const w = img.width;
  const h = img.height;
  if (w <= 0 || h <= 0) throw new Error('image has no pixels');

  // Never upscale: cap the longest side at MAX_DIM.
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Drawing onto a fresh canvas re-encodes pixels only — every source
  // metadata segment (EXIF/GPS/color profiles) is dropped by construction.
  ctx.drawImage(img, 0, 0, outW, outH);

  const jpeg = canvas.toBuffer('image/jpeg', JPEG_QUALITY);
  return { jpeg, ms: Date.now() - started };
}

// ── Binary-safe job framing on stdin ───────────────────────────────────────
// state 'text': accumulating a header line up to the next 0x0A byte.
// state 'payload': accumulating exactly N raw bytes for the pending job.
let state = 'text';
let textBuf = '';
let jobId = 0;
let need = 0;
let payload = null;
let payloadLen = 0;

process.stdout.write(JSON.stringify({ t: 'ready' }) + '\n');

function replyHeader(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function finishPayload() {
  const id = jobId;
  const image = payload;
  state = 'text';
  payload = null; payloadLen = 0; need = 0; jobId = 0;
  processImage(image)
    .then(({ jpeg, ms }) => {
      replyHeader({ id, ok: true, jpegLen: jpeg.length, ms });
      process.stdout.write(jpeg);
    })
    .catch((err) => {
      replyHeader({ id, ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) });
    });
}

process.stdin.on('error', () => { /* parent went away */ });
process.stdin.on('data', (chunk) => {
  let rest = chunk;
  while (rest.length > 0) {
    if (state === 'payload') {
      const take = Math.min(rest.length, need - payloadLen);
      rest.copy(payload, payloadLen, 0, take);
      payloadLen += take;
      rest = rest.subarray(take);
      if (payloadLen === need) finishPayload();
      continue;
    }
    // state === 'text': find the header line terminator.
    const nl = rest.indexOf(0x0a);
    if (nl === -1) {
      textBuf += rest.toString('latin1');
      break; // line continues in a later chunk
    }
    const line = textBuf + rest.subarray(0, nl).toString('latin1');
    textBuf = '';
    rest = rest.subarray(nl + 1);
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      replyHeader({ id: 0, ok: false, error: 'bad json: ' + String(e && e.message ? e.message : e).slice(0, 120) });
      continue;
    }
    if (typeof parsed.id !== 'number' ||
        typeof parsed.imageLen !== 'number' || parsed.imageLen < 0) {
      replyHeader({ id: typeof parsed.id === 'number' ? parsed.id : 0, ok: false, error: 'malformed job header' });
      continue;
    }
    jobId = parsed.id;
    need = parsed.imageLen;
    payload = Buffer.alloc(need);
    payloadLen = 0;
    state = 'payload';
    if (need === 0) finishPayload();
  }
});
`;

// ── Parent-side worker management ──────────────────────────────────────────

interface PendingJob {
  resolve: (r: ProcessedImage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let child: ChildProcess | null = null;
let ready: Promise<void> | null = null;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();
let lastSpawnAttempt = 0;

// Binary-safe stdout framing (parent side): header line then raw payload.
let outState: 'text' | 'payload' = 'text';
let outText = '';
let outJobId = 0;
let outNeed = 0;
let outBuf: Buffer | null = null;
let outLen = 0;
let outMs = 0;

function resolvePending(id: number, jpeg: Buffer, ms: number): void {
  const job = pending.get(id);
  if (job) {
    clearTimeout(job.timer);
    pending.delete(id);
    job.resolve({ jpeg, ms });
  }
}

function rejectPending(id: number, err: Error): void {
  const job = pending.get(id);
  if (job) {
    clearTimeout(job.timer);
    pending.delete(id);
    job.reject(err);
  }
}

function finishOutPayload(): void {
  const id = outJobId;
  const jpeg = outBuf!;
  const ms = outMs;
  outState = 'text';
  outBuf = null; outLen = 0; outNeed = 0; outJobId = 0; outMs = 0;
  resolvePending(id, jpeg, ms);
}

function handleStdout(chunk: Buffer): void {
  let rest = chunk;
  while (rest.length > 0) {
    if (outState === 'payload') {
      const take = Math.min(rest.length, outNeed - outLen);
      rest.copy(outBuf!, outLen, 0, take);
      outLen += take;
      rest = rest.subarray(take);
      if (outLen === outNeed) finishOutPayload();
      continue;
    }
    const nl = rest.indexOf(0x0a);
    if (nl === -1) {
      outText += rest.toString('utf8');
      break;
    }
    const line = (outText + rest.subarray(0, nl).toString('utf8')).trim();
    outText = '';
    rest = rest.subarray(nl + 1);
    if (line === '') continue;
    let header: { id?: number; ok?: boolean; jpegLen?: number; ms?: number; error?: string; t?: string };
    try {
      header = JSON.parse(line);
    } catch {
      continue; // ignore unparseable diagnostics lines
    }
    if (header.t === 'ready') continue; // already resolved via the ready race
    if (typeof header.id !== 'number') continue;
    if (header.ok === true && typeof header.jpegLen === 'number') {
      outJobId = header.id;
      outNeed = header.jpegLen;
      outMs = header.ms ?? 0;
      outBuf = Buffer.alloc(outNeed);
      outLen = 0;
      outState = 'payload';
      if (outNeed === 0) finishOutPayload(); // resolve immediately (degenerate)
      continue;
    }
    if (header.ok === false) {
      rejectPending(header.id, new Error(header.error ?? 'image processing failed'));
    }
  }
}

function spawnWorker(): ChildProcess {
  const canvas = resolveCanvasPath();
  if (!canvas) {
    throw new Error('image worker environment unavailable (@napi-rs/canvas not resolvable)');
  }
  return spawn('node', ['--input-type=commonjs', '-e', WORKER_SOURCE], {
    env: {
      ...process.env,
      IMAGE_CANVAS: canvas,
      IMAGE_MAX_DIM: String(IMAGE_MAX_DIMENSION),
      IMAGE_JPEG_QUALITY: String(IMAGE_JPEG_QUALITY),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function ensureWorker(): Promise<void> {
  if (child && !child.killed && child.exitCode === null) {
    return ready ?? Promise.resolve();
  }
  const now = Date.now();
  if (now - lastSpawnAttempt < IMAGE_SPAWN_COOLDOWN_MS) {
    throw new Error('image worker restarting (cooldown)');
  }
  lastSpawnAttempt = now;

  const proc = spawnWorker();
  child = proc;
  const myReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('image worker ready timeout')), IMAGE_READY_TIMEOUT_MS);
    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0 && text.slice(0, nl).includes('"t":"ready"')) {
        clearTimeout(timer);
        // Any bytes following the ready line belong to job replies.
        const remainder = chunk.subarray(Buffer.byteLength(text.slice(0, nl + 1), 'utf8'));
        if (remainder.length > 0) handleStdout(remainder);
        resolve();
      } else {
        handleStdout(chunk);
      }
    };
    proc.stdout!.on('data', onStdout);
    proc.stderr!.on('data', (c: Buffer) => {
      // Worker diagnostics only — never file contents.
      getLogger().debug({ worker: 'image', stderr: c.toString('utf8').slice(0, 300) }, 'image worker stderr');
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      const err = new Error('image worker exited');
      for (const [id, job] of pending) {
        clearTimeout(job.timer);
        job.reject(err);
        pending.delete(id);
      }
      if (child === proc) child = null;
      ready = null;
      reject(err);
    });
    proc.stdin!.on('error', () => { /* handled via 'exit' */ });
  });
  ready = myReady;
  return myReady;
}

/**
 * Process one image (decode → orient → cap → re-encode JPEG).
 * Rejects when the worker cannot produce a valid processed image — the
 * caller fails the upload (nothing is stored).
 */
export async function processDocumentImage(input: Buffer): Promise<ProcessedImage> {
  await ensureWorker();
  const w = child!;
  const id = nextJobId++;

  return new Promise<ProcessedImage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('image processing timed out'));
    }, IMAGE_JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });

    const header = Buffer.from(JSON.stringify({ id, imageLen: input.length }) + '\n', 'utf8');
    try {
      w.stdin!.write(header);
      w.stdin!.write(input);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Stop the worker (graceful shutdown; in-flight jobs reject). */
export function stopImageWorker(reason: string): void {
  if (child) {
    getLogger().info({ reason }, 'Stopping image worker');
    try {
      child.stdin?.end();
    } catch {
      // already gone
    }
    child.kill();
    child = null;
    ready = null;
  }
}
