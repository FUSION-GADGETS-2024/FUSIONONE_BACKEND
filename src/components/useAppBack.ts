/**
 * useAppBack — the application's browser-history back navigation.
 *
 * The application's navigation model (browser history is the source of
 * truth — no origin routes are ever hardcoded into a page):
 *
 *   ENTERING AN EDITOR     → normal navigation; the editor gets its own
 *                            history entry like any page.
 *   SUCCESSFUL SAVE        → `navigate(resultingDetail, { replace: true })`
 *                            — the editor's entry is REPLACED by the
 *                            resulting detail page, so Back from that
 *                            detail returns to wherever the editor was
 *                            actually entered from (the list, another
 *                            detail, …), never to the completed editor.
 *   FAILED SAVE            → no navigation at all; the editor (and its
 *                            form state) stays for correction/retry.
 *   EDITOR GUARD REDIRECT  → replace (an editor that refuses to mount —
 *                            cancelled entity, closed financial year —
 *                            must not linger in history behind the
 *                            redirect).
 *   LEAVING A DETAIL PAGE  → navigate backward through real history.
 *
 * This hook implements the last rule for detail/editor Back controls:
 * browser history back returns to wherever the user actually came from
 * (Sales, Purchases, Party Detail, …) and restores that page's state.
 * The fallback route is used only for direct entry — a page opened with
 * no in-app history (fresh tab / external link), where `navigate(-1)`
 * alone would leave the application.
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router'

export function useAppBack(fallback: string): () => void {
  const navigate = useNavigate()
  return useCallback(() => {
    // react-router records the entry index in history.state.idx — a detail
    // page opened after in-app navigation has somewhere real to go back to.
    if (window.history.state && typeof window.history.state.idx === 'number' && window.history.state.idx > 0) {
      navigate(-1)
    } else {
      navigate(fallback, { replace: true })
    }
  }, [navigate, fallback])
}
