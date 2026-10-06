/**
 * Client-side invoice print (browser-only).
 *
 * Reuses the exact same PDF pipeline as the download action — `buildInvoicePdf`
 * in download.ts is the single source of truth for invoice rendering — and
 * hands the generated PDF to the browser's native print UI through a transient
 * hidden iframe: the browser's built-in PDF viewer renders the document and
 * its print command prints precisely the generated PDF.
 *
 * The user stays on the current page — no navigation, no hidden detail page,
 * no second rendering of the invoice. The native print dialog takes over,
 * as with any browser print.
 */
import type { InvoiceType } from './types'
import { buildInvoicePdf } from './download'

export async function printInvoicePdf(invoiceId: string, invoiceType: InvoiceType): Promise<void> {
  const { blob, billNumber } = await buildInvoicePdf(invoiceId, invoiceType)
  await printPdfBlob(blob, `${billNumber}.pdf`)
}

/**
 * Print-transport adapter — the standard browser pattern for handing a
 * generated PDF blob to the native print UI (the same transport used by the
 * established print libraries):
 *
 *   1. a zero-size, fixed-position iframe carries the PDF through a blob URL
 *      (same-origin, so its window stays reachable);
 *   2. once loaded, one macrotask lets the browser's embedded PDF viewer
 *      finish initializing — calling print() inside the load handler itself
 *      races the viewer and opens a BLANK preview in Chromium;
 *   3. the viewer window is focused (Chromium prints the focused frame —
 *      without the focus the wrong frame can reach the dialog) and its
 *      native print command is invoked;
 *   4. the adapter cleans up the moment the dialog is dismissed — via the
 *      viewer's afterprint event when the engine fires it, otherwise when
 *      the (modal) print() call returns and afterprint fails to arrive.
 *
 * It renders nothing of its own and receives no user events.
 */
function printPdfBlob(blob: Blob, title: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')

    let settled = false
    const settle = (cause?: unknown) => {
      if (settled) return
      settled = true
      frame.remove()
      URL.revokeObjectURL(url)
      if (cause) {
        reject(cause instanceof Error ? cause : new Error('Unable to open the print preview.'))
      } else {
        resolve()
      }
    }

    frame.addEventListener('load', () => {
      const viewer = frame.contentWindow
      if (!viewer || typeof viewer.print !== 'function') {
        settle(new Error('The browser could not open the print preview. Use Save PDF instead.'))
        return
      }

      // Viewer-readiness handshake: the iframe `load` event fires while the
      // embedded PDF viewer is still initializing. Handing over on the next
      // macrotask is what separates a printed invoice from a blank dialog.
      window.setTimeout(() => {
        if (settled) return
        const onAfterPrint = () => settle()
        viewer.addEventListener('afterprint', onAfterPrint, { once: true })
        try {
          // Chromium prints the focused frame — focus the viewer first.
          viewer.focus()
          // Modal in Chromium/Firefox: returns after the dialog is dismissed.
          // Engines where it returns early settle through afterprint above.
          viewer.print()
          if (settled) return
          // print() returned without afterprint (dialog already dismissed, or
          // an engine that does not emit afterprint on subframe windows) —
          // give afterprint a brief grace to arrive, then settle.
          window.setTimeout(() => settle(), 250)
        } catch (cause) {
          viewer.removeEventListener('afterprint', onAfterPrint)
          settle(cause)
        }
      }, 50)
    })

    frame.title = title
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
    frame.src = url
    document.body.appendChild(frame)
  })
}
