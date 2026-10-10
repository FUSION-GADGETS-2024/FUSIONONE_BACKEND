/**
 * Client-side native invoice PDF share (browser-only).
 *
 * ONE more action wrapper over the ONE artifact provider: `shareInvoicePdf`
 * obtains the invoice PDF from the exact same pipeline as the viewer, Save
 * PDF and Print (`buildInvoicePdf`, cache included — a cached invoice is
 * never re-rendered for sharing), wraps the artifact in a File carrying the
 * canonical `invoicePdfFilename`, and hands it — and nothing else — to the
 * device/browser native share sheet through the Web Share API:
 *
 *   Share → existing invoice PDF artifact → File → navigator.share({files})
 *
 * The payload is ONLY the PDF file. No thumbnail, no rendered image, no
 * share card, no message text — the user picks the destination in the
 * platform dialog. The backend-owned WhatsApp delivery pipeline is a
 * completely separate action and is never invoked here.
 *
 * Capability handling (Web Share with files is not universal):
 *   - the gate is checked BEFORE any PDF work, so unsupported browsers never
 *     build an artifact they cannot hand over;
 *   - an unsupported platform rejects with a clear, actionable error that
 *     the calling layer surfaces through the app's toast pattern;
 *   - the user dismissing the native dialog is a normal outcome (AbortError)
 *     and resolves silently — it is not a failure.
 */
import type { InvoiceType } from './types'
import { buildInvoicePdf, invoicePdfFilename } from './download'

/**
 * Whether this browser/platform can share files through the Web Share API
 * at all (`navigator.share` + `navigator.canShare` present). A precise
 * per-file verdict comes from `navigator.canShare({ files })` once the
 * artifact exists.
 */
export function isNativeFileShareSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  )
}

/**
 * Share the invoice PDF through the device/browser native share dialog.
 *
 * Reuses the one PDF pipeline (and its cache) — this is an action wrapper,
 * not a second generator. Rejects with a descriptive Error when the
 * platform cannot share files (surfaced by the caller as the app's toast);
 * resolves when the share sheet was dismissed by the user.
 */
export async function shareInvoicePdf(invoiceId: string, invoiceType: InvoiceType): Promise<void> {
  // Gate first — no artifact work on platforms that cannot share files.
  if (!isNativeFileShareSupported()) {
    throw new Error('This browser cannot share files. Use Save PDF instead.')
  }

  // The ONE artifact: same pipeline, same cache, same rendering as
  // Preview / Save PDF / Print.
  const { blob, billNumber } = await buildInvoicePdf(invoiceId, invoiceType)
  const file = new File([blob], invoicePdfFilename(billNumber), { type: 'application/pdf' })

  // Precise verdict for the actual file (type/name) on this platform.
  if (!navigator.canShare({ files: [file] })) {
    throw new Error('This browser cannot share PDF files. Use Save PDF instead.')
  }

  try {
    // The shared payload is ONLY the invoice PDF file.
    await navigator.share({ files: [file] })
  } catch (cause) {
    // The user closing the platform share dialog rejects with AbortError
    // (name may arrive lowercased, and not every engine reports it as a
    // DOMException) — a dismissal, not a failure. Everything else
    // (permission denied, unexpected engine errors) propagates to the
    // caller's error surface with its message preserved.
    if (isAbortError(cause)) {
      return
    }
    throw new Error(errorMessageOf(cause))
  }
}

/** An AbortError-shaped rejection — the user dismissed the share sheet. */
function isAbortError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const name = (cause as { name?: unknown }).name
  return typeof name === 'string' && name.toLowerCase() === 'aborterror'
}

/**
 * The message of a share failure — preserved verbatim when present (an
 * engine's rejection may be a DOMException, which is not an Error subclass
 * in every runtime, so duck-typing carries the message).
 */
function errorMessageOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'The invoice could not be shared.'
}
